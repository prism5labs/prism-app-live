// Messenger, Step 9 — Facebook Page messaging only (Meta Graph API).
//
// The honest limit, first: Meta offers a messaging API for Facebook Pages
// (business pages), not for personal Messenger accounts. There is no
// supported way to connect a personal Messenger account, and this module
// does not invent one. What it does:
//
//   - Read and send messages on a Page the owner runs, through the Graph API.
//   - Receive incoming Page messages on a webhook and store them locally,
//     so the Photon can read them. It never auto-replies; the Photon drafts
//     and the owner taps send, like every other channel.
//   - Say so plainly in every status answer: personal Messenger has no
//     supported API and is not connected by this module. For personal
//     threads the path stays paste-in: the owner pastes the messages into
//     chat and the Photon reads them there.
//
// Env (read from process.env at call time, so the server starts fine
// without them; the coordinator consolidates these into config.ts at merge):
//   META_PAGE_ID               the Facebook Page id, from the Meta developer app
//   META_PAGE_ACCESS_TOKEN     a Page access token for that Page, from the Meta developer app
//   META_WEBHOOK_VERIFY_TOKEN  a token Neil/Calyn choose; Meta sends it back when verifying the webhook
// Nothing secret is committed: no token value lives in this repo.
//
// Graph API version pinned to v26.0 (current as of Nov 2026; check Meta's
// changelog before changing it). Plain fetch only, zero dependencies,
// same pattern as src/server/gmail.ts.

import { db, setFacebookPage, getFacebookPageToken, listFacebookPages, deleteFacebookPage } from "./db";
import { config } from "./config";

const GRAPH_BASE = "https://graph.facebook.com/v26.0";

// The Page id, token, and webhook verify token, from config.ts.
function pageId(): string {
  return config.metaPageId.trim();
}
function pageAccessToken(): string {
  return config.metaPageAccessToken.trim();
}
function webhookVerifyToken(): string {
  return config.metaWebhookVerifyToken.trim();
}

// Resolve the token and Page id for a Graph call. A Page connected from
// the app (accountId + pageId) uses its own stored token; anything else
// uses the server's Page from the env vars. The token is only ever read
// server-side and is never sent back to the client.
function resolvePage(accountId: string | null, pageIdArg: string | null): { token: string; pageId: string } {
  if (accountId && pageIdArg) {
    const t = getFacebookPageToken(accountId, pageIdArg);
    if (t) return { token: t, pageId: pageIdArg };
  }
  return { token: pageAccessToken(), pageId: pageId() };
}

export function messengerConfigured(): boolean {
  return pageId().length > 0 && pageAccessToken().length > 0;
}

// Personal Messenger, in plain words, wherever a status answer goes.
export const PERSONAL_MESSENGER_NOTE =
  "Personal Messenger has no supported API: Meta offers messaging for Facebook Pages (business pages) only, so a personal Messenger account cannot be connected by this module. For personal threads, paste the messages into chat and your Supernova will read them there.";

export type MessengerStatus = {
  ok: boolean;
  configured: boolean;
  page: boolean;
  pageId: string | null;
  pageIdSet: boolean;
  pageAccessTokenSet: boolean;
  webhookVerifyTokenSet: boolean;
  personalMessenger: {
    connected: boolean;
    note: string;
  };
  message: string;
};

export function messengerStatus(): MessengerStatus {
  const configured = messengerConfigured();
  return {
    ok: true,
    configured,
    page: configured,
    pageId: pageId() || null,
    pageIdSet: pageId().length > 0,
    pageAccessTokenSet: pageAccessToken().length > 0,
    webhookVerifyTokenSet: webhookVerifyToken().length > 0,
    personalMessenger: { connected: false, note: PERSONAL_MESSENGER_NOTE },
    message: configured
      ? "Facebook Page messaging is connected. Personal Messenger is not connected — there is no supported API for it."
      : "Facebook Page messaging is not connected yet — set META_PAGE_ID and META_PAGE_ACCESS_TOKEN. Personal Messenger is not connected either — there is no supported API for it.",
  };
}

// --- Pages connected from the app ---
//
// A customer connects their own Facebook Page by pasting a Page access
// token (from Meta's developer console, their Page's settings). The token
// is tested against Graph first — GET /me?fields=id,name — so a wrong or
// expired token is refused before anything is stored. The token is stored
// in SQLite the same way Gmail refresh tokens are, and it is never sent
// back to the client: the app only ever sees the Page id and name.
// Messages that arrive on a Page still come in through the server's
// webhook (the server's Page); connecting here lets the owner read
// threads and reply from the app on their own Page.
export async function connectPage(
  accountId: string,
  token: string,
): Promise<
  | { ok: true; pageId: string; pageName: string }
  | { ok: false; error: string; message?: string }
> {
  const t = String(token || "").trim();
  if (!t || /\s/.test(t)) return { ok: false, error: "bad_token" };
  const r = await graphGet("/me", { fields: "id,name" }, t);
  if (!r.ok) {
    return {
      ok: false,
      error: "token_rejected",
      message: r.error?.message || "Meta did not accept that token.",
    };
  }
  const pageIdVal = String(r.data?.id || "").trim();
  const pageName = String(r.data?.name || "").trim();
  if (!pageIdVal) return { ok: false, error: "token_rejected", message: "Meta did not return a Page for that token." };
  setFacebookPage(accountId, pageIdVal, pageName || pageIdVal, t);
  return { ok: true, pageId: pageIdVal, pageName: pageName || pageIdVal };
}

export function listConnectedPages(accountId: string): { pageId: string; pageName: string; createdAt: string }[] {
  return listFacebookPages(accountId);
}

export function disconnectPage(accountId: string, pageIdArg: string): void {
  deleteFacebookPage(accountId, String(pageIdArg || "").trim());
}

export type MessengerThread = {
  id: string;
  participants: { id: string; name: string }[];
  snippet: string;
  updatedTime: string;
  unreadCount?: number;
};

export type MessengerMessage = {
  id: string;
  from: { id: string; name?: string };
  text: string;
  createdTime: string;
};

// --- Local storage: incoming Page messages, from the webhook ---
//
// A webhook payload carries no conversation id: the thread is the person
// writing to the Page, so conversation_id is that sender's Page-scoped id
// (PSID). Outbound sends store the same way, with the sender id being the
// Page id, so the local history for a thread is whole. The Graph API stays
// the source for live reads; this table is the record of what arrived while
// the app was running.
db.exec(`
CREATE TABLE IF NOT EXISTS messenger_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  message_id TEXT UNIQUE,
  sender_id TEXT NOT NULL,
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messenger_messages_conversation
  ON messenger_messages (conversation_id, id);
`);

export type StoredMessengerMessage = {
  id: number;
  conversationId: string;
  messageId: string | null;
  senderId: string;
  text: string;
  timestamp: string;
  receivedAt: string;
};

function rowToStored(row: any): StoredMessengerMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id || null,
    senderId: row.sender_id,
    text: row.text,
    timestamp: row.timestamp,
    receivedAt: row.received_at,
  };
}

export function storeMessengerMessage(
  conversationId: string,
  senderId: string,
  text: string,
  timestamp: string,
  messageId?: string | null,
): StoredMessengerMessage | null {
  const receivedAt = new Date().toISOString();
  let inserted = false;
  try {
    // INSERT OR IGNORE + changes: a redelivered Meta message (same mid)
    // is a duplicate, not a new store — report it as such, don't count it.
    const info = db.query(
      `INSERT OR IGNORE INTO messenger_messages
         (conversation_id, message_id, sender_id, text, timestamp, received_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(conversationId, messageId || null, senderId, text, timestamp, receivedAt);
    inserted = info.changes > 0;
  } catch (e) {
    console.error("messenger store failed:", e);
    return null;
  }
  if (!inserted) return null;
  const row = db
    .query(
      `SELECT * FROM messenger_messages
        WHERE conversation_id = ? AND sender_id = ? AND timestamp = ?
        ORDER BY id DESC LIMIT 1`,
    )
    .get(conversationId, senderId, timestamp) as any;
  return row ? rowToStored(row) : null;
}

export function listStoredMessages(
  conversationId: string,
  limit = 50,
): StoredMessengerMessage[] {
  const rows = db
    .query(
      `SELECT * FROM messenger_messages
        WHERE conversation_id = ? ORDER BY id ASC LIMIT ?`,
    )
    .all(conversationId, Math.max(1, Math.min(200, Math.floor(limit)))) as any[];
  return rows.map(rowToStored);
}

// --- Graph API helpers (plain fetch, Bearer token, no SDK) ---

type GraphError = { code?: number; subcode?: number; message: string; type?: string };

async function graphGet(
  path: string,
  params: Record<string, string>,
  tokenOverride?: string,
): Promise<{ ok: true; data: any } | { ok: false; error: GraphError; status: number }> {
  const url = new URL(`${GRAPH_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${tokenOverride || pageAccessToken()}` },
    });
  } catch (e) {
    console.error("Messenger Graph request failed:", e);
    return { ok: false, error: { message: "Could not reach Meta. Try again in a moment." }, status: 502 };
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const err = (body?.error || {}) as GraphError;
    console.error("Messenger Graph error:", res.status, err.code, err.message || "");
    return {
      ok: false,
      status: res.status,
      error: {
        code: err.code,
        subcode: err.subcode,
        type: err.type,
        message: err.message || `Meta returned ${res.status}.`,
      },
    };
  }
  return { ok: true, data: body };
}

async function graphPost(
  path: string,
  payload: Record<string, unknown>,
  tokenOverride?: string,
): Promise<{ ok: true; data: any } | { ok: false; error: GraphError; status: number }> {
  let res: Response;
  try {
    res = await fetch(`${GRAPH_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenOverride || pageAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("Messenger Graph request failed:", e);
    return { ok: false, error: { message: "Could not reach Meta. Try again in a moment." }, status: 502 };
  }
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    const err = (body?.error || {}) as GraphError;
    console.error("Messenger Graph error:", res.status, err.code, err.message || "");
    return {
      ok: false,
      status: res.status,
      error: {
        code: err.code,
        subcode: err.subcode,
        type: err.type,
        message: err.message || `Meta returned ${res.status}.`,
      },
    };
  }
  return { ok: true, data: body };
}

// GET /{page-id}/conversations — the Page's threads. opts selects a
// Page connected from the app (accountId + pageId); without it the
// server's Page is used, exactly as before.
export async function listMessengerThreads(
  limit = 25,
  opts?: { accountId?: string; pageId?: string },
): Promise<
  | { ok: true; threads: MessengerThread[] }
  | { ok: false; error: string; metaError?: GraphError; status?: number }
> {
  const resolved = resolvePage(opts?.accountId || null, opts?.pageId || null);
  if (!resolved.token || !resolved.pageId) {
    return { ok: false, error: "messenger_not_configured" };
  }
  const r = await graphGet(`/${resolved.pageId}/conversations`, {
    fields: "id,participants,snippet,updated_time,unread_count",
    limit: String(Math.max(1, Math.min(100, Math.floor(limit)))),
  }, resolved.token);
  if (!r.ok) return { ok: false, error: "meta_error", metaError: r.error, status: r.status };
  const threads: MessengerThread[] = ((r.data.data || []) as any[]).map((c) => ({
    id: c.id,
    participants: ((c.participants?.data || []) as any[]).map((p) => ({
      id: p.id,
      name: p.name || "",
    })),
    snippet: c.snippet || "",
    updatedTime: c.updated_time || "",
    unreadCount: typeof c.unread_count === "number" ? c.unread_count : undefined,
  }));
  return { ok: true, threads };
}

// GET /{conversation-id}/messages — the messages in one Page thread.
export async function listMessengerMessages(
  conversationId: string,
  limit = 25,
  opts?: { accountId?: string; pageId?: string },
): Promise<
  | { ok: true; conversationId: string; messages: MessengerMessage[] }
  | { ok: false; error: string; metaError?: GraphError; status?: number }
> {
  const resolved = resolvePage(opts?.accountId || null, opts?.pageId || null);
  if (!resolved.token) {
    return { ok: false, error: "messenger_not_configured" };
  }
  if (!conversationId.trim()) return { ok: false, error: "conversationId required" };
  const r = await graphGet(`/${conversationId.trim()}/messages`, {
    fields: "id,from,message,created_time",
    limit: String(Math.max(1, Math.min(100, Math.floor(limit)))),
  }, resolved.token);
  if (!r.ok) return { ok: false, error: "meta_error", metaError: r.error, status: r.status };
  const messages: MessengerMessage[] = ((r.data.data || []) as any[]).map((m) => ({
    id: m.id,
    from: { id: m.from?.id || "", name: m.from?.name },
    text: m.message || "",
    createdTime: m.created_time || "",
  }));
  return { ok: true, conversationId: conversationId.trim(), messages };
}

// The recipient of a send is the thread's other participant: the person
// writing to the Page. The conversation id alone is not a recipient, so
// look the participants up and take the one who is not the Page.
async function recipientForConversation(
  conversationId: string,
  opts?: { accountId?: string; pageId?: string },
): Promise<{ ok: true; recipientId: string } | { ok: false; error: string; metaError?: GraphError; status?: number }> {
  const resolved = resolvePage(opts?.accountId || null, opts?.pageId || null);
  const r = await graphGet(`/${conversationId.trim()}`, { fields: "participants" }, resolved.token);
  if (!r.ok) return { ok: false, error: "meta_error", metaError: r.error, status: r.status };
  const participants = ((r.data.participants?.data || []) as any[]).filter(
    (p) => p.id && p.id !== resolved.pageId,
  );
  if (!participants.length) {
    return { ok: false, error: "no_recipient" };
  }
  return { ok: true, recipientId: participants[0].id };
}

// POST /me/messages — send one message into a Page thread.
//
// Meta's 24-hour messaging window is enforced honestly: this sends as a
// RESPONSE, the standard reply inside the window. If Meta rejects the send
// (for example the window has closed), Meta's error is returned plainly in
// the response. There is no retry with a different message type and no
// tag workaround — inventing one would send outside the rules Meta sets.
export async function sendMessengerMessage(
  conversationId: string,
  text: string,
  opts?: { accountId?: string; pageId?: string },
): Promise<
  | { ok: true; messageId: string; recipientId: string }
  | { ok: false; error: string; metaError?: GraphError; status?: number }
> {
  const resolved = resolvePage(opts?.accountId || null, opts?.pageId || null);
  if (!resolved.token) {
    return { ok: false, error: "messenger_not_configured" };
  }
  const convo = conversationId.trim();
  const body = text.trim();
  if (!convo) return { ok: false, error: "conversationId required" };
  if (!body) return { ok: false, error: "text required" };
  if (body.length > 2000) return { ok: false, error: "text too long" };
  const recipient = await recipientForConversation(convo, opts);
  if (!recipient.ok) return recipient;
  const r = await graphPost("/me/messages", {
    recipient: { id: recipient.recipientId },
    messaging_type: "RESPONSE",
    message: { text: body },
  }, resolved.token);
  if (!r.ok) return { ok: false, error: "meta_error", metaError: r.error, status: r.status };
  const messageId = String(r.data.message_id || "");
  // Keep the local thread history whole: the sent message, from the Page.
  try {
    storeMessengerMessage(convo, resolved.pageId, body, new Date().toISOString(), messageId || null);
  } catch {
    // The send already happened; a local-store failure must not fail it.
  }
  return { ok: true, messageId, recipientId: recipient.recipientId };
}

// --- HTTP plumbing for server.ts ---
//
// server.ts keeps its own json/bad/accountIdFrom helpers; this module
// carries small local copies so the coordinator can mount it with one line
// (see WIRING.md) without touching the existing helpers.

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function isValidAccountId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(id);
}

function accountIdFrom(req: Request, body: any): string {
  const fromBody = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (fromBody) return fromBody;
  const fromHeader = req.headers.get("x-account-id") || "";
  if (fromHeader.trim()) return fromHeader.trim();
  const url = new URL(req.url);
  return (url.searchParams.get("accountId") || "").trim();
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function notConfigured(): Response {
  return json({
    ok: false,
    error: "messenger_not_configured",
    message:
      "Facebook Page messaging is not connected yet — set META_PAGE_ID and META_PAGE_ACCESS_TOKEN. Personal Messenger has no supported API and is not connected either.",
    personalMessenger: { connected: false, note: PERSONAL_MESSENGER_NOTE },
  });
}

// GET /api/messenger/webhook — hub.mode=subscribe verification.
// Meta calls this when the webhook is first set up. The challenge is
// returned as plain text only when hub.verify_token matches
// META_WEBHOOK_VERIFY_TOKEN; anything else is a 403.
export function verifyMessengerWebhook(req: Request): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode") || "";
  const token = url.searchParams.get("hub.verify_token") || "";
  const challenge = url.searchParams.get("hub.challenge") || "";
  const expected = webhookVerifyToken();
  if (mode !== "subscribe" || !expected || token !== expected || !challenge) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(challenge, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

// POST /api/messenger/webhook — incoming Page messages.
//
// Meta posts { object: "page", entry: [{ messaging: [...] }] }. Each
// messaging event with a real incoming text message is stored in
// messenger_messages; delivery/read receipts, echoes of the Page's own
// messages, and events with no text are skipped and counted, not stored.
// Nothing is invented: only what Meta sent is stored, and nothing is
// auto-replied to. The Photon drafts; the owner taps send. Always 200 for
// a parseable Page payload, so Meta does not retry the delivery.
export async function handleMessengerWebhook(req: Request): Promise<Response> {
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400);
  }
  if (!payload || typeof payload !== "object" || payload.object !== "page") {
    // Not a Page event. Acknowledge it so Meta does not retry, and say so.
    return json({ ok: true, stored: 0, skipped: 0, ignored: true });
  }
  let stored = 0;
  let skipped = 0;
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const events = Array.isArray(entry?.messaging) ? entry.messaging : [];
    for (const ev of events) {
      const msg = ev?.message;
      const senderId = String(ev?.sender?.id || "");
      // Echoes are the Page's own sent messages coming back; receipts and
      // read events have no message at all. None of those is an incoming
      // message to store.
      if (!msg || msg.is_echo || typeof msg.text !== "string" || !msg.text) {
        skipped += 1;
        continue;
      }
      if (!senderId) {
        skipped += 1;
        continue;
      }
      const ts = typeof ev.timestamp === "number" ? ev.timestamp : Date.now();
      const storedRow = storeMessengerMessage(
        senderId,
        senderId,
        msg.text,
        new Date(ts).toISOString(),
        typeof msg.mid === "string" ? msg.mid : null,
      );
      if (storedRow) stored += 1;
      else skipped += 1;
    }
  }
  return json({ ok: true, stored, skipped });
}

// Route dispatcher for server.ts. Returns null for paths this module does
// not own, so server.ts falls through to its 404. The webhook routes take
// no accountId — Meta calls them, not the app. Every other route requires
// a valid accountId, like the Gmail routes.
export async function handleMessenger(req: Request, path: string): Promise<Response | null> {
  const url = new URL(req.url);
  const method = req.method;

  if (path === "/api/messenger/webhook" && method === "GET") {
    return verifyMessengerWebhook(req);
  }
  if (path === "/api/messenger/webhook" && method === "POST") {
    return handleMessengerWebhook(req);
  }

  if (path === "/api/messenger/status" && method === "GET") {
    return json(messengerStatus());
  }

  // POST /api/messenger/connect — connect a Page from the app. Body:
  // { accountId, token }. The token is tested against Graph before it is
  // stored, and it is never echoed back. The token itself is never
  // returned by any endpoint.
  if (path === "/api/messenger/connect" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const token = String(body.token || "");
    const r = await connectPage(accountId, token);
    if (!r.ok) {
      if (r.error === "bad_token") return bad("a Page access token is required", 400);
      return json({
        ok: false,
        error: r.error,
        message: r.message || "Meta did not accept that token. Check it and try again.",
      });
    }
    return json({ ok: true, pageId: r.pageId, pageName: r.pageName });
  }

  // GET /api/messenger/pages — the Pages this account connected from the
  // app (page id + name only; the token is never returned).
  if (path === "/api/messenger/pages" && method === "GET") {
    const accountId = accountIdFrom(req, {});
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    return json({ ok: true, pages: listConnectedPages(accountId) });
  }

  // POST /api/messenger/disconnect — remove a Page connected from the
  // app. Body: { accountId, pageId }. The server's own Page (env vars)
  // is not touched by this.
  if (path === "/api/messenger/disconnect" && method === "POST") {
    const body = await readBody(req);
    const accountId = accountIdFrom(req, body);
    if (!isValidAccountId(accountId)) return bad("accountId required", 400);
    const pageIdArg = String(body.pageId || "").trim();
    if (!pageIdArg) return bad("pageId required", 400);
    disconnectPage(accountId, pageIdArg);
    return json({ ok: true, disconnected: true });
  }

  // Everything below needs an account, like the Gmail routes.
  const needsAccount =
    (path === "/api/messenger/threads" && method === "GET") ||
    (path === "/api/messenger/messages" && method === "GET") ||
    (path === "/api/messenger/stored" && method === "GET") ||
    (path === "/api/messenger/send" && method === "POST");
  if (!needsAccount) return null;

  const body = method === "POST" ? await readBody(req) : {};
  const accountId = accountIdFrom(req, body);
  if (!isValidAccountId(accountId)) return bad("accountId required", 400);
  // A Page connected from the app is selected with pageId; without it
  // the server's Page is used, exactly as before.
  const pageIdArg =
    url.searchParams.get("pageId") || url.searchParams.get("page_id") || String(body.pageId || "") || "";

  if (path === "/api/messenger/threads" && method === "GET") {
    const r = await listMessengerThreads(25, { accountId, pageId: pageIdArg });
    if (!r.ok) {
      if (r.error === "messenger_not_configured") return notConfigured();
      return json({ ok: false, error: r.error, metaError: r.metaError || null }, r.status || 502);
    }
    return json({ ok: true, threads: r.threads });
  }

  if (path === "/api/messenger/messages" && method === "GET") {
    const conversationId =
      url.searchParams.get("conversationId") || url.searchParams.get("conversation_id") || "";
    if (!conversationId.trim()) return bad("conversationId required", 400);
    const r = await listMessengerMessages(conversationId, 25, { accountId, pageId: pageIdArg });
    if (!r.ok) {
      if (r.error === "messenger_not_configured") return notConfigured();
      if (r.error === "conversationId required") return bad(r.error, 400);
      return json({ ok: false, error: r.error, metaError: r.metaError || null }, r.status || 502);
    }
    return json({ ok: true, conversationId: r.conversationId, messages: r.messages });
  }

  if (path === "/api/messenger/stored" && method === "GET") {
    const conversationId =
      url.searchParams.get("conversationId") || url.searchParams.get("conversation_id") || "";
    if (!conversationId.trim()) return bad("conversationId required", 400);
    return json({
      ok: true,
      conversationId: conversationId.trim(),
      messages: listStoredMessages(conversationId.trim()),
      note: "Messages received on the Page webhook and stored locally. Live reads come from GET /api/messenger/messages.",
    });
  }

  if (path === "/api/messenger/send" && method === "POST") {
    const conversationId = String(body.conversationId || body.conversation_id || "").trim();
    const text = String(body.text || "");
    if (!conversationId) return bad("conversationId required", 400);
    if (!text.trim()) return bad("text required", 400);
    const r = await sendMessengerMessage(conversationId, text, { accountId, pageId: pageIdArg });
    if (!r.ok) {
      if (r.error === "messenger_not_configured") return notConfigured();
      if (r.error === "conversationId required" || r.error === "text required" || r.error === "text too long") {
        return bad(r.error, 400);
      }
      if (r.error === "no_recipient") {
        return json({
          ok: false,
          error: "no_recipient",
          message: "That thread has no other participant to send to.",
        });
      }
      // Meta refused the send — most often the 24-hour messaging window
      // has closed. Meta's error is returned plainly; there is no retry
      // with another message type and no workaround.
      return json(
        {
          ok: false,
          error: "meta_error",
          message: r.metaError?.message || "Meta refused the send.",
          metaError: r.metaError || null,
        },
        r.status || 502,
      );
    }
    return json({ ok: true, sent: true, messageId: r.messageId, recipientId: r.recipientId });
  }

  return null;
}
