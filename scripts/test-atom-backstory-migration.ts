// Boot test for the atom backstory pronoun migration (Nov 22, 2026).
//
// The v55 pronoun pass fixed the Jude (they/them) and Pierce (he/him)
// templates in src/shared/backstories.ts, but atom_backstories rows are
// seeded once at account linking, so stored rows keep the old she/her
// wording — and because the v54 rename migration never touched this
// table, rows can still be keyed by the old names June and Pearl.
//
// This test seeds a scratch database with the four live shapes:
//   acct-old-keys   — June + Pearl rows (pre-v54 text), plus Mabel and
//                     Clive control rows that must not change.
//   acct-new-keys   — Jude + Pierce rows holding the v54 (pre-v55) text.
//   acct-both       — a June row AND a Jude row for one account (the
//                     collision case), plus a lone Pearl row.
//   acct-current    — Jude + Pierce rows already at the corrected text.
//   acct-cleo-only  — a lone Cleo row (pre-v54 text): the final sweep
//                     carries it to Clive with the current template.
//   acct-cleo-both  — a Cleo row AND a corrected Clive row: the stale
//                     Cleo row is removed, the Clive row left as it is.
// It boots the real server against the scratch DB, checks every row,
// then boots a second time and checks the state is identical
// (idempotency). Usage: bun scripts/test-atom-backstory-migration.ts
// (exit 0 = all pass). Prints PASS/FAIL lines and counts only — never
// the backstory texts themselves beyond short pronoun probes.

import { rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ATOM_BACKSTORIES } from "../src/shared/backstories";

const DATA_DIR = process.env.DATA_DIR || "/tmp/prism-atom-backstory-migration-test";
const APP_PORT = 3117;
const NOW = "2026-11-19T00:00:00.000Z";

// The pre-v55 stored texts (git history: 91d77df for the June/Pearl
// keys, 911edf7 for the Jude/Pierce keys). The v54 rename changed only
// the leading name in each story, so the Jude/Pierce old texts derive
// from the June/Pearl ones by that one word.
const OLD_JUNE =
  "June kept the lamp in a lighthouse keeper's cottage, and her whole job was the first light: lit before dark, steady through the night, so that anyone coming home could find the way. She learned that starting is the hard part — once the lamp is lit, the rest of the evening looks after itself. She has lit the first lamp ever since, and since {date} she has lit it for {owner} — one small start, and the day begins.";
const OLD_PEARL =
  "Pearl kept the ledger at a market stall where the money was counted in plain sight and explained in plain words. She never let a customer leave confused about what they had spent, and she never let a shilling go missing without knowing where it went. She has kept the books ever since, plainly and kindly, and since {date} she has kept {owner}'s — the money in plain words, no jargon, and nothing hidden.";
const OLD_JUDE = OLD_JUNE.replace("June kept", "Jude kept");
const OLD_PIERCE = OLD_PEARL.replace("Pearl kept", "Pierce kept");
// The pre-v54 Cleo text (git history: 91d77df^). Cleo's template never
// had a pronoun fault, so the old text differs from Clive's current
// template only in the leading name.
const OLD_CLEO = (ATOM_BACKSTORIES["Clive"] as string).replace("Clive ran", "Cleo ran");

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

function seed() {
  const db = new Database(join(DATA_DIR, "app.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`CREATE TABLE IF NOT EXISTS atom_backstories (
    account_id TEXT NOT NULL,
    atom TEXT NOT NULL,
    template TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (account_id, atom)
  );`);
  const ins = db.query(
    `INSERT INTO atom_backstories (account_id, atom, template, created_at) VALUES (?, ?, ?, ?)`,
  );
  // acct-old-keys: pre-v54 keys and text, plus two controls.
  ins.run("acct-old-keys", "June", OLD_JUNE, NOW);
  ins.run("acct-old-keys", "Pearl", OLD_PEARL, NOW);
  ins.run("acct-old-keys", "Mabel", ATOM_BACKSTORIES["Mabel"], NOW);
  ins.run("acct-old-keys", "Clive", ATOM_BACKSTORIES["Clive"], NOW);
  // acct-new-keys: post-v54 keys, pre-v55 text.
  ins.run("acct-new-keys", "Jude", OLD_JUDE, NOW);
  ins.run("acct-new-keys", "Pierce", OLD_PIERCE, NOW);
  // acct-both: collision — both keys for the lamp story, lone Pearl.
  ins.run("acct-both", "June", OLD_JUNE, NOW);
  ins.run("acct-both", "Jude", OLD_JUDE, NOW);
  ins.run("acct-both", "Pearl", OLD_PEARL, NOW);
  // acct-current: already corrected.
  ins.run("acct-current", "Jude", ATOM_BACKSTORIES["Jude"], NOW);
  ins.run("acct-current", "Pierce", ATOM_BACKSTORIES["Pierce"], NOW);
  // acct-cleo-only: a lone pre-v54 Cleo row.
  ins.run("acct-cleo-only", "Cleo", OLD_CLEO, NOW);
  // acct-cleo-both: stale Cleo row beside a corrected Clive row.
  ins.run("acct-cleo-both", "Cleo", OLD_CLEO, NOW);
  ins.run("acct-cleo-both", "Clive", ATOM_BACKSTORIES["Clive"], NOW);
  db.close();
}

type Row = { account_id: string; atom: string; template: string };
function readRows(): Row[] {
  const db = new Database(join(DATA_DIR, "app.db"));
  const rows = db
    .query(`SELECT account_id, atom, template FROM atom_backstories ORDER BY account_id, atom`)
    .all() as Row[];
  db.close();
  return rows;
}

function assertMigrated(label: string) {
  const rows = readRows();
  const byKey = new Map(rows.map((r) => [`${r.account_id}/${r.atom}`, r.template]));
  check(`${label}: no June rows survive`, !rows.some((r) => r.atom === "June"));
  check(`${label}: no Pearl rows survive`, !rows.some((r) => r.atom === "Pearl"));
  check(`${label}: no Cleo rows survive`, !rows.some((r) => r.atom === "Cleo"));
  check(`${label}: total row count is 12`, rows.length === 12, `got ${rows.length}`);
  check(
    `${label}: acct-cleo-only row carried to Clive with the current template`,
    byKey.get("acct-cleo-only/Clive") === ATOM_BACKSTORIES["Clive"],
  );
  check(
    `${label}: acct-cleo-both keeps its corrected Clive row`,
    byKey.get("acct-cleo-both/Clive") === ATOM_BACKSTORIES["Clive"],
  );
  for (const acct of ["acct-old-keys", "acct-new-keys", "acct-both", "acct-current"]) {
    check(
      `${label}: ${acct} Jude row holds the corrected template`,
      byKey.get(`${acct}/Jude`) === ATOM_BACKSTORIES["Jude"],
    );
    check(
      `${label}: ${acct} Pierce row holds the corrected template`,
      byKey.get(`${acct}/Pierce`) === ATOM_BACKSTORIES["Pierce"],
    );
  }
  check(
    `${label}: Mabel control row untouched`,
    byKey.get("acct-old-keys/Mabel") === ATOM_BACKSTORIES["Mabel"],
  );
  check(
    `${label}: Clive control row untouched`,
    byKey.get("acct-old-keys/Clive") === ATOM_BACKSTORIES["Clive"],
  );
  const jude = byKey.get("acct-old-keys/Jude") || "";
  const pierce = byKey.get("acct-old-keys/Pierce") || "";
  check(`${label}: migrated Jude text reads they/them`, jude.includes("their whole job") && !jude.includes("her whole job"));
  check(`${label}: migrated Pierce text reads he/him`, pierce.includes("He never let") && !pierce.includes("She never let"));
}

async function startApp() {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(APP_PORT), DATA_DIR, GEMINI_API_KEY: "test-key" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://localhost:${APP_PORT}/healthz`);
      if (r.ok) return proc;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  const errText = await new Response(proc.stderr as any).text().catch(() => "");
  throw new Error(`app did not come up: ${errText.slice(0, 1000)}`);
}

check("old fixtures really are the old wording", OLD_JUDE.includes("her whole job") && OLD_PIERCE.includes("She never let"));
check("corrected Jude template differs from old", ATOM_BACKSTORIES["Jude"] !== OLD_JUDE);
check("corrected Pierce template differs from old", ATOM_BACKSTORIES["Pierce"] !== OLD_PIERCE);
check("old Cleo fixture really is the old key text", OLD_CLEO.startsWith("Cleo ran") && OLD_CLEO !== ATOM_BACKSTORIES["Clive"]);

await rm(DATA_DIR, { recursive: true, force: true });
mkdirSync(DATA_DIR, { recursive: true });
seed();
check("seeded 14 rows", readRows().length === 14, `got ${readRows().length}`);

// --- First boot: the migration runs ---
let proc = await startApp();
try {
  check("first boot succeeds against seeded DB", true);
  assertMigrated("boot 1");
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}
const afterFirst = JSON.stringify(readRows());

// --- Second boot: idempotency ---
proc = await startApp();
try {
  check("second boot succeeds", true);
  assertMigrated("boot 2");
  check("state identical after second boot", JSON.stringify(readRows()) === afterFirst);
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
