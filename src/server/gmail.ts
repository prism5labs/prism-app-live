// Gmail API + Google OAuth (plain fetch, no SDK). The Connected tab reads
// the three Gmail accounts side by side and can save real drafts. Connecting
// an account needs a Google OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// / GOOGLE_REDIRECT_URI). Without one, the Connected tab says so honestly.
// Tokens are stored in the local SQLite database; on Render's free tier the
// disk is ephemeral, so connections reset when the service redeploys.

import { config, googleConfigured } from "./config";
import { EXTRA_SCOPES, recordGoogleToken } from "./google";
import {
  getGmailAccount,
  getGmailAccounts,
  setGmailAccount,
  updateGmailAccessToken,
} from "./db";

export const GMAIL_LABELS = ["personal", "contact", "test"] as const;

// A Gmail label is a free-form slug now, not just one of the three
// original slots. The three legacy labels keep their titles and their
// send preference order; new accounts get generated labels
// (gmail-1, gmail-2, …), so anyone can add as many accounts as they
// like. A label rides in the OAuth state as `accountId:label`, so it
// must be a safe slug — no colon, no spaces.
export type GmailLabel = string;

export function isValidGmailLabel(label: string): boolean {
  if ((GMAIL_LABELS as readonly string[]).includes(label)) return true;
  return /^gmail-[1-9][0-9]*$/.test(label);
}

// The card title for an account: the old names for the three original
// slots, the account's own email for anything added since.
export function gmailLabelTitle(label: string, email: string | null): string {
  const t = (GMAIL_LABEL_TITLES as Record<string, string>)[label];
  if (t) return t;
  return email || "Gmail account";
}

export const GMAIL_LABEL_TITLES: Record<string, string> = {
  personal: "Personal",
  contact: "Labs contact",
  test: "Labs test",
};

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
  // One Google sign-in for Gmail, Calendar, and Drive (redesign,
  // Nov 19, 2026): the Gmail consent asks for the Calendar and Drive
  // scopes too, so the owner signs in once and all three work. The
  // app sign-in is a different flow with identity-only scopes and is
  // untouched. Accounts connected before this change keep the old
  // Gmail-only grant until they sign in once more; the separate
  // Calendar + Drive flow stays as the way to add that permission.
  ...EXTRA_SCOPES,
];

export function authUrl(accountId: string, label: GmailLabel): string | null {
  if (!googleConfigured()) return null;
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: `${accountId}:${label}`,
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

async function exchangeToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`token exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function handleOAuthCallback(
  code: string,
  state: string,
): Promise<{ ok: boolean; accountId?: string; label?: string; email?: string; error?: string }> {
  const [accountId, label] = state.split(":");
  if (!accountId || !label || !isValidGmailLabel(label)) {
    return { ok: false, error: "bad_state" };
  }
  try {
    const tokens = await exchangeToken({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: config.googleRedirectUri,
      grant_type: "authorization_code",
    });
    if (!tokens.refresh_token) return { ok: false, error: "no_refresh_token" };
    // Who is this account? Ask Google for the profile email.
    const meRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meRes.ok) return { ok: false, error: "profile_failed" };
    const me = (await meRes.json()) as { emailAddress?: string };
    const email = me.emailAddress || "";
    const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
    setGmailAccount(accountId, label as GmailLabel, email, tokens.refresh_token, tokens.access_token, expiry);
    // The same consent granted Calendar and Drive: record the same
    // tokens for those services, so one sign-in connects all three.
    // Google reports the granted scopes in the token response; a
    // partial grant (the owner unchecked a scope) records nothing
    // here, and the Calendar + Drive flow stays available to add it.
    // No scope field at all means a full grant of what was asked.
    const grantedScopes = tokens.scope ? tokens.scope.split(" ").filter(Boolean) : null;
    const hasExtra = !grantedScopes || EXTRA_SCOPES.every((s) => grantedScopes.includes(s));
    if (hasExtra) {
      recordGoogleToken(
        accountId,
        email,
        tokens.refresh_token,
        tokens.access_token,
        expiry,
        [...SCOPES].join(" "),
      );
    }
    return { ok: true, accountId, label, email };
  } catch (e) {
    console.error("OAuth callback failed:", e);
    return { ok: false, error: "oauth_failed" };
  }
}

async function freshAccessToken(accountId: string, label: string): Promise<string | null> {
  const acct = getGmailAccount(accountId, label);
  if (!acct) return null;
  if (acct.access_token && acct.token_expiry && acct.token_expiry > Date.now() + 60_000) {
    return acct.access_token;
  }
  try {
    const tokens = await exchangeToken({
      refresh_token: acct.refresh_token,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      grant_type: "refresh_token",
    });
    const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
    updateGmailAccessToken(accountId, label, tokens.access_token, expiry);
    return tokens.access_token;
  } catch (e) {
    console.error("Gmail token refresh failed:", e);
    return null;
  }
}

export type InboxMessage = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  // True when Gmail still has the message marked unread. The summary
  // view leads with these, so the owner sees what needs attention
  // instead of the whole inbox.
  unread?: boolean;
};

export async function listInbox(
  accountId: string,
  label: GmailLabel,
  maxResults = 10,
): Promise<{
  connected: boolean;
  email?: string;
  messages: InboxMessage[];
  unreadCount?: number;
  error?: string;
}> {
  const acct = getGmailAccount(accountId, label);
  if (!acct) return { connected: false, messages: [] };
  const token = await freshAccessToken(accountId, label);
  if (!token) return { connected: false, email: acct.email, messages: [], error: "token_failed" };
  // The list and the unread count are independent: ask for both at
  // once instead of queuing them, and fetch every message's metadata
  // in parallel too — the old serial loop made the inbox load feel
  // claggy, one round trip per message.
  const [listRes, labelsRes] = await Promise.all([
    fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=in%3Ainbox`,
      { headers: { Authorization: `Bearer ${token}` } },
    ),
    fetch(`https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);
  let unreadCount: number | undefined;
  if (labelsRes.ok) {
    const lab = (await labelsRes.json().catch(() => null)) as { messagesUnread?: number } | null;
    if (typeof lab?.messagesUnread === "number") unreadCount = lab.messagesUnread;
  }
  if (!listRes.ok) {
    console.error("Gmail list failed:", listRes.status);
    return { connected: true, email: acct.email, messages: [], unreadCount, error: "list_failed" };
  }
  const list = (await listRes.json()) as { messages?: { id: string }[] };
  const out: InboxMessage[] = (
    await Promise.all(
      (list.messages || []).map(async (m) => {
        const r = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!r.ok) return null;
        const d = (await r.json()) as any;
        const headers: Record<string, string> = {};
        for (const h of d.payload?.headers || []) headers[h.name] = h.value;
        return {
          id: d.id,
          from: headers["From"] || "",
          subject: headers["Subject"] || "(no subject)",
          date: headers["Date"] || "",
          snippet: d.snippet || "",
          unread: Array.isArray(d.labelIds) ? d.labelIds.includes("UNREAD") : undefined,
        } as InboxMessage;
      }),
    )
  ).filter((m): m is InboxMessage => m !== null);
  return { connected: true, email: acct.email, messages: out, unreadCount };
}

// Read one message in full: subject, sender, date, and the plain-text
// body. The list endpoint only carries a snippet, so the summary view
// opens the real message through here, one tap, no whole-inbox render.
export async function getMessage(
  accountId: string,
  label: GmailLabel,
  id: string,
): Promise<{
  ok: boolean;
  id?: string;
  from?: string;
  subject?: string;
  date?: string;
  body?: string;
  error?: string;
}> {
  const acct = getGmailAccount(accountId, label);
  if (!acct) return { ok: false, error: "not_connected" };
  const token = await freshAccessToken(accountId, label);
  if (!token) return { ok: false, error: "token_failed" };
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    console.error("Gmail message failed:", res.status);
    return { ok: false, error: "message_failed" };
  }
  const d = (await res.json()) as any;
  const headers: Record<string, string> = {};
  for (const h of d.payload?.headers || []) headers[h.name] = h.value;
  const body = plainTextFromPayload(d.payload).slice(0, 60000);
  return {
    ok: true,
    id: d.id,
    from: headers["From"] || "",
    subject: headers["Subject"] || "(no subject)",
    date: headers["Date"] || "",
    body,
  };
}

// Walk a Gmail message payload for the plain-text body: prefer
// text/plain wherever it hides (multipart/alternative nests it under
// multipart/mixed), fall back to text/html with the tags stripped.
// Bodies are base64url; a part with no data is skipped, not fatal.
function plainTextFromPayload(payload: any): string {
  if (!payload) return "";
  const decode = (data: string): string => {
    try {
      const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return "";
    }
  };
  const walk = (part: any, want: "text/plain" | "text/html"): string => {
    if (!part) return "";
    const mime = String(part.mimeType || "");
    if (mime === want && part.body?.data) return decode(part.body.data);
    for (const sub of part.parts || []) {
      const found = walk(sub, want);
      if (found) return found;
    }
    return "";
  };
  const plain = walk(payload, "text/plain");
  if (plain) return plain;
  const html = walk(payload, "text/html");
  if (!html) return "";
  return html
    .replace(/<(br|p|div|li|tr|h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function toBase64Url(s: string): string {
  return Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function saveDraft(
  accountId: string,
  label: GmailLabel,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; draftId?: string; error?: string }> {
  const acct = getGmailAccount(accountId, label);
  if (!acct) return { ok: false, error: "not_connected" };
  const token = await freshAccessToken(accountId, label);
  if (!token) return { ok: false, error: "token_failed" };
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ].join("\r\n");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: { raw: toBase64Url(mime) } }),
  });
  if (!res.ok) {
    console.error("Gmail draft failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return { ok: false, error: "draft_failed" };
  }
  const d = (await res.json()) as { id?: string };
  return { ok: true, draftId: d.id };
}

// Send a real email from a connected Gmail account. Same MIME build as
// saveDraft, but it goes out the door instead of into drafts.
export async function sendEmail(
  accountId: string,
  label: GmailLabel,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const acct = getGmailAccount(accountId, label);
  if (!acct) return { ok: false, error: "not_connected" };
  const token = await freshAccessToken(accountId, label);
  if (!token) return { ok: false, error: "token_failed" };
  const mime = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    body,
  ].join("\r\n");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: toBase64Url(mime) }),
  });
  if (!res.ok) {
    console.error("Gmail send failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return { ok: false, error: "send_failed" };
  }
  const d = (await res.json()) as { id?: string };
  return { ok: true, messageId: d.id };
}

// Send from whichever Gmail account is connected, preferring the three
// original slots in their old order, then any account added since, in
// the order it was connected. Returns which label sent it.
export async function sendFromAny(
  accountId: string,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; label?: GmailLabel; messageId?: string; error?: string }> {
  const connected = getGmailAccounts(accountId);
  if (!connected.length) return { ok: false, error: "not_connected" };
  const ordered = [
    ...GMAIL_LABELS.map((l) => connected.find((a) => a.label === l)).filter(
      (a): a is (typeof connected)[number] => Boolean(a),
    ),
    ...connected.filter((a) => !(GMAIL_LABELS as readonly string[]).includes(a.label)),
  ];
  for (const a of ordered) {
    const r = await sendEmail(accountId, a.label, to, subject, body);
    if (r.ok) return { ok: true, label: a.label, messageId: r.messageId };
    // A token failure on one account is not worth trying the next with
    // the same stale credentials; a hard send failure is worth one retry
    // on the next connected account.
    if (r.error === "token_failed") return { ok: false, error: "token_failed" };
  }
  return { ok: false, error: "send_failed" };
}

export function connectedLabels(accountId: string): { label: GmailLabel; email: string }[] {
  return getGmailAccounts(accountId).map((a) => ({
    label: a.label as GmailLabel,
    email: a.email,
  }));
}
