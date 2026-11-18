-- Pre-fix schema: the exact schema block from commit 7cdd755 (the deploy
-- live on Render before the memory import fix). The imported_memory table
-- has NO section or group_id column and there is no group index: that is
-- the state the Render persistent disk holds, and the state the boot
-- migration must survive. Extracted verbatim with:
--   git show 7cdd755:src/server/db.ts | sed -n "/^db.exec(\`$/,/^\`);$/p"
-- Only the db.exec( wrapper lines were removed.
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
