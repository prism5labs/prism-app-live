// Google Calendar + Google Drive through the same Google sign-in the app
// already uses for Gmail (src/server/gmail.ts). Same OAuth client, with
// calendar and Drive scopes added, so the owner signs in once and grants
// both. Owners already connected for Gmail will be asked to sign in again
// once for the new permission.
//
// This module owns its own OAuth flow and its own token table
// (google_tokens), separate from gmail.ts — gmail.ts is not touched.
// Nothing here writes or shares a file. Reading first; writing and
// sharing come later. Booking an event only happens when the owner taps
// to book: the Photon drafts, POST /api/calendar/book creates.
//
// Needs, before any of this works live: the Calendar API and the Drive
// API turned on in the same Google Cloud project as the Gmail OAuth
// client. That is a step for Neil in the Google Cloud console, not code.
// Without those APIs enabled, Google answers with an error and these
// endpoints say so in plain words instead of inventing anything.
//
// Tokens live in the local SQLite database; on Render's free tier the
// disk is ephemeral, so connections reset when the service redeploys,
// same as Gmail.

import { db } from "./db";
import { config } from "./config";

// Own table, created here at import (this module's file ownership).
db.exec(`
CREATE TABLE IF NOT EXISTS google_tokens (
  account_id TEXT NOT NULL PRIMARY KEY,
  scope_set TEXT NOT NULL,
  email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  token_expiry INTEGER
);
`);

export const EXTRA_CALLBACK_PATH = "/api/oauth/google/callback-extra";

export const EXTRA_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
] as const;

export const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
] as const;

export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"] as const;

// Same Google OAuth client as Gmail, from config.ts. No new secrets.
const googleClientId = config.googleClientId;
const googleClientSecret = config.googleClientSecret;
const googleRedirectUri = config.googleRedirectUri;

export function googleExtraConfigured(): boolean {
  return (
    googleClientId.length > 0 && googleClientSecret.length > 0 && googleRedirectUri.length > 0
  );
}

export type GoogleTokenRow = {
  account_id: string;
  scope_set: string;
  email: string;
  refresh_token: string;
  access_token: string | null;
  token_expiry: number | null;
};

function getGoogleToken(accountId: string): GoogleTokenRow | null {
  const row = db
    .query(`SELECT * FROM google_tokens WHERE account_id = ?`)
    .get(accountId) as GoogleTokenRow | null;
  return row ?? null;
}

function setGoogleToken(
  accountId: string,
  email: string,
  refreshToken: string,
  accessToken: string | null,
  tokenExpiry: number | null,
): void {
  // The Calendar + Drive sign-in records only its own scopes.
  recordGoogleToken(accountId, email, refreshToken, accessToken, tokenExpiry, EXTRA_SCOPES.join(" "));
}

// One Google sign-in for Gmail, Calendar, and Drive (redesign,
// Nov 19, 2026): the Gmail sign-in now asks for the Calendar and
// Drive scopes too, so the same consent fills both token stores —
// the Gmail row in gmail.ts and this row here — and the owner signs
// in once instead of twice. The scope_set recorded is the set the
// token was actually granted, so a partial grant never claims a
// service it cannot reach.
export function recordGoogleToken(
  accountId: string,
  email: string,
  refreshToken: string,
  accessToken: string | null,
  tokenExpiry: number | null,
  scopeSet: string,
): void {
  db.query(
    `INSERT INTO google_tokens (account_id, scope_set, email, refresh_token, access_token, token_expiry)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       scope_set = excluded.scope_set, email = excluded.email,
       refresh_token = excluded.refresh_token,
       access_token = excluded.access_token, token_expiry = excluded.token_expiry`,
  ).run(accountId, scopeSet, email, refreshToken, accessToken, tokenExpiry);
}

function updateGoogleAccessToken(accountId: string, accessToken: string, tokenExpiry: number): void {
  db.query(
    `UPDATE google_tokens SET access_token = ?, token_expiry = ? WHERE account_id = ?`,
  ).run(accessToken, tokenExpiry, accountId);
}

// --- OAuth: own flow, mirroring gmail.ts -------------------------------

export function authUrlExtra(accountId: string): string | null {
  if (!googleExtraConfigured()) return null;
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: googleRedirectUri,
    response_type: "code",
    scope: EXTRA_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: `${accountId}:calendar-drive`,
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

export async function handleExtraOAuthCallback(
  code: string,
  state: string,
): Promise<{ ok: boolean; accountId?: string; email?: string; error?: string }> {
  const [accountId, kind] = state.split(":");
  if (!accountId || kind !== "calendar-drive") {
    return { ok: false, error: "bad_state" };
  }
  try {
    const tokens = await exchangeToken({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: googleRedirectUri,
      grant_type: "authorization_code",
    });
    if (!tokens.refresh_token) return { ok: false, error: "no_refresh_token" };
    // Who is this account? Ask Google for the profile email.
    const meRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meRes.ok) return { ok: false, error: "profile_failed" };
    const me = (await meRes.json()) as { email?: string };
    const email = me.email || "";
    const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
    setGoogleToken(accountId, email, tokens.refresh_token, tokens.access_token, expiry);
    return { ok: true, accountId, email };
  } catch (e) {
    console.error("Calendar/Drive OAuth callback failed:", e);
    return { ok: false, error: "oauth_failed" };
  }
}

async function freshAccessToken(accountId: string): Promise<string | null> {
  const row = getGoogleToken(accountId);
  if (!row) return null;
  if (row.access_token && row.token_expiry && row.token_expiry > Date.now() + 60_000) {
    return row.access_token;
  }
  try {
    const tokens = await exchangeToken({
      refresh_token: row.refresh_token,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      grant_type: "refresh_token",
    });
    const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
    updateGoogleAccessToken(accountId, tokens.access_token, expiry);
    return tokens.access_token;
  } catch (e) {
    console.error("Calendar/Drive token refresh failed:", e);
    return null;
  }
}

// --- Google API helpers ------------------------------------------------

export const GOOGLE_REAUTH_MESSAGE =
  "Calendar and Drive need to be connected again. Sign in with Google once more and allow the calendar and Drive permission, then try again.";

type GoogleResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "not_connected" | "token_failed" | "google_reauth" | "google_failed"; status?: number };

function isScopeError(status: number, text: string): boolean {
  if (status !== 403) return false;
  return /insufficientPermission/i.test(text) || /insufficient permission/i.test(text);
}

// One authenticated call to a Google API. Retries once after a forced
// refresh on a 401. A 403 that says the scope was not granted becomes
// google_reauth, never an invented answer.
async function googleFetch(
  accountId: string,
  url: string,
  init?: RequestInit,
): Promise<GoogleResult<Response>> {
  const token = await freshAccessToken(accountId);
  if (!token) {
    const row = getGoogleToken(accountId);
    return { ok: false, error: row ? "token_failed" : "not_connected" };
  }
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    console.error("Google API call failed:", e);
    return { ok: false, error: "google_failed" };
  }
  if (res.status === 401) {
    // Force a refresh and try once more.
    const row = getGoogleToken(accountId);
    if (!row) return { ok: false, error: "not_connected" };
    try {
      const tokens = await exchangeToken({
        refresh_token: row.refresh_token,
        client_id: googleClientId,
        client_secret: googleClientSecret,
        grant_type: "refresh_token",
      });
      const expiry = Date.now() + (tokens.expires_in || 3600) * 1000;
      updateGoogleAccessToken(accountId, tokens.access_token, expiry);
      const retryHeaders = new Headers(init?.headers);
      retryHeaders.set("Authorization", `Bearer ${tokens.access_token}`);
      res = await fetch(url, { ...init, headers: retryHeaders });
    } catch (e) {
      console.error("Calendar/Drive token refresh failed:", e);
      return { ok: false, error: "token_failed" };
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("Google API failed:", res.status, text.slice(0, 200));
    if (isScopeError(res.status, text)) return { ok: false, error: "google_reauth", status: res.status };
    return { ok: false, error: "google_failed", status: res.status };
  }
  return { ok: true, data: res };
}

function reauthResult(): { ok: false; error: string; message: string } {
  return { ok: false, error: "google_reauth", message: GOOGLE_REAUTH_MESSAGE };
}

function notConnectedResult(): { ok: false; error: string; message: string } {
  return {
    ok: false,
    error: "not_connected",
    message:
      "Calendar and Drive aren't connected yet. Sign in with Google in the app to connect them.",
  };
}

function googleFailedResult(): { ok: false; error: string; message: string } {
  return {
    ok: false,
    error: "google_failed",
    message: "Google didn't answer that one. Try again in a moment.",
  };
}

function tokenFailedResult(): { ok: false; error: string; message: string } {
  return {
    ok: false,
    error: "token_failed",
    message:
      "The connection to Google went stale. Sign in with Google again to reconnect Calendar and Drive.",
  };
}

function toGoogleError(r: Extract<GoogleResult<Response>, { ok: false }>) {
  if (r.error === "not_connected") return notConnectedResult();
  if (r.error === "google_reauth") return reauthResult();
  if (r.error === "token_failed") return tokenFailedResult();
  return googleFailedResult();
}

// --- Status ------------------------------------------------------------

export function calendarStatus(accountId: string): {
  ok: boolean;
  connected: boolean;
  email?: string | null;
  scopes?: string[];
  googleConfigured?: boolean;
  error?: string;
  message?: string;
} {
  const row = getGoogleToken(accountId);
  if (!row) {
    return {
      ok: true,
      connected: false,
      googleConfigured: googleExtraConfigured(),
      message: googleExtraConfigured()
        ? "Calendar isn't connected yet. Sign in with Google to connect it."
        : "Calendar sign-in isn't set up on this server yet. It needs a Google OAuth client (client ID, secret, and redirect).",
    };
  }
  const granted = row.scope_set.split(" ").filter(Boolean);
  return {
    ok: true,
    connected: true,
    email: row.email,
    scopes: CALENDAR_SCOPES.filter((s) => granted.includes(s)),
  };
}

export function driveStatus(accountId: string): {
  ok: boolean;
  connected: boolean;
  email?: string | null;
  scopes?: string[];
  googleConfigured?: boolean;
  error?: string;
  message?: string;
} {
  const row = getGoogleToken(accountId);
  if (!row) {
    return {
      ok: true,
      connected: false,
      googleConfigured: googleExtraConfigured(),
      message: googleExtraConfigured()
        ? "Drive isn't connected yet. Sign in with Google to connect it."
        : "Drive sign-in isn't set up on this server yet. It needs a Google OAuth client (client ID, secret, and redirect).",
    };
  }
  const granted = row.scope_set.split(" ").filter(Boolean);
  return {
    ok: true,
    connected: true,
    email: row.email,
    scopes: DRIVE_SCOPES.filter((s) => granted.includes(s)),
  };
}

// --- Calendar ----------------------------------------------------------

export type CalendarEvent = {
  id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  location?: string;
  description?: string;
};

function toCalendarEvent(e: any): CalendarEvent {
  const start = e.start?.dateTime || e.start?.date || "";
  const end = e.end?.dateTime || e.end?.date || "";
  const attendees: string[] = (e.attendees || [])
    .map((a: any) => a.email)
    .filter((x: any) => typeof x === "string" && x.length > 0);
  const out: CalendarEvent = { id: String(e.id || ""), summary: String(e.summary || "(no title)"), start, end, attendees };
  if (typeof e.location === "string" && e.location) out.location = e.location;
  if (typeof e.description === "string" && e.description) out.description = e.description;
  return out;
}

function defaultWindow(): { timeMin: string; timeMax: string } {
  const now = new Date();
  const max = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { timeMin: now.toISOString(), timeMax: max.toISOString() };
}

export async function listCalendarEvents(
  accountId: string,
  timeMin?: string,
  timeMax?: string,
): Promise<
  | { ok: true; connected: boolean; email?: string; events: CalendarEvent[] }
  | { ok: false; error: string; message: string }
> {
  const row = getGoogleToken(accountId);
  if (!row) return notConnectedResult();
  const win = defaultWindow();
  const min = timeMin || win.timeMin;
  const max = timeMax || win.timeMax;
  const params = new URLSearchParams({
    timeMin: min,
    timeMax: max,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  const r = await googleFetch(
    accountId,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
  );
  if (!r.ok) return toGoogleError(r);
  const data = (await r.data.json()) as { items?: any[] };
  return {
    ok: true,
    connected: true,
    email: row.email,
    events: (data.items || []).map(toCalendarEvent),
  };
}

// --- Proactive channel check (contract: see proactive.ts) ---
// Calendar events starting within the next 24 hours, for the scheduler
// to diff against seen_state. An unconnected Calendar returns [] — the
// channel exists and is available, it is simply quiet. Any Google error
// also returns [] here (never throws into the scheduler); the detail is
// logged by listCalendarEvents/googleFetch already.
export async function checkChannelItems(
  accountId: string,
): Promise<Array<{ id: string; summary: string; detail?: string }>> {
  if (!getGoogleToken(accountId)) return [];
  const now = new Date();
  const max = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const r = await listCalendarEvents(accountId, now.toISOString(), max.toISOString());
  if (!r.ok) return [];
  return r.events.map((e) => ({
    id: `${e.id}:${e.start}`,
    summary: e.summary,
    detail: e.location ? `${e.start} — ${e.location}` : e.start,
  }));
}

export async function bookCalendarEvent(
  accountId: string,
  input: { title?: string; start?: string; end?: string; description?: string; location?: string; attendees?: string[] },
): Promise<
  | { ok: true; event: CalendarEvent }
  | { ok: false; error: string; message: string }
> {
  const row = getGoogleToken(accountId);
  if (!row) return notConnectedResult();
  const title = String(input.title || "").trim();
  const start = String(input.start || "").trim();
  const end = String(input.end || "").trim();
  if (!title || !start || !end) {
    return {
      ok: false,
      error: "missing_fields",
      message: "A booking needs a title, a start time, and an end time.",
    };
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
    return {
      ok: false,
      error: "bad_time",
      message: "Those start and end times don't parse as dates. Use a full date and time, like 2026-11-20T14:00:00-06:00.",
    };
  }
  if (endMs <= startMs) {
    return { ok: false, error: "bad_time", message: "The end time has to be after the start time." };
  }
  const attendees = (input.attendees || [])
    .map((a) => String(a).trim())
    .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a))
    .map((email) => ({ email }));
  const body: Record<string, unknown> = {
    summary: title,
    start: { dateTime: new Date(startMs).toISOString() },
    end: { dateTime: new Date(endMs).toISOString() },
  };
  if (input.description) body.description = String(input.description);
  if (input.location) body.location = String(input.location);
  if (attendees.length) body.attendees = attendees;
  const r = await googleFetch(
    accountId,
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) return toGoogleError(r);
  const data = (await r.data.json()) as any;
  return { ok: true, event: toCalendarEvent(data) };
}

export async function cancelCalendarEvent(
  accountId: string,
  eventId: string,
): Promise<{ ok: true; cancelled: boolean } | { ok: false; error: string; message: string }> {
  const row = getGoogleToken(accountId);
  if (!row) return notConnectedResult();
  const id = String(eventId || "").trim();
  if (!id) return { ok: false, error: "missing_fields", message: "An event id is needed to cancel." };
  const r = await googleFetch(
    accountId,
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!r.ok) return toGoogleError(r);
  return { ok: true, cancelled: true };
}

export async function freeBusy(
  accountId: string,
  timeMin?: string,
  timeMax?: string,
): Promise<
  | { ok: true; connected: boolean; email?: string; busy: { start: string; end: string }[] }
  | { ok: false; error: string; message: string }
> {
  const row = getGoogleToken(accountId);
  if (!row) return notConnectedResult();
  const win = defaultWindow();
  const r = await googleFetch(accountId, "https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      timeMin: timeMin || win.timeMin,
      timeMax: timeMax || win.timeMax,
      items: [{ id: "primary" }],
    }),
  });
  if (!r.ok) return toGoogleError(r);
  const data = (await r.data.json()) as { calendars?: Record<string, { busy?: { start: string; end: string }[] }> };
  const busy = data.calendars?.primary?.busy || [];
  return {
    ok: true,
    connected: true,
    email: row.email,
    busy: busy.map((b) => ({ start: b.start, end: b.end })),
  };
}

// --- Drive -------------------------------------------------------------

export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
};

function toDriveFile(f: any): DriveFile {
  return {
    id: String(f.id || ""),
    name: String(f.name || "(no name)"),
    mimeType: String(f.mimeType || ""),
    modifiedTime: String(f.modifiedTime || ""),
  };
}

const READABLE_TEXT_MIME = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/html",
  "application/json",
]);

const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const GOOGLE_SLIDES_MIME = "application/vnd.google-apps.presentation";

const MAX_READ_CHARS = 100_000;

export async function searchDrive(
  accountId: string,
  q?: string,
): Promise<
  | { ok: true; connected: boolean; email?: string; files: DriveFile[] }
  | { ok: false; error: string; message: string }
> {
  const row = getGoogleToken(accountId);
  if (!row) return notConnectedResult();
  const query = String(q || "").trim();
  const params = new URLSearchParams({
    fields: "files(id,name,mimeType,modifiedTime)",
    pageSize: "20",
    orderBy: "modifiedTime desc",
  });
  if (query) {
    // Drive query language: escape a single quote by doubling it.
    const escaped = query.replace(/'/g, "\\'");
    params.set("q", `name contains '${escaped}' and trashed = false`);
  } else {
    params.set("q", "trashed = false");
  }
  const r = await googleFetch(
    accountId,
    `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
  );
  if (!r.ok) return toGoogleError(r);
  const data = (await r.data.json()) as { files?: any[] };
  return {
    ok: true,
    connected: true,
    email: row.email,
    files: (data.files || []).map(toDriveFile),
  };
}

export async function readDriveFile(
  accountId: string,
  fileId: string,
): Promise<
  | { ok: true; readable: true; file: DriveFile; content: string; truncated: boolean }
  | { ok: true; readable: false; file: DriveFile; message: string }
  | { ok: false; error: string; message: string }
> {
  const row = getGoogleToken(accountId);
  if (!row) return notConnectedResult();
  const id = String(fileId || "").trim();
  if (!id) return { ok: false, error: "missing_fields", message: "A file id is needed to read a file." };
  const metaRes = await googleFetch(
    accountId,
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,name,mimeType,modifiedTime,size`,
  );
  if (!metaRes.ok) return toGoogleError(metaRes);
  const meta = (await metaRes.data.json()) as any;
  const file = toDriveFile(meta);
  let url: string | null = null;
  if (file.mimeType === GOOGLE_DOC_MIME || file.mimeType === GOOGLE_SLIDES_MIME) {
    url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text%2Fplain`;
  } else if (file.mimeType === GOOGLE_SHEET_MIME) {
    url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}/export?mimeType=text%2Fcsv`;
  } else if (READABLE_TEXT_MIME.has(file.mimeType)) {
    url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`;
  } else {
    // Never invent content for a file type this step cannot read as text.
    return {
      ok: true,
      readable: false,
      file,
      message: "This file type cannot be read as text.",
    };
  }
  const contentRes = await googleFetch(accountId, url);
  if (!contentRes.ok) return toGoogleError(contentRes);
  const text = await contentRes.data.text();
  const truncated = text.length > MAX_READ_CHARS;
  return {
    ok: true,
    readable: true,
    file,
    content: truncated ? text.slice(0, MAX_READ_CHARS) : text,
    truncated,
  };
}
