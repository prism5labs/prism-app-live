// SQLite storage (bun:sqlite, zero dependencies). One database file per
// deployment at <DATA_DIR>/app.db. On Render's free tier the disk is
// ephemeral: chat history, unlocks, and Upkeep flags reset when the service
// redeploys or restarts. That is the known free-tier limit, same as before.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { PHOTON_NAMES } from "../shared/photons";
import { VOICES, LOOK_SETS } from "../shared/voices";

const VOICE_IDS = new Set(VOICES.map((v) => v.id));
const LOOK_SET_IDS = new Set(LOOK_SETS.map((s) => s.id));

mkdirSync(config.dataDir, { recursive: true });
const dbPath = join(config.dataDir, "app.db");
export const db = new Database(dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  custom_name TEXT,
  upkeep INTEGER NOT NULL DEFAULT 0,
  upkeep_since TEXT,
  free_code INTEGER NOT NULL DEFAULT 0,
  meter_used INTEGER NOT NULL DEFAULT 0,
  meter_month TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS owned (
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind, ref)
);
CREATE TABLE IF NOT EXISTS threads (
  account_id TEXT NOT NULL,
  photon TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, photon)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  photon TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (account_id, photon, id);
CREATE TABLE IF NOT EXISTS gmail_accounts (
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  token_expiry INTEGER,
  PRIMARY KEY (account_id, label)
);
-- Outlook accounts (Microsoft Graph), same shape as Gmail: one row per
-- connected mailbox, labelled outlook-1, outlook-2, ... so anyone can add
-- as many Outlook accounts as they like. Tokens are stored the same way
-- as Gmail refresh tokens and are never sent back to the client.
CREATE TABLE IF NOT EXISTS outlook_accounts (
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  email TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  token_expiry INTEGER,
  PRIMARY KEY (account_id, label)
);
-- Facebook Pages connected from the app. A Page access token is pasted in
-- by the owner (from Meta's developer console) and stored here, the same
-- way Gmail refresh tokens are stored. The token is never sent back to
-- the client: the app only ever sees the page id and name. The server's
-- own Page (META_PAGE_ID / META_PAGE_ACCESS_TOKEN) still works on its own
-- and is the fallback when no Page is connected here.
CREATE TABLE IF NOT EXISTS facebook_pages (
  account_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  page_name TEXT NOT NULL,
  access_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, page_id)
);
-- About you: what the owner tells Prism about themselves, so the Photons
-- know them instead of starting cold. One row per account. This is the
-- owner's own words, stored on the server for their account only, and it
-- is never shared with anyone else. It is read into the chat system
-- prompt, so the Photons actually know it.
CREATE TABLE IF NOT EXISTS profile (
  account_id TEXT PRIMARY KEY,
  display_name TEXT,
  about TEXT,
  preferences TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
);
-- Memory imported from other AIs, so the owner keeps continuity and does
-- not start over. One row per imported file. The content is the parsed
-- transcript (or the notes, for a Markdown or text file), capped when it
-- is stored. A short digest of the most recent imports is read into the
-- chat system prompt as background, never as instructions.
CREATE TABLE IF NOT EXISTS imported_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imported_memory_account ON imported_memory (account_id, imported_at);
CREATE TABLE IF NOT EXISTS customizations (
  account_id TEXT NOT NULL,
  photon TEXT NOT NULL,
  face_name TEXT,
  voice TEXT NOT NULL DEFAULT 'house',
  voice_tuning TEXT,
  look_set TEXT,
  portrait TEXT,
  step INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, photon)
);
-- Switchboard contacts (Nov 15, 2026): who a Photon may email. A contact
-- starts pending: the recipient gets a connection request by email and taps
-- Approve or Decline, like a friend request. Only an approved contact can
-- receive a Switchboard send. The token is the unguessable part of the
-- approve/decline links in the request email.
CREATE TABLE IF NOT EXISTS contacts (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  photon TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  request_sent_at TEXT,
  decided_at TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX IF NOT EXISTS idx_contacts_address ON contacts (account_id, address);
`);

export const MONTH_LIMIT = 300;

export type Account = {
  id: string;
  created_at: string;
  custom_name: string | null;
  upkeep: boolean;
  upkeep_since: string | null;
  free_code: boolean;
  meter_used: number;
  meter_month: string;
};

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function rowToAccount(row: any): Account {
  return {
    id: row.id,
    created_at: row.created_at,
    custom_name: row.custom_name,
    upkeep: row.upkeep === 1,
    upkeep_since: row.upkeep_since,
    free_code: row.free_code === 1,
    meter_used: row.meter_used,
    meter_month: row.meter_month,
  };
}

export function getOrCreateAccount(id: string): Account {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO accounts (id, created_at, meter_month) VALUES (?, ?, ?)`,
  ).run(id, now, currentMonth());
  let row = db.query(`SELECT * FROM accounts WHERE id = ?`).get(id) as any;
  // Month rollover: a new month resets the meter.
  if (row.meter_month !== currentMonth()) {
    db.query(`UPDATE accounts SET meter_used = 0, meter_month = ? WHERE id = ?`).run(
      currentMonth(),
      id,
    );
    row = db.query(`SELECT * FROM accounts WHERE id = ?`).get(id) as any;
  }
  return rowToAccount(row);
}

export function setCustomName(accountId: string, name: string | null): void {
  db.query(`UPDATE accounts SET custom_name = ? WHERE id = ?`).run(name, accountId);
}

export function setUpkeep(accountId: string, on: boolean): void {
  const now = new Date().toISOString();
  if (on) {
    db.query(`UPDATE accounts SET upkeep = 1, upkeep_since = ? WHERE id = ?`).run(now, accountId);
  } else {
    db.query(`UPDATE accounts SET upkeep = 0, upkeep_since = NULL WHERE id = ?`).run(accountId);
  }
}

export function isUnlimited(a: Account): boolean {
  return a.free_code || a.upkeep;
}

export function meterState(a: Account): { used: number; limit: number; unlimited: boolean } {
  return { used: a.meter_used, limit: MONTH_LIMIT, unlimited: isUnlimited(a) };
}

export function incrementMeter(accountId: string): void {
  db.query(`UPDATE accounts SET meter_used = meter_used + 1 WHERE id = ?`).run(accountId);
}

export function getOwned(accountId: string): { photons: string[]; products: string[] } {
  const rows = db
    .query(`SELECT kind, ref FROM owned WHERE account_id = ?`)
    .all(accountId) as { kind: string; ref: string }[];
  const photons = rows.filter((r) => r.kind === "photon").map((r) => r.ref);
  const products = rows.filter((r) => r.kind === "product").map((r) => r.ref);
  return { photons, products };
}

export function ownsPhoton(accountId: string, photon: string): boolean {
  const a = getOrCreateAccount(accountId);
  if (a.free_code) return true;
  const row = db
    .query(`SELECT 1 AS x FROM owned WHERE account_id = ? AND kind = 'photon' AND ref = ?`)
    .get(accountId, photon) as any;
  return !!row;
}

export function ownPhoton(accountId: string, photon: string): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at) VALUES (?, 'photon', ?, ?)`,
  ).run(accountId, photon, now);
}

export function ownProduct(accountId: string, ref: string): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at) VALUES (?, 'product', ?, ?)`,
  ).run(accountId, ref, now);
}

export function redeemFreeCode(accountId: string): void {
  const now = new Date().toISOString();
  // The row must exist first: UPDATE touches zero rows on an account
  // the server has never seen (a redeem that arrives before the first
  // state call), and the flag would silently stay off while the
  // Photons still unlocked — the worst kind of half-redeem.
  getOrCreateAccount(accountId);
  db.query(`UPDATE accounts SET free_code = 1 WHERE id = ?`).run(accountId);
  for (const name of PHOTON_NAMES) ownPhoton(accountId, name);
  // The free code unlocks everything: all Photons and all catalog products.
  db.query(
    `INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at)
     SELECT ?, 'product', slug, ? FROM (SELECT 'supernova' AS slug UNION ALL SELECT 'satellite')`,
  ).run(accountId, now);
}

export type Customization = {
  photon: string;
  faceName: string | null;
  voice: string;
  tuning: Record<string, boolean> | null;
  lookSet: string | null;
  portrait: string | null;
  step: number;
  done: boolean;
};

function rowToCustomization(row: any): Customization {
  let tuning: Record<string, boolean> | null = null;
  if (row.voice_tuning) {
    try {
      tuning = JSON.parse(row.voice_tuning);
    } catch {
      tuning = null;
    }
  }
  return {
    photon: row.photon,
    faceName: row.face_name || null,
    voice: row.voice || "house",
    tuning,
    lookSet: row.look_set || null,
    portrait: row.portrait || null,
    step: row.step || 0,
    done: row.done === 1,
  };
}

// Null when the owner has never started customizing this Photon: chat
// behavior is unchanged until they do.
export function getCustomization(accountId: string, photon: string): Customization | null {
  const row = db
    .query(`SELECT * FROM customizations WHERE account_id = ? AND photon = ?`)
    .get(accountId, photon) as any;
  return row ? rowToCustomization(row) : null;
}

export function getCustomizations(accountId: string): Record<string, Customization> {
  const rows = db
    .query(`SELECT * FROM customizations WHERE account_id = ?`)
    .all(accountId) as any[];
  const out: Record<string, Customization> = {};
  for (const row of rows) out[row.photon] = rowToCustomization(row);
  return out;
}

export function saveCustomization(
  accountId: string,
  photon: string,
  patch: {
    faceName?: string | null;
    voice?: string;
    tuning?: Record<string, boolean> | null;
    lookSet?: string | null;
    portrait?: string | null;
    step?: number;
    done?: boolean;
  },
): Customization {
  const now = new Date().toISOString();
  const current = getCustomization(accountId, photon);
  const faceName =
    patch.faceName === undefined
      ? (current?.faceName ?? null)
      : patch.faceName === null
        ? null
        : String(patch.faceName).trim().slice(0, 40) || null;
  const voice =
    patch.voice !== undefined && VOICE_IDS.has(patch.voice) ? patch.voice : (current?.voice ?? "house");
  const tuning = patch.tuning === undefined ? (current?.tuning ?? null) : patch.tuning;
  const lookSet =
    patch.lookSet === undefined
      ? (current?.lookSet ?? null)
      : patch.lookSet === null
        ? null
        : LOOK_SET_IDS.has(patch.lookSet)
          ? patch.lookSet
          : (current?.lookSet ?? null);
  const portrait =
    patch.portrait === undefined
      ? (current?.portrait ?? null)
      : patch.portrait === null
        ? null
        : PHOTON_NAMES.includes(patch.portrait)
          ? patch.portrait
          : (current?.portrait ?? null);
  const step =
    patch.step === undefined ? (current?.step ?? 0) : Math.max(0, Math.min(3, Math.floor(patch.step)));
  const done = patch.done === undefined ? (current?.done ?? false) : !!patch.done;
  db.query(
    `INSERT INTO customizations (account_id, photon, face_name, voice, voice_tuning, look_set, portrait, step, done, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, photon) DO UPDATE SET
       face_name = excluded.face_name, voice = excluded.voice,
       voice_tuning = excluded.voice_tuning, look_set = excluded.look_set,
       portrait = excluded.portrait, step = excluded.step,
       done = excluded.done, updated_at = excluded.updated_at`,
  ).run(
    accountId,
    photon,
    faceName,
    voice,
    tuning ? JSON.stringify(tuning) : null,
    lookSet,
    portrait,
    step,
    done ? 1 : 0,
    now,
  );
  return getCustomization(accountId, photon) as Customization;
}

export type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export function getThread(accountId: string, photon: string): ChatMessage[] {
  const rows = db
    .query(
      `SELECT id, role, content, created_at FROM messages WHERE account_id = ? AND photon = ? ORDER BY id ASC`,
    )
    .all(accountId, photon) as any[];
  return rows.map((r) => ({ id: r.id, role: r.role, content: r.content, created_at: r.created_at }));
}

export function addMessage(
  accountId: string,
  photon: string,
  role: "user" | "assistant",
  content: string,
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO messages (account_id, photon, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, photon, role, content, now);
  db.query(
    `INSERT INTO threads (account_id, photon, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, photon) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(accountId, photon, now, now);
}

export type GmailAccount = {
  label: string;
  email: string;
  refresh_token: string;
  access_token: string | null;
  token_expiry: number | null;
};

export function setGmailAccount(
  accountId: string,
  label: string,
  email: string,
  refreshToken: string,
  accessToken: string | null,
  tokenExpiry: number | null,
): void {
  db.query(
    `INSERT INTO gmail_accounts (account_id, label, email, refresh_token, access_token, token_expiry)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, label) DO UPDATE SET
       email = excluded.email, refresh_token = excluded.refresh_token,
       access_token = excluded.access_token, token_expiry = excluded.token_expiry`,
  ).run(accountId, label, email, refreshToken, accessToken, tokenExpiry);
}

export function getGmailAccounts(accountId: string): GmailAccount[] {
  return db
    .query(`SELECT label, email, refresh_token, access_token, token_expiry FROM gmail_accounts WHERE account_id = ?`)
    .all(accountId) as GmailAccount[];
}

export function getGmailAccount(accountId: string, label: string): GmailAccount | null {
  const row = db
    .query(
      `SELECT label, email, refresh_token, access_token, token_expiry FROM gmail_accounts WHERE account_id = ? AND label = ?`,
    )
    .get(accountId, label) as GmailAccount | null;
  return row ?? null;
}

export function updateGmailAccessToken(
  accountId: string,
  label: string,
  accessToken: string,
  tokenExpiry: number,
): void {
  db.query(
    `UPDATE gmail_accounts SET access_token = ?, token_expiry = ? WHERE account_id = ? AND label = ?`,
  ).run(accessToken, tokenExpiry, accountId, label);
}

// --- Outlook accounts (Microsoft Graph) ---
export type OutlookAccount = {
  label: string;
  email: string;
  refresh_token: string;
  access_token: string | null;
  token_expiry: number | null;
};

export function setOutlookAccount(
  accountId: string,
  label: string,
  email: string,
  refreshToken: string,
  accessToken: string | null,
  tokenExpiry: number | null,
): void {
  db.query(
    `INSERT INTO outlook_accounts (account_id, label, email, refresh_token, access_token, token_expiry)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, label) DO UPDATE SET
       email = excluded.email, refresh_token = excluded.refresh_token,
       access_token = excluded.access_token, token_expiry = excluded.token_expiry`,
  ).run(accountId, label, email, refreshToken, accessToken, tokenExpiry);
}

export function getOutlookAccounts(accountId: string): OutlookAccount[] {
  return db
    .query(`SELECT label, email, refresh_token, access_token, token_expiry FROM outlook_accounts WHERE account_id = ?`)
    .all(accountId) as OutlookAccount[];
}

export function getOutlookAccount(accountId: string, label: string): OutlookAccount | null {
  const row = db
    .query(
      `SELECT label, email, refresh_token, access_token, token_expiry FROM outlook_accounts WHERE account_id = ? AND label = ?`,
    )
    .get(accountId, label) as OutlookAccount | null;
  return row ?? null;
}

export function updateOutlookAccessToken(
  accountId: string,
  label: string,
  accessToken: string,
  tokenExpiry: number,
): void {
  db.query(
    `UPDATE outlook_accounts SET access_token = ?, token_expiry = ? WHERE account_id = ? AND label = ?`,
  ).run(accessToken, tokenExpiry, accountId, label);
}

// --- Facebook Pages connected from the app ---
export type FacebookPage = {
  pageId: string;
  pageName: string;
  createdAt: string;
};

export function setFacebookPage(
  accountId: string,
  pageId: string,
  pageName: string,
  accessToken: string,
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO facebook_pages (account_id, page_id, page_name, access_token, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(account_id, page_id) DO UPDATE SET
       page_name = excluded.page_name, access_token = excluded.access_token`,
  ).run(accountId, pageId, pageName, accessToken, now);
}

// The token is only ever read server-side, for Graph API calls. It is
// never returned to the client.
export function getFacebookPageToken(accountId: string, pageId: string): string | null {
  const row = db
    .query(`SELECT access_token FROM facebook_pages WHERE account_id = ? AND page_id = ?`)
    .get(accountId, pageId) as { access_token?: string } | null;
  return row?.access_token || null;
}

export function listFacebookPages(accountId: string): FacebookPage[] {
  const rows = db
    .query(`SELECT page_id, page_name, created_at FROM facebook_pages WHERE account_id = ? ORDER BY created_at ASC`)
    .all(accountId) as any[];
  return rows.map((r) => ({ pageId: r.page_id, pageName: r.page_name, createdAt: r.created_at }));
}

export function deleteFacebookPage(accountId: string, pageId: string): void {
  db.query(`DELETE FROM facebook_pages WHERE account_id = ? AND page_id = ?`).run(accountId, pageId);
}

// --- About you (the owner's profile) ---
export type Profile = {
  displayName: string | null;
  about: string | null;
  preferences: string | null;
  notes: string | null;
  updatedAt: string | null;
};

export function getProfile(accountId: string): Profile {
  const row = db
    .query(`SELECT display_name, about, preferences, notes, updated_at FROM profile WHERE account_id = ?`)
    .get(accountId) as any;
  if (!row) {
    return { displayName: null, about: null, preferences: null, notes: null, updatedAt: null };
  }
  return {
    displayName: row.display_name || null,
    about: row.about || null,
    preferences: row.preferences || null,
    notes: row.notes || null,
    updatedAt: row.updated_at || null,
  };
}

export function saveProfile(
  accountId: string,
  patch: { displayName?: string | null; about?: string | null; preferences?: string | null; notes?: string | null },
): Profile {
  const now = new Date().toISOString();
  const current = getProfile(accountId);
  const displayName =
    patch.displayName === undefined
      ? current.displayName
      : patch.displayName === null
        ? null
        : String(patch.displayName).trim().slice(0, 80) || null;
  const about =
    patch.about === undefined
      ? current.about
      : patch.about === null
        ? null
        : String(patch.about).trim().slice(0, 4000) || null;
  const preferences =
    patch.preferences === undefined
      ? current.preferences
      : patch.preferences === null
        ? null
        : String(patch.preferences).trim().slice(0, 4000) || null;
  const notes =
    patch.notes === undefined
      ? current.notes
      : patch.notes === null
        ? null
        : String(patch.notes).trim().slice(0, 4000) || null;
  db.query(
    `INSERT INTO profile (account_id, display_name, about, preferences, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       display_name = excluded.display_name, about = excluded.about,
       preferences = excluded.preferences, notes = excluded.notes,
       updated_at = excluded.updated_at`,
  ).run(accountId, displayName, about, preferences, notes, now);
  return getProfile(accountId);
}

// --- Memory imported from other AIs ---
export type ImportedMemory = {
  id: number;
  source: string;
  title: string;
  chars: number;
  importedAt: string;
};

const MEMORY_MAX_CHARS = 100_000;

export function addImportedMemory(
  accountId: string,
  source: string,
  title: string,
  content: string,
): ImportedMemory {
  const now = new Date().toISOString();
  const clean = String(content || "").slice(0, MEMORY_MAX_CHARS);
  const safeTitle = String(title || "Imported memory").trim().slice(0, 200) || "Imported memory";
  const safeSource = String(source || "file").trim().slice(0, 80) || "file";
  const info = db
    .query(
      `INSERT INTO imported_memory (account_id, source, title, content, imported_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(accountId, safeSource, safeTitle, clean, now);
  return {
    id: Number(info.lastInsertRowid),
    source: safeSource,
    title: safeTitle,
    chars: clean.length,
    importedAt: now,
  };
}

export function listImportedMemory(accountId: string): ImportedMemory[] {
  const rows = db
    .query(
      `SELECT id, source, title, length(content) AS chars, imported_at
       FROM imported_memory WHERE account_id = ? ORDER BY imported_at DESC`,
    )
    .all(accountId) as any[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    chars: r.chars,
    importedAt: r.imported_at,
  }));
}

export function deleteImportedMemory(accountId: string, id: number): void {
  db.query(`DELETE FROM imported_memory WHERE account_id = ? AND id = ?`).run(accountId, id);
}

// A short digest of the most recent imports, for the chat system prompt.
// Capped hard: the two most recent imports, 1,500 characters each, 3,000
// total. It is background, never instructions.
export function memoryDigest(accountId: string): string {
  const rows = db
    .query(
      `SELECT title, source, content FROM imported_memory
       WHERE account_id = ? ORDER BY imported_at DESC LIMIT 2`,
    )
    .all(accountId) as any[];
  if (!rows.length) return "";
  const parts = rows.map((r) => {
    const text = String(r.content || "").slice(0, 1500);
    return `[From ${r.source}: ${r.title}]\n${text}`;
  });
  return parts.join("\n\n").slice(0, 3000);
}

// --- Switchboard contacts ---
export type Contact = {
  id: string;
  photon: string;
  name: string;
  address: string;
  phone: string | null;
  status: "pending" | "approved" | "declined";
  token: string;
  created_at: string;
  requestSentAt: string | null;
  decided_at: string | null;
};

function rowToContact(row: any): Contact {
  return {
    id: row.id,
    photon: row.photon,
    name: row.name,
    address: row.address,
    phone: row.phone || null,
    status: row.status,
    token: row.token,
    created_at: row.created_at,
    requestSentAt: row.request_sent_at || null,
    decided_at: row.decided_at,
  };
}

export function listContacts(accountId: string): Contact[] {
  const rows = db
    .query(`SELECT * FROM contacts WHERE account_id = ? ORDER BY created_at ASC`)
    .all(accountId) as any[];
  return rows.map(rowToContact);
}

export function getContactByAddress(accountId: string, address: string): Contact | null {
  const row = db
    .query(`SELECT * FROM contacts WHERE account_id = ? AND lower(address) = lower(?)`)
    .get(accountId, address) as any;
  return row ? rowToContact(row) : null;
}

export function createContact(
  accountId: string,
  photon: string,
  name: string,
  address: string,
): Contact {
  const now = new Date().toISOString();
  const id = `ct_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  db.query(
    `INSERT INTO contacts (account_id, id, photon, name, address, status, token, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
  ).run(accountId, id, photon, name, address, token, now);
  return getContactByAddress(accountId, address) as Contact;
}

// Step 1: a contact's phone number, for texts and caller ID. The column
// itself is added by the telephony module at import (ALTER TABLE ...
// ADD COLUMN, wrapped so it no-ops if the column already exists).
export function setContactPhone(accountId: string, contactId: string, phone: string): void {
  db.query(`UPDATE contacts SET phone = ? WHERE account_id = ? AND id = ?`).run(
    phone,
    accountId,
    contactId,
  );
}

export function getContactByToken(
  accountId: string,
  id: string,
  token: string,
): Contact | null {
  const row = db
    .query(`SELECT * FROM contacts WHERE account_id = ? AND id = ? AND token = ?`)
    .get(accountId, id, token) as any;
  return row ? rowToContact(row) : null;
}

export function setContactStatus(
  accountId: string,
  id: string,
  status: "approved" | "declined",
): Contact | null {
  const now = new Date().toISOString();
  db.query(
    `UPDATE contacts SET status = ?, decided_at = ? WHERE account_id = ? AND id = ?`,
  ).run(status, now, accountId, id);
  const row = db
    .query(`SELECT * FROM contacts WHERE account_id = ? AND id = ?`)
    .get(accountId, id) as any;
  return row ? rowToContact(row) : null;
}

export function markRequestSent(accountId: string, id: string): void {
  const now = new Date().toISOString();
  db.query(`UPDATE contacts SET request_sent_at = ? WHERE account_id = ? AND id = ?`).run(
    now,
    accountId,
    id,
  );
}
