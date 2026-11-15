// Gmail API + Google OAuth (plain fetch, no SDK). The Inboxes tab reads the
// three Gmail accounts side by side and can save real drafts. Connecting an
// account needs a Google OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
// / GOOGLE_REDIRECT_URI). Without one, the Inboxes tab says so honestly.
// Tokens are stored in the local SQLite database; on Render's free tier the
// disk is ephemeral, so connections reset when the service redeploys.

import { config, googleConfigured } from "./config";
import {
  getGmailAccount,
  getGmailAccounts,
  setGmailAccount,
  updateGmailAccessToken,
} from "./db";

export const GMAIL_LABELS = ["personal", "contact", "test"] as const;
export type GmailLabel = (typeof GMAIL_LABELS)[number];

export const GMAIL_LABEL_TITLES: Record<GmailLabel, string> = {
  personal: "Personal",
  contact: "Labs contact",
  test: "Labs test",
};

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
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
  if (!accountId || !label || !(GMAIL_LABELS as readonly string[]).includes(label)) {
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
};

export async function listInbox(
  accountId: string,
  label: GmailLabel,
  maxResults = 10,
): Promise<{ connected: boolean; email?: string; messages: InboxMessage[]; error?: string }> {
  const acct = getGmailAccount(accountId, label);
  if (!acct) return { connected: false, messages: [] };
  const token = await freshAccessToken(accountId, label);
  if (!token) return { connected: false, email: acct.email, messages: [], error: "token_failed" };
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${maxResults}&q=in%3Ainbox`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!listRes.ok) {
    console.error("Gmail list failed:", listRes.status);
    return { connected: true, email: acct.email, messages: [], error: "list_failed" };
  }
  const list = (await listRes.json()) as { messages?: { id: string }[] };
  const out: InboxMessage[] = [];
  for (const m of list.messages || []) {
    const r = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) continue;
    const d = (await r.json()) as any;
    const headers: Record<string, string> = {};
    for (const h of d.payload?.headers || []) headers[h.name] = h.value;
    out.push({
      id: d.id,
      from: headers["From"] || "",
      subject: headers["Subject"] || "(no subject)",
      date: headers["Date"] || "",
      snippet: d.snippet || "",
    });
  }
  return { connected: true, email: acct.email, messages: out };
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

export function connectedLabels(accountId: string): { label: GmailLabel; email: string }[] {
  return getGmailAccounts(accountId).map((a) => ({
    label: a.label as GmailLabel,
    email: a.email,
  }));
}
