// scripts/export-db.ts — local-only backup of the Prism 5 app database.
//
// Dumps every user-data table from <DATA_DIR>/app.db to a timestamped JSON
// file. Run locally:
//
//   bun scripts/export-db.ts [output-dir]
//
// DATA_DIR honoured the same way as the server (src/server/config.ts):
// process.env.DATA_DIR, default "./data". The backup defaults to
// <DATA_DIR>/backups/app-db-<timestamp>.json, so it sits next to the
// database it came from and never inside the git repo's tracked files.
// Pass an explicit output dir as the first argument to put it elsewhere.
//
// This script is LOCAL ONLY. It is never exposed as an HTTP endpoint and
// nothing in src/server.ts calls it.
//
// WARNING: the backup contains Gmail OAuth refresh tokens (gmail_accounts)
// and Switchboard contact tokens. Treat the file as a secret: keep it off
// git, off shared drives, off chat. It exists so a database can be
// restored after a disk loss — not to be passed around.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Every user-data table in src/server/db.ts, in dependency-free order.
// Keep this list in sync with db.ts: if a table is added there, add it here.
const TABLES = [
  "accounts",
  "owned",
  "threads",
  "messages",
  "gmail_accounts",
  "customizations",
  "contacts",
] as const;

const dataDir = process.env.DATA_DIR || "./data";
const dbPath = join(dataDir, "app.db");

if (!existsSync(dbPath)) {
  console.error(`no database found at ${dbPath}`);
  console.error(`set DATA_DIR to the directory holding app.db and try again.`);
  process.exit(1);
}

// Open read-only: an export must never create, modify, or lock the live DB.
const db = new Database(dbPath, { readonly: true });

const existing = new Set(
  (
    db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as {
      name: string;
    }[]
  ).map((r) => r.name),
);

const tables: Record<string, unknown[]> = {};
const counts: Record<string, number> = {};
for (const table of TABLES) {
  if (!existing.has(table)) {
    console.warn(`warning: table ${table} not present, exporting as empty`);
    tables[table] = [];
    counts[table] = 0;
    continue;
  }
  // Table names come from the hardcoded TABLES list above, never from input.
  const rows = db.query(`SELECT * FROM ${table}`).all();
  tables[table] = rows;
  counts[table] = rows.length;
}
db.close();

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = process.argv[2] ? process.argv[2] : join(dataDir, "backups");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `app-db-${stamp}.json`);

writeFileSync(
  outPath,
  JSON.stringify(
    {
      meta: {
        exportedAt: new Date().toISOString(),
        sourcePath: dbPath,
        tool: "scripts/export-db.ts",
        counts,
      },
      tables,
    },
    null,
    2,
  ),
);

console.log(`exported ${dbPath}`);
for (const table of TABLES) console.log(`  ${table}: ${counts[table]}`);
console.log(`wrote ${outPath}`);
console.log(`keep this file private: it contains Gmail refresh tokens.`);
