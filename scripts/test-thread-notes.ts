// Thread notes test: a user can keep one short private note on each
// Photon or Atom conversation, view/edit/clear it, scoped by account.
//
//   1. Initially empty, set then get, edit overwrites.
//   2. Trim + 500-char cap; empty note clears.
//   3. Account isolation both ways.
//   4. Unknown name 400, missing account 400 on get and set.
//   5. Deleting a conversation clears its note.
//   6. Client wiring: note API path and Note control.
//
// Run: bun scripts/test-thread-notes.ts (spawns the real server on
// :3137 against a throwaway DATA_DIR; no network, no brain needed).

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP_PORT = 3137;
const DATA_DIR = "/tmp/prism-thread-notes-test";
const ACCOUNT = "acc_notetest012345678";
const OTHER = "acc_noteother01234567";

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
    } catch {}
    await Bun.sleep(200);
  }
  const errText = await new Response(proc.stderr as any).text().catch(() => "");
  throw new Error(`app did not come up: ${errText.slice(0, 1000)}`);
}

async function getNote(accountId: string | null, name: string, byHeader = false): Promise<any> {
  const headers: Record<string, string> = {};
  let url = `http://localhost:${APP_PORT}/api/threads/${name}/note`;
  if (accountId) {
    if (byHeader) headers["x-account-id"] = accountId;
    else url += `?accountId=${accountId}`;
  }
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function setNote(accountId: string | null, name: string, note: string, byHeader = false): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const body: Record<string, string> = { note };
  if (accountId) {
    if (byHeader) headers["x-account-id"] = accountId;
    else body.accountId = accountId;
  }
  const res = await fetch(`http://localhost:${APP_PORT}/api/threads/${name}/note`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

function seedMessage(accountId: string, photon: string, content: string) {
  const db = new Database(join(DATA_DIR, "app.db"));
  const now = new Date().toISOString();
  db.query(`INSERT INTO messages (account_id, photon, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(accountId, photon, "user", content, now);
  db.query(`INSERT INTO threads (account_id, photon, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, photon) DO UPDATE SET updated_at = excluded.updated_at`).run(accountId, photon, now, now);
  db.close();
}

await rm(DATA_DIR, { recursive: true, force: true });
const proc = await startApp();
try {
  const st = await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${ACCOUNT}`);
  check("seed: account state loads", st.ok);

  const empty = await getNote(ACCOUNT, "Prism");
  check("get: initially empty note", empty.status === 200 && empty.body?.ok === true && empty.body?.name === "Prism" && empty.body?.note === "", `${empty.status} ${JSON.stringify(empty.body)}`);

  const set1 = await setNote(ACCOUNT, "Prism", "Working on the spring launch");
  check("set: returns stored note", set1.status === 200 && set1.body?.ok === true && set1.body?.name === "Prism" && set1.body?.note === "Working on the spring launch", `${set1.status} ${JSON.stringify(set1.body)}`);
  const got1 = await getNote(ACCOUNT, "Prism");
  check("get: set note reads back", got1.status === 200 && got1.body?.note === "Working on the spring launch", JSON.stringify(got1.body));

  const set2 = await setNote(ACCOUNT, "Prism", "Revised: launch moved to May");
  const got2 = await getNote(ACCOUNT, "Prism");
  check("edit: overwrites previous note", set2.status === 200 && got2.body?.note === "Revised: launch moved to May", JSON.stringify(got2.body));

  // Atom name works too
  const setAtom = await setNote(ACCOUNT, "Mabel", "Garden project");
  check("set: Atom Mabel note works", setAtom.status === 200 && setAtom.body?.note === "Garden project", JSON.stringify(setAtom.body));

  // Trim + cap
  const padded = await setNote(ACCOUNT, "Prism", "  hello note  ");
  check("set: note is trimmed", padded.status === 200 && padded.body?.note === "hello note", JSON.stringify(padded.body));
  const long = "x".repeat(600);
  const capped = await setNote(ACCOUNT, "Prism", long);
  check("set: note capped at 500 chars", capped.status === 200 && capped.body?.note?.length === 500, `${capped.body?.note?.length}`);
  const gotCap = await getNote(ACCOUNT, "Prism");
  check("get: capped note reads back at 500", gotCap.body?.note?.length === 500);

  // Empty clears
  const cleared = await setNote(ACCOUNT, "Prism", "   ");
  check("clear: empty/whitespace note clears", cleared.status === 200 && cleared.body?.note === "", JSON.stringify(cleared.body));
  const gotCleared = await getNote(ACCOUNT, "Prism");
  check("clear: get after clear is empty", gotCleared.body?.note === "");

  // Account isolation both ways
  await setNote(ACCOUNT, "Prism", "Account A note");
  const otherEmpty = await getNote(OTHER, "Prism");
  check("isolation: other account gets empty note for same Face", otherEmpty.status === 200 && otherEmpty.body?.note === "", JSON.stringify(otherEmpty.body));
  await setNote(OTHER, "Prism", "Account B note");
  const aAfter = await getNote(ACCOUNT, "Prism");
  const bAfter = await getNote(OTHER, "Prism");
  check("isolation: each account keeps its own note", aAfter.body?.note === "Account A note" && bAfter.body?.note === "Account B note", `${JSON.stringify(aAfter.body)} ${JSON.stringify(bAfter.body)}`);
  await setNote(OTHER, "Prism", "");
  const aAfterClear = await getNote(ACCOUNT, "Prism");
  check("isolation: other account clearing does not clear first", aAfterClear.body?.note === "Account A note");

  // Header account on get
  const byHeader = await getNote(ACCOUNT, "Prism", true);
  check("get: x-account-id header accepted", byHeader.status === 200 && byHeader.body?.note === "Account A note", JSON.stringify(byHeader.body));

  // Unknown name 400
  const unknownGet = await getNote(ACCOUNT, "Nobody");
  check("unknown name: get is 400 unknown photon", unknownGet.status === 400 && unknownGet.body?.error === "unknown photon", `${unknownGet.status} ${JSON.stringify(unknownGet.body)}`);
  const unknownSet = await setNote(ACCOUNT, "Nobody", "hi");
  check("unknown name: set is 400 unknown photon", unknownSet.status === 400 && unknownSet.body?.error === "unknown photon", `${unknownSet.status} ${JSON.stringify(unknownSet.body)}`);

  // Missing account 400 on get and set
  const noAccGet = await getNote(null, "Prism");
  check("missing account: get is 400 accountId required", noAccGet.status === 400 && noAccGet.body?.error === "accountId required", `${noAccGet.status} ${JSON.stringify(noAccGet.body)}`);
  const noAccSet = await setNote(null, "Prism", "hi");
  check("missing account: set is 400 accountId required", noAccSet.status === 400 && noAccSet.body?.error === "accountId required", `${noAccSet.status} ${JSON.stringify(noAccSet.body)}`);

  // Deleting a conversation clears its note
  seedMessage(ACCOUNT, "Prism", "A message to delete");
  const delRes = await fetch(`http://localhost:${APP_PORT}/api/threads/Prism/delete`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: ACCOUNT }),
  });
  const delBody: any = await delRes.json().catch(() => null);
  check("delete: conversation deletes", delRes.status === 200 && delBody?.ok === true, `${delRes.status} ${JSON.stringify(delBody)}`);
  const afterDelete = await getNote(ACCOUNT, "Prism");
  check("delete: note is cleared with conversation", afterDelete.status === 200 && afterDelete.body?.note === "", JSON.stringify(afterDelete.body));
  // Other Face note untouched by delete
  const mabelAfter = await getNote(ACCOUNT, "Mabel");
  check("delete: other Face note untouched", mabelAfter.body?.note === "Garden project", JSON.stringify(mabelAfter.body));
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}

// --- Client and server wiring ---
{
  const main = readFileSync(join(ROOT, "client", "main.ts"), "utf8");
  check("client: thread head carries a Note control", main.includes('"edit-thread-note"') && main.includes(">Note</button>"));
  check("client: thread head shows note text when set", main.includes("threadNote") && main.includes("Note:"));
  check("client: note is loaded with the thread", main.includes("loadThreadNote(name)") || main.includes("loadThreadNote"));
  const apiClient = readFileSync(join(ROOT, "client", "api.ts"), "utf8");
  check("client: api carries thread note endpoints", apiClient.includes("/note") && apiClient.includes("setThreadNote") && apiClient.includes("threadNote"));
  const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  check("server: thread note routes are mounted", server.includes("/note") && server.includes("getThreadNote") && server.includes("setThreadNote"));
  const db = readFileSync(join(ROOT, "src", "server", "db.ts"), "utf8");
  check("db: thread_notes table and helpers exist", db.includes("thread_notes") && db.includes("getThreadNote") && db.includes("setThreadNote") && db.includes("deleteThreadNote"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
