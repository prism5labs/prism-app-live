// Telephony: texts, calls, and caller ID over a provider number (Twilio).
// Steps 1 and 7 of the Prism 5 capability design.
//
// The server gets a phone number from Twilio and sends/receives texts and
// calls through it. Nothing goes out without the owner's tap, and nothing
// goes to a number that is not an approved Switchboard contact: the
// contacts table gains a phone column, and a first text or call to a new
// number is refused until that contact is approved, same as email.
//
// This module is self-contained on purpose: it creates its own tables at
// import, reads its env vars directly, and exports one handler per route.
// server.ts mounts the routes (see WIRING.md at the repo root); this file
// never touches server.ts, db.ts, or the client.
//
// When Twilio is not configured (any of TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER absent), every JSON endpoint
// answers {ok:false, error:"not_connected"} in plain words and the server
// still starts. The webhooks answer empty TwiML instead of JSON, so
// Twilio does not retry-storm a number that was never pointed at us.

import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { addMessage, db, getContactByAddress } from "./db";

// --- Tables (created here, in this module, at import) ---
db.exec(`
CREATE TABLE IF NOT EXISTS texts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stored',
  provider_sid TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_texts_account ON texts (account_id, id);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiated',
  duration_seconds INTEGER,
  transcript TEXT,
  recording_url TEXT,
  provider_sid TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_account ON calls (account_id, id);
`);

// The Switchboard contacts list gains a phone column (design step 1:
// vetting). The ALTER fails if the column already exists, so it is wrapped
// and ignored on purpose.
try {
  db.exec(`ALTER TABLE contacts ADD COLUMN phone TEXT`);
} catch {
  // Column already exists; nothing to do.
}

// --- Config (from config.ts) ---
function twilioSid(): string {
  return config.twilioAccountSid;
}
function twilioToken(): string {
  return config.twilioAuthToken;
}
function twilioNumber(): string {
  return config.twilioPhoneNumber;
}
function appUrl(): string {
  return (config.appUrl || "").replace(/\/$/, "");
}

export function twilioConfigured(): boolean {
  return twilioSid().length > 0 && twilioToken().length > 0 && twilioNumber().length > 0;
}

// The number, masked: the owner can check which number is live without
// the full number sitting in API responses.
export function maskedTwilioNumber(): string | null {
  const digits = twilioNumber().replace(/\D/g, "");
  const last4 = digits.slice(-4);
  return last4 ? `(***) ***-${last4}` : null;
}

const NOT_CONNECTED_MESSAGE =
  "Texts and calls aren't connected yet. Add your Twilio number in the server settings to turn them on.";

// --- Small response helpers (local copies; server.ts has its own) ---
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function notConnected(): Response {
  return json({ ok: false, error: "not_connected", configured: false, message: NOT_CONNECTED_MESSAGE });
}

function twiml(body: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Phone numbers ---
// Digits only; matching compares the last 10 digits, so +1 (555) 123-4567,
// 5551234567, and 555-123-4567 all match the same contact.
export function normalizePhone(phone: string): string {
  return (phone || "").replace(/\D/g, "");
}

function sameNumber(a: string, b: string): boolean {
  const da = normalizePhone(a);
  const dbDigits = normalizePhone(b);
  if (!da || !dbDigits) return false;
  if (da.length >= 10 && dbDigits.length >= 10) return da.slice(-10) === dbDigits.slice(-10);
  return da === dbDigits;
}

// What Twilio wants: E.164. A bare 10-digit US number gets +1.
function toE164(phone: string): string {
  const digits = normalizePhone(phone);
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return phone.trim();
}

// --- Contacts by phone ---
// The contacts table is keyed by email address, so a phone lookup scans
// the account's contacts and matches on the phone column. The list is
// small (one owner's address book), so this stays cheap.
type PhoneContact = {
  id: string;
  photon: string;
  name: string;
  address: string;
  status: "pending" | "approved" | "declined";
  phone: string | null;
};

function getContactByPhone(accountId: string, phone: string): PhoneContact | null {
  const rows = db
    .query(`SELECT * FROM contacts WHERE account_id = ?`)
    .all(accountId) as any[];
  for (const row of rows) {
    if (row.phone && sameNumber(row.phone, phone)) {
      return {
        id: row.id,
        photon: row.photon,
        name: row.name,
        address: row.address,
        status: row.status,
        phone: row.phone,
      };
    }
  }
  return null;
}

// Resolve a "to" value to an approved contact and a dialable number.
// The client may send a phone number, or an email address (in which case
// the contact is found by address and the number comes from its phone
// column). Returns the contact and number, or the reason it cannot go out.
function resolveApprovedContact(
  accountId: string,
  to: string,
): { contact: PhoneContact; phone: string } | { error: string; message: string } {
  let contact: PhoneContact | null = null;
  let phone = "";
  if (to.includes("@")) {
    const byAddress = getContactByAddress(accountId, to.trim().toLowerCase());
    if (byAddress) {
      // getContactByAddress returns the db Contact type, which has no
      // phone field; read the row again with the phone column included.
      const row = db
        .query(`SELECT * FROM contacts WHERE account_id = ? AND id = ?`)
        .get(accountId, byAddress.id) as any;
      contact = row
        ? {
            id: row.id,
            photon: row.photon,
            name: row.name,
            address: row.address,
            status: row.status,
            phone: row.phone || null,
          }
        : null;
      phone = contact?.phone || "";
    }
  } else {
    contact = getContactByPhone(accountId, to);
    phone = to.trim();
  }
  if (!contact || !phone) {
    return {
      error: "contact_not_approved",
      message:
        "That number isn't an approved contact yet. Add them to your contacts and get their approval first — nothing was sent.",
    };
  }
  if (contact.status === "declined") {
    return {
      error: "contact_not_approved",
      message: `${contact.name} declined the connection, so nothing can be sent to them.`,
    };
  }
  if (contact.status !== "approved") {
    return {
      error: "contact_not_approved",
      message: `Waiting on ${contact.name} to approve the connection first — nothing was sent.`,
    };
  }
  return { contact, phone };
}

// --- Caller ID ---
// Match the number against the owner's contacts first. Unknown numbers
// get a plain label, never a guessed name.
export function callerIdFor(
  accountId: string,
  phone: string,
): { name: string | null; label: string; known: boolean } {
  const contact = getContactByPhone(accountId, phone);
  if (contact) return { name: contact.name, label: contact.name, known: true };
  return { name: null, label: "unknown number", known: false };
}

// --- Twilio REST (plain fetch, Basic auth, no SDK) ---
function twilioAuthHeader(): string {
  return `Basic ${Buffer.from(`${twilioSid()}:${twilioToken()}`).toString("base64")}`;
}

async function twilioPost(
  path: string,
  params: Record<string, string>,
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid()}/${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: twilioAuthHeader(),
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    console.error("Twilio request failed:", e);
    return { ok: false, status: 0, data: null };
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

// --- Twilio request-signature validation ---
// Twilio signs each webhook: HMAC-SHA1 over the full URL plus every POST
// parameter sorted by name, key and value concatenated, with the auth
// token as the key, base64-encoded. See the Twilio webhook security docs.
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string,
  authToken?: string,
): boolean {
  const token = authToken ?? twilioToken();
  if (!token || !signature) return false;
  const sorted = Object.keys(params).sort();
  let data = url;
  for (const key of sorted) data += key + params[key];
  const expected = createHmac("sha1", token).update(data).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// The URL Twilio called, as Twilio sees it. Behind a proxy the request
// URL can carry the internal host, so prefer the public APP_URL origin
// when it is set; the signature check tries both.
function signatureUrlCandidates(req: Request): string[] {
  const out = [req.url];
  const base = appUrl();
  if (base) {
    const u = new URL(req.url);
    const rebuilt = `${base}${u.pathname}${u.search}`;
    if (rebuilt !== req.url) out.push(rebuilt);
  }
  return out;
}

async function readFormParams(req: Request): Promise<Record<string, string>> {
  try {
    const form = await req.formData();
    const out: Record<string, string> = {};
    for (const [key, value] of form.entries()) out[key] = String(value);
    return out;
  } catch {
    return {};
  }
}

async function readJsonBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function accountIdFromQuery(req: Request): string {
  return new URL(req.url).searchParams.get("accountId") || "";
}

// --- Rows ---
export type TextRow = {
  id: number;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  body: string;
  status: string;
  providerSid: string | null;
  createdAt: string;
};

export type CallRow = {
  id: number;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  fromLabel: string;
  toLabel: string;
  status: string;
  durationSeconds: number | null;
  transcript: string | null;
  recordingUrl: string | null;
  providerSid: string | null;
  createdAt: string;
};

function rowToText(accountId: string, row: any): TextRow {
  const fromLabel = callerIdFor(accountId, row.from_number).label;
  const toLabel =
    row.direction === "outbound"
      ? (getContactByPhone(accountId, row.to_number)?.name ?? row.to_number)
      : "me";
  return {
    id: row.id,
    direction: row.direction,
    from: row.from_number,
    to: row.to_number,
    fromLabel,
    toLabel,
    body: row.body,
    status: row.status,
    providerSid: row.provider_sid || null,
    createdAt: row.created_at,
  };
}

function rowToCall(accountId: string, row: any): CallRow {
  return {
    id: row.id,
    direction: row.direction,
    from: row.from_number,
    to: row.to_number,
    fromLabel: callerIdFor(accountId, row.from_number).label,
    toLabel:
      row.direction === "outbound"
        ? (getContactByPhone(accountId, row.to_number)?.name ?? row.to_number)
        : "me",
    status: row.status,
    durationSeconds: row.duration_seconds ?? null,
    transcript: row.transcript || null,
    recordingUrl: row.recording_url || null,
    providerSid: row.provider_sid || null,
    createdAt: row.created_at,
  };
}

function storeText(
  accountId: string,
  direction: "inbound" | "outbound",
  fromNumber: string,
  toNumber: string,
  body: string,
  status: string,
  providerSid: string | null,
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO texts (account_id, direction, from_number, to_number, body, status, provider_sid, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(accountId, direction, fromNumber, toNumber, body, status, providerSid, now);
}

function storeCall(
  accountId: string,
  direction: "inbound" | "outbound",
  fromNumber: string,
  toNumber: string,
  status: string,
  providerSid: string | null,
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO calls (account_id, direction, from_number, to_number, status, provider_sid, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(accountId, direction, fromNumber, toNumber, status, providerSid, now);
}

// --- Handlers (mounted by server.ts; see WIRING.md) ---

// GET /api/texts/status — configured or not, and the number (masked).
export async function getTextsStatus(_req: Request, _accountId: string): Promise<Response> {
  if (!twilioConfigured()) {
    return json({
      ok: false,
      error: "not_connected",
      configured: false,
      phoneNumber: null,
      message: NOT_CONNECTED_MESSAGE,
    });
  }
  return json({ ok: true, configured: true, phoneNumber: maskedTwilioNumber() });
}

// GET /api/texts — stored inbound/outbound texts for the account.
export async function listTexts(req: Request, accountId: string): Promise<Response> {
  if (!twilioConfigured()) return notConnected();
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50) || 50));
  const rows = db
    .query(`SELECT * FROM texts WHERE account_id = ? ORDER BY id DESC LIMIT ?`)
    .all(accountId, limit) as any[];
  return json({ ok: true, texts: rows.map((r) => rowToText(accountId, r)) });
}

// POST /api/texts/send — owner-tap send. Only to an approved contact.
// `body` is the JSON body server.ts already parsed (its readBody consumes
// the request, so the handler must not re-read it); when called without
// one, the handler reads the request itself.
export async function sendText(req: Request, accountId: string, body?: any): Promise<Response> {
  if (!twilioConfigured()) return notConnected();
  const parsed = body ?? (await readJsonBody(req));
  const to = String(parsed.to || "").trim();
  const text = String(parsed.body || "");
  if (!to) return bad("a phone number or email address is required", 400);
  if (!text.trim()) return bad("message required", 400);
  if (text.length > 1600) return bad("message too long", 400);
  const resolved = resolveApprovedContact(accountId, to);
  if ("error" in resolved) return json({ ok: false, error: resolved.error, message: resolved.message });
  const phone = toE164(resolved.phone);
  const r = await twilioPost("Messages.json", {
    From: twilioNumber(),
    To: phone,
    Body: text,
  });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      return json({
        ok: false,
        error: "provider_auth_failed",
        message: "Twilio didn't accept the account details. Check the account SID and auth token.",
      });
    }
    if (r.status === 0) {
      return json({
        ok: false,
        error: "provider_unreachable",
        message: "Couldn't reach Twilio. The text wasn't sent — try again in a moment.",
      });
    }
    console.error("Twilio send failed:", r.status, JSON.stringify(r.data || "").slice(0, 200));
    return json({
      ok: false,
      error: "send_failed",
      message: "The text didn't go through. Try again in a moment.",
    });
  }
  const sid = (r.data?.sid as string) || null;
  storeText(accountId, "outbound", twilioNumber(), phone, text, "sent", sid);
  return json({ ok: true, sent: true, messageSid: sid, to: phone, contactName: resolved.contact.name });
}

// POST /api/texts/incoming — Twilio webhook (form-encoded). Validates the
// Twilio signature when the token is present, stores the inbound text,
// and answers an empty TwiML response.
export async function incomingText(req: Request): Promise<Response> {
  const params = await readFormParams(req);
  if (!twilioConfigured()) return twiml("");
  const signature = req.headers.get("x-twilio-signature") || "";
  const valid = signatureUrlCandidates(req).some((u) =>
    validateTwilioSignature(u, params, signature),
  );
  if (!valid) {
    console.error("Twilio incoming text rejected: bad signature");
    return new Response("forbidden", { status: 403 });
  }
  const accountId = accountIdFromQuery(req);
  const from = String(params.From || "").trim();
  const to = String(params.To || "").trim();
  const textBody = String(params.Body || "");
  if (!accountId || !from) return twiml("");
  storeText(accountId, "inbound", from, to || twilioNumber(), textBody, "stored", (params.MessageSid as string) || null);
  return twiml("");
}

// GET /api/calls — the call log for the account.
export async function listCalls(req: Request, accountId: string): Promise<Response> {
  if (!twilioConfigured()) return notConnected();
  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50) || 50));
  const rows = db
    .query(`SELECT * FROM calls WHERE account_id = ? ORDER BY id DESC LIMIT ?`)
    .all(accountId, limit) as any[];
  return json({ ok: true, calls: rows.map((r) => rowToCall(accountId, r)) });
}

// POST /api/calls/dial — owner-tap outbound call. Only to an approved contact.
// `body` is the JSON body server.ts already parsed (see sendText).
export async function dialCall(req: Request, accountId: string, body?: any): Promise<Response> {
  if (!twilioConfigured()) return notConnected();
  const parsed = body ?? (await readJsonBody(req));
  const to = String(parsed.to || "").trim();
  if (!to) return bad("a phone number or email address is required", 400);
  const resolved = resolveApprovedContact(accountId, to);
  if ("error" in resolved) return json({ ok: false, error: resolved.error, message: resolved.message });
  const base = appUrl();
  if (!base) {
    return json({
      ok: false,
      error: "no_public_url",
      message:
        "The server needs its public address (APP_URL) set before it can place calls, so Twilio knows where to fetch the call instructions.",
    });
  }
  const phone = toE164(resolved.phone);
  const voiceUrl = `${base}/api/calls/voice?accountId=${encodeURIComponent(accountId)}`;
  const r = await twilioPost("Calls.json", { From: twilioNumber(), To: phone, Url: voiceUrl });
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      return json({
        ok: false,
        error: "provider_auth_failed",
        message: "Twilio didn't accept the account details. Check the account SID and auth token.",
      });
    }
    if (r.status === 0) {
      return json({
        ok: false,
        error: "provider_unreachable",
        message: "Couldn't reach Twilio. The call wasn't placed — try again in a moment.",
      });
    }
    console.error("Twilio dial failed:", r.status, JSON.stringify(r.data || "").slice(0, 200));
    return json({
      ok: false,
      error: "call_failed",
      message: "The call didn't go through. Try again in a moment.",
    });
  }
  const sid = (r.data?.sid as string) || null;
  storeCall(accountId, "outbound", twilioNumber(), phone, "initiated", sid);
  return json({ ok: true, placed: true, callSid: sid, to: phone, contactName: resolved.contact.name });
}

// POST /api/calls/voice — TwiML webhook for inbound calls (and the Url
// Twilio fetches for outbound dials): greet briefly, record a voicemail
// with transcription enabled.
export async function voiceWebhook(req: Request): Promise<Response> {
  const accountId = accountIdFromQuery(req);
  const params = await readFormParams(req);
  if (!twilioConfigured()) return twiml("");
  const from = String(params.From || "").trim();
  const to = String(params.To || "").trim();
  const callSid = String(params.CallSid || "").trim() || null;
  if (accountId && from) {
    // File the call before the recording lands; the transcription
    // callback updates this row.
    storeCall(accountId, "inbound", from, to || twilioNumber(), "in_progress", callSid);
  }
  const base = appUrl() || new URL(req.url).origin;
  const callback = `${base}/api/calls/voicemail${accountId ? `?accountId=${encodeURIComponent(accountId)}` : ""}`;
  return twiml(
    `<Say voice="alice">Hi, you've reached the Prism 5 line. Please leave a message after the tone, and we'll get back to you.</Say>` +
      `<Record transcribe="true" transcribeCallback="${escapeXml(callback)}" maxLength="120" />` +
      `<Hangup/>`,
  );
}

// POST /api/calls/voicemail — Twilio transcription callback. Stores the
// transcript on the call row, and as a message in the Prism thread so the
// Photon can read it and answer it like any other message.
export async function voicemailCallback(req: Request): Promise<Response> {
  const params = await readFormParams(req);
  if (!twilioConfigured()) return twiml("");
  const signature = req.headers.get("x-twilio-signature") || "";
  const valid = signatureUrlCandidates(req).some((u) =>
    validateTwilioSignature(u, params, signature),
  );
  if (!valid) {
    console.error("Twilio voicemail callback rejected: bad signature");
    return new Response("forbidden", { status: 403 });
  }
  const accountId = accountIdFromQuery(req);
  const callSid = String(params.CallSid || "").trim();
  const from = String(params.From || "").trim();
  const to = String(params.To || "").trim();
  const transcript = String(params.TranscriptionText || "").trim();
  const recordingUrl = String(params.RecordingUrl || "").trim() || null;
  const status = String(params.TranscriptionStatus || "").trim();
  if (!accountId) return twiml("");
  const now = new Date().toISOString();
  const existing = callSid
    ? (db
        .query(`SELECT * FROM calls WHERE account_id = ? AND provider_sid = ?`)
        .get(accountId, callSid) as any)
    : null;
  if (existing) {
    db.query(
      `UPDATE calls SET status = ?, transcript = ?, recording_url = ? WHERE account_id = ? AND provider_sid = ?`,
    ).run(status === "failed" ? "voicemail_failed" : "voicemail", transcript || null, recordingUrl, accountId, callSid);
  } else if (from) {
    db.query(
      `INSERT INTO calls (account_id, direction, from_number, to_number, status, transcript, recording_url, provider_sid, created_at)
       VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountId,
      from,
      to || twilioNumber(),
      status === "failed" ? "voicemail_failed" : "voicemail",
      transcript || null,
      recordingUrl,
      callSid || null,
      now,
    );
  }
  // The transcript lands as a message the Photon can read: in the Prism
  // thread, as a user message, labelled with who called. The Inboxes tab
  // can also surface it from GET /api/calls (see WIRING.md).
  if (transcript && from) {
    const label = callerIdFor(accountId, from).label;
    addMessage(
      accountId,
      "Prism",
      "user",
      `Voicemail from ${label} (${from}): ${transcript}`,
    );
  }
  return twiml("");
}
