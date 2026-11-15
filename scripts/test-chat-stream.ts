// Verify the streaming chat endpoint end to end (local only, never production).
// A mock Gemini server answers :generateContent with JSON and
// :streamGenerateContent with slow SSE chunks, then the real app server
// (3103) is exercised over POST /api/chat/stream:
//   1. Deltas arrive one by one, well before the stream ends (streaming
//      actually streams), the done event carries the full reply, the
//      meter moves 0 -> 1, and the thread saves the exchange.
//   2. A transient 500 on the first attempt is retried once and the chat
//      still succeeds.
//   3. A persistent 500 ends in an error event, the meter is untouched,
//      and nothing is saved to the thread.
//   4. The plain /api/chat endpoint still works (regression).
// Usage: FREE_CODE=<current code> bun scripts/test-chat-stream.ts
//   (exit 0 = all pass)

import { rm } from "node:fs/promises";

const APP_PORT = 3103;
const DATA_DIR = "/tmp/prism-stream-test";
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

// --- Mock Gemini: JSON for :generateContent, slow SSE for :streamGenerateContent ---
let mode: "ok" | "flaky" | "down" = "ok";
let geminiHits = 0;

function sseReply(text: string): string {
  const chunks = [text.slice(0, 6), text.slice(6, 12), text.slice(12)];
  return chunks.map((c) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: c }] } }] })}`).join("\n") + "\n";
}

const mockGemini = Bun.serve({
  port: 3102,
  async fetch(req) {
    geminiHits++;
    const url = req.url;
    if (mode === "down") {
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    }
    if (mode === "flaky" && geminiHits === 1) {
      return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    }
    if (url.includes(":streamGenerateContent")) {
      // Three chunks, 300ms apart: a streaming client sees the first words
      // about 300ms in, long before the stream ends near 900ms.
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          for (const line of sseReply("Streaming mock reply.").split("\n")) {
            if (!line) continue;
            controller.enqueue(enc.encode(line + "\n"));
            await Bun.sleep(300);
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "Mock Gemini reply." }] }, finishReason: "STOP" }],
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

// Read a stream endpoint, timing the first delta and the end.
async function streamChat(accountId: string, message: string) {
  const started = Date.now();
  const res = await fetch(`http://localhost:${APP_PORT}/api/chat/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, photon: "Prism", message }),
  });
  const ctype = res.headers.get("content-type") || "";
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let firstDeltaAt = -1;
  let endAt = -1;
  const events: any[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      const ev = JSON.parse(payload);
      events.push(ev);
      if (ev.delta && firstDeltaAt < 0) firstDeltaAt = Date.now() - started;
      if (ev.done || ev.error) endAt = Date.now() - started;
    }
  }
  if (endAt < 0) endAt = Date.now() - started;
  return { ctype, events, firstDeltaAt, endAt };
}

await rm(DATA_DIR, { recursive: true, force: true });

const proc = await startApp({
  GEMINI_API_KEY: "test-key",
  GEMINI_BASE_URL: "http://localhost:3102",
});

// --- Scenario 1: streaming actually streams ---
mode = "ok";
await redeem("test-stream-01");
let s = await streamChat("test-stream-01", "Hello streaming");
check("stream: content-type is SSE", s.ctype.includes("text/event-stream"), s.ctype);
const deltas = s.events.filter((e) => typeof e.delta === "string");
check("stream: three deltas arrived", deltas.length === 3, `deltas=${deltas.length}`);
check("stream: first delta well before the end", s.firstDeltaAt >= 0 && s.firstDeltaAt < s.endAt - 200, `first=${s.firstDeltaAt}ms end=${s.endAt}ms`);
const done = s.events.find((e) => e.done);
check("stream: done event carries the full reply", done?.reply === "Streaming mock reply.", JSON.stringify(done).slice(0, 160));
check("stream: meter 0 -> 1", done?.meter?.used === 1, JSON.stringify(done?.meter));
const thread = await api("/api/threads/Prism?accountId=test-stream-01");
check(
  "stream: thread saved the exchange",
  Array.isArray(thread.messages) &&
    thread.messages.length === 2 &&
    thread.messages[0].content === "Hello streaming" &&
    thread.messages[1].content === "Streaming mock reply.",
  JSON.stringify(thread.messages).slice(0, 200),
);

// --- Scenario 2: transient 500 is retried once ---
mode = "flaky";
geminiHits = 0;
await redeem("test-stream-02");
s = await streamChat("test-stream-02", "Hello flaky");
check("flaky: chat still succeeds", s.events.some((e) => e.done && e.reply === "Streaming mock reply."), JSON.stringify(s.events).slice(0, 200));
check("flaky: Gemini was hit twice (one retry)", geminiHits === 2, `hits=${geminiHits}`);

// --- Scenario 3: persistent 500 -> error event, nothing saved ---
mode = "down";
await redeem("test-stream-03");
s = await streamChat("test-stream-03", "Hello down");
check("down: error event, no done", s.events.some((e) => e.error) && !s.events.some((e) => e.done), JSON.stringify(s.events).slice(0, 200));
const st3 = await api("/api/state?accountId=test-stream-03");
check("down: meter untouched", st3.meter?.used === 0, JSON.stringify(st3.meter));
const thread3 = await api("/api/threads/Prism?accountId=test-stream-03");
check("down: thread empty", Array.isArray(thread3.messages) && thread3.messages.length === 0, JSON.stringify(thread3.messages));

// --- Scenario 4: plain /api/chat still works ---
mode = "ok";
await redeem("test-stream-04");
const r = await api("/api/chat", {
  method: "POST",
  body: JSON.stringify({ accountId: "test-stream-04", photon: "Prism", message: "Hello plain" }),
});
check("plain chat: still works", r.ok === true && r.reply === "Mock Gemini reply.", JSON.stringify(r).slice(0, 160));

await stopApp(proc);
mockGemini.stop();

console.log(failures === 0 ? "\nALL STREAM TESTS PASSED" : `\n${failures} STREAM TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
