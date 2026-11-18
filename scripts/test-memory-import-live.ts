// Verify the memory import fix through the real HTTP API with a mock
// brain (local only, never production). Boots the app server and a mock
// Gemini that captures the system prompt the brain actually receives,
// then checks, over the wire:
//   1. POST /api/memory stores the real self-export as 12 sections.
//   2. GET /api/memory lists it as one grouped import.
//   3. POST /api/chat "Do you know me?" reaches the brain with a system
//      prompt that names Neil, Calyn, and Harvey and speaks as Jeeves,
//      with no table of contents and no free-code section.
//   4. A content question ("Mounjaro") pulls the matching section into
//      the prompt.
// Usage: DATA_DIR=/tmp/prism-memory-import-live-test bun scripts/test-memory-import-live.ts
//   (exit 0 = all pass)
// Nothing in this file prints the export's contents: only counts and
// PASS/FAIL lines. The export itself is private and stays out of logs.

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const DATA_DIR = process.env.DATA_DIR || "/tmp/prism-memory-import-live-test";
const EXPORT_PATH =
  process.env.EXPORT_PATH ||
  join(process.env.HOME || "/home/hatch", "workspace/your_files/prism-5-self-export-2026-11-17.txt");
const APP_PORT = 3106;
const MOCK_PORT = 3105;
const ACCT = "test-live-import-01";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

await rm(DATA_DIR, { recursive: true, force: true });
const exportText = readFileSync(EXPORT_PATH, "utf-8");

// --- Mock Gemini: capture the system prompt, answer with a fixed line ---
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

// --- App server lifecycle ---
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

const proc = await startApp();
try {
  // Own Prism for the test account, straight into the throwaway database.
  const testDb = new Database(join(DATA_DIR, "app.db"));
  testDb
    .query(`INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at) VALUES (?, 'photon', ?, ?)`)
    .run(ACCT, "Prism", new Date().toISOString());
  testDb.close();

  // 1. Import the real export over the API.
  const imp = await api("/api/memory", {
    method: "POST",
    body: JSON.stringify({
      accountId: ACCT,
      source: "Notes file",
      title: "prism-5-self-export-2026-11-17",
      content: exportText,
    }),
  });
  check("API import succeeds", imp.ok === true, JSON.stringify(imp).slice(0, 120));
  check("API import stores 12 sections", imp.imported?.sections === 12, `got ${imp.imported?.sections}`);
  check("API import keeps the whole file", (imp.imported?.chars || 0) > 140_000, `${(imp.imported?.chars || 0).toLocaleString()} chars`);

  // 2. It lists as one grouped import.
  const listed = await api(`/api/memory?accountId=${ACCT}`);
  check("API list shows one grouped import", listed.ok === true && listed.imports?.length === 1, `got ${listed.imports?.length}`);
  check("listed import has 12 sections", listed.imports?.[0]?.sections === 12, `got ${listed.imports?.[0]?.sections}`);

  // 3. "Do you know me?" reaches the brain knowing Neil.
  const chat1 = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ accountId: ACCT, photon: "Prism", message: "Do you know me?" }),
  });
  check("chat answers", chat1.ok === true, JSON.stringify(chat1).slice(0, 120));
  check("brain sees the owner's name", lastSystemPrompt.includes("Neil Joseph Saindon"));
  check("brain sees Calyn", lastSystemPrompt.includes("Calyn"));
  check("brain sees Harvey", lastSystemPrompt.includes("Harvey"));
  check("brain sees the Jeeves persona", lastSystemPrompt.includes("Jeeves"));
  check("brain never sees the table of contents", !lastSystemPrompt.includes("WHAT IS IN HERE"));
  check("brain never sees the free-code section", !lastSystemPrompt.includes("Friends & Family free code"));

  // 4. A content question pulls the matching section.
  lastSystemPrompt = "";
  const chat2 = await api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ accountId: ACCT, photon: "Prism", message: "What Mounjaro dose am I on?" }),
  });
  check("content question answers", chat2.ok === true, JSON.stringify(chat2).slice(0, 120));
  check("brain sees the Mounjaro section", lastSystemPrompt.includes("Mounjaro"));
  check("content prompt has no table of contents", !lastSystemPrompt.includes("WHAT IS IN HERE"));
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
  mockGemini.stop();
}

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
