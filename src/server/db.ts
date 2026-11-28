// SQLite storage (bun:sqlite, zero dependencies). One database file per
// deployment at <DATA_DIR>/app.db. On Render's free tier the disk is
// ephemeral: chat history, unlocks, and Upkeep flags reset when the service
// redeploys or restarts. That is the known free-tier limit, same as before.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { PHOTON_NAMES } from "../shared/photons";
import { ATOM_NAMES } from "../shared/atoms";
import { ATOM_BACKSTORIES } from "../shared/backstories";
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
-- IMAP accounts (Yahoo Mail, Apple Mail, any other IMAP mailbox): one
-- row per connected mailbox, labelled imap-1, imap-2, ... so anyone can
-- add as many as they like. The credential is the app-specific password
-- the owner pastes in (IMAP has no refresh token); it is stored the
-- same way Gmail and Outlook refresh tokens are stored, and it is never
-- sent back to the client. Disconnect deletes the row.
CREATE TABLE IF NOT EXISTS imap_accounts (
  account_id TEXT NOT NULL,
  label TEXT NOT NULL,
  provider TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  email TEXT NOT NULL,
  password TEXT NOT NULL,
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
  title TEXT,
  pronouns TEXT,
  side TEXT,
  updated_at TEXT NOT NULL
);
-- Memory imported from other AIs, so the owner keeps continuity and does
-- not start over. One row per imported file, or one row per section when
-- the file is a Prism self-export: the export is split into its sections
-- (SOUL, IDENTITY, USER, MEMORY, and the rest) at import, all sharing
-- one group_id, so the brain can be handed the section it needs instead
-- of the head of one long file. Content is capped at 1,000,000
-- characters when it is stored. A short identity block and the matching
-- sections are read into the chat system prompt as background, never as
-- instructions.
CREATE TABLE IF NOT EXISTS imported_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  section TEXT,
  group_id TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imported_memory_account ON imported_memory (account_id, imported_at);
-- NOTE: the group index is NOT created here. Older databases have
-- imported_memory without group_id, and creating this index before the
-- migration below adds the column crashed the boot (Render deploy
-- 73c7772, Nov 18, 2026: SQLiteError no such column: group_id, thrown
-- from the db.exec above before the migration ever ran). It is created
-- after the columns, in the migration block below.
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
CREATE TABLE IF NOT EXISTS pinned_faces (
  account_id TEXT NOT NULL,
  photon TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, photon)
);
CREATE TABLE IF NOT EXISTS thread_notes (
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, name)
);
`);

// --- Imported-memory columns added Nov 18, 2026 (memory import fix) ---
// Older databases have imported_memory without section/group_id. Add
// them, then split any self-export that was stored whole (and truncated
// at 100,000 characters) into its sections, so the brain can use it.
// Idempotent: rows that already have a group_id are left alone. Any
// failure here must never stop the server starting, so it is caught
// and logged.
try {
  const _cols = db.query(`PRAGMA table_info(imported_memory)`).all() as { name: string }[];
  const _names = new Set(_cols.map((c) => c.name));
  if (!_names.has("section")) db.exec(`ALTER TABLE imported_memory ADD COLUMN section TEXT`);
  if (!_names.has("group_id")) db.exec(`ALTER TABLE imported_memory ADD COLUMN group_id TEXT`);
  // Only now that the column is guaranteed to exist: the group index
  // crashed the boot when it lived in the schema block above, because
  // older databases reach this file with imported_memory lacking
  // group_id. Creating it here keeps any failure inside this catch, so
  // the server still starts (the index is a lookup aid, not data).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_imported_memory_group ON imported_memory (account_id, group_id)`);
  migrateUnsectionedSelfExports();
} catch (err) {
  console.error("imported_memory migration failed:", err);
}

// --- Profile columns added Nov 18, 2026 (preferred form of address) ---
// Older databases have profile without title/pronouns. Add them the
// same way as the imported_memory columns above: idempotent, and any
// failure must never stop the server starting, so it is caught and
// logged. Existing rows keep working with both fields null, which is
// the default: no title, no gendered address.
try {
  const _pcols = db.query(`PRAGMA table_info(profile)`).all() as { name: string }[];
  const _pnames = new Set(_pcols.map((c) => c.name));
  if (!_pnames.has("title")) db.exec(`ALTER TABLE profile ADD COLUMN title TEXT`);
  if (!_pnames.has("pronouns")) db.exec(`ALTER TABLE profile ADD COLUMN pronouns TEXT`);
  if (!_pnames.has("side")) db.exec(`ALTER TABLE profile ADD COLUMN side TEXT`);
} catch (err) {
  console.error("profile migration failed:", err);
}

// --- Atom renames, Nov 22, 2026 (June -> Jude, Cleo -> Clive, Pearl -> Pierce) ---
// Three of the twelve Atoms were renamed at Neil's ruling: the portraits
// are men and the old names were women's. Threads, messages and
// customizations are keyed by persona name, and Atom ownership lives in
// owned rows with kind 'atom', so existing rows under the old names are
// carried to the new ones here. Idempotent: after the first run no rows
// carry the old names, so the updates match nothing. The new names never
// existed as personas before this deploy, so no row can collide. Any
// failure is caught and logged; it must never stop the server starting.
try {
  const ATOM_RENAMES: [string, string][] = [
    ["June", "Jude"],
    ["Cleo", "Clive"],
    ["Pearl", "Pierce"],
  ];
  for (const [oldName, newName] of ATOM_RENAMES) {
    db.query(`UPDATE threads SET photon = ? WHERE photon = ?`).run(newName, oldName);
    db.query(`UPDATE messages SET photon = ? WHERE photon = ?`).run(newName, oldName);
    db.query(`UPDATE customizations SET photon = ? WHERE photon = ?`).run(newName, oldName);
    db.query(`UPDATE contacts SET photon = ? WHERE photon = ?`).run(newName, oldName);
    db.query(`UPDATE OR IGNORE pinned_faces SET photon = ? WHERE photon = ?`).run(newName, oldName);
    db.query(`DELETE FROM pinned_faces WHERE photon = ?`).run(oldName);
    db.query(`UPDATE owned SET ref = ? WHERE kind = 'atom' AND ref = ?`).run(newName, oldName);
  }
} catch (err) {
  console.error("atom rename migration failed:", err);
}

// --- Atom backstory pronoun correction, Nov 22, 2026 ---
// The v55 pronoun pass fixed the Jude and Pierce templates in
// src/shared/backstories.ts (Jude they/them, Pierce he/him, matching the
// declared pronouns in src/shared/atoms.ts), but atom_backstories rows
// are seeded once, at account linking, and never rewritten — so accounts
// linked earlier still hold the old she/her wording in their stored
// rows. This migration brings the stored Jude and Pierce rows up to the
// current corrected template text. The rename migration above does not
// touch this table, so rows may also still be keyed by the old names
// June and Pearl: those are carried to Jude and Pierce with the
// corrected text, unless the account already has a row under the new
// name (corrected by the first two updates), in which case the stale
// old-name row is removed. Only Jude/Pierce (and June/Pearl) rows are
// touched; every other Atom's stored text is left exactly as it stands.
// The Cleo carry below is the same treatment for the third renamed
// Atom, added as a final sweep: Cleo's template never had a pronoun
// fault, so existing Clive rows are NOT rewritten — only a surviving
// Cleo-keyed row is carried to Clive with the current template text,
// or removed when the account already holds a Clive row.
// Idempotent: after the first run the templates already match and no
// old-name rows remain, so the updates match nothing that differs. Any
// failure is caught and logged; it must never stop the server starting.
// The table itself is created in auth.ts, which loads after this file,
// so on a brand-new database it may not exist yet — then there are no
// stored rows to correct, and the guard simply skips.
try {
  const _hasAtomBackstories = db
    .query(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'atom_backstories'`)
    .get() as { n: number };
  if (_hasAtomBackstories.n === 1) {
    const _judeText = ATOM_BACKSTORIES["Jude"];
    const _pierceText = ATOM_BACKSTORIES["Pierce"];
    if (_judeText) {
      db.query(`UPDATE atom_backstories SET template = ? WHERE atom = 'Jude'`).run(_judeText);
      db.query(`UPDATE OR IGNORE atom_backstories SET atom = 'Jude', template = ? WHERE atom = 'June'`).run(_judeText);
      db.query(`DELETE FROM atom_backstories WHERE atom = 'June'`).run();
    }
    if (_pierceText) {
      db.query(`UPDATE atom_backstories SET template = ? WHERE atom = 'Pierce'`).run(_pierceText);
      db.query(`UPDATE OR IGNORE atom_backstories SET atom = 'Pierce', template = ? WHERE atom = 'Pearl'`).run(_pierceText);
      db.query(`DELETE FROM atom_backstories WHERE atom = 'Pearl'`).run();
    }
    const _cliveText = ATOM_BACKSTORIES["Clive"];
    if (_cliveText) {
      db.query(`UPDATE OR IGNORE atom_backstories SET atom = 'Clive', template = ? WHERE atom = 'Cleo'`).run(_cliveText);
      db.query(`DELETE FROM atom_backstories WHERE atom = 'Cleo'`).run();
    }
  }
} catch (err) {
  console.error("atom backstory pronoun migration failed:", err);
}

// --- Atom rename, Nov 27, 2026 (Jude -> Vera) ---
// Nova Jude is now Nova Vera, at Neil's order: the portrait is a
// woman, so the name and the pronouns (she/her) now match her.
// Same treatment as the Nov 22 renames above: threads, messages,
// customizations, contacts, pinned faces and atom ownership rows
// keyed "Jude" are carried to "Vera". Idempotent: after the first
// run no rows carry the old name, so the updates match nothing.
// Vera never existed as a persona before this deploy, so no row
// can collide. Any failure is caught and logged; it must never
// stop the server starting.
try {
  db.query(`UPDATE threads SET photon = ? WHERE photon = ?`).run("Vera", "Jude");
  db.query(`UPDATE messages SET photon = ? WHERE photon = ?`).run("Vera", "Jude");
  db.query(`UPDATE customizations SET photon = ? WHERE photon = ?`).run("Vera", "Jude");
  db.query(`UPDATE contacts SET photon = ? WHERE photon = ?`).run("Vera", "Jude");
  db.query(`UPDATE OR IGNORE pinned_faces SET photon = ? WHERE photon = ?`).run("Vera", "Jude");
  db.query(`DELETE FROM pinned_faces WHERE photon = ?`).run("Jude");
  db.query(`UPDATE owned SET ref = ? WHERE kind = 'atom' AND ref = ?`).run("Vera", "Jude");
} catch (err) {
  console.error("atom rename (Jude -> Vera) migration failed:", err);
}

// --- Atom backstory carry for the Vera rename, Nov 27, 2026 ---
// Stored atom_backstories rows keyed "Jude" (or, on the oldest
// accounts, still "June") are carried to "Vera" with the current
// template text — the Vera story reads she/her throughout, matching
// her declared pronouns in src/shared/atoms.ts. Existing Vera rows
// are refreshed to the current template. A stale old-name row is
// removed when the account already holds a Vera row. Idempotent.
// The guard mirrors the pronoun-correction block above: on a
// brand-new database the table may not exist yet, and then there
// are no stored rows to carry.
try {
  const _hasAtomBackstories2 = db
    .query(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'atom_backstories'`)
    .get() as { n: number };
  if (_hasAtomBackstories2.n === 1) {
    const _veraText = ATOM_BACKSTORIES["Vera"];
    if (_veraText) {
      db.query(`UPDATE atom_backstories SET template = ? WHERE atom = 'Vera'`).run(_veraText);
      db.query(`UPDATE OR IGNORE atom_backstories SET atom = 'Vera', template = ? WHERE atom = 'Jude'`).run(_veraText);
      db.query(`DELETE FROM atom_backstories WHERE atom = 'Jude'`).run();
      db.query(`UPDATE OR IGNORE atom_backstories SET atom = 'Vera', template = ? WHERE atom = 'June'`).run(_veraText);
      db.query(`DELETE FROM atom_backstories WHERE atom = 'June'`).run();
    }
  }
} catch (err) {
  console.error("atom backstory (Vera) migration failed:", err);
}

// --- Side column added Nov 19, 2026 (Business or Personal) ---
// The first-open chooser's choice lives on the ACCOUNT, in the profile
// row, so the app and the website follow it together for a signed-in
// owner. Only "business" or "personal" is ever stored; anything else
// reads back as null, which is "never chosen" — the chooser shows until
// a door is picked. The device-local copy (prism.side.v1) is a cache,
// not the truth.

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

export function getOwned(accountId: string): { photons: string[]; products: string[]; atoms: string[] } {
  const rows = db
    .query(`SELECT kind, ref FROM owned WHERE account_id = ?`)
    .all(accountId) as { kind: string; ref: string }[];
  const photons = rows.filter((r) => r.kind === "photon").map((r) => r.ref);
  const products = rows.filter((r) => r.kind === "product").map((r) => r.ref);
  const atoms = rows.filter((r) => r.kind === "atom").map((r) => r.ref);
  return { photons, products, atoms };
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

// Atoms are owned the same way as Photons: one row per Atom, kind
// 'atom', ref the Atom's name (see src/shared/atoms.ts).
export function ownAtom(accountId: string, atom: string): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at) VALUES (?, 'atom', ?, ?)`,
  ).run(accountId, atom, now);
}

export function ownsAtom(accountId: string, atom: string): boolean {
  const a = getOrCreateAccount(accountId);
  if (a.free_code) return true;
  const row = db
    .query(`SELECT 1 AS x FROM owned WHERE account_id = ? AND kind = 'atom' AND ref = ?`)
    .get(accountId, atom) as any;
  return !!row;
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
  for (const name of ATOM_NAMES) ownAtom(accountId, name);
  // The free code unlocks everything: all Photons and all catalog products.
  db.query(
    `INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at)
     SELECT ?, 'product', slug, ? FROM (SELECT 'supernova' AS slug UNION ALL SELECT 'satellite' UNION ALL SELECT 'nova' UNION ALL SELECT 'personal-upkeep')`,
  ).run(accountId, now);
}

// --- Nova settings (Nov 19, 2026) ---
// One row per account, only when the owner has saved a choice. No row
// means "the default": check-ins and getting-started nudges ON for Nova
// owners, OFF for everyone else (see getNovaSettings and
// NOVA_DEFAULTS in src/shared/features.ts). The check-in/nudge sender
// itself is not built yet; when it is, it reads these same values from
// /api/state, so the owner's choice here is the one that counts.
db.exec(`
CREATE TABLE IF NOT EXISTS nova_settings (
  account_id TEXT PRIMARY KEY,
  check_ins INTEGER NOT NULL DEFAULT 1,
  getting_started_nudges INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
`);

export type NovaSettings = {
  checkIns: boolean;
  gettingStartedNudges: boolean;
  saved: boolean;
};

export function getNovaSettings(accountId: string): NovaSettings {
  const row = db
    .query(`SELECT check_ins, getting_started_nudges FROM nova_settings WHERE account_id = ?`)
    .get(accountId) as { check_ins: number; getting_started_nudges: number } | null;
  if (row) {
    return {
      checkIns: row.check_ins === 1,
      gettingStartedNudges: row.getting_started_nudges === 1,
      saved: true,
    };
  }
  // No saved choice: the default follows ownership. A Nova owner (or an
  // Atom owner, or a business Launch owner, who holds the personal set
  // too, or the free code) gets the gentler default — both on. Anyone
  // else gets both off, so nothing nudges an owner who never bought Nova.
  const owned = getOwned(accountId);
  const a = getOrCreateAccount(accountId);
  const on =
    a.free_code ||
    owned.atoms.length > 0 ||
    owned.products.includes("nova") ||
    owned.products.includes("supernova") ||
    owned.products.includes("satellite");
  return { checkIns: on, gettingStartedNudges: on, saved: false };
}

export function saveNovaSettings(
  accountId: string,
  patch: { checkIns?: boolean; gettingStartedNudges?: boolean },
): NovaSettings {
  const current = getNovaSettings(accountId);
  const next: NovaSettings = {
    checkIns: patch.checkIns !== undefined ? patch.checkIns : current.checkIns,
    gettingStartedNudges:
      patch.gettingStartedNudges !== undefined
        ? patch.gettingStartedNudges
        : current.gettingStartedNudges,
    saved: true,
  };
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO nova_settings (account_id, check_ins, getting_started_nudges, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       check_ins = excluded.check_ins,
       getting_started_nudges = excluded.getting_started_nudges,
       updated_at = excluded.updated_at`,
  ).run(accountId, next.checkIns ? 1 : 0, next.gettingStartedNudges ? 1 : 0, now);
  return next;
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

export type MessageSearchResult = {
  photon: string;
  role: string;
  snippet: string;
  created_at: string;
};

// A short window of context around the first match: about 160
// characters, with ellipses where the message was trimmed. The full
// message body never leaves the server through search.
export function searchSnippet(content: string, query: string): string {
  const text = String(content || "");
  const idx = text.toLowerCase().indexOf(String(query || "").toLowerCase());
  if (idx < 0) return text.slice(0, 160) + (text.length > 160 ? "…" : "");
  const start = Math.max(0, idx - 60);
  const slice = text.slice(start, start + 160);
  return (start > 0 ? "…" : "") + slice + (start + 160 < text.length ? "…" : "");
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Account-scoped message search: a case-insensitive substring match
// on content, strictly for the requesting account, newest first,
// capped at 50. Parameterised only; LIKE wildcards in the query are
// escaped so % and _ match literally.
export function searchMessages(accountId: string, query: string): MessageSearchResult[] {
  const pattern = `%${escapeLike(query)}%`;
  const rows = db
    .query(
      `SELECT photon, role, content, created_at FROM messages
       WHERE account_id = ? AND content COLLATE NOCASE LIKE ? ESCAPE '\\'
       ORDER BY id DESC LIMIT 50`,
    )
    .all(accountId, pattern) as any[];
  return rows.map((r) => ({
    photon: r.photon,
    role: r.role,
    snippet: searchSnippet(r.content, query),
    created_at: r.created_at,
  }));
}

// The conversations this account can export in full: every named
// thread holding at least one message, most recently active first.
export function listExportThreads(accountId: string): { photon: string; messageCount: number }[] {
  const rows = db
    .query(
      `SELECT photon, COUNT(*) AS n FROM messages WHERE account_id = ?
       GROUP BY photon ORDER BY MAX(id) DESC`,
    )
    .all(accountId) as any[];
  return rows.map((r) => ({ photon: r.photon, messageCount: r.n }));
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

// --- Delete a conversation ---
// Removes everything this account has stored with one Photon or
// Atom: every message, the thread row itself, and any pin pointing
// at it, so the conversation is gone from the thread read, search,
// export, and the Pinned section at once. Returns how many messages
// were removed. Other accounts and other Faces are untouched, and
// the Face's customization (name, voice, look) is a separate store
// that stays — deleting a conversation is not un-personalizing it.
export function deleteThread(accountId: string, photon: string): number {
  const removed = db
    .query(`DELETE FROM messages WHERE account_id = ? AND photon = ?`)
    .run(accountId, photon);
  db.query(`DELETE FROM threads WHERE account_id = ? AND photon = ?`).run(accountId, photon);
  db.query(`DELETE FROM pinned_faces WHERE account_id = ? AND photon = ?`).run(accountId, photon);
  db.query(`DELETE FROM thread_notes WHERE account_id = ? AND name = ?`).run(accountId, photon);
  return removed.changes;
}

// --- Thread notes ---
// One short private note per account per Photon or Atom conversation,
// so the owner can remember what they were working on with that Face.
// The note is trimmed and capped at 500 characters; an empty note
// deletes the row, which is the clear path.
export function getThreadNote(accountId: string, name: string): string {
  const row = db
    .query(`SELECT note FROM thread_notes WHERE account_id = ? AND name = ?`)
    .get(accountId, name) as { note: string } | null;
  return row?.note ?? "";
}

export function setThreadNote(accountId: string, name: string, note: string): string {
  const stored = String(note ?? "").trim().slice(0, 500);
  if (!stored) {
    deleteThreadNote(accountId, name);
    return "";
  }
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO thread_notes (account_id, name, note, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, name) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  ).run(accountId, name, stored, now);
  return stored;
}

export function deleteThreadNote(accountId: string, name: string): void {
  db.query(`DELETE FROM thread_notes WHERE account_id = ? AND name = ?`).run(accountId, name);
}

// --- Pinned Faces ---
// A pinned Photon or Atom conversation, so the Faces the owner uses
// most sit at the top of the Chat front. Pinning is idempotent: a
// re-pin keeps the original pinned time, so the order stays stable.
export function pinFace(accountId: string, photon: string): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO pinned_faces (account_id, photon, created_at) VALUES (?, ?, ?)`,
  ).run(accountId, photon, now);
}

export function unpinFace(accountId: string, photon: string): void {
  db.query(`DELETE FROM pinned_faces WHERE account_id = ? AND photon = ?`).run(accountId, photon);
}

export function listPinnedFaces(accountId: string): string[] {
  const rows = db
    .query(`SELECT photon FROM pinned_faces WHERE account_id = ? ORDER BY created_at ASC, rowid ASC`)
    .all(accountId) as { photon: string }[];
  return rows.map((r) => r.photon);
}

export function isFacePinned(accountId: string, photon: string): boolean {
  const row = db
    .query(`SELECT 1 AS x FROM pinned_faces WHERE account_id = ? AND photon = ?`)
    .get(accountId, photon) as any;
  return !!row;
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

// --- IMAP accounts (Yahoo Mail, Apple Mail, other IMAP mailboxes) ---
export type ImapAccount = {
  label: string;
  provider: string;
  host: string;
  port: number;
  email: string;
  password: string;
};

export function setImapAccount(
  accountId: string,
  label: string,
  provider: string,
  host: string,
  port: number,
  email: string,
  password: string,
): void {
  db.query(
    `INSERT INTO imap_accounts (account_id, label, provider, host, port, email, password)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, label) DO UPDATE SET
       provider = excluded.provider, host = excluded.host, port = excluded.port,
       email = excluded.email, password = excluded.password`,
  ).run(accountId, label, provider, host, port, email, password);
}

export function getImapAccounts(accountId: string): ImapAccount[] {
  return db
    .query(`SELECT label, provider, host, port, email, password FROM imap_accounts WHERE account_id = ?`)
    .all(accountId) as ImapAccount[];
}

export function getImapAccount(accountId: string, label: string): ImapAccount | null {
  const row = db
    .query(
      `SELECT label, provider, host, port, email, password FROM imap_accounts WHERE account_id = ? AND label = ?`,
    )
    .get(accountId, label) as ImapAccount | null;
  return row ?? null;
}

export function deleteImapAccount(accountId: string, label: string): void {
  db.query(`DELETE FROM imap_accounts WHERE account_id = ? AND label = ?`).run(accountId, label);
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

// Titles the app may use to address the owner. A whitelist, not free
// text: a title rides straight into the chat system prompt, so only
// these exact values are ever stored. Anything else arrives as null,
// which is the default: no title, no gendered address. "Sir",
// "M'Lady", and "M'Lord" are offered only as opt-in choices
// (Nov 18, 2026, Neil's word); nobody is addressed that way
// unless they pick it.
export const ADDRESS_TITLES = ["Mr.", "Ms.", "Mx.", "Dr.", "Sir", "M'Lady", "M'Lord"] as const;
export type AddressTitle = (typeof ADDRESS_TITLES)[number];

export function normalizeTitle(value: unknown): AddressTitle | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return (ADDRESS_TITLES as readonly string[]).includes(v) ? (v as AddressTitle) : null;
}

export function normalizePronouns(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // One line, capped: pronouns ride in the system prompt, so no
  // newlines and no long free text.
  const v = value.replace(/[\r\n]+/g, " ").trim().slice(0, 40) || null;
  return v;
}

// --- About you (the owner's profile) ---
export type Side = "business" | "personal";
export function normalizeSide(value: unknown): Side | null {
  return value === "business" || value === "personal" ? value : null;
}
export type Profile = {
  displayName: string | null;
  about: string | null;
  preferences: string | null;
  notes: string | null;
  title: AddressTitle | null;
  pronouns: string | null;
  side: Side | null;
  updatedAt: string | null;
};

export function getProfile(accountId: string): Profile {
  const row = db
    .query(`SELECT display_name, about, preferences, notes, title, pronouns, side, updated_at FROM profile WHERE account_id = ?`)
    .get(accountId) as any;
  if (!row) {
    return { displayName: null, about: null, preferences: null, notes: null, title: null, pronouns: null, side: null, updatedAt: null };
  }
  return {
    displayName: row.display_name || null,
    about: row.about || null,
    preferences: row.preferences || null,
    notes: row.notes || null,
    title: normalizeTitle(row.title),
    pronouns: normalizePronouns(row.pronouns),
    side: normalizeSide(row.side),
    updatedAt: row.updated_at || null,
  };
}

export function saveProfile(
  accountId: string,
  patch: { displayName?: string | null; about?: string | null; preferences?: string | null; notes?: string | null; title?: string | null; pronouns?: string | null; side?: string | null },
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
  // A title is only ever one of the whitelisted values; anything else
  // (including "sir") arrives as null, which is the no-title default.
  // Pronouns are one capped line. Undefined means "leave it as it is".
  const title = patch.title === undefined ? current.title : normalizeTitle(patch.title);
  const pronouns = patch.pronouns === undefined ? current.pronouns : normalizePronouns(patch.pronouns);
  // A side is only ever "business" or "personal"; anything else arrives
  // as null, which is "never chosen". Undefined means "leave it as it is".
  const side = patch.side === undefined ? current.side : normalizeSide(patch.side);
  db.query(
    `INSERT INTO profile (account_id, display_name, about, preferences, notes, title, pronouns, side, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       display_name = excluded.display_name, about = excluded.about,
       preferences = excluded.preferences, notes = excluded.notes,
       title = excluded.title, pronouns = excluded.pronouns,
       side = excluded.side,
       updated_at = excluded.updated_at`,
  ).run(accountId, displayName, about, preferences, notes, title, pronouns, side, now);
  return getProfile(accountId);
}

// --- Memory imported from other AIs ---
export type ImportedMemory = {
  id: number;
  source: string;
  title: string;
  chars: number;
  importedAt: string;
  sections: number;
};

// The whole import is kept: 1,000,000 characters covers the self-export
// (about 146,000 characters) and larger future exports. The old 100,000
// cap silently dropped the last third of the export.
const MEMORY_MAX_CHARS = 1_000_000;

// A Prism self-export is a bundle of top-level sections (# SOUL.md,
// # IDENTITY.md, # USER.md, # MEMORY.md, and the rest) under a banner
// header. Split it so each section is stored on its own row and the
// brain can be handed the section it needs, instead of the head of one
// long file. Anything that is not a self-export stays one row.
export type ExportSection = {
  title: string;
  kind: string;
  content: string;
};

export function isSelfExport(content: string): boolean {
  const text = String(content || "");
  return (
    text.slice(0, 2000).includes("SELF EXPORT") &&
    text.includes("# SOUL.md") &&
    text.includes("# MEMORY.md")
  );
}

// What a section is, from its top-level header. The free-code section
// is named apart so it is never read into a prompt: a code value must
// never travel through the brain.
export function sectionKind(header: string): string {
  const h = String(header || "").toLowerCase();
  if (h.includes("free code")) return "freecode";
  if (h.startsWith("soul")) return "soul";
  if (h.startsWith("identity")) return "identity";
  if (h.startsWith("user")) return "user";
  if (h.startsWith("memory")) return "memory";
  if (h.includes("alignment")) return "alignment";
  if (h.startsWith("agents")) return "agents";
  if (h.includes("people index")) return "people";
  if (h.includes("groups index")) return "groups";
  if (h.includes("mother") || h.includes("original rule")) return "mother";
  if (h.includes("upkeep")) return "upkeep";
  return "other";
}

export function splitSelfExport(content: string): ExportSection[] {
  const lines = String(content || "").split("\n");
  const sections: ExportSection[] = [];
  let current: { title: string; kind: string; lines: string[] } = {
    title: "About this export",
    kind: "header",
    lines: [],
  };
  const flush = () => {
    const body = current.lines.join("\n").trim();
    if (body) sections.push({ title: current.title, kind: current.kind, content: body });
  };
  for (const line of lines) {
    const m = line.match(/^#\s+(.+?)\s*$/);
    if (m) {
      flush();
      current = { title: m[1], kind: sectionKind(m[1]), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  flush();
  return sections;
}

// Sections of the most recent self-export for this account, in file
// order. Empty when the account never imported one.
function latestSelfExportSections(accountId: string): { title: string; content: string }[] {
  const latest = db
    .query(
      `SELECT group_id FROM imported_memory
       WHERE account_id = ? AND group_id IS NOT NULL
       ORDER BY imported_at DESC LIMIT 1`,
    )
    .get(accountId) as { group_id: string } | null;
  if (!latest) return [];
  return db
    .query(
      `SELECT section AS title, content FROM imported_memory
       WHERE account_id = ? AND group_id = ? ORDER BY id ASC`,
    )
    .all(accountId, latest.group_id) as { title: string; content: string }[];
}

// One-time reorganization for self-exports stored whole before
// sectioning (and truncated at 100,000 characters): split them into
// their sections in place, keeping the original import date. Returns
// how many imports were split. Idempotent: rows that already have a
// group_id are left alone.
export function migrateUnsectionedSelfExports(): number {
  let migrated = 0;
  try {
    const rows = db
      .query(
        `SELECT id, account_id, source, title, content, imported_at
         FROM imported_memory WHERE group_id IS NULL`,
      )
      .all() as any[];
    for (const row of rows) {
      if (!isSelfExport(String(row.content || ""))) continue;
      const sections = splitSelfExport(String(row.content));
      if (sections.length < 2) continue;
      const groupId = `imp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
      for (const s of sections) {
        db.query(
          `INSERT INTO imported_memory (account_id, source, title, content, section, group_id, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(row.account_id, row.source, row.title, s.content, s.title, groupId, row.imported_at);
      }
      db.query(`DELETE FROM imported_memory WHERE id = ?`).run(row.id);
      migrated++;
      console.log(
        `imported_memory migration: split "${row.title}" into ${sections.length} sections`,
      );
    }
  } catch (err) {
    console.error("imported_memory migration failed:", err);
  }
  return migrated;
}

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
  if (isSelfExport(clean)) {
    const sections = splitSelfExport(clean);
    const groupId = `imp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
    let firstId = 0;
    let totalChars = 0;
    for (const s of sections) {
      const info = db
        .query(
          `INSERT INTO imported_memory (account_id, source, title, content, section, group_id, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(accountId, safeSource, safeTitle, s.content, s.title, groupId, now);
      if (!firstId) firstId = Number(info.lastInsertRowid);
      totalChars += s.content.length;
    }
    return {
      id: firstId,
      source: safeSource,
      title: safeTitle,
      chars: totalChars,
      importedAt: now,
      sections: sections.length,
    };
  }
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
    sections: 1,
  };
}

export function listImportedMemory(accountId: string): ImportedMemory[] {
  const rows = db
    .query(
      `SELECT id, source, title, length(content) AS chars, imported_at, group_id
       FROM imported_memory WHERE account_id = ? ORDER BY imported_at DESC, id ASC`,
    )
    .all(accountId) as any[];
  // A sectioned import lists as one entry: its sections summed.
  const out: ImportedMemory[] = [];
  const groups = new Map<string, ImportedMemory>();
  for (const r of rows) {
    if (r.group_id) {
      const g = groups.get(r.group_id);
      if (!g) {
        const entry: ImportedMemory = {
          id: r.id,
          source: r.source,
          title: r.title,
          chars: r.chars,
          importedAt: r.imported_at,
          sections: 1,
        };
        groups.set(r.group_id, entry);
        out.push(entry);
      } else {
        g.chars += r.chars;
        g.sections += 1;
      }
    } else {
      out.push({
        id: r.id,
        source: r.source,
        title: r.title,
        chars: r.chars,
        importedAt: r.imported_at,
        sections: 1,
      });
    }
  }
  return out;
}

export function deleteImportedMemory(accountId: string, id: number): void {
  const row = db
    .query(`SELECT group_id FROM imported_memory WHERE account_id = ? AND id = ?`)
    .get(accountId, id) as { group_id: string | null } | null;
  if (row?.group_id) {
    db.query(`DELETE FROM imported_memory WHERE account_id = ? AND group_id = ?`).run(
      accountId,
      row.group_id,
    );
  } else {
    db.query(`DELETE FROM imported_memory WHERE account_id = ? AND id = ?`).run(accountId, id);
  }
}

// Who the owner is, always on: the head of USER.md (name, what to call
// them, contact, work) plus the head of MEMORY.md's Facts. A few hundred
// words, so Prism knows the owner on sight instead of asking who is
// typing. Drawn from the owner's own import, never from a stranger.
export function identityBlock(accountId: string): string {
  const sections = latestSelfExportSections(accountId);
  if (!sections.length) return "";
  const parts: string[] = [];
  const user = sections.find((s) => sectionKind(s.title) === "user");
  if (user) {
    const head = user.content.split(/^##\s+Context/m)[0].trim();
    if (head) parts.push(head.slice(0, 2000));
  }
  const memory = sections.find((s) => sectionKind(s.title) === "memory");
  if (memory) {
    const facts = (memory.content.split(/^##\s+Facts/m)[1] || "").trim();
    if (facts) parts.push(facts.slice(0, 1500));
  }
  if (!parts.length) return "";
  return parts.join("\n\n").slice(0, 3000);
}

// Who Prism is, from the owner's own export: the SOUL and IDENTITY
// sections, for the Prism account only. Null when nothing was imported.
export function personaSeed(accountId: string): string | null {
  const sections = latestSelfExportSections(accountId);
  if (!sections.length) return null;
  const parts: string[] = [];
  for (const kind of ["soul", "identity"]) {
    const s = sections.find((x) => sectionKind(x.title) === kind);
    if (s) parts.push(s.content);
  }
  if (!parts.length) return null;
  return parts.join("\n\n").slice(0, 6000);
}

// Words that carry no meaning on their own, skipped when matching a
// message against the imported sections.
const RETRIEVAL_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "been", "were",
  "what", "when", "where", "which", "about", "there", "their", "they", "them",
  "then", "than", "also", "into", "your", "yours", "does", "did", "are", "was",
  "you", "your", "our", "ours", "can", "could", "would", "should", "will",
  "just", "like", "know", "think", "tell", "please", "thanks", "hello", "hiya",
]);

// Sections the brain must never be handed: the export's banner and
// table of contents, the persona (it seeds identity, not facts), and
// the free-code section, which must never travel through the brain.
const RETRIEVAL_EXCLUDED_KINDS = new Set(["header", "soul", "identity", "freecode"]);

function retrievalTokens(message: string): string[] {
  const words = String(message || "").toLowerCase().match(/[a-z][a-z'-]{2,}/g) || [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    if (RETRIEVAL_STOPWORDS.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

// The sections that answer this message, for the chat system prompt.
// Each stored section is scored by how many of the message's words it
// holds; the best two are handed over as a window around the first
// match, never as a fixed cut of the file's head. It is background,
// never instructions.
export function memoryDigest(accountId: string, message?: string): string {
  const sections = latestSelfExportSections(accountId);
  if (sections.length) {
    const tokens = retrievalTokens(message || "");
    if (!tokens.length) return "";
    const scored = sections
      .filter((s) => !RETRIEVAL_EXCLUDED_KINDS.has(sectionKind(s.title)))
      .map((s) => {
        const hay = s.content.toLowerCase();
        let score = 0;
        let firstPos = -1;
        for (const t of tokens) {
          const pos = hay.indexOf(t);
          if (pos >= 0) {
            score += 1;
            if (firstPos < 0 || pos < firstPos) firstPos = pos;
          }
        }
        return { title: s.title, content: s.content, score, firstPos };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.firstPos - b.firstPos)
      .slice(0, 2);
    if (!scored.length) return "";
    const parts = scored.map((s) => {
      const start = Math.max(0, s.firstPos - 400);
      const slice = s.content.slice(start, start + 2500);
      return `[From your imported memory: ${s.title}]\n${slice}`;
    });
    return parts.join("\n\n").slice(0, 6000);
  }
  // No self-export: the most recent plain imports, head-cut as before.
  // A plain note is short, so the head is the whole of it.
  const rows = db
    .query(
      `SELECT title, source, content FROM imported_memory
       WHERE account_id = ? AND group_id IS NULL ORDER BY imported_at DESC LIMIT 2`,
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

// --- Website demo requests (Nov 23, 2026) ---
// The "Text me the demo" form on prism5labs.com posts to
// /api/demo-request (see src/server/demoRequests.ts). One row per
// accepted request: the number the visitor asked to have the demo
// texted to, and whether the notification email to the business inbox
// went out. Nothing else is collected — no name, no email, no account.

db.exec(`
CREATE TABLE IF NOT EXISTS demo_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  phone_display TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_demo_requests_phone ON demo_requests (phone, created_at);
`);

export interface DemoRequest {
  id: number;
  phone: string;
  phoneDisplay: string;
  createdAt: string;
  notified: boolean;
}

export function addDemoRequest(phone: string, phoneDisplay: string): DemoRequest {
  const now = new Date().toISOString();
  const info = db
    .query(
      `INSERT INTO demo_requests (phone, phone_display, created_at) VALUES (?, ?, ?)`,
    )
    .run(phone, phoneDisplay, now);
  return {
    id: Number(info.lastInsertRowid),
    phone,
    phoneDisplay,
    createdAt: now,
    notified: false,
  };
}

// The most recent request for a number, or null. The endpoint uses it
// to keep a double-tap (or a flood) from emailing the business inbox
// twice for the same number in a day.
export function latestDemoRequest(phone: string): DemoRequest | null {
  const row = db
    .query(`SELECT * FROM demo_requests WHERE phone = ? ORDER BY id DESC LIMIT 1`)
    .get(phone) as any;
  if (!row) return null;
  return {
    id: row.id,
    phone: row.phone,
    phoneDisplay: row.phone_display,
    createdAt: row.created_at,
    notified: row.notified === 1,
  };
}

export function markDemoRequestNotified(id: number): void {
  db.query(`UPDATE demo_requests SET notified = 1 WHERE id = ?`).run(id);
}

// The app account that has a given Gmail address connected, or null.
// The demo-request notification is sent through the business
// mailbox's own Gmail connection when one exists in this app (the
// same connection the Switchboard sends from).
export function gmailConnectionForEmail(
  email: string,
): { accountId: string; label: string } | null {
  const row = db
    .query(
      `SELECT account_id, label FROM gmail_accounts WHERE lower(email) = lower(?) LIMIT 1`,
    )
    .get(email) as any;
  return row ? { accountId: row.account_id, label: row.label } : null;
}
