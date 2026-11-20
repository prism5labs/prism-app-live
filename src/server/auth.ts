// Google sign-in for the Prism app itself: a person, not a device.
//
// Until now an account was only a device-generated id stored in
// localStorage and sent as X-Account-Id. The server created the account
// on first sight, and everything — owned Photons, threads, meter, Gmail
// and Outlook connections, imported memory — hung off that device id.
// Clearing browser data, losing the phone, or switching devices lost the
// account, and there was no way back in.
//
// This module signs the owner in with Google (the same OAuth client the
// app already uses for Gmail — no new service, no new cost) and links
// their Google identity to their Prism account id. After that the
// account follows the person: sign in on any device and the same
// Photons, chats, and purchases are there. The device id becomes the
// permanent account id on first sign-in, so nothing moves and nothing
// is lost. If the Google identity already maps to a different account
// id (a second device, or a browser that cleared its storage), the
// device's data migrates into the Google-linked account instead.
//
// The sign-in rides the SAME registered redirect URI as Gmail
// (/api/oauth/google/callback) so nothing has to be registered in the
// Google Cloud console: the state tells the flows apart
// ("<deviceAccountId>:signin"). Scopes are only openid, email, profile
// — identity, nothing else. No Google API access is taken.
//
// Sessions: the callback does not hand the account id back in the URL.
// It mints a one-time session token (10 minutes), the client exchanges
// it once for the account id, and the token is spent. The account id
// itself is still the only credential after that, same as before.
// Recovery: because that token can be spent in a different browsing
// context than the installed app (see recoverSignin), the callback
// also records device id -> account id at link time, so any context
// holding the device id can find its account again without signing in
// a second time.
//
// Perks, created when an account is first linked:
//   - A backstory for every Photon (src/shared/backstories.ts), rendered
//     with the owner's name and the day they met. Display only, never
//     read into a chat system prompt.
//   - A welcome offer: 15% off the first order, code WELCOME15, valid
//     10 days from account creation. The code is a real Stripe promotion
//     code (created once in the Stripe dashboard); the app enforces the
//     10-day window by only showing and prefilling it while it is
//     active, and Stripe enforces first-time-transaction on the code
//     itself. The webhook marks the perk used when a discounted
//     checkout lands.

import { db, getOrCreateAccount, setUpkeep } from "./db";
import { config, googleConfigured, isOwnerEmail } from "./config";
import { BACKSTORIES, ATOM_BACKSTORIES, renderBackstory } from "../shared/backstories";
import { PHOTON_NAMES } from "../shared/photons";
import { ATOM_NAMES } from "../shared/atoms";

// --- Tables (created here, in this module, at import) ---
db.exec(`
CREATE TABLE IF NOT EXISTS google_identities (
  google_sub TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  refresh_token TEXT,
  created_at TEXT NOT NULL,
  last_signin_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_google_identities_account ON google_identities (account_id);
CREATE TABLE IF NOT EXISTS signin_sessions (
  token TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  is_new INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
-- Sign-in links: which account a device id was linked to, and when.
-- The OAuth callback records this at link time, before any token is
-- spent, so a device can always find its account again — even when the
-- callback (and its one-time token) was spent in a different browsing
-- context than the one that asked to sign in. See recoverSignin below.
CREATE TABLE IF NOT EXISTS signin_links (
  device_account_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Sign-in starts: which origin the installed app was on when a sign-in
-- began. The OAuth callback always lands on the single registered
-- redirect URI (the Render origin), so the return has to be routed back
-- to the origin the sign-in started from — that is the installed app's
-- origin. A row lives 30 minutes and is spent on first read, so a stale
-- start can never steer a later sign-in.
CREATE TABLE IF NOT EXISTS signin_starts (
  device_account_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_perks (
  account_id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_session TEXT
);
CREATE TABLE IF NOT EXISTS photon_backstories (
  account_id TEXT NOT NULL,
  photon TEXT NOT NULL,
  template TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, photon)
);
-- An Atom's backstory, the same welcome material as a Photon's (Nov 19,
-- 2026): one row per Atom, created when the account is first linked.
-- A separate table, not the photon one: the column is named "photon"
-- there, and an Atom's name in it would be a lie the next reader has
-- to untangle. Same shape, same rules.
CREATE TABLE IF NOT EXISTS atom_backstories (
  account_id TEXT NOT NULL,
  atom TEXT NOT NULL,
  template TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, atom)
);
`);

export const PERK_CODE = "WELCOME15";
export const PERK_PERCENT = 15;
export const PERK_DAYS = 10;
export const SIGNIN_SESSION_TTL_MS = 10 * 60 * 1000;

const SIGNIN_SCOPES = ["openid", "email", "profile"];

// --- OAuth: sign-in URL (same client and redirect URI as Gmail) ---

export function authUrlSignin(deviceAccountId: string): string | null {
  if (!googleConfigured()) return null;
  const params = new URLSearchParams({
    client_id: config.googleClientId,
    redirect_uri: config.googleRedirectUri,
    response_type: "code",
    scope: SIGNIN_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state: `${deviceAccountId}:signin`,
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

export type GoogleIdentity = {
  sub: string;
  email: string;
  name: string | null;
};

// --- Perks + backstories (created once, when an account is first linked) ---

function createPerk(accountId: string): void {
  const now = new Date();
  const expires = new Date(now.getTime() + PERK_DAYS * 24 * 60 * 60 * 1000);
  db.query(
    `INSERT OR IGNORE INTO account_perks (account_id, code, created_at, expires_at, used_at, used_session)
     VALUES (?, ?, ?, ?, NULL, NULL)`,
  ).run(accountId, PERK_CODE, now.toISOString(), expires.toISOString());
}

function createBackstories(accountId: string): void {
  const now = new Date().toISOString();
  for (const photon of PHOTON_NAMES) {
    const template = BACKSTORIES[photon];
    if (!template) continue;
    db.query(
      `INSERT OR IGNORE INTO photon_backstories (account_id, photon, template, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(accountId, photon, template, now);
  }
}

// An Atom's backstories, created alongside the Photons' at account
// linking — the same welcome material, one row per Atom. INSERT OR
// IGNORE, so calling it twice (linking, then a backfill) never
// duplicates a row.
function createAtomBackstories(accountId: string): void {
  const now = new Date().toISOString();
  for (const atom of ATOM_NAMES) {
    const template = ATOM_BACKSTORIES[atom];
    if (!template) continue;
    db.query(
      `INSERT OR IGNORE INTO atom_backstories (account_id, atom, template, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run(accountId, atom, template, now);
  }
}

export type Perk = {
  code: string;
  percent: number;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  active: boolean;
};

export function getPerk(accountId: string): Perk | null {
  const row = db
    .query(`SELECT code, created_at, expires_at, used_at FROM account_perks WHERE account_id = ?`)
    .get(accountId) as
    | { code: string; created_at: string; expires_at: string; used_at: string | null }
    | null;
  if (!row) return null;
  const active = !row.used_at && Date.now() < Date.parse(row.expires_at);
  return {
    code: row.code,
    percent: PERK_PERCENT,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    active,
  };
}

// Mark the welcome perk used after a discounted checkout lands.
// Returns true when this call spent the perk, false when it was
// already used or never existed.
export function markPerkUsed(accountId: string, sessionId: string): boolean {
  const now = new Date().toISOString();
  const info = db
    .query(
      `UPDATE account_perks SET used_at = ?, used_session = ?
       WHERE account_id = ? AND used_at IS NULL`,
    )
    .run(now, sessionId, accountId);
  return info.changes > 0;
}

export type AuthStatus = {
  signedIn: boolean;
  email?: string | null;
  name?: string | null;
  since?: string | null;
  lastSigninAt?: string | null;
};

export function authStatus(accountId: string): AuthStatus {
  const row = db
    .query(
      `SELECT email, name, created_at, last_signin_at FROM google_identities WHERE account_id = ?`,
    )
    .get(accountId) as
    | { email: string; name: string | null; created_at: string; last_signin_at: string }
    | null;
  if (!row) return { signedIn: false };
  return {
    signedIn: true,
    email: row.email,
    name: row.name,
    since: row.created_at,
    lastSigninAt: row.last_signin_at,
  };
}

// Backstories for this account, rendered with the owner's name and the
// day the account was created. Empty when the account never signed in:
// the stories are an account-creation perk, not a device perk. Photons
// and Atoms both: the two rosters share one map (the names are distinct),
// so no surface carries one roster's welcome without the other's.
// Backfill: an account linked before the Atoms existed has Photon rows
// and no Atom rows — the Atom rows are created on first read, so the
// welcome is whole without a migration run.
export function getBackstories(
  accountId: string,
  ownerName: string,
  sinceIso: string,
): Record<string, string> {
  const atomCount = (
    db.query(`SELECT COUNT(*) AS n FROM atom_backstories WHERE account_id = ?`).get(accountId) as { n: number }
  ).n;
  const photonCount = (
    db.query(`SELECT COUNT(*) AS n FROM photon_backstories WHERE account_id = ?`).get(accountId) as { n: number }
  ).n;
  if (photonCount > 0 && atomCount === 0) createAtomBackstories(accountId);
  const rows = db
    .query(`SELECT photon, template FROM photon_backstories WHERE account_id = ?`)
    .all(accountId) as { photon: string; template: string }[];
  const out: Record<string, string> = {};
  for (const row of rows) out[row.photon] = renderBackstory(row.template, ownerName, sinceIso);
  const atomRows = db
    .query(`SELECT atom, template FROM atom_backstories WHERE account_id = ?`)
    .all(accountId) as { atom: string; template: string }[];
  for (const row of atomRows) out[row.atom] = renderBackstory(row.template, ownerName, sinceIso);
  return out;
}

// --- Migration: move one device account's data into another account ---
//
// Used when a Google identity already maps to a different account id
// (a second device, or a browser that cleared its storage). Every row
// keyed by the old id moves to the new id. Where the new account
// already has a row for the same thing, the new account's row wins and
// the old one is dropped — nothing is ever duplicated. The accounts
// row itself merges: the earlier creation date, the union of upkeep and
// free-code flags, the custom name when the new account has none, and
// the sum of this month's meter when both used chats this month.

const MIGRATABLE_TABLES = [
  "owned",
  "threads",
  "messages",
  "gmail_accounts",
  "outlook_accounts",
  "facebook_pages",
  "profile",
  "imported_memory",
  "customizations",
  "contacts",
  "google_tokens",
  "stripe_payments",
  "texts",
  "calls",
  "seen_state",
  "reminders",
  "push_subscriptions",
  "day_items",
  "google_identities",
  "account_perks",
  "photon_backstories",
  "atom_backstories",
];

function moveTable(table: string, fromId: string, toId: string): number {
  const info = db.query(`PRAGMA table_info("${table}")`).all() as any[];
  const cols = info.map((c) => c.name);
  if (!cols.includes("account_id")) return 0;
  // Two shapes, and the wrong one loses rows. When the primary key
  // includes account_id, copying the row under the new id can only
  // clash with a row the new account already has (the new account
  // wins, the old one is dropped). When the primary key does NOT
  // include account_id — a message id, a reminder id, a Google sub —
  // copying the row under the same key clashes with the row itself, so
  // the copy is skipped and the delete that follows destroys it. Those
  // tables move with a plain UPDATE instead: the key never changes, so
  // nothing can clash.
  const pkIncludesAccount = info.some((c) => c.pk > 0 && c.name === "account_id");
  if (!pkIncludesAccount) {
    const updated = db
      .query(`UPDATE "${table}" SET account_id = ? WHERE account_id = ?`)
      .run(toId, fromId);
    return updated.changes;
  }
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const selectList = cols.map((c) => (c === "account_id" ? "?" : `"${c}"`)).join(", ");
  const inserted = db
    .query(
      `INSERT OR IGNORE INTO "${table}" (${colList}) SELECT ${selectList} FROM "${table}" WHERE account_id = ?`,
    )
    .run(toId, fromId);
  db.query(`DELETE FROM "${table}" WHERE account_id = ?`).run(fromId);
  return inserted.changes;
}

export function migrateAccount(fromId: string, toId: string): { moved: number; merged: boolean } {
  if (fromId === toId) return { moved: 0, merged: false };
  getOrCreateAccount(toId);
  const from = db.query(`SELECT * FROM accounts WHERE id = ?`).get(fromId) as any;
  const to = db.query(`SELECT * FROM accounts WHERE id = ?`).get(toId) as any;
  let moved = 0;
  db.transaction(() => {
    for (const table of MIGRATABLE_TABLES) moved += moveTable(table, fromId, toId);
    if (from && to) {
      const createdAt = from.created_at < to.created_at ? from.created_at : to.created_at;
      const customName = to.custom_name || from.custom_name || null;
      const upkeep = to.upkeep === 1 || from.upkeep === 1 ? 1 : 0;
      const upkeepSince = to.upkeep_since || from.upkeep_since || null;
      const freeCode = to.free_code === 1 || from.free_code === 1 ? 1 : 0;
      const sameMonth = from.meter_month === to.meter_month;
      const meterUsed = sameMonth ? to.meter_used + from.meter_used : to.meter_used;
      const meterMonth = to.meter_month;
      db.query(
        `UPDATE accounts SET created_at = ?, custom_name = ?, upkeep = ?, upkeep_since = ?,
         free_code = ?, meter_used = ?, meter_month = ? WHERE id = ?`,
      ).run(createdAt, customName, upkeep, upkeepSince, freeCode, meterUsed, meterMonth, toId);
    }
    db.query(`DELETE FROM accounts WHERE id = ?`).run(fromId);
  })();
  return { moved, merged: !!from };
}

// --- Sign-in recovery: find the account a device id was linked to ---
//
// WHY THIS EXISTS. The sign-in is a full-page navigation out of the
// app to accounts.google.com, and the OAuth callback hands the result
// back as a one-time session token in a URL, spent by whichever
// browsing context loads that URL. On Android the installed PWA's
// navigation is diverted to a browser tab (a Custom Tab, with its own
// bar and X): the callback loads there, the token is spent there, and
// the linked account id is written to that tab's storage — never to
// the installed app's. The token is single-use, so there is no second
// spend. The installed app keeps its old anonymous device id, and if
// that id was already migrated into the linked account (the identity
// was linked before, from another context), the server has deleted
// the anonymous account row — so the app recreates itself as a fresh
// anonymous account on every open, and every sign-in replays the same
// loop. That is the "must reconnect Google every time" report.
//
// The fix is server-side and does not depend on which context spent
// the token: at link time the callback records device id -> account
// id here. Any context holding that device id can ask for its account
// and adopt it. The device id is already the whole credential for the
// account (it is sent as X-Account-Id on every call), so revealing the
// linked account id to its holder exposes nothing new.
//
// A link is recorded on every sign-in, new identity or known one, so
// recovery also covers a device whose id changed after a successful
// sign-in (reinstall, cleared storage).

export function recordSigninLink(deviceAccountId: string, accountId: string): void {
  db.query(
    `INSERT INTO signin_links (device_account_id, account_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(device_account_id) DO UPDATE SET account_id = excluded.account_id, created_at = excluded.created_at`,
  ).run(deviceAccountId, accountId, new Date().toISOString());
}

// --- Sign-in start origin: route the return back to the installed app --
//
// WHY THIS EXISTS. The sign-in leaves the installed app for Google and
// the callback comes back on the single registered redirect URI, which
// is the Render origin — not necessarily the origin the app was
// installed from. A bare redirect from the callback to the app URL
// stays in the browser tab (a Custom Tab, with its bar and X): a
// redirect is not a user gesture, so Android never hands it to the
// installed app. The return has to be a tap: a plain link to an
// in-scope URL, tapped by the owner, is routed by Android's intent
// filters to the installed app window. So the callback sends the owner
// to a small return page on the origin the sign-in started from, and
// that page's button is the tap that opens the app. The page carries
// the one-time session token in its link, exactly as the old redirect
// did, and the app spends it on arrival as before.
const SIGNIN_START_TTL_MS = 30 * 60 * 1000;

export function recordSigninStart(deviceAccountId: string, origin: string): void {
  if (!/^https?:\/\/[^\/]+$/.test(origin)) return;
  db.query(`DELETE FROM signin_starts WHERE created_at < ?`).run(
    new Date(Date.now() - SIGNIN_START_TTL_MS).toISOString(),
  );
  db.query(
    `INSERT INTO signin_starts (device_account_id, origin, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(device_account_id) DO UPDATE SET origin = excluded.origin, created_at = excluded.created_at`,
  ).run(deviceAccountId, origin, new Date().toISOString());
}

// Take the recorded start origin for a device id, if one is still
// fresh. Consumed on first read, so a later sign-in is never steered
// by an old start.
export function takeSigninStart(deviceAccountId: string): string | null {
  const row = db
    .query(`SELECT origin, created_at FROM signin_starts WHERE device_account_id = ?`)
    .get(deviceAccountId) as { origin: string; created_at: string } | null;
  if (!row) return null;
  db.query(`DELETE FROM signin_starts WHERE device_account_id = ?`).run(deviceAccountId);
  if (Date.now() - new Date(row.created_at).getTime() > SIGNIN_START_TTL_MS) return null;
  return row.origin;
}

export function lookupSigninLink(deviceAccountId: string): string | null {
  const row = db
    .query(`SELECT account_id FROM signin_links WHERE device_account_id = ?`)
    .get(deviceAccountId) as { account_id: string } | null;
  return row ? row.account_id : null;
}

// Recover the account for a device id: the linked account id, or null
// when this device never signed in. When the device id is not the
// account id, finishing the migration this device started — moving any
// rows that landed under the orphaned device id (Calendar/Drive tokens
// connected while the app was orphaned, chats, meter) into the linked
// account — is part of the recovery, so the services work under the
// adopted id instead of staying stranded under the old one.
export function recoverSignin(deviceAccountId: string): string | null {
  const accountId = lookupSigninLink(deviceAccountId);
  if (!accountId) return null;
  if (accountId !== deviceAccountId) migrateAccount(deviceAccountId, accountId);
  return accountId;
}

// --- Link a Google identity to a Prism account ---
//
// The device account id becomes the permanent account id when the
// Google identity is new. When the identity already maps to another
// account id, the device's data migrates into that account instead.
// Returns the account id the browser should use from here on.

export function linkGoogleIdentity(
  deviceAccountId: string,
  identity: GoogleIdentity,
  refreshToken: string | null,
): { accountId: string; isNew: boolean; migrated: number } {
  const now = new Date().toISOString();
  const existing = db
    .query(`SELECT account_id FROM google_identities WHERE google_sub = ?`)
    .get(identity.sub) as { account_id: string } | null;
  if (existing) {
    const accountId = existing.account_id;
    let migrated = 0;
    if (deviceAccountId !== accountId) {
      migrated = migrateAccount(deviceAccountId, accountId).moved;
    }
    db.query(
      `UPDATE google_identities SET email = ?, name = ?, last_signin_at = ?
       WHERE google_sub = ?`,
    ).run(identity.email, identity.name, now, identity.sub);
    if (refreshToken) {
      db.query(`UPDATE google_identities SET refresh_token = ? WHERE google_sub = ?`).run(
        refreshToken,
        identity.sub,
      );
    }
    // Owner grant: an owner signing in gets Upkeep free, so the app
    // can be tested with the upgraded features. A re-sign-in re-grants.
    if (isOwnerEmail(identity.email)) setUpkeep(accountId, true);
    recordSigninLink(deviceAccountId, accountId);
    return { accountId, isNew: false, migrated };
  }
  getOrCreateAccount(deviceAccountId);
  db.query(
    `INSERT INTO google_identities (google_sub, account_id, email, name, refresh_token, created_at, last_signin_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    identity.sub,
    deviceAccountId,
    identity.email,
    identity.name,
    refreshToken,
    now,
    now,
  );
  createPerk(deviceAccountId);
  createBackstories(deviceAccountId);
  createAtomBackstories(deviceAccountId);
  // Owner grant: see the existing-identity branch above.
  if (isOwnerEmail(identity.email)) setUpkeep(deviceAccountId, true);
  recordSigninLink(deviceAccountId, deviceAccountId);
  return { accountId: deviceAccountId, isNew: true, migrated: 0 };
}

// --- One-time session: the callback mints it, the client spends it once ---

export function createSigninSession(accountId: string, isNew: boolean): string {
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  const now = new Date();
  const expires = new Date(now.getTime() + SIGNIN_SESSION_TTL_MS);
  db.query(
    `INSERT INTO signin_sessions (token, account_id, is_new, created_at, expires_at, used)
     VALUES (?, ?, ?, ?, ?, 0)`,
  ).run(token, accountId, isNew ? 1 : 0, now.toISOString(), expires.toISOString());
  return token;
}

// Spend a session token. Returns the account id and whether this
// sign-in created the account, or null when the token is unknown,
// already spent, or expired.
export function exchangeSigninSession(token: string): { accountId: string; isNew: boolean } | null {
  const row = db
    .query(`SELECT account_id, is_new, expires_at, used FROM signin_sessions WHERE token = ?`)
    .get(token) as
    | { account_id: string; is_new: number; expires_at: string; used: number }
    | null;
  if (!row || row.used === 1) return null;
  if (Date.now() > Date.parse(row.expires_at)) return null;
  db.query(`UPDATE signin_sessions SET used = 1 WHERE token = ?`).run(token);
  return { accountId: row.account_id, isNew: row.is_new === 1 };
}

// --- The OAuth callback: code + state -> linked account + session ---

export async function handleSigninCallback(
  code: string,
  state: string,
): Promise<
  | { ok: true; accountId: string; email: string; name: string | null; isNew: boolean; sessionToken: string }
  | { ok: false; error: string }
> {
  const [deviceAccountId, kind] = state.split(":");
  if (!deviceAccountId || kind !== "signin") {
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
    if (!tokens.access_token) return { ok: false, error: "no_access_token" };
    // Who is this? Ask Google for the profile behind the token.
    const meRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!meRes.ok) return { ok: false, error: "profile_failed" };
    const me = (await meRes.json()) as { id?: string; sub?: string; email?: string; name?: string };
    const sub = me.sub || me.id || "";
    const email = me.email || "";
    if (!sub || !email) return { ok: false, error: "profile_failed" };
    const linked = linkGoogleIdentity(
      deviceAccountId,
      { sub, email, name: me.name || null },
      tokens.refresh_token || null,
    );
    const sessionToken = createSigninSession(linked.accountId, linked.isNew);
    return {
      ok: true,
      accountId: linked.accountId,
      email,
      name: me.name || null,
      isNew: linked.isNew,
      sessionToken,
    };
  } catch (e) {
    console.error("App sign-in callback failed:", e);
    return { ok: false, error: "oauth_failed" };
  }
}
