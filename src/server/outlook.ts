// Outlook mail + Microsoft OAuth (plain fetch, no SDK). The Inboxes tab
// reads Outlook accounts the same way it reads Gmail: each connected
// mailbox shows as its own card and can save real drafts. Connecting an
// account needs a Microsoft OAuth client (MICROSOFT_CLIENT_ID /
// MICROSOFT_CLIENT_SECRET / MICROSOFT_REDIRECT_URI), registered in the
// Microsoft Entra admin center (Azure). Without one, the Inboxes tab
// says so honestly. Tokens are stored in the local SQLite database, the
// same way Gmail refresh tokens are; on Render's free tier the disk is
// ephemeral, so connections reset when the service redeploys.
//
// Microsoft Graph API: https://graph.microsoft.com/v1.0. Scopes are
// Mail.Read (read the inbox), Mail.Send (send mail), User.Read (who the
// mailbox belongs to), and offline_access (a refresh token, so the
// sign-in survives). The authorize and token endpoints are the v2.0
// common endpoints, so a personal Microsoft account and a work or school
// account both sign in the same way.

import { config, microsoftConfigured } from "./config";
import {
  getOutlookAccount,
  getOutlookAccounts,
  setOutlookAccount,
  updateOutlookAccessToken,
} from "./db";

// An Outlook label is a generated slug, outlook-1, outlook-2, ... so
// anyone can add as many Outlook accounts as they like. A label rides in
// the OAuth state as `accountId:label`, so it must be a safe slug: no
// colon, no spaces.
export type OutlookLabel = string;

export function isValidOutlookLabel(label: string): boolean {
  return /^outlook-[1-9][0-9]*$/.test(label);
}

// The card title for an account: the mailbox's own email address.
export function outlookLabelTitle(label: string, email: string | null): string {
  return email || "Outlook account";
}

const SCOPES = [
  "https://graph.microsoft.com/Mail.Read",
  "https://graph.microsoft.com/Mail.Send",
  "https://graph.microsoft.com/User.Read",
  "offline_access",
];

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export function authUrl(accountId: string, label: OutlookLabel): string | null {
  if (!microsoftConfigured()) return null;
  const params = new URLSearchParams({
    client_id: config.microsoftClientId,
    redirect_uri: config.microsoftRedirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    response_mode: "query",
    state: `${accountId}:${label}`,
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
};

async function exchangeToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
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
  if (!accountId || !label || !isValidOutlookLabel(label)) {
    return { ok: false, error: "bad_state" };
  }
  try {
    const tokens = await exchangeToken({
      code,
      client_id: config.microsoftClientId,
      client_secret: config.microsoftClientSecret,
      redirect_uri: config.microsoftRedirectUri,
      grant_type: "authorization_code",
    });
    if (!tokens.refresh_token) return { ok: false, error: "no_refresh_token" };
    // Who is this mailbox? Ask Graph for the signed-in user's address.
    const meRes = await fetch(`${GRAPH_BASE}/me?$select=mail,userPrincipalName,displayName`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meRes.ok) return { ok: false, error: "profile_failed" };
    const me = (await meRes.json()) as { mail?: string; userPrincipalName?: string };
    const email = me.mail || me.userPrincipalName || "";
    const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
    setOutlookAccount(accountId, label as OutlookLabel, email, tokens.refresh_token, tokens.access_token, expiry);
    return { ok: true, accountId, label, email };
  } catch (e) {
    console.error("Outlook OAuth callback failed:", e);
    return { ok: false, error: "oauth_failed" };
  }
}

async function freshAccessToken(accountId: string, label: string): Promise<string | null> {
  const acct = getOutlookAccount(accountId, label);
  if (!acct) return null;
  if (acct.access_token && acct.token_expiry && acct.token_expiry > Date.now() + 60_000) {
    return acct.access_token;
  }
  try {
    const tokens = await exchangeToken({
      refresh_token: acct.refresh_token,
      client_id: config.microsoftClientId,
      client_secret: config.microsoftClientSecret,
      grant_type: "refresh_token",
    });
    const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
    updateOutlookAccessToken(accountId, label, tokens.access_token, expiry);
    return tokens.access_token;
  } catch (e) {
    console.error("Outlook token refresh failed:", e);
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
  label: OutlookLabel,
  maxResults = 10,
): Promise<{ connected: boolean; email?: string; messages: InboxMessage[]; error?: string }> {
  const acct = getOutlookAccount(accountId, label);
  if (!acct) return { connected: false, messages: [] };
  const token = await freshAccessToken(accountId, label);
  if (!token) return { connected: false, email: acct.email, messages: [], error: "token_failed" };
  const q = new URLSearchParams({
    $top: String(Math.max(1, Math.min(25, Math.floor(maxResults)))),
    $select: "id,from,subject,receivedDateTime,bodyPreview",
    $orderby: "receivedDateTime desc",
  });
  const listRes = await fetch(`${GRAPH_BASE}/me/messages?${q.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    console.error("Outlook list failed:", listRes.status);
    return { connected: true, email: acct.email, messages: [], error: "list_failed" };
  }
  const list = (await listRes.json()) as { value?: any[] };
  const out: InboxMessage[] = (list.value || []).map((m: any) => ({
    id: String(m.id || ""),
    from: m.from?.emailAddress?.address
      ? `${m.from.emailAddress.name ? m.from.emailAddress.name + " " : ""}<${m.from.emailAddress.address}>`
      : "",
    subject: m.subject || "(no subject)",
    date: m.receivedDateTime || "",
    snippet: m.bodyPreview || "",
  }));
  return { connected: true, email: acct.email, messages: out };
}

// Save a real draft into an Outlook mailbox. Graph creates the draft
// with a POST to /me/messages; the draft stays in Drafts until the
// owner sends it from Outlook.
export async function saveDraft(
  accountId: string,
  label: OutlookLabel,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; draftId?: string; error?: string }> {
  const acct = getOutlookAccount(accountId, label);
  if (!acct) return { ok: false, error: "not_connected" };
  const token = await freshAccessToken(accountId, label);
  if (!token) return { ok: false, error: "token_failed" };
  const res = await fetch(`${GRAPH_BASE}/me/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject: subject || "",
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    }),
  });
  if (!res.ok) {
    console.error("Outlook draft failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return { ok: false, error: "draft_failed" };
  }
  const d = (await res.json()) as { id?: string };
  return { ok: true, draftId: d.id };
}

// Send a real email from a connected Outlook mailbox.
export async function sendEmail(
  accountId: string,
  label: OutlookLabel,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const acct = getOutlookAccount(accountId, label);
  if (!acct) return { ok: false, error: "not_connected" };
  const token = await freshAccessToken(accountId, label);
  if (!token) return { ok: false, error: "token_failed" };
  const res = await fetch(`${GRAPH_BASE}/me/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: subject || "",
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) {
    console.error("Outlook send failed:", res.status, (await res.text().catch(() => "")).slice(0, 200));
    return { ok: false, error: "send_failed" };
  }
  return { ok: true };
}

export function connectedLabels(accountId: string): { label: OutlookLabel; email: string }[] {
  return getOutlookAccounts(accountId).map((a) => ({
    label: a.label as OutlookLabel,
    email: a.email,
  }));
}
