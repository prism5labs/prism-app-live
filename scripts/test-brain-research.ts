// Verify the brain's web_search tool end to end (local only, never production).
// A mock Anthropic server answers /v1/messages, then the real brain client
// (src/server/anthropic.ts) and the real app server are exercised:
//   1. Tool round-trip: the brain asks web_search, the provider's results ride
//      back as a tool_result, and the final reply cites the source.
//   2. Search failure: a throwing provider still ends in an honest reply,
//      and the brain is told the search did not come back.
//   3. Search cap: three tool calls in one turn run at most two searches.
//   4. No key, no provider: the request carries no tools field at all
//      (run as a child process without BRAVE_SEARCH_API_KEY).
//   5. HTTP smoke: the real app server takes a chat through /api/chat with
//      the tool attached; the Brave call fails on the dummy key and the
//      brain still answers, the meter moves 0 -> 1, the thread is saved.
// Usage: ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://localhost:3111 \
//   bun scripts/test-brain-research.ts
//   (exit 0 = all pass)

import { rm } from "node:fs/promises";
import { chat } from "../src/server/anthropic";
import type { SearchProvider, SearchResult } from "../src/server/research";

const MOCK_PORT = Number(process.env.BRAIN_TEST_MOCK_PORT || 3111);
const APP_PORT = 3113;
const DATA_DIR = "/tmp/prism-brain-research-test";
const ACCOUNT = "test-brain-01";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// --- Mock Anthropic ---
// mode "tool": first request gets a web_search tool_use, second gets the
// final reply. mode "multi": one response with three tool_use blocks.
// mode "plain": a straight text reply.
let mode: "tool" | "multi" | "plain" = "tool";
let requests: any[] = [];
function resetPhase(m: typeof mode) {
  mode = m;
  requests = [];
}
const FINAL_REPLY =
  "Per Example News, the 2026 World Series was won by the Example Team.";

function toolUseResponse(uses: { id: string; query: string }[]) {
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "mock",
    content: uses.map((u) => ({
      type: "tool_use",
      id: u.id,
      name: "web_search",
      input: { query: u.query },
    })),
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 12 },
  };
}
function textResponse(text: string) {
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: "mock",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 12 },
  };
}

const mockAnthropic = Bun.serve({
  port: MOCK_PORT,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as any;
    requests.push(body);
    if (mode === "plain") {
      return Response.json(textResponse("Mock reply: I heard you."));
    }
    if (requests.length === 1 && mode === "tool") {
      return Response.json(
        toolUseResponse([{ id: "tu-1", query: "who won the 2026 World Series" }]),
      );
    }
    if (requests.length === 1 && mode === "multi") {
      return Response.json(
        toolUseResponse([
          { id: "tu-1", query: "first query" },
          { id: "tu-2", query: "second query" },
          { id: "tu-3", query: "third query" },
        ]),
      );
    }
    return Response.json(textResponse(FINAL_REPLY));
  },
});

// --- Fake search provider (no Brave call) ---
const FAKE_RESULTS: SearchResult[] = [
  {
    title: "Example Team wins the 2026 World Series",
    url: "https://example.news/world-series-2026",
    snippet: "The Example Team took the series in six games.",
    source: "example.news",
  },
];
let providerQueries: string[] = [];
const fakeProvider: SearchProvider = {
  name: "fake",
  async search(query: string) {
    providerQueries.push(query);
    return FAKE_RESULTS;
  },
};
const throwingProvider: SearchProvider = {
  name: "throwing",
  async search() {
    throw new Error("boom");
  },
};

function toolResultsOf(body: any): any[] {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (m.role === "user" && Array.isArray(m.content)) {
      const results = m.content.filter((b: any) => b.type === "tool_result");
      if (results.length > 0) return results;
    }
  }
  return [];
}

// --- Plain-only mode: no provider, no Brave key -> no tools field ---
if (process.argv.includes("--plain-only")) {
  resetPhase("plain");
  const r = await chat("You are Prism.", [], "Hello plain");
  check("plain-only: reply arrives", r.ok === true && r.reply === "Mock reply: I heard you.", JSON.stringify(r).slice(0, 160));
  check(
    "plain-only: no tools field on the request",
    requests.length === 1 && !("tools" in requests[0]),
    JSON.stringify(requests[0]).slice(0, 200),
  );
  mockAnthropic.stop();
  console.log(failures === 0 ? "\nALL PLAIN-ONLY TESTS PASSED" : `\n${failures} PLAIN-ONLY TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// --- 1. Tool round-trip ---
resetPhase("tool");
providerQueries = [];
let r = await chat("You are Prism.", [], "Who won the 2026 World Series?", {
  searchProvider: fakeProvider,
});
check("tool: final reply cites the source", r.ok === true && r.reply === FINAL_REPLY, JSON.stringify(r).slice(0, 160));
check("tool: provider called once with the model's query", providerQueries.length === 1 && providerQueries[0] === "who won the 2026 World Series", JSON.stringify(providerQueries));
check("tool: tools offered on the first request", Array.isArray(requests[0]?.tools) && requests[0].tools[0]?.name === "web_search", JSON.stringify(requests[0]?.tools).slice(0, 200));
check(
  "tool: second request carries the tool_result with the fake result",
  requests.length === 2 &&
    toolResultsOf(requests[1]).length === 1 &&
    String(toolResultsOf(requests[1])[0].content).includes("example.news"),
  JSON.stringify(toolResultsOf(requests[1])).slice(0, 200),
);

// --- 2. Search failure still ends in an honest reply ---
resetPhase("tool");
r = await chat("You are Prism.", [], "Who won the 2026 World Series?", {
  searchProvider: throwingProvider,
});
check("fail: reply still arrives", r.ok === true && r.reply === FINAL_REPLY, JSON.stringify(r).slice(0, 160));
check(
  "fail: tool_result says the search did not come back",
  requests.length === 2 &&
    String(toolResultsOf(requests[1])[0]?.content || "").includes("did not come back"),
  JSON.stringify(toolResultsOf(requests[1])).slice(0, 200),
);

// --- 3. Search cap: three calls, at most two searches ---
resetPhase("multi");
providerQueries = [];
r = await chat("You are Prism.", [], "Tell me three things.", {
  searchProvider: fakeProvider,
});
check("cap: reply still arrives", r.ok === true && r.reply === FINAL_REPLY, JSON.stringify(r).slice(0, 160));
check("cap: only two searches ran", providerQueries.length === 2, JSON.stringify(providerQueries));
check(
  "cap: third tool_result says the limit was reached",
  requests.length === 2 &&
    toolResultsOf(requests[1]).length === 3 &&
    String(toolResultsOf(requests[1])[2].content).includes("search limit"),
  JSON.stringify(toolResultsOf(requests[1])).slice(0, 300),
);

// --- 4. Plain-only child (no Brave key, no provider) ---
{
  const env = { ...process.env };
  delete env.BRAVE_SEARCH_API_KEY;
  // The child needs its own mock port: the parent already holds 3111.
  env.BRAIN_TEST_MOCK_PORT = "3112";
  env.ANTHROPIC_BASE_URL = "http://localhost:3112";
  const child = Bun.spawn(
    ["bun", "scripts/test-brain-research.ts", "--plain-only"],
    { cwd: import.meta.dir + "/..", env, stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(child.stdout as any).text();
  const err = await new Response(child.stderr as any).text().catch(() => "");
  const code = await child.exited;
  console.log(out.trim());
  if (err.trim()) console.log("child stderr:", err.trim().slice(0, 500));
  check("plain-only child exits 0", code === 0, `exit=${code}`);
}

// --- 5. HTTP smoke through the real app server ---
async function startApp(env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "src/server.ts"], {
    cwd: import.meta.dir + "/..",
    env: { ...process.env, PORT: String(APP_PORT), DATA_DIR, ...env },
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${APP_PORT}/healthz`);
      if (res.ok) return proc;
    } catch {
      // not up yet
    }
    await Bun.sleep(200);
  }
  const errText = await new Response(proc.stderr as any).text().catch(() => "");
  throw new Error(`app did not come up: ${errText.slice(0, 1000)}`);
}
async function stopApp(proc: any) {
  proc.kill();
  await proc.exited.catch(() => {});
  await Bun.sleep(300);
}

await rm(DATA_DIR, { recursive: true, force: true });
resetPhase("tool");
const proc = await startApp({
  ANTHROPIC_API_KEY: "test",
  ANTHROPIC_BASE_URL: `http://localhost:${MOCK_PORT}`,
  BRAVE_SEARCH_API_KEY: "dummy-invalid-key",
});
// Seed ownership of Prism for the test account (no free code involved).
{
  const seed = Bun.spawn(
    ["bun", "-e", `const m = await import("./src/server/db.ts"); m.ownPhoton(${JSON.stringify(ACCOUNT)}, "Prism");`],
    { cwd: import.meta.dir + "/..", env: { ...process.env, DATA_DIR }, stdout: "ignore", stderr: "pipe" },
  );
  const code = await seed.exited;
  check("http: ownership seeded", code === 0, `exit=${code}`);
}
async function api(path: string, init?: RequestInit) {
  const res = await fetch(`http://localhost:${APP_PORT}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return res.json() as Promise<any>;
}
const chatRes = await api("/api/chat", {
  method: "POST",
  body: JSON.stringify({ accountId: ACCOUNT, photon: "Prism", message: "Who won the 2026 World Series?" }),
});
check("http: chat answers through the tool loop", chatRes.ok === true && chatRes.reply === FINAL_REPLY, JSON.stringify(chatRes).slice(0, 200));
check("http: tools were offered on the first brain request", Array.isArray(requests[0]?.tools) && requests[0].tools[0]?.name === "web_search", JSON.stringify(requests[0]?.tools).slice(0, 200));
check(
  "http: failed Brave search reached the brain as a tool_result",
  requests.length === 2 && String(toolResultsOf(requests[1])[0]?.content || "").includes("did not come back"),
  JSON.stringify(toolResultsOf(requests[1])).slice(0, 200),
);
check("http: meter 0 -> 1", chatRes.meter?.used === 1, JSON.stringify(chatRes.meter));
const thread = await api(`/api/threads/Prism?accountId=${ACCOUNT}`);
check(
  "http: thread saved the exchange",
  Array.isArray(thread.messages) &&
    thread.messages.length === 2 &&
    thread.messages[1].content === FINAL_REPLY,
  JSON.stringify(thread.messages).slice(0, 200),
);
await stopApp(proc);
mockAnthropic.stop();

console.log(failures === 0 ? "\nALL BRAIN RESEARCH TESTS PASSED" : `\n${failures} BRAIN RESEARCH TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
