// Conversation export test: GET /api/threads/:name/export returns the
// thread as a downloadable Markdown transcript.
//
//   1. A seeded thread exports its messages in order, with speaker
//      labels ("You" for the owner, the Photon's name for the Photon),
//      the Photon's name in the heading, and an exported date line.
//   2. The download headers are right: text/markdown content type and
//      a Content-Disposition attachment with a .md filename naming
//      the Photon.
//   3. An empty thread is a clean 404 in the usual error shape, an
//      unknown name is a 400, and a missing account id is a 400.
//   4. The pure transcript builder keeps order and labels on its own.
//   5. The client carries the Export control wired to this endpoint.
//
// Run: bun scripts/test-thread-export.ts (spawns the real server on
// :3127 against a throwaway DATA_DIR; no network, no brain needed).

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { buildThreadExport, threadExportFilename } from "../src/server/threadExport";

const ROOT = join(import.meta.dir, "..");
const APP_PORT = 3127;
const DATA_DIR = "/tmp/prism-thread-export-test";
const ACCOUNT = "acc_exporttest01234567";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

// --- Pure builder: order, labels, heading, date line ---
{
  const text = buildThreadExport(
    "Prism",
    [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer" },
      { role: "user", content: "Second question" },
    ],
    new Date("2026-11-22T08:00:00.000Z"),
  );
  check("builder: heading names the Photon", text.startsWith("# Conversation with Prism"));
  check("builder: exported date line", text.includes("Exported: 2026-11-22T08:00:00.000Z"));
  check(
    "builder: messages in order with labels",
    text.indexOf("**You:** First question") >= 0 &&
      text.indexOf("**You:** First question") < text.indexOf("**Prism:** First answer") &&
      text.indexOf("**Prism:** First answer") < text.indexOf("**You:** Second question"),
    text.slice(0, 300),
  );
  check(
    "builder: filename names the Photon and the day",
    threadExportFilename("Prism", new Date("2026-11-22T08:00:00.000Z")) ===
      "prism-Prism-conversation-2026-11-22.md",
  );
}

// --- Server lifecycle (same harness shape as test-atom-chat.ts) ---
async function startApp() {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APP_PORT), DATA_DIR },
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

function seedMessage(accountId: string, photon: string, role: string, content: string) {
  const db = new Database(join(DATA_DIR, "app.db"));
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO messages (account_id, photon, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, photon, role, content, now);
  db.query(
    `INSERT INTO threads (account_id, photon, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, photon) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(accountId, photon, now, now);
  db.close();
}

await rm(DATA_DIR, { recursive: true, force: true });
const proc = await startApp();
try {
  // Create the account, then seed its Prism thread in order.
  const st = await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${ACCOUNT}`);
  check("seed: account state loads", st.ok);
  seedMessage(ACCOUNT, "Prism", "user", "Please remember the blue notebook.");
  seedMessage(ACCOUNT, "Prism", "assistant", "Noted — the blue notebook.");
  seedMessage(ACCOUNT, "Prism", "user", "And the meeting on Tuesday.");

  const res = await fetch(
    `http://localhost:${APP_PORT}/api/threads/Prism/export?accountId=${ACCOUNT}`,
  );
  const body = await res.text();
  check("export: status 200", res.status === 200, `got ${res.status}`);
  check(
    "export: content type is Markdown",
    (res.headers.get("content-type") || "").startsWith("text/markdown"),
    res.headers.get("content-type") || "",
  );
  const disposition = res.headers.get("content-disposition") || "";
  check(
    "export: attachment filename names the Photon and ends .md",
    disposition.startsWith("attachment;") &&
      disposition.includes('filename="prism-Prism-conversation-') &&
      disposition.includes('.md"'),
    disposition,
  );
  check("export: heading names the Photon", body.startsWith("# Conversation with Prism"));
  check("export: exported date line present", /^Exported: \d{4}-\d{2}-\d{2}T/m.test(body), body.slice(0, 200));
  check(
    "export: messages in order with speaker labels",
    body.indexOf("**You:** Please remember the blue notebook.") >= 0 &&
      body.indexOf("**You:** Please remember the blue notebook.") <
        body.indexOf("**Prism:** Noted — the blue notebook.") &&
      body.indexOf("**Prism:** Noted — the blue notebook.") <
        body.indexOf("**You:** And the meeting on Tuesday."),
    body.slice(0, 400),
  );

  // The account id also arrives by header, as on the thread read.
  const byHeader = await fetch(`http://localhost:${APP_PORT}/api/threads/Prism/export`, {
    headers: { "x-account-id": ACCOUNT },
  });
  check("export: x-account-id header accepted", byHeader.status === 200, `got ${byHeader.status}`);

  // Empty thread: a clean 404 in the usual error shape.
  const empty = await fetch(
    `http://localhost:${APP_PORT}/api/threads/Juniper/export?accountId=${ACCOUNT}`,
  );
  const emptyBody: any = await empty.json().catch(() => null);
  check(
    "empty thread: 404 with the standard error shape",
    empty.status === 404 && emptyBody?.ok === false && emptyBody?.error === "no messages to export",
    `${empty.status} ${JSON.stringify(emptyBody)}`,
  );

  // Unknown name and missing account follow the thread route's errors.
  const unknown = await fetch(
    `http://localhost:${APP_PORT}/api/threads/Nobody/export?accountId=${ACCOUNT}`,
  );
  const unknownBody: any = await unknown.json().catch(() => null);
  check(
    "unknown name: 400 unknown photon",
    unknown.status === 400 && unknownBody?.error === "unknown photon",
    `${unknown.status} ${JSON.stringify(unknownBody)}`,
  );
  const noAccount = await fetch(`http://localhost:${APP_PORT}/api/threads/Prism/export`);
  const noAccountBody: any = await noAccount.json().catch(() => null);
  check(
    "missing account: 400 accountId required",
    noAccount.status === 400 && noAccountBody?.error === "accountId required",
    `${noAccount.status} ${JSON.stringify(noAccountBody)}`,
  );
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}

// --- Client wiring: the Export control sits in the thread head and
// points at this endpoint with the current account id ---
{
  const main = readFileSync(join(ROOT, "client", "main.ts"), "utf8");
  check(
    "client: thread head carries an Export download control",
    main.includes("api.threadExportUrl(p.name)") && main.includes(">Export</a>"),
  );
  const apiClient = readFileSync(join(ROOT, "client", "api.ts"), "utf8");
  check(
    "client: export URL carries the current accountId",
    apiClient.includes("/export?accountId=${encodeURIComponent(getAccountId())}"),
  );
  const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  check("server: export route is mounted", server.includes("/export") && server.includes("threadExportFilename"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
