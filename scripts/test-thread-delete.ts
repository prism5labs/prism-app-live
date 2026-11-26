// Delete-a-conversation test: a user can delete their whole stored
// conversation with a Photon or an Atom — every message, the thread
// row, and any pin — while other Faces and other accounts stay put.
//
//   1. A seeded thread reads back in full, then deletes: the delete
//      reports the message count, the thread reads empty afterwards,
//      and the pin that pointed at it is gone.
//   2. The deleted words are gone everywhere: cross-conversation
//      search finds nothing and the single-thread export is the
//      clean "no messages to export" 404.
//   3. Deleting again is a clean no-op reporting zero removed.
//   4. Other Faces keep their messages; another account's thread
//      with the same Face is untouched, in read and in search.
//   5. An unknown name is a 400, and a missing account id is a 400.
//      The account id also arrives by header, as elsewhere.
//   6. The client carries the delete API, the Delete conversation
//      control in the thread head menu, and the two-tap arm in its
//      handler.
//
// Run: bun scripts/test-thread-delete.ts (spawns the real server on
// :3133 against a throwaway DATA_DIR; no network, no brain needed).

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP_PORT = 3133;
const DATA_DIR = "/tmp/prism-thread-delete-test";
const ACCOUNT = "acc_deletetest0123456";
const OTHER = "acc_deleteother012345";

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

async function getThread(accountId: string, name: string): Promise<any> {
  const res = await fetch(
    `http://localhost:${APP_PORT}/api/threads/${name}?accountId=${accountId}`,
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function deleteThread(accountId: string | null, name: string, byHeader = false): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  let body: Record<string, string> = {};
  if (accountId) {
    if (byHeader) headers["x-account-id"] = accountId;
    else body = { accountId };
  }
  const res = await fetch(`http://localhost:${APP_PORT}/api/threads/${name}/delete`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

await rm(DATA_DIR, { recursive: true, force: true });
const proc = await startApp();
try {
  const st = await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${ACCOUNT}`);
  check("seed: account state loads", st.ok);
  const stOther = await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${OTHER}`);
  check("seed: other account state loads", stOther.ok);

  // Seed: this account's Prism thread (3 messages, one carrying the
  // unique word "notebook"), this account's Mabel thread (2), and the
  // other account's Prism thread (1, same unique word).
  seedMessage(ACCOUNT, "Prism", "user", "Please remember the blue notebook.");
  seedMessage(ACCOUNT, "Prism", "assistant", "Noted — the blue notebook.");
  seedMessage(ACCOUNT, "Prism", "user", "And the meeting on Tuesday.");
  seedMessage(ACCOUNT, "Mabel", "user", "The garden gate sticks again.");
  seedMessage(ACCOUNT, "Mabel", "assistant", "I will add it to the list.");
  seedMessage(OTHER, "Prism", "user", "My own notebook note, nobody else's.");

  const before = await getThread(ACCOUNT, "Prism");
  check(
    "read: seeded Prism thread returns all 3 messages",
    before.status === 200 && before.body?.messages?.length === 3,
    `${before.status} ${JSON.stringify(before.body)?.slice(0, 200)}`,
  );

  // Pin Prism first, so the delete has a pin to clear.
  const pinRes = await fetch(`http://localhost:${APP_PORT}/api/threads/Prism/pin`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: ACCOUNT }),
  });
  const pinBody: any = await pinRes.json().catch(() => null);
  check("seed: Prism pinned", pinRes.status === 200 && pinBody?.pinned === true);

  // Delete the conversation.
  const del = await deleteThread(ACCOUNT, "Prism");
  check(
    "delete: returns ok with the removed message count",
    del.status === 200 && del.body?.ok === true && del.body?.deleted === 3,
    `${del.status} ${JSON.stringify(del.body)}`,
  );
  check(
    "delete: the pin is cleared in the same answer",
    del.body?.pinned === false &&
      Array.isArray(del.body?.pinnedFaces) &&
      del.body.pinnedFaces.length === 0,
    JSON.stringify(del.body),
  );

  const after = await getThread(ACCOUNT, "Prism");
  check(
    "read: thread is empty after delete",
    after.status === 200 && Array.isArray(after.body?.messages) && after.body.messages.length === 0,
    `${after.status} ${JSON.stringify(after.body)?.slice(0, 200)}`,
  );

  const pinnedRes = await fetch(`http://localhost:${APP_PORT}/api/pinned?accountId=${ACCOUNT}`);
  const pinnedBody: any = await pinnedRes.json().catch(() => null);
  check(
    "pinned list: Prism no longer pinned",
    pinnedRes.status === 200 && Array.isArray(pinnedBody?.pinned) && pinnedBody.pinned.length === 0,
    JSON.stringify(pinnedBody),
  );

  // Gone everywhere: search and export agree.
  const searchRes = await fetch(
    `http://localhost:${APP_PORT}/api/threads/search?accountId=${ACCOUNT}&q=notebook`,
  );
  const searchBody: any = await searchRes.json().catch(() => null);
  check(
    "search: the deleted words are not found",
    searchRes.status === 200 && Array.isArray(searchBody?.results) && searchBody.results.length === 0,
    `${searchRes.status} ${JSON.stringify(searchBody)}`,
  );
  const exportRes = await fetch(
    `http://localhost:${APP_PORT}/api/threads/Prism/export?accountId=${ACCOUNT}`,
  );
  const exportBody: any = await exportRes.json().catch(() => null);
  check(
    "export: deleted thread is the clean 404",
    exportRes.status === 404 && exportBody?.error === "no messages to export",
    `${exportRes.status} ${JSON.stringify(exportBody)}`,
  );

  // A second delete is a clean no-op.
  const delAgain = await deleteThread(ACCOUNT, "Prism");
  check(
    "delete again: ok, zero removed",
    delAgain.status === 200 && delAgain.body?.ok === true && delAgain.body?.deleted === 0,
    `${delAgain.status} ${JSON.stringify(delAgain.body)}`,
  );

  // Other Faces and other accounts are untouched.
  const mabel = await getThread(ACCOUNT, "Mabel");
  check(
    "isolation: this account's Mabel thread keeps its 2 messages",
    mabel.status === 200 && mabel.body?.messages?.length === 2,
    `${mabel.status} ${JSON.stringify(mabel.body)?.slice(0, 200)}`,
  );
  const otherPrism = await getThread(OTHER, "Prism");
  check(
    "isolation: other account's Prism thread keeps its message",
    otherPrism.status === 200 && otherPrism.body?.messages?.length === 1,
    `${otherPrism.status} ${JSON.stringify(otherPrism.body)?.slice(0, 200)}`,
  );
  const otherSearchRes = await fetch(
    `http://localhost:${APP_PORT}/api/threads/search?accountId=${OTHER}&q=notebook`,
  );
  const otherSearchBody: any = await otherSearchRes.json().catch(() => null);
  check(
    "isolation: other account's words still searchable",
    otherSearchRes.status === 200 &&
      Array.isArray(otherSearchBody?.results) &&
      otherSearchBody.results.length === 1,
    `${otherSearchRes.status} ${JSON.stringify(otherSearchBody)}`,
  );

  // The account id also arrives by header, as elsewhere.
  const delByHeader = await deleteThread(ACCOUNT, "Mabel", true);
  check(
    "delete: x-account-id header accepted",
    delByHeader.status === 200 && delByHeader.body?.deleted === 2,
    `${delByHeader.status} ${JSON.stringify(delByHeader.body)}`,
  );
  const mabelAfter = await getThread(ACCOUNT, "Mabel");
  check(
    "read: Mabel thread empty after header delete",
    mabelAfter.status === 200 && mabelAfter.body?.messages?.length === 0,
    `${mabelAfter.status} ${JSON.stringify(mabelAfter.body)?.slice(0, 200)}`,
  );

  // Unknown name and missing account are 400s.
  const unknown = await deleteThread(ACCOUNT, "Nobody");
  check(
    "unknown name: delete is 400 unknown photon",
    unknown.status === 400 && unknown.body?.error === "unknown photon",
    `${unknown.status} ${JSON.stringify(unknown.body)}`,
  );
  const noAccount = await deleteThread(null, "Prism");
  check(
    "missing account: delete is 400 accountId required",
    noAccount.status === 400 && noAccount.body?.error === "accountId required",
    `${noAccount.status} ${JSON.stringify(noAccount.body)}`,
  );
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}

// --- Client and server wiring ---
{
  const main = readFileSync(join(ROOT, "client", "main.ts"), "utf8");
  check(
    "client: thread head menu carries a Delete conversation control",
    main.includes('"delete-thread"') && main.includes("Delete conversation"),
  );
  check(
    "client: delete arms on the first tap before anything is removed",
    main.includes("Tap again — deletes every message") && main.includes('t.dataset.armed !== "1"'),
  );
  check(
    "client: a successful delete leaves the thread and refreshes pins",
    main.includes("api.threadDelete(name)") && main.includes("Your conversation with"),
  );
  const apiClient = readFileSync(join(ROOT, "client", "api.ts"), "utf8");
  check(
    "client: api carries threadDelete",
    apiClient.includes("threadDelete") && apiClient.includes("/delete`"),
  );
  const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  check(
    "server: thread delete route is mounted",
    server.includes("/delete$/)") && server.includes("deleteThread(accountId, photon)"),
  );
  const db = readFileSync(join(ROOT, "src", "server", "db.ts"), "utf8");
  check(
    "db: deleteThread removes messages, thread row, and pin for the account",
    db.includes("export function deleteThread") &&
      db.includes("DELETE FROM messages WHERE account_id = ? AND photon = ?") &&
      db.includes("DELETE FROM threads WHERE account_id = ? AND photon = ?") &&
      db.includes("DELETE FROM pinned_faces WHERE account_id = ? AND photon = ?"),
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
