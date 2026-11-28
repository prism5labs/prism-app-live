// Proactive checks, reminders, and push (Step 3 of the capability design).
//
// Three pieces that only work together:
//   1. A scheduler that wakes every 5 minutes and checks Gmail, texts, and
//      calendar for anything new.
//   2. Persistent storage (seen_state) so it remembers what it already saw
//      and never brings the same item twice.
//   3. Web Push (VAPID) so the owner gets a tap on their phone when something
//      needs a decision, through the service worker the app already has.
//
// The Photon-facing rule, from the design: checks only ever bring what needs
// a decision. Nothing is sent anywhere without the owner's tap. Push goes
// only to the owner's own subscribed devices, never to anyone else.
//
// This module owns its own tables (created at import, like db.ts) and reads
// its env vars directly from process.env, so the coordinator can wire it
// without touching config.ts. It never auto-starts: the coordinator calls
// startProactiveScheduler() once the server is up.
//
// Honest limits, stated here so no Photon ever claims otherwise:
//   - Texts (telephony.ts) and calendar (google.ts) checks are built: each
//     module exports checkChannelItems and this scheduler diffs the results
//     against seen_state. Texts only contain anything when Twilio is
//     configured on the server; calendar only when the owner has connected
//     Google Calendar. Unconfigured/unconnected channels return no items —
//     available, but quiet.
//   - On the free tier the process sleeps, so the scheduler only runs while
//     the server is awake, and seen-state lives on the ephemeral disk until
//     step 2's paid disk lands (see WIRING.md).
//   - Push needs VAPID keys in the environment. Without them, checks and
//     reminders still run and list; only the tap on the phone is missing.

import { addMessage, db, getNovaSettings, getOrCreateAccount, getOwned, ownsAtom } from "./db";
import { config } from "./config";
import { listInbox, connectedLabels, type GmailLabel } from "./gmail";

// --- Own tables (created at import, like db.ts) ---
db.exec(`
CREATE TABLE IF NOT EXISTS seen_state (
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  item_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (account_id, channel, item_id)
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT NOT NULL PRIMARY KEY,
  account_id TEXT NOT NULL,
  text TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders (account_id, done, remind_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  account_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, endpoint)
);
`);

// --- Small local helpers (server.ts has its own; this module must not
// depend on it, so it can be wired by the coordinator with one call) ---
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function accountIdFrom(req: Request, body: any): string {
  const fromBody = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (fromBody) return fromBody;
  const fromHeader = req.headers.get("x-account-id") || "";
  if (fromHeader.trim()) return fromHeader.trim();
  const url = new URL(req.url);
  return (url.searchParams.get("accountId") || "").trim();
}

function isValidAccountId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id);
}

// --- VAPID / Web Push configuration (from config.ts) ---
function vapidConfig(): { publicKey: string; privateKey: string; subject: string } {
  return {
    publicKey: config.vapidPublicKey,
    privateKey: config.vapidPrivateKey,
    subject: config.vapidSubject,
  };
}

export function pushConfigured(): boolean {
  const v = vapidConfig();
  return v.publicKey.length > 0 && v.privateKey.length > 0 && v.subject.length > 0;
}

// --- Seen-state storage ---
function alreadySeen(accountId: string, channel: string, itemId: string): boolean {
  const row = db
    .query(`SELECT 1 AS x FROM seen_state WHERE account_id = ? AND channel = ? AND item_id = ?`)
    .get(accountId, channel, itemId) as any;
  return !!row;
}

function markSeen(accountId: string, channel: string, itemId: string): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO seen_state (account_id, channel, item_id, seen_at) VALUES (?, ?, ?, ?)`,
  ).run(accountId, channel, itemId, now);
}

// --- Reminders ---
export type Reminder = {
  id: string;
  accountId: string;
  text: string;
  remindAt: string;
  done: boolean;
  createdAt: string;
};

function rowToReminder(row: any): Reminder {
  return {
    id: row.id,
    accountId: row.account_id,
    text: row.text,
    remindAt: row.remind_at,
    done: row.done === 1,
    createdAt: row.created_at,
  };
}

export function listReminders(accountId: string): Reminder[] {
  const rows = db
    .query(`SELECT * FROM reminders WHERE account_id = ? ORDER BY remind_at ASC`)
    .all(accountId) as any[];
  return rows.map(rowToReminder);
}

export function createReminder(accountId: string, text: string, remindAt: string): Reminder {
  const now = new Date().toISOString();
  const id = `rm_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  db.query(
    `INSERT INTO reminders (id, account_id, text, remind_at, done, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
  ).run(id, accountId, text, remindAt, now);
  return rowToReminder(
    db.query(`SELECT * FROM reminders WHERE id = ?`).get(id) as any,
  );
}

export function markReminderDone(accountId: string, id: string): Reminder | null {
  db.query(`UPDATE reminders SET done = 1 WHERE account_id = ? AND id = ?`).run(accountId, id);
  const row = db
    .query(`SELECT * FROM reminders WHERE account_id = ? AND id = ?`)
    .get(accountId, id) as any;
  return row ? rowToReminder(row) : null;
}

// Reminders that have come due and have not been surfaced yet. A due
// reminder is recorded in seen_state (channel "reminder") the first time a
// check cycle surfaces it, so the next cycle does not bring it again — but
// it stays done=0 until the owner marks it done. There is no delivery
// channel invented here: surfacing means "listed in the check result and
// pushed to the owner's own devices if push is configured".
function dueReminders(accountId: string, nowIso: string): Reminder[] {
  const rows = db
    .query(
      `SELECT * FROM reminders WHERE account_id = ? AND done = 0 AND remind_at <= ? ORDER BY remind_at ASC`,
    )
    .all(accountId, nowIso) as any[];
  return rows.map(rowToReminder);
}

// --- Push subscriptions ---
export type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export function listPushSubscriptions(accountId: string): PushSubscription[] {
  const rows = db
    .query(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE account_id = ?`)
    .all(accountId) as any[];
  return rows.map((r) => ({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }));
}

export function storePushSubscription(accountId: string, sub: PushSubscription): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO push_subscriptions (account_id, endpoint, p256dh, auth, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at`,
  ).run(accountId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, now, now);
}

function deletePushSubscription(accountId: string, endpoint: string): void {
  db.query(`DELETE FROM push_subscriptions WHERE account_id = ? AND endpoint = ?`).run(
    accountId,
    endpoint,
  );
}

// Turning phone taps off means off: after a reinstall the browser has no
// local subscription to name, so the only way to clear the orphaned server
// row is to delete every stored subscription for the account.
export function deleteAllPushSubscriptions(accountId: string): void {
  db.query(`DELETE FROM push_subscriptions WHERE account_id = ?`).run(accountId);
}

// --- Web Push crypto (WebCrypto only, zero dependencies) ---
// Implements RFC 8291 (aes128gcm) + RFC 8292 (VAPID, ES256 JWT).

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = norm + "=".repeat((4 - (norm.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data as BufferSource);
  return new Uint8Array(sig);
}

// HKDF-Extract(salt, ikm) -> PRK (RFC 5869).
async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt, ikm);
}

// HKDF-Expand(prk, info, length) -> output (RFC 5869).
async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let prev: Uint8Array = new Uint8Array(0);
  let filled = 0;
  let counter = 1;
  while (filled < length) {
    const input = new Uint8Array(prev.length + info.length + 1);
    input.set(prev, 0);
    input.set(info, prev.length);
    input[input.length - 1] = counter;
    prev = await hmacSha256(prk, input);
    const take = Math.min(prev.length, length - filled);
    out.set(prev.subarray(0, take), filled);
    filled += take;
    counter += 1;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// WebCrypto ECDSA returns a DER signature in Node, but Bun returns raw
// r || s (64 bytes). VAPID wants raw, so accept both: a 64-byte value that
// does not start with the DER SEQUENCE tag is already raw.
function derToRawSig(der: Uint8Array): Uint8Array {
  if (der.length === 64 && der[0] !== 0x30) return der.slice();
  // DER: 0x30 len 0x02 lenR r... 0x02 lenS s...
  let off = 2; // skip SEQUENCE tag + length (short form; ES256 sigs are < 128 bytes)
  if (der[1] & 0x80) off = 2 + (der[1] & 0x7f);
  if (der[off] !== 0x02) throw new Error("bad ECDSA signature");
  const lenR = der[off + 1];
  const r = der.slice(off + 2, off + 2 + lenR);
  off = off + 2 + lenR;
  if (der[off] !== 0x02) throw new Error("bad ECDSA signature");
  const lenS = der[off + 1];
  const s = der.slice(off + 2, off + 2 + lenS);
  const out = new Uint8Array(64);
  const strip = (v: Uint8Array): Uint8Array => (v.length > 32 ? v.slice(v.length - 32) : v);
  const r32 = strip(r);
  const s32 = strip(s);
  out.set(r32, 32 - r32.length);
  out.set(s32, 64 - s32.length);
  return out;
}

async function vapidJwt(endpoint: string): Promise<string> {
  const v = vapidConfig();
  const origin = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: v.subject,
  };
  const enc = new TextEncoder();
  const unsigned = `${b64urlEncode(enc.encode(JSON.stringify(header)))}.${b64urlEncode(enc.encode(JSON.stringify(payload)))}`;
  const pubBytes = b64urlDecode(v.publicKey);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) {
    throw new Error("VAPID_PUBLIC_KEY must be the base64url uncompressed P-256 point (65 bytes)");
  }
  const privBytes = b64urlDecode(v.privateKey);
  if (privBytes.length !== 32) {
    throw new Error("VAPID_PRIVATE_KEY must be the base64url P-256 scalar (32 bytes)");
  }
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pubBytes.slice(1, 33)),
    y: b64urlEncode(pubBytes.slice(33, 65)),
    d: b64urlEncode(privBytes),
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sigDer = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(unsigned),
    ),
  );
  return `${unsigned}.${b64urlEncode(derToRawSig(sigDer))}`;
}

// Encrypt one payload for one subscription (RFC 8291 aes128gcm) and POST it
// to the push service. Returns "sent", "gone" (410/404: subscription dead,
// delete it), or "failed".
async function sendPushToSubscription(
  sub: PushSubscription,
  payload: string,
): Promise<"sent" | "gone" | "failed"> {
  const v = vapidConfig();
  try {
    const payloadBytes = new TextEncoder().encode(payload);
    if (payloadBytes.length > 4078) return "failed";
    const receiverKey = b64urlDecode(sub.keys.p256dh);
    const authSecret = b64urlDecode(sub.keys.auth);
    if (receiverKey.length !== 65 || authSecret.length !== 16) return "failed";

    // Ephemeral ECDH key pair for this message.
    const ephemeral = await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const senderPub = new Uint8Array(
      await crypto.subtle.exportKey("raw", ephemeral.publicKey),
    );
    const receiverPubKey = await crypto.subtle.importKey(
      "raw",
      receiverKey as BufferSource,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const sharedSecret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "ECDH", public: receiverPubKey },
        ephemeral.privateKey,
        256,
      ),
    );

    const salt = crypto.getRandomValues(new Uint8Array(16));
    // RFC 8291 §3.3-3.4: PRK = HKDF-Extract(auth, ECDH secret); then the
    // random salt drives a second HKDF for the key and nonce.
    const prk = await hkdfExtract(authSecret, sharedSecret);
    const cekInfo = concat(
      new TextEncoder().encode("Content-Encoding: aes128gcm"),
      new Uint8Array([0]),
      receiverKey,
      senderPub,
    );
    const nonceInfo = concat(
      new TextEncoder().encode("Content-Encoding: nonce"),
      new Uint8Array([0]),
      receiverKey,
      senderPub,
    );
    // The random salt drives a second Extract over the PRK (RFC 8291:
    // PRK2 = HKDF-Extract(salt, PRK)), then Expand for the key and nonce.
    const prk2 = await hkdfExtract(salt, prk);
    const cekSalted = await hkdfExpand(prk2, cekInfo, 16);
    const nonce = await hkdfExpand(prk2, nonceInfo, 12);

    const cekKey = await crypto.subtle.importKey(
      "raw",
      cekSalted as BufferSource,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    // Plaintext is the payload plus the 0x02 padding delimiter (RFC 8291:
    // at least the delimiter; no extra padding added here).
    const plaintext = concat(payloadBytes, new Uint8Array([0x02]));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
        cekKey,
        plaintext as BufferSource,
      ),
    );
    // Body: salt || ciphertext length (4 bytes BE) || sender key || ciphertext.
    const lenBytes = new Uint8Array(4);
    new DataView(lenBytes.buffer).setUint32(0, ciphertext.length, false);
    const body = concat(salt, lenBytes, senderPub, ciphertext);

    const jwt = await vapidJwt(sub.endpoint);
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: "86400",
        Urgency: "normal",
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        Encryption: `salt=${b64urlEncode(salt)}`,
        "Crypto-Key": `dh=${b64urlEncode(senderPub)}; p256ecdsa=${v.publicKey}`,
        Authorization: `vapid t=${jwt}, k=${v.publicKey}`,
      },
      body: body as unknown as BodyInit,
    });
    if (res.status === 201 || res.status === 200 || res.status === 202) return "sent";
    if (res.status === 404 || res.status === 410) return "gone";
    console.error("push send failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return "failed";
  } catch (e) {
    console.error("push send error:", e);
    return "failed";
  }
}

// Send a push to every subscribed device for one account. Only ever called
// with the owner's own devices, and only to surface what a check found.
// Returns counts; a dead subscription (410/404) is removed.
// The face that goes with a Prism push: Prism's own portrait, same-origin
// so the phone can fetch it. Absolute when APP_URL is set, else the
// root-relative path (the service worker resolves it against the origin).
const PRISM_PUSH_IMAGE_PATH = "/supernovas/Prism.webp";
function pushImageUrl(path: string): string {
  const base = (config.appUrl || "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

export async function sendPush(
  accountId: string,
  title: string,
  body: string,
  image?: string,
): Promise<{ configured: boolean; attempted: number; sent: number; failed: number; removed: number }> {
  const result = { configured: pushConfigured(), attempted: 0, sent: 0, failed: 0, removed: 0 };
  if (!result.configured) return result;
  const subs = listPushSubscriptions(accountId);
  const payload = JSON.stringify({ title, body, ...(image ? { image } : {}) });
  for (const sub of subs) {
    result.attempted += 1;
    const outcome = await sendPushToSubscription(sub, payload);
    if (outcome === "sent") result.sent += 1;
    else if (outcome === "gone") {
      result.removed += 1;
      deletePushSubscription(accountId, sub.endpoint);
    } else result.failed += 1;
  }
  return result;
}

// --- Channel checks ---
// Each check returns the new items it found (already diffed against
// seen_state). A check never throws: failures are reported, not raised.

export type NewItem = {
  channel: string;
  id: string;
  summary: string;
  detail?: string;
};

async function checkGmail(accountId: string): Promise<{ checked: boolean; newItems: NewItem[]; error?: string }> {
  const out: NewItem[] = [];
  try {
    const labels = connectedLabels(accountId);
    if (!labels.length) return { checked: false, newItems: [] };
    for (const { label } of labels) {
      try {
        const r = await listInbox(accountId, label as GmailLabel, 10);
        if (!r.connected) continue;
        for (const m of r.messages) {
          const channel = `gmail:${label}`;
          if (alreadySeen(accountId, channel, m.id)) continue;
          markSeen(accountId, channel, m.id);
          out.push({
            channel,
            id: m.id,
            summary: m.subject,
            detail: `${m.from} — ${m.snippet}`,
          });
        }
      } catch (e) {
        console.error(`proactive gmail check failed (${label}):`, e);
      }
    }
    return { checked: true, newItems: out };
  } catch (e) {
    console.error("proactive gmail check failed:", e);
    return { checked: false, newItems: out, error: "gmail_check_failed" };
  }
}

// Texts (telephony.ts) and calendar (google.ts) implement the channel
// contract: each exports
//   checkChannelItems(accountId: string): Promise<Array<{ id, summary, detail? }>>
// returning recent items for that channel; this scheduler diffs them against
// seen_state itself. A module that is missing or does not export the
// function is reported unavailable, honestly.
// The dynamic import uses a plain string specifier on purpose: TypeScript
// does not try to resolve it at typecheck time, and the try/catch below
// turns a missing module into "not built" instead of a crash.
async function checkOptionalChannel(
  accountId: string,
  channel: string,
  modulePath: string,
): Promise<{ checked: boolean; available: boolean; newItems: NewItem[] }> {
  try {
    const spec: string = modulePath;
    const mod: any = await import(spec);
    const fn = mod?.checkChannelItems;
    if (typeof fn !== "function") {
      return { checked: false, available: false, newItems: [] };
    }
    const items = (await fn(accountId)) as Array<{ id: string; summary: string; detail?: string }>;
    const out: NewItem[] = [];
    for (const item of items || []) {
      if (!item || typeof item.id !== "string") continue;
      if (alreadySeen(accountId, channel, item.id)) continue;
      markSeen(accountId, channel, item.id);
      out.push({ channel, id: item.id, summary: item.summary || item.id, detail: item.detail });
    }
    return { checked: true, available: true, newItems: out };
  } catch {
    return { checked: false, available: false, newItems: [] };
  }
}

// --- Findings into the owner's Photon thread ---
// When a cycle finds something new, the same findings are also written
// into the owner's first owned Photon's thread as ONE assistant message,
// so they are waiting in the conversation the owner actually reads — not
// only as a phone tap. This is a factual briefing composed here by the
// scheduler, not a brain-generated reply, so the wording stays plain.
// No owned Photon means no thread delivery (push behaviour unchanged),
// and a delivery failure never breaks the cycle.
function deliverBriefingToPhotonThread(accountId: string, items: NewItem[]): void {
  try {
    const photon = getOwned(accountId).photons[0];
    if (!photon) return;
    const lines = items
      .slice(0, 10)
      .map((i) => (i.detail ? `• ${i.summary} — ${i.detail}` : `• ${i.summary}`));
    addMessage(accountId, photon, "assistant", `While you were away:\n${lines.join("\n")}`);
  } catch (e) {
    console.error(`proactive thread briefing failed for ${accountId}:`, e);
  }
}

// --- Nova check-ins (Ruby) and getting-started nudges (Vera) ---
// Template lines, written here — NOT brain-generated. Two-three variants
// each, rotated by calendar date. Delivery is gated by seen_state with a
// dated id, so a restart can never double-send a day's message.
const RUBY_CHECK_INS = [
  "Hi, it's Ruby. Just checking in — how is your day going? If there's someone you've been meaning to reach out to, or anything I can help you line up, tell me and we'll take it from there.",
  "Hello, Ruby here. A quick check-in: how are you doing today? If a note, a birthday, or a catch-up has been sitting on your mind, I can help you get it drafted.",
  "Hi, it's Ruby, checking in. How's the day treating you? Say the word if you'd like a hand staying in touch with anyone who matters.",
];
const VERA_NUDGES = [
  "Hello, I'm Vera. One small first step is enough for today — pick the tiniest piece of the thing you've been putting off, and let's just do that piece together.",
  "Hi, Vera here. You don't need the whole staircase today, just the first step: what's one small thing we could start, right now, in the next few minutes?",
  "Hello, it's Vera. A gentle nudge: choose one thing that's been waiting, shrink it to its smallest first step, and tell me what it is — we'll begin there.",
];

function chicagoDate(now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function variantFor<T>(variants: T[], date: string): T {
  const day = Math.floor(Date.parse(`${date}T12:00:00Z`) / 86_400_000);
  return variants[Math.abs(day) % variants.length];
}

// The same ownership test getNovaSettings' defaults rely on: free code,
// any Atom, or a Nova / Supernova / Satellite product.
function hasNovaAccess(accountId: string): boolean {
  const owned = getOwned(accountId);
  const a = getOrCreateAccount(accountId);
  return (
    a.free_code ||
    owned.atoms.length > 0 ||
    owned.products.includes("nova") ||
    owned.products.includes("supernova") ||
    owned.products.includes("satellite")
  );
}

function ownsAtomOrNovaProduct(accountId: string, atom: string): boolean {
  if (ownsAtom(accountId, atom)) return true;
  const products = getOwned(accountId).products;
  return products.includes("nova") || products.includes("supernova") || products.includes("satellite");
}

function seenCount(accountId: string, channel: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM seen_state WHERE account_id = ? AND channel = ?`)
    .get(accountId, channel) as { n: number } | null;
  return row?.n ?? 0;
}

// Deliver today's Ruby check-in and/or Vera nudge for one account.
// Returns what was delivered. Never throws: a sender failure must not
// break the check cycle.
export async function runNovaSenders(
  accountId: string,
): Promise<{ checkIn: boolean; nudge: boolean }> {
  const out = { checkIn: false, nudge: false };
  try {
    if (!hasNovaAccess(accountId)) return out;
    const settings = getNovaSettings(accountId);
    const date = chicagoDate();

    if (settings.checkIns && ownsAtomOrNovaProduct(accountId, "Ruby")) {
      if (!alreadySeen(accountId, "nova-checkin", date)) {
        const text = variantFor(RUBY_CHECK_INS, date);
        addMessage(accountId, "Ruby", "assistant", text);
        markSeen(accountId, "nova-checkin", date);
        out.checkIn = true;
        // A phone tap only when push is configured and the owner has a
        // subscribed device; sendPush handles both checks itself.
        await sendPush(accountId, "Ruby", "Ruby checked in with you.");
      }
    }

    if (settings.gettingStartedNudges && ownsAtomOrNovaProduct(accountId, "Vera")) {
      // At most once per day, and only on the first 3 distinct days.
      if (!alreadySeen(accountId, "nova-nudge", date) && seenCount(accountId, "nova-nudge") < 3) {
        const text = variantFor(VERA_NUDGES, date);
        addMessage(accountId, "Vera", "assistant", text);
        markSeen(accountId, "nova-nudge", date);
        out.nudge = true;
        await sendPush(accountId, "Vera", "Vera has a small first step for you.");
      }
    }
  } catch (e) {
    console.error(`proactive nova senders failed for ${accountId}:`, e);
  }
  return out;
}

// --- One check cycle for one account ---
export type CheckResult = {
  accountId: string;
  checkedAt: string;
  gmail: { checked: boolean; newItems: NewItem[]; error?: string };
  texts: { checked: boolean; available: boolean; newItems: NewItem[] };
  calendar: { checked: boolean; available: boolean; newItems: NewItem[] };
  remindersDue: NewItem[];
  newTotal: number;
  push: { configured: boolean; attempted: number; sent: number; failed: number; removed: number } | null;
};

export async function runCheckCycle(accountId: string): Promise<CheckResult> {
  const checkedAt = new Date().toISOString();
  const gmail = await checkGmail(accountId);
  const texts = await checkOptionalChannel(accountId, "texts", "./telephony");
  const calendar = await checkOptionalChannel(accountId, "calendar", "./google");

  // Reminders that came due: surfaced once (recorded in seen_state), still
  // undone until the owner marks them done.
  const remindersDue: NewItem[] = [];
  for (const r of dueReminders(accountId, checkedAt)) {
    if (alreadySeen(accountId, "reminder", r.id)) continue;
    markSeen(accountId, "reminder", r.id);
    remindersDue.push({ channel: "reminder", id: r.id, summary: r.text, detail: `due ${r.remindAt}` });
  }

  const newTotal =
    gmail.newItems.length + texts.newItems.length + calendar.newItems.length + remindersDue.length;

  // The tap on the phone: one summary push per cycle, only if something new
  // turned up, only to the owner's own subscribed devices.
  let push: CheckResult["push"] = null;
  if (newTotal > 0) {
    const summary =
      newTotal === 1
        ? gmail.newItems[0]?.summary || texts.newItems[0]?.summary || calendar.newItems[0]?.summary || remindersDue[0]?.summary || "Something needs you."
        : `${newTotal} things need your attention.`;
    push = await sendPush(accountId, "Prism 5", summary, pushImageUrl(PRISM_PUSH_IMAGE_PATH));
    // The same findings, waiting in the owner's Photon thread.
    deliverBriefingToPhotonThread(accountId, [
      ...gmail.newItems,
      ...texts.newItems,
      ...calendar.newItems,
      ...remindersDue,
    ]);
  }

  // Nova check-in / getting-started nudges for this account (gated
  // internally on Nova access and the owner's Nova settings; a failure
  // there never breaks this cycle — runNovaSenders catches its own).
  await runNovaSenders(accountId);

  return { accountId, checkedAt, gmail, texts, calendar, remindersDue, newTotal, push };
}

// --- Scheduler state ---
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let lastCheckAt: string | null = null;
let totalNewFound = 0;
let lastCycleSummary: { checkedAt: string; accounts: number; newTotal: number } | null = null;

function schedulerAccountIds(): string[] {
  const rows = db
    .query(
      `SELECT account_id FROM gmail_accounts
       UNION SELECT account_id FROM reminders WHERE done = 0
       UNION SELECT account_id FROM push_subscriptions
       UNION SELECT account_id FROM owned WHERE kind IN ('atom', 'product')
       UNION SELECT account_id FROM nova_settings`,
    )
    .all() as { account_id: string }[];
  return rows.map((r) => r.account_id);
}

export async function runSchedulerCycle(): Promise<void> {
  const startedAt = new Date().toISOString();
  const accounts = schedulerAccountIds();
  let newTotal = 0;
  for (const accountId of accounts) {
    try {
      const result = await runCheckCycle(accountId);
      newTotal += result.newTotal;
      if (result.newTotal > 0) {
        console.log(
          `proactive: ${accountId}: ${result.newTotal} new (${result.gmail.newItems.length} gmail, ${result.texts.newItems.length} texts, ${result.calendar.newItems.length} calendar, ${result.remindersDue.length} reminders due)`,
        );
      }
    } catch (e) {
      // One account's cycle must never kill the scheduler.
      console.error(`proactive cycle failed for ${accountId}:`, e);
    }
  }
  lastCheckAt = startedAt;
  totalNewFound += newTotal;
  lastCycleSummary = { checkedAt: startedAt, accounts: accounts.length, newTotal };
  console.log(`proactive: cycle done at ${startedAt}, ${accounts.length} account(s), ${newTotal} new`);
}

export function startProactiveScheduler(): void {
  if (timer) return;
  // One cycle right away so the first check does not wait 5 minutes, then
  // every 5 minutes after that. Never throws: each cycle is try/catch'd.
  runSchedulerCycle().catch((e) => console.error("proactive initial cycle failed:", e));
  timer = setInterval(() => {
    runSchedulerCycle().catch((e) => console.error("proactive cycle failed:", e));
  }, CHECK_INTERVAL_MS);
  console.log(`proactive: scheduler started (every ${CHECK_INTERVAL_MS / 60000} minutes)`);
}

export function stopProactiveScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("proactive: scheduler stopped");
  }
}

export function schedulerRunning(): boolean {
  return timer !== null;
}

// --- Route handler ---
// The coordinator mounts this from server.ts handleApi before the final
// 404: `const proactive = await handleProactiveApi(req, path); if (proactive)
// return proactive;`. It returns null for paths it does not own.
export async function handleProactiveApi(req: Request, path: string): Promise<Response | null> {
  const url = new URL(req.url);
  const method = req.method;

  // GET /api/proactive/status — scheduler state, last check, push state.
  if (path === "/api/proactive/status" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    const subscribed = accountId && isValidAccountId(accountId)
      ? listPushSubscriptions(accountId).length
      : 0;
    return json({
      ok: true,
      scheduler: { running: schedulerRunning(), intervalMinutes: CHECK_INTERVAL_MS / 60000, lastCheckAt, totalNewFound, lastCycle: lastCycleSummary },
      push: { configured: pushConfigured(), subscribed, publicKey: pushConfigured() ? vapidConfig().publicKey : null },
      channels: {
        gmail: true,
        texts: true,
        calendar: true,
        note: "Texts and calendar checks are built. Texts only contain anything when Twilio is configured on the server, and calendar only when the owner has connected Google Calendar; otherwise those channels are available but quiet.",
      },
    });
  }

  // POST /api/proactive/check — one manual check cycle for the caller.
  if (path === "/api/proactive/check" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const result = await runCheckCycle(accountId);
    totalNewFound += result.newTotal;
    lastCheckAt = result.checkedAt;
    return json({ ok: true, ...result });
  }

  // GET /api/reminders — the caller's reminders.
  if (path === "/api/reminders" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json({ ok: true, reminders: listReminders(accountId) });
  }

  // POST /api/reminders — create one (text, remind_at).
  if (path === "/api/reminders" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const text = String(body.text || "").trim();
    const remindAtRaw = String(body.remind_at || body.remindAt || "").trim();
    if (!text) return bad("text required", 400);
    if (text.length > 500) return bad("text too long", 400);
    const remindAtMs = Date.parse(remindAtRaw);
    if (!remindAtRaw || Number.isNaN(remindAtMs)) return bad("remind_at required (ISO date)", 400);
    const reminder = createReminder(accountId, text, new Date(remindAtMs).toISOString());
    return json({ ok: true, reminder }, 201);
  }

  // POST /api/reminders/:id/done — mark done.
  const doneMatch = path.match(/^\/api\/reminders\/([A-Za-z0-9_-]+)\/done$/);
  if (doneMatch && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const reminder = markReminderDone(accountId, doneMatch[1]);
    if (!reminder) return bad("reminder not found", 404);
    return json({ ok: true, reminder });
  }

  // POST /api/push/subscribe — store the browser's push subscription.
  if (path === "/api/push/subscribe" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const sub = body.subscription || body;
    const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint.trim() : "";
    const p256dh = typeof sub?.keys?.p256dh === "string" ? sub.keys.p256dh.trim() : "";
    const auth = typeof sub?.keys?.auth === "string" ? sub.keys.auth.trim() : "";
    if (!endpoint.startsWith("https://")) return bad("subscription endpoint required", 400);
    if (!p256dh || !auth) return bad("subscription keys required", 400);
    storePushSubscription(accountId, { endpoint, keys: { p256dh, auth } });
    return json({ ok: true, subscribed: true, pushConfigured: pushConfigured() });
  }

  // POST /api/push/unsubscribe — delete the stored push subscription(s).
  // With an endpoint, only that device's row goes; with no endpoint, every
  // stored subscription for the account goes — that is what "turn phone
  // taps off" means after a reinstall, when the browser has no local
  // subscription left to name. Same auth as /api/push/subscribe.
  if (path === "/api/push/unsubscribe" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const sub = body.subscription || body;
    const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint.trim() : "";
    if (endpoint) deletePushSubscription(accountId, endpoint);
    else deleteAllPushSubscriptions(accountId);
    const remaining = listPushSubscriptions(accountId);
    return json({ ok: true, subscribed: remaining.length > 0, subscriptions: remaining.length });
  }

  // GET /api/push/status — is push configured, and is this device subscribed?
  if (path === "/api/push/status" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const subs = listPushSubscriptions(accountId);
    return json({
      ok: true,
      configured: pushConfigured(),
      subscribed: subs.length > 0,
      subscriptions: subs.length,
      publicKey: pushConfigured() ? vapidConfig().publicKey : null,
      note: pushConfigured()
        ? undefined
        : "Push is not configured on this server yet. It needs VAPID keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT). Checks and reminders still run without them.",
    });
  }

  return null;
}
