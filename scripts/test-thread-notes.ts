// Thread notes test: a user can keep one short private note on each
// Photon or Atom conversation, view/edit/clear it, scoped by account.
//
//   1. Initially empty, set then get, edit overwrites.
//   2. Trim + 500-char cap; empty note clears.
//   3. Account isolation both ways.
//   4. Unknown name 400, missing account 400 on get and set.
//   5. Deleting a conversation clears its note.
//   6. Client wiring: note API path and Note control.
//   7. Conversation search finds notes: a note-only hit returns the
//      conversation (role "note", snippet windowed on the match),
//      case-insensitively, account-isolated, merged newest first
//      with message hits; a cleared note stops matching.
//   8. The notes view across Faces: GET /api/threads/notes lists
//      every noted conversation for the account only, most recently
//      updated first; cleared and deleted conversations leave it.
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

function seedMessageAt(accountId: string, photon: string, content: string, createdAt: string) {
  const db = new Database(join(DATA_DIR, "app.db"));
  db.query(`INSERT INTO messages (account_id, photon, role, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(accountId, photon, "user", content, createdAt);
  db.query(`INSERT INTO threads (account_id, photon, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(account_id, photon) DO UPDATE SET updated_at = excluded.updated_at`).run(accountId, photon, createdAt, createdAt);
  db.close();
}

async function search(accountId: string, q: string): Promise<any> {
  const res = await fetch(`http://localhost:${APP_PORT}/api/threads/search?accountId=${accountId}&q=${encodeURIComponent(q)}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function listNotes(accountId: string | null): Promise<any> {
  const url = accountId
    ? `http://localhost:${APP_PORT}/api/threads/notes?accountId=${accountId}`
    : `http://localhost:${APP_PORT}/api/threads/notes`;
  const res = await fetch(url);
  return { status: res.status, body: await res.json().catch(() => null) };
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

  // --- Search finds notes ---
  await setNote(ACCOUNT, "Juniper", "Quixotic deadline for the mural");
  const noteHit = await search(ACCOUNT, "quixotic");
  const noteResults = noteHit.body?.results || [];
  check("search: note-only query finds the conversation", noteHit.status === 200 && noteResults.length === 1 && noteResults[0].photon === "Juniper" && noteResults[0].role === "note", `${noteHit.status} ${JSON.stringify(noteResults)}`);
  check("search: note hit snippet windows the match", noteResults.length === 1 && noteResults[0].snippet.includes("Quixotic deadline"), JSON.stringify(noteResults));
  check("search: note hit carries only the message-hit fields", noteResults.length === 1 && !("content" in noteResults[0]) && Object.keys(noteResults[0]).sort().join(",") === "created_at,photon,role,snippet", JSON.stringify(noteResults.map((r: any) => Object.keys(r))));
  const noteHitUpper = await search(ACCOUNT, "QUIXOTIC");
  check("search: note match is case-insensitive", noteHitUpper.status === 200 && (noteHitUpper.body?.results || []).length === 1, JSON.stringify(noteHitUpper.body?.results));
  const noteHitOther = await search(OTHER, "quixotic");
  check("search: other account cannot find this account's note", noteHitOther.status === 200 && (noteHitOther.body?.results || []).length === 0, JSON.stringify(noteHitOther.body?.results));
  await setNote(OTHER, "Juniper", "Quixotic plans of my own");
  const otherOwn = await search(OTHER, "quixotic");
  const accountOwn = await search(ACCOUNT, "quixotic");
  check("search: each account finds only its own note", (otherOwn.body?.results || []).length === 1 && ((otherOwn.body.results[0].snippet || "").includes("my own")) && (accountOwn.body?.results || []).length === 1, `${JSON.stringify(otherOwn.body?.results)} ${JSON.stringify(accountOwn.body?.results)}`);
  // A message hit and a note hit for one query merge newest first.
  seedMessageAt(ACCOUNT, "Prism", "A quixotic message from long ago", "2020-01-01T00:00:00.000Z");
  const merged = await search(ACCOUNT, "quixotic");
  const mergedResults = merged.body?.results || [];
  check("search: note and message hits merge, newest first", mergedResults.length === 2 && mergedResults[0].role === "note" && mergedResults[0].photon === "Juniper" && mergedResults[1].role === "user" && mergedResults[1].photon === "Prism", JSON.stringify(mergedResults));
  await setNote(ACCOUNT, "Juniper", "");
  const afterClearSearch = await search(ACCOUNT, "quixotic");
  const afterClearResults = afterClearSearch.body?.results || [];
  check("search: cleared note no longer matches", afterClearResults.length === 1 && afterClearResults.every((r: any) => r.role !== "note"), JSON.stringify(afterClearResults));
  await setNote(OTHER, "Juniper", "");

  // --- Notes view across Faces ---
  const emptyList = await listNotes(OTHER);
  check("notes view: account with no notes gets an empty list", emptyList.status === 200 && emptyList.body?.ok === true && Array.isArray(emptyList.body?.notes) && emptyList.body.notes.length === 0, `${emptyList.status} ${JSON.stringify(emptyList.body)}`);
  const list1 = await listNotes(ACCOUNT);
  const list1Notes = list1.body?.notes || [];
  check("notes view: lists every noted conversation with its note", list1.status === 200 && list1Notes.length === 2 && list1Notes.some((n: any) => n.name === "Prism" && n.note === "Account A note") && list1Notes.some((n: any) => n.name === "Mabel" && n.note === "Garden project"), JSON.stringify(list1Notes));
  check("notes view: entries carry name, note, updated_at", list1Notes.length === 2 && list1Notes.every((n: any) => typeof n.name === "string" && typeof n.note === "string" && n.note.length > 0 && typeof n.updated_at === "string"), JSON.stringify(list1Notes));
  await Bun.sleep(10);
  await setNote(ACCOUNT, "Mabel", "Garden project");
  const list2 = await listNotes(ACCOUNT);
  const list2Notes = list2.body?.notes || [];
  check("notes view: most recently updated first", list2Notes.length === 2 && list2Notes[0].name === "Mabel", JSON.stringify(list2Notes));
  check("notes view: cleared notes do not appear", !list2Notes.some((n: any) => n.name === "Juniper"), JSON.stringify(list2Notes));
  const noAccList = await listNotes(null);
  check("notes view: missing account is 400 accountId required", noAccList.status === 400 && noAccList.body?.error === "accountId required", `${noAccList.status} ${JSON.stringify(noAccList.body)}`);

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
  const listAfterDelete = await listNotes(ACCOUNT);
  check("delete: conversation leaves the notes view", !(listAfterDelete.body?.notes || []).some((n: any) => n.name === "Prism"), JSON.stringify(listAfterDelete.body?.notes));
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
  check("client: api carries the notes list endpoint", apiClient.includes("threadNotes") && apiClient.includes("/api/threads/notes"));
  check("client: notes view renders on the Chat front", main.includes("Your notes") && main.includes("threadNotesList") && main.includes("loadThreadNotesList"));
  check("client: search renders note hits as your note", main.includes("Your note") && main.includes('"note"'));
  const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  check("server: thread note routes are mounted", server.includes("/note") && server.includes("getThreadNote") && server.includes("setThreadNote"));
  check("server: notes list route is mounted", server.includes('"/api/threads/notes"') && server.includes("listThreadNotes"));
  check("server: search merges note hits", server.includes("searchThreadNotes(accountId, query)"));
  const db = readFileSync(join(ROOT, "src", "server", "db.ts"), "utf8");
  check("db: thread_notes table and helpers exist", db.includes("thread_notes") && db.includes("getThreadNote") && db.includes("setThreadNote") && db.includes("deleteThreadNote"));
  check("db: note list and note search helpers exist", db.includes("listThreadNotes") && db.includes("searchThreadNotes"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
