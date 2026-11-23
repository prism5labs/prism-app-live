// Conversation search test: GET /api/threads/search?q= finds where
// something was said across all of an account's threads.
//
//   1. A match is found in the right thread, with the right role, a
//      snippet around the match, and a created_at — never the full
//      message body and never a content field.
//   2. Matching is case-insensitive and results are newest first.
//   3. Results are capped at 50.
//   4. Another account's matching message never appears.
//   5. A missing, empty, or under-2-character query is a 400, and a
//      missing account id is a 400.
//   6. LIKE wildcards in the query are literal: % and _ do not match
//      everything.
//   7. A query with no matches is a clean 200 with an empty list.
//   8. The client carries the search box wired to this endpoint.
//
// Run: bun scripts/test-thread-search.ts (spawns the real server on
// :3129 against a throwaway DATA_DIR; no network, no brain needed).

import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const APP_PORT = 3129;
const DATA_DIR = "/tmp/prism-thread-search-test";
const ACCOUNT = "acc_searchtest01234567";
const OTHER = "acc_searchother0123456";

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

// --- Server lifecycle (same harness shape as test-thread-export.ts) ---
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

function seedMessage(accountId: string, photon: string, role: string, content: string, createdAt?: string) {
  const db = new Database(join(DATA_DIR, "app.db"));
  const now = createdAt || new Date().toISOString();
  db.query(
    `INSERT INTO messages (account_id, photon, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, photon, role, content, now);
  db.query(
    `INSERT INTO threads (account_id, photon, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, photon) DO UPDATE SET updated_at = excluded.updated_at`,
  ).run(accountId, photon, now, now);
  db.close();
}

async function search(account: string, q: string | null, useHeader = false) {
  const params = new URLSearchParams();
  if (!useHeader) params.set("accountId", account);
  if (q !== null) params.set("q", q);
  const res = await fetch(`http://localhost:${APP_PORT}/api/threads/search?${params.toString()}`, {
    headers: useHeader ? { "x-account-id": account } : {},
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, body };
}

await rm(DATA_DIR, { recursive: true, force: true });
const proc = await startApp();
try {
  const st = await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${ACCOUNT}`);
  check("seed: account state loads", st.ok);
  await fetch(`http://localhost:${APP_PORT}/api/state?accountId=${OTHER}`);

  // Basic match, in order of insertion (oldest first here).
  seedMessage(ACCOUNT, "Prism", "user", "Please remember the blue notebook.", "2026-11-20T10:00:00.000Z");
  seedMessage(ACCOUNT, "Juniper", "assistant", "The BLUE Notebook is on the desk.", "2026-11-21T10:00:00.000Z");
  seedMessage(ACCOUNT, "Prism", "user", "Nothing relevant in this one.", "2026-11-21T11:00:00.000Z");
  // Another account says the same words: it must never appear.
  seedMessage(OTHER, "Prism", "user", "Please remember the blue notebook.", "2026-11-22T10:00:00.000Z");

  const basic = await search(ACCOUNT, "blue notebook");
  check("search: status 200", basic.status === 200, `got ${basic.status} ${JSON.stringify(basic.body)}`);
  check("search: ok flag", basic.body?.ok === true);
  const results = basic.body?.results || [];
  check("search: finds both of this account's matches", results.length === 2, `got ${results.length}`);
  check(
    "search: newest first",
    results.length === 2 && results[0].created_at === "2026-11-21T10:00:00.000Z" && results[1].created_at === "2026-11-20T10:00:00.000Z",
    JSON.stringify(results.map((r: any) => r.created_at)),
  );
  check(
    "search: right thread and role labels",
    results.length === 2 && results[0].photon === "Juniper" && results[0].role === "assistant" && results[1].photon === "Prism" && results[1].role === "user",
    JSON.stringify(results),
  );
  check(
    "search: snippet contains the match",
    results.length === 2 && results.every((r: any) => r.snippet.toLowerCase().includes("blue notebook")),
    JSON.stringify(results),
  );
  check(
    "search: results carry no full content field",
    results.length === 2 && results.every((r: any) => !("content" in r) && Object.keys(r).sort().join(",") === "created_at,photon,role,snippet"),
    JSON.stringify(results.map((r: any) => Object.keys(r))),
  );

  // Case-insensitivity, both directions.
  const upper = await search(ACCOUNT, "BLUE NOTEBOOK");
  check("search: upper-case query matches", upper.status === 200 && (upper.body?.results || []).length === 2);
  const mixed = await search(ACCOUNT, "BlUe NoTeBoOk");
  check("search: mixed-case query matches", mixed.status === 200 && (mixed.body?.results || []).length === 2);

  // Account isolation, from the other side too.
  const otherView = await search(OTHER, "blue notebook");
  check(
    "isolation: other account sees only its own match",
    otherView.status === 200 && (otherView.body?.results || []).length === 1,
    `got ${(otherView.body?.results || []).length}`,
  );

  // The account id also arrives by header, as on the thread export.
  const byHeader = await search(ACCOUNT, "blue notebook", true);
  check("search: x-account-id header accepted", byHeader.status === 200 && (byHeader.body?.results || []).length === 2);

  // Snippet trimming: a long message comes back as a short window
  // around the match, with ellipses, never the whole body.
  const longBody = `${"padding ".repeat(30)}needleword${" more padding".repeat(30)}`;
  seedMessage(ACCOUNT, "Prism", "assistant", longBody, "2026-11-22T09:00:00.000Z");
  const longRes = await search(ACCOUNT, "needleword");
  const longFirst = (longRes.body?.results || [])[0];
  check(
    "snippet: long message is trimmed around the match",
    !!longFirst && longFirst.snippet.includes("needleword") && longFirst.snippet.length <= 162 && longFirst.snippet.startsWith("…") && longFirst.snippet.endsWith("…"),
    longFirst ? `${longFirst.snippet.length} chars: ${longFirst.snippet.slice(0, 80)}` : "no result",
  );
  check(
    "snippet: full long body never returned",
    !JSON.stringify(longRes.body).includes(longBody),
  );

  // LIKE wildcards are literal.
  seedMessage(ACCOUNT, "Prism", "user", "The discount is 50% today.", "2026-11-22T10:00:00.000Z");
  seedMessage(ACCOUNT, "Prism", "user", "The code 5000 is not a discount.", "2026-11-22T10:01:00.000Z");
  const pct = await search(ACCOUNT, "50%");
  check(
    "wildcard: % in query matches literally, not everything",
    pct.status === 200 && (pct.body?.results || []).length === 1 && (pct.body.results[0].snippet || "").includes("50%"),
    `got ${(pct.body?.results || []).length}`,
  );
  seedMessage(ACCOUNT, "Prism", "user", "Open file_name first.", "2026-11-22T10:02:00.000Z");
  seedMessage(ACCOUNT, "Prism", "user", "Open fileXname first.", "2026-11-22T10:03:00.000Z");
  const under = await search(ACCOUNT, "file_name");
  check(
    "wildcard: _ in query matches literally",
    under.status === 200 && (under.body?.results || []).length === 1 && (under.body.results[0].snippet || "").includes("file_name"),
    `got ${(under.body?.results || []).length}`,
  );

  // The 50-result cap, newest first.
  for (let i = 0; i < 55; i++) {
    seedMessage(ACCOUNT, "Prism", "user", `capword entry ${i}`, `2026-11-22T12:${String(i).padStart(2, "0")}:00.000Z`);
  }
  const capped = await search(ACCOUNT, "capword");
  const cappedResults = capped.body?.results || [];
  check("cap: exactly 50 results", capped.status === 200 && cappedResults.length === 50, `got ${cappedResults.length}`);
  check(
    "cap: capped list is still newest first",
    cappedResults.length === 50 && cappedResults[0].snippet.includes("capword entry 54") && cappedResults[49].snippet.includes("capword entry 5"),
    cappedResults.length ? `${cappedResults[0].snippet} .. ${cappedResults[cappedResults.length - 1].snippet}` : "none",
  );

  // Empty-result success.
  const empty = await search(ACCOUNT, "zzzznope");
  check(
    "empty: no matches is 200 with an empty list",
    empty.status === 200 && empty.body?.ok === true && Array.isArray(empty.body?.results) && empty.body.results.length === 0,
    `${empty.status} ${JSON.stringify(empty.body)}`,
  );

  // Missing / short queries and missing account.
  const noQ = await search(ACCOUNT, null);
  check("bad query: missing q is 400", noQ.status === 400 && noQ.body?.ok === false && typeof noQ.body?.error === "string" && noQ.body.error.length > 0, `${noQ.status} ${JSON.stringify(noQ.body)}`);
  const emptyQ = await search(ACCOUNT, "");
  check("bad query: empty q is 400", emptyQ.status === 400 && emptyQ.body?.ok === false, `${emptyQ.status}`);
  const shortQ = await search(ACCOUNT, "a");
  check("bad query: 1-character q is 400", shortQ.status === 400 && shortQ.body?.ok === false, `${shortQ.status}`);
  const noAccountRes = await fetch(`http://localhost:${APP_PORT}/api/threads/search?q=blue`);
  const noAccountBody: any = await noAccountRes.json().catch(() => null);
  check(
    "missing account: 400 accountId required",
    noAccountRes.status === 400 && noAccountBody?.error === "accountId required",
    `${noAccountRes.status} ${JSON.stringify(noAccountBody)}`,
  );
} finally {
  proc.kill();
  await proc.exited.catch(() => {});
}

// --- Client wiring: the search box sits on the Chat front and points
// at this endpoint through the api client ---
{
  const main = readFileSync(join(ROOT, "client", "main.ts"), "utf8");
  check(
    "client: Chat front carries the conversation search form",
    main.includes('id="conversation-search-form"') && main.includes("Search your conversations") && main.includes("api.searchThreads(conversationSearchQuery)"),
  );
  check(
    "client: a result tap opens that thread",
    main.includes('data-action="search-open-thread"') && main.includes("openThread(name)"),
  );
  check(
    "client: no-results line is rendered",
    main.includes("No conversations found for"),
  );
  const apiClient = readFileSync(join(ROOT, "client", "api.ts"), "utf8");
  check(
    "client: api search carries the current accountId and query",
    apiClient.includes("/api/threads/search?accountId=${encodeURIComponent(getAccountId())}&q=${encodeURIComponent(q)}"),
  );
  const server = readFileSync(join(ROOT, "src", "server.ts"), "utf8");
  check("server: search route is mounted", server.includes('path === "/api/threads/search"') && server.includes("searchMessages(accountId, query)"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
