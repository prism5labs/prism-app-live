// Export-all test: GET /api/threads/export-all returns every
// conversation the account holds in one Markdown file.
//
// Run: bun scripts/test-export-all.ts (spawns the real server on
// :3128 against a throwaway DATA_DIR; no network, no brain needed).

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildFullExport, fullExportFilename } from "../src/server/threadExport";

const ROOT = join(import.meta.dir, "..");
const APP_PORT = 3128;
const DATA_DIR = "/tmp/prism-export-all-test";
const ACCOUNT = "acc_exportall012345678";
const OTHER = "acc_exportother0123456";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

{
  const text = buildFullExport(
    [
      { photon: "Prism", messages: [{ role: "user", content: "Hello Prism" }, { role: "assistant", content: "Hello to you" }] },
      { photon: "Mabel", messages: [{ role: "user", content: "Hello Mabel" }] },
    ],
    new Date("2026-11-25T08:00:00.000Z"),
  );
  check("builder: heading", text.startsWith("# All your Prism conversations"));
  check("builder: counts", text.includes("2 conversations · 3 messages"));
  check("builder: both conversations in order", text.indexOf("## Conversation with Prism") >= 0 && text.indexOf("## Conversation with Prism") < text.indexOf("## Conversation with Mabel"));
  check("builder: labels", text.includes("**You:** Hello Prism") && text.includes("**Prism:** Hello to you") && text.includes("**You:** Hello Mabel"));
  check("builder: filename", fullExportFilename(new Date("2026-11-25T08:00:00.000Z")) === "prism-all-conversations-2026-11-25.md");
}

async function startApp() {
  const proc = Bun.spawn(["bun", "src/server.ts"], { cwd: ROOT, env: { ...process.env, PORT: String(APP_PORT), DATA_DIR }, stdout: "ignore", stderr: "pipe" });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://localhost:${APP_PORT}/healthz`); if (r.ok) return proc; } catch {}
    await Bun.sleep(200);
  }
  throw new Error("app did not come up");
}

function seedMessage(accountId: string, photon: string, role: string, content: string) {
  const db = new Database(join(DATA_DIR, "app.db"));
  const now = new Date().toISOString();
  db.query(`INSERT INTO messages (account_id, photon, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(accountId, photon, role, content, now);
  db.query(`INSERT INTO threads (account_id, photon, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, photon) DO UPDATE SET updated_at = excluded.updated_at`).run(accountId, photon, now, now);
  db.close();
}

await rm(DATA_DIR, { recursive: true, force: true });
const proc = await startApp();
try {
  const st = await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${ACCOUNT}`);
  check("seed: account state loads", st.ok);
  await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${OTHER}`);
  seedMessage(ACCOUNT, "Prism", "user", "First account Prism line.");
  seedMessage(ACCOUNT, "Prism", "assistant", "Prism replies here.");
  seedMessage(ACCOUNT, "Mabel", "user", "A line for Mabel only.");
  seedMessage(OTHER, "Prism", "user", "Other account secret line.");

  const res = await fetch(`http://localhost:${APP_PORT}/api/threads/export-all?accountId=${ACCOUNT}`);
  const body = await res.text();
  check("export-all: status 200", res.status === 200, `got ${res.status}`);
  check("export-all: markdown content type", (res.headers.get("content-type") || "").startsWith("text/markdown"));
  const disp = res.headers.get("content-disposition") || "";
  check("export-all: attachment filename", disp.includes('filename="prism-all-conversations-') && disp.includes('.md"'), disp);
  check("export-all: both conversations present", body.includes("## Conversation with Prism") && body.includes("## Conversation with Mabel"), body.slice(0, 400));
  check("export-all: messages present with labels", body.includes("**You:** First account Prism line.") && body.includes("**Prism:** Prism replies here.") && body.includes("**You:** A line for Mabel only."));
  check("export-all: other account never included", !body.includes("Other account secret line."));
  check("export-all: counts line", body.includes("2 conversations · 3 messages"), body.slice(0, 300));

  const empty = await fetch(`http://localhost:${APP_PORT}/api/threads/export-all?accountId=acc_exportempty0123456`);
  const emptyBody: any = await empty.json().catch(() => null);
  check("export-all: empty account is 404 no messages", empty.status === 404 && emptyBody?.error === "no messages to export", `${empty.status} ${JSON.stringify(emptyBody)}`);

  const noAccount = await fetch(`http://localhost:${APP_PORT}/api/threads/export-all`);
  check("export-all: missing account is 400", noAccount.status === 400, `got ${noAccount.status}`);

  // The single-thread route still works and is not swallowed by export-all.
  const single = await fetch(`http://localhost:${APP_PORT}/api/threads/Prism/export?accountId=${ACCOUNT}`);
  check("export-all: single export still 200", single.status === 200, `got ${single.status}`);
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}

{
  const main = readFileSync(join(ROOT, "client", "main.ts"), "utf8");
  check("client: Chat front carries Export all conversations", main.includes("Export all conversations") && main.includes("api.exportAllUrl()"));
  const apiClient = readFileSync(join(ROOT, "client", "api.ts"), "utf8");
  check("client: export-all URL carries accountId", apiClient.includes("/api/threads/export-all?accountId="));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
