// Boot test for the imported_memory migration (Render deploy 73c7772
// crashed at boot: the schema block created an index on group_id before
// the migration added the column).
//
// Phase A: seed a database with the PRE-fix schema (no section/group_id
// columns — the state Render's persistent disk holds) holding one whole,
// 100,000-character-truncated self-export row, then boot the real server
// against it. The boot must succeed, the migration must add the columns
// and split the row into sections in place.
// Phase B: boot the same database again (columns now exist) and confirm
// the boot still succeeds and nothing is split twice.
// Usage: bun scripts/test-migration-boot.ts  (exit 0 = all pass)
// Nothing in this file prints the export's contents: only counts and
// PASS/FAIL lines. The export itself is private and stays out of logs.

import { rm } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DATA_DIR = process.env.DATA_DIR || "/tmp/prism-migration-boot-test";
const EXPORT_PATH =
  process.env.EXPORT_PATH ||
  join(process.env.HOME || "/home/hatch", "workspace/your_files/prism-5-self-export-2026-11-17.txt");
const APP_PORT = 3116;
const MOCK_PORT = 3115;
const ACCT = "test-migration-boot-01";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// --- Seed a pre-fix database: old schema + one truncated whole-file row ---
async function seedPreFixDb() {
  await rm(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
  const schema = readFileSync(join(import.meta.dir, "fixtures/pre-fix-schema.sql"), "utf-8");
  const db = new Database(join(DATA_DIR, "app.db"));
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(schema);
  const cols = db.query(`PRAGMA table_info(imported_memory)`).all() as { name: string }[];
  const names = cols.map((c) => c.name);
  check("seeded DB has no section column", !names.includes("section"));
  check("seeded DB has no group_id column", !names.includes("group_id"));
  const exportText = readFileSync(EXPORT_PATH, "utf-8");
  const truncated = exportText.slice(0, 100_000); // the old 100k cap: the live state
  db.query(
    `INSERT INTO imported_memory (account_id, source, title, content, imported_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(ACCT, "Notes file", "prism-5-self-export-2026-11-17", truncated, "2026-11-17T21:49:00.000Z");
  check("seeded one truncated whole-file row", true, `${truncated.length.toLocaleString()} chars`);
  db.query(`INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at) VALUES (?, 'photon', ?, ?)`)
    .run(ACCT, "Prism", new Date().toISOString());
  db.close();
}

// --- Mock Gemini + app server lifecycle (same shape as test-memory-import-live.ts) ---
let lastSystemPrompt = "";
const mockGemini = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const body = await req.json().catch(() => ({}));
    lastSystemPrompt = String(body?.systemInstruction?.parts?.[0]?.text || "");
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Mock reply." }] }, finishReason: "STOP" }],
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});

async function startApp() {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DATA_DIR,
      GEMINI_API_KEY: "test-key",
      GEMINI_BASE_URL: `http://localhost:${MOCK_PORT}`,
    },
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

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`http://localhost:${APP_PORT}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return r.json() as Promise<any>;
}

function dbState() {
  const db = new Database(join(DATA_DIR, "app.db"));
  const cols = db.query(`PRAGMA table_info(imported_memory)`).all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  const unsectioned = db
    .query(`SELECT COUNT(*) AS n FROM imported_memory WHERE group_id IS NULL`)
    .get() as { n: number };
  const sectioned = db
    .query(`SELECT COUNT(*) AS n, COUNT(DISTINCT group_id) AS g FROM imported_memory WHERE group_id IS NOT NULL`)
    .get() as { n: number; g: number };
  const titles = db
    .query(`SELECT DISTINCT section AS s FROM imported_memory WHERE group_id IS NOT NULL`)
    .all() as { s: string }[];
  const hasGroupIndex = db
    .query(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_imported_memory_group'`)
    .get() as { n: number };
  db.close();
  return {
    names,
    unsectioned: unsectioned.n,
    sectioned: sectioned.n,
    groups: sectioned.g,
    titles: titles.map((t) => t.s),
    hasGroupIndex: hasGroupIndex.n === 1,
  };
}

await seedPreFixDb();
let phaseASections = 0;

// --- Phase A: first boot against the pre-fix database ---
let proc = await startApp();
try {
  check("Phase A: server boots against pre-fix DB", true);
  const s = dbState();
  check("migration added section column", s.names.has("section"));
  check("migration added group_id column", s.names.has("group_id"));
  check("migration created the group index", s.hasGroupIndex);
  check("no unsectioned rows remain", s.unsectioned === 0, `got ${s.unsectioned}`);
  // The 100,000-char cut lands mid-file, so the truncated copy holds
  // only its first six sections (preamble, SOUL, IDENTITY, USER,
  // MEMORY, Alignment Synthesis); the later sections were cut off by
  // the old cap and can only come back with a full re-import.
  check("whole-file row split into sections", s.sectioned === 6, `got ${s.sectioned} sections in ${s.groups} group(s)`);
  check(
    "sections include SOUL, IDENTITY, USER, MEMORY",
    ["SOUL.md", "IDENTITY.md", "USER.md", "MEMORY.md"].every((t) => s.titles.includes(t)),
    s.titles.join(", "),
  );
  const listed = await api(`/api/memory?accountId=${ACCT}`);
  check("API lists one grouped import", listed.ok === true && listed.imports?.length === 1, `got ${listed.imports?.length}`);
  check("listed import section count matches", listed.imports?.[0]?.sections === s.sectioned, `got ${listed.imports?.[0]?.sections}`);
  lastSystemPrompt = "";
  const chat = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ accountId: ACCT, photon: "Prism", message: "Do you know me?" }),
  });
  check("chat answers after migration", chat.ok === true, JSON.stringify(chat).slice(0, 120));
  check("brain sees the owner's name", lastSystemPrompt.includes("Neil Joseph Saindon"));
  check("brain never sees the table of contents", !lastSystemPrompt.includes("WHAT IS IN HERE"));
  phaseASections = s.sectioned;
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}

// --- Phase B: boot the same database again (columns already exist) ---
proc = await startApp();
try {
  check("Phase B: server boots again with columns present", true);
  const s = dbState();
  check("no double-split on re-boot", s.sectioned === phaseASections, `got ${s.sectioned}, was ${phaseASections}`);
  check("still one group", s.groups === 1, `got ${s.groups}`);
  lastSystemPrompt = "";
  const chat = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ accountId: ACCT, photon: "Prism", message: "Do you know me?" }),
  });
  check("chat still answers after re-boot", chat.ok === true);
  check("brain still sees the owner's name", lastSystemPrompt.includes("Neil Joseph Saindon"));
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
  mockGemini.stop();
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
