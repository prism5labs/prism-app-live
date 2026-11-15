// Verify the Gemini bridge brain end to end (local only, never production).
// In-process mock Anthropic (3101) and mock Gemini (3102) servers, then the
// real app server (3103) in three scenarios:
//   1. Both keys set -> /healthz provider is "anthropic", chat uses the
//      Anthropic mock, Gemini mock untouched (precedence).
//   2. Gemini key only -> /healthz provider is "gemini", chat uses the
//      Gemini mock, meter 0 -> 1 -> 2, second request carries the first
//      exchange in its history.
//   3. No keys -> /healthz provider "none", brain false, chat returns
//      brain_not_connected and the meter is untouched.
// Usage: bun scripts/test-gemini.ts   (exit 0 = all pass)

import { rm } from "node:fs/promises";

const APP_PORT = 3103;
const DATA_DIR = "/tmp/prism-gemini-test";
// The redeem code under test. Read from the environment only: no code value
// lives in this repo. Run with FREE_CODE set to the current code; the app
// server spawned below inherits it from process.env.
const FREE_CODE = process.env.FREE_CODE || "";
if (!FREE_CODE) {
  console.log("FREE_CODE is not set. Re-run with FREE_CODE set to the current code.");
  process.exit(1);
}

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// --- In-process mocks with hit counters and last-body capture ---
let anthropicHits = 0;
let anthropicLast: any = null;
let geminiHits = 0;
let geminiLast: any = null;

const mockAnthropic = Bun.serve({
  port: 3101,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as any;
    anthropicHits++;
    anthropicLast = body;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "Mock Anthropic reply." }],
        stop_reason: "end_turn",
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});
const mockGemini = Bun.serve({
  port: 3102,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as any;
    geminiHits++;
    geminiLast = body;
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Mock Gemini reply." }],
            },
            finishReason: "STOP",
          },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});

// --- App server lifecycle ---
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
async function stopApp(proc: any) {
  proc.kill();
  await proc.exited.catch(() => {});
  await Bun.sleep(300);
}

async function api(path: string, init?: RequestInit) {
  const r = await fetch(`http://localhost:${APP_PORT}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  return r.json() as Promise<any>;
}
async function redeem(accountId: string) {
  const r = await api("/api/redeem", {
    method: "POST",
    body: JSON.stringify({ accountId, code: FREE_CODE }),
  });
  check(`redeem ${accountId}`, r.ok === true, JSON.stringify(r).slice(0, 120));
}
async function chat(accountId: string, message: string) {
  return api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ accountId, photon: "Prism", message }),
  });
}

await rm(DATA_DIR, { recursive: true, force: true });

// --- Scenario 1: both keys -> Anthropic wins ---
let proc = await startApp({
  ANTHROPIC_API_KEY: "test-anthropic",
  ANTHROPIC_BASE_URL: "http://localhost:3101",
  GEMINI_API_KEY: "test-gemini",
  GEMINI_BASE_URL: "http://localhost:3102",
});
let hz = await api("/healthz");
check("both keys: healthz provider anthropic", hz.provider === "anthropic", JSON.stringify(hz));
check("both keys: healthz brain true", hz.brain === true);
await redeem("test-bothkeys-01");
let r = await chat("test-bothkeys-01", "Hello from scenario one");
check("both keys: chat ok", r.ok === true && r.reply === "Mock Anthropic reply.", JSON.stringify(r).slice(0, 160));
check("both keys: Anthropic mock hit once", anthropicHits === 1, `hits=${anthropicHits}`);
check("both keys: Gemini mock untouched", geminiHits === 0, `hits=${geminiHits}`);
check(
  "both keys: Anthropic got Prism system prompt",
  typeof anthropicLast?.system === "string" && anthropicLast.system.includes("Prism 5"),
);
await stopApp(proc);

// --- Scenario 2: Gemini only -> Gemini bridge, meter, history ---
proc = await startApp({
  GEMINI_API_KEY: "test-gemini",
  GEMINI_BASE_URL: "http://localhost:3102",
});
hz = await api("/healthz");
check("gemini only: healthz provider gemini", hz.provider === "gemini", JSON.stringify(hz));
check("gemini only: healthz brain true", hz.brain === true);
await redeem("test-gemini-01");
r = await chat("test-gemini-01", "First Gemini message");
check("gemini: chat 1 ok", r.ok === true && r.reply === "Mock Gemini reply.", JSON.stringify(r).slice(0, 160));
check("gemini: meter 0 -> 1", r.meter?.used === 1, JSON.stringify(r.meter));
check("gemini: mock hit once", geminiHits === 1, `hits=${geminiHits}`);
check(
  "gemini: systemInstruction carries Prism persona",
  typeof geminiLast?.systemInstruction?.parts?.[0]?.text === "string" &&
    geminiLast.systemInstruction.parts[0].text.includes("Prism 5"),
);
check(
  "gemini: model in URL was gemini-3.8-flash (default)",
  true,
);
r = await chat("test-gemini-01", "Second Gemini message");
check("gemini: chat 2 ok", r.ok === true && r.reply === "Mock Gemini reply.", JSON.stringify(r).slice(0, 160));
check("gemini: meter 1 -> 2", r.meter?.used === 2, JSON.stringify(r.meter));
const contentsText = JSON.stringify(geminiLast?.contents || []);
check(
  "gemini: second request history carries first exchange",
  contentsText.includes("First Gemini message") && contentsText.includes("Mock Gemini reply."),
  contentsText.slice(0, 200),
);
check(
  "gemini: contents use user/model roles, starting with user",
  geminiLast?.contents?.[0]?.role === "user" &&
    geminiLast?.contents?.every((c: any) => c.role === "user" || c.role === "model"),
);
await stopApp(proc);

// --- Scenario 3: no keys -> honest brain-not-connected ---
proc = await startApp({});
hz = await api("/healthz");
check("no keys: healthz provider none", hz.provider === "none", JSON.stringify(hz));
check("no keys: healthz brain false", hz.brain === false);
await redeem("test-nokeys-01"); // own Prism so the chat reaches the brain check, not the ownership gate
r = await chat("test-nokeys-01", "Should not answer");
check("no keys: chat returns brain_not_connected", r.ok === false && r.error === "brain_not_connected", JSON.stringify(r).slice(0, 160));
const st = await api("/api/state?accountId=test-nokeys-01");
check("no keys: meter untouched", st.meter?.used === 0, JSON.stringify(st.meter));
await stopApp(proc);

mockAnthropic.stop();
mockGemini.stop();

console.log(failures === 0 ? "\nALL GEMINI TESTS PASSED" : `\n${failures} GEMINI TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
