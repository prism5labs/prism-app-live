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
