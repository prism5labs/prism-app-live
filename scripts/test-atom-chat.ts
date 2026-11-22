// Verify Atom chat end to end (local only, never production).
// A mock Gemini server answers :generateContent, then the real app
// server (3113) is exercised over POST /api/chat, POST /api/chat/stream,
// and GET /api/threads/:name:
//   1. An Atom name is accepted with Nova product ownership, the reply
//      lands in the Atom's thread, and the monthly meter moves.
//   2. An Atom is rejected (not_owned) with no ownership at all, on
//      both chat endpoints, and nothing is saved or charged.
//   3. Individual Atom ownership works per Atom: the owned Atom chats,
//      a different Atom is still refused.
//   4. The free code opens Atom chat (the spawned server is given a
//      throwaway test code through its env — never the real code).
//   5. The Photon path is unchanged: owned Photon chats, unowned is
//      refused, an unknown name is a 400.
//   6. The Atom system prompt carries the Atom's persona seed and the
//      Atom truth block (no tools, no sends, no reminders), plus the
//      owner context; the Photon prompt still carries APP_TRUTH.
// Usage: bun scripts/test-atom-chat.ts   (exit 0 = all pass)

import { rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const APP_PORT = 3113;
const MOCK_PORT = 3112;
const DATA_DIR = "/tmp/prism-atom-chat-test";
const TEST_CODE = "atom-test-code";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// --- Mock Gemini: one canned reply for :generateContent ---
const mockGemini = Bun.serve({
  port: MOCK_PORT,
  async fetch() {
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
function chat(accountId: string, photon: string, message: string) {
  return api("/api/chat", {
    method: "POST",
    body: JSON.stringify({ accountId, photon, message }),
  });
}

// Ownership rows are written straight into the throwaway database, the
// same shape stripe.ts writes on a purchase (kind 'atom' / 'photon'
// with the name, kind 'product' with the slug).
function grant(accountId: string, kind: string, ref: string) {
  const db = new Database(join(DATA_DIR, "app.db"));
  db.query(
    `INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at) VALUES (?, ?, ?, ?)`,
  ).run(accountId, kind, ref, new Date().toISOString());
  db.close();
}

await rm(DATA_DIR, { recursive: true, force: true });

const proc = await startApp({
  GEMINI_API_KEY: "test-key",
  GEMINI_BASE_URL: `http://localhost:${MOCK_PORT}`,
  FREE_CODE: TEST_CODE,
});

// --- Scenario 1: Atom accepted with Nova product ownership ---
await api("/api/state?accountId=test-atom-nova");
grant("test-atom-nova", "product", "nova");
let r = await chat("test-atom-nova", "Mabel", "Hello Mabel");
check("nova: Atom chat accepted", r.ok === true && r.reply === "Mock Gemini reply.", JSON.stringify(r).slice(0, 160));
check("nova: meter moved 0 -> 1", r.meter?.used === 1, JSON.stringify(r.meter));
let thread = await api("/api/threads/Mabel?accountId=test-atom-nova");
check(
  "nova: thread saved the exchange and reports owned",
  thread.ok === true &&
    thread.owned === true &&
    Array.isArray(thread.messages) &&
    thread.messages.length === 2 &&
    thread.messages[0].content === "Hello Mabel",
  JSON.stringify(thread).slice(0, 200),
);
// The Nova product is generic: it opens a second Atom too.
r = await chat("test-atom-nova", "Nora", "Hello Nora");
check("nova: a second Atom chats too", r.ok === true, JSON.stringify(r).slice(0, 120));

// --- Scenario 2: Atom rejected without ownership ---
await api("/api/state?accountId=test-atom-none");
r = await chat("test-atom-none", "Mabel", "Hello Mabel");
check("none: Atom chat refused as not_owned", r.ok === false && r.error === "not_owned", JSON.stringify(r).slice(0, 160));
const streamRes = await fetch(`http://localhost:${APP_PORT}/api/chat/stream`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ accountId: "test-atom-none", photon: "Mabel", message: "Hello Mabel" }),
});
const streamBody: any = await streamRes.json().catch(() => null);
check(
  "none: stream endpoint refuses the same way (plain JSON, no stream)",
  streamBody?.ok === false && streamBody?.error === "not_owned",
  JSON.stringify(streamBody).slice(0, 160),
);
thread = await api("/api/threads/Mabel?accountId=test-atom-none");
check(
  "none: thread reports unowned and stays empty",
  thread.ok === true && thread.owned === false && thread.messages.length === 0,
  JSON.stringify(thread).slice(0, 160),
);
const stNone = await api("/api/state?accountId=test-atom-none");
check("none: meter untouched", stNone.meter?.used === 0, JSON.stringify(stNone.meter));

// --- Scenario 3: individual Atom ownership is per Atom ---
await api("/api/state?accountId=test-atom-one");
grant("test-atom-one", "atom", "Hazel");
r = await chat("test-atom-one", "Hazel", "Hello Hazel");
check("individual: the owned Atom chats", r.ok === true, JSON.stringify(r).slice(0, 120));
r = await chat("test-atom-one", "Mabel", "Hello Mabel");
check("individual: a different Atom is still refused", r.ok === false && r.error === "not_owned", JSON.stringify(r).slice(0, 120));

// --- Scenario 4: the free code opens Atom chat ---
r = await api("/api/redeem", {
  method: "POST",
  body: JSON.stringify({ accountId: "test-atom-free", code: TEST_CODE }),
});
check("free code: redeem accepted", r.ok === true, JSON.stringify(r).slice(0, 120));
r = await chat("test-atom-free", "Nora", "Hello Nora");
check("free code: Atom chat accepted", r.ok === true, JSON.stringify(r).slice(0, 120));

// --- Scenario 5: the Photon path is unchanged ---
await api("/api/state?accountId=test-photon-one");
grant("test-photon-one", "photon", "Prism");
r = await chat("test-photon-one", "Prism", "Hello Prism");
check("photon: owned Photon still chats", r.ok === true && r.reply === "Mock Gemini reply.", JSON.stringify(r).slice(0, 160));
r = await chat("test-atom-none", "Prism", "Hello Prism");
check("photon: unowned Photon still refused", r.ok === false && r.error === "not_owned", JSON.stringify(r).slice(0, 120));
thread = await api("/api/threads/Prism?accountId=test-photon-one");
check(
  "photon: thread endpoint unchanged",
  thread.ok === true && thread.owned === true && thread.messages.length === 2,
  JSON.stringify(thread).slice(0, 160),
);
const unknownRes = await fetch(`http://localhost:${APP_PORT}/api/chat`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ accountId: "test-photon-one", photon: "Nobody", message: "Hello" }),
});
const unknownBody: any = await unknownRes.json().catch(() => null);
check(
  "photon: unknown name is still a 400",
  unknownRes.status === 400 && unknownBody?.error === "unknown photon",
  `${unknownRes.status} ${JSON.stringify(unknownBody).slice(0, 120)}`,
);

// --- Scenario 6: the Atom system prompt ---
const { systemPromptFor } = await import("../src/server/personas");
const owner = {
  name: "Test Owner",
  about: null,
  preferences: null,
  notes: null,
  title: null,
  pronouns: null,
  memoryDigest: "",
  personaSeed: null,
  identityBlock: "",
};
const atomPrompt = systemPromptFor("Mabel", "Mabel", null, owner);
check("prompt: carries the Atom persona seed", atomPrompt.includes("keep a personal inbox in order"));
check("prompt: Atom truth — no tools", atomPrompt.includes("You have no tools"));
check("prompt: Atom truth — no sends", atomPrompt.includes("You cannot send anything"));
check("prompt: Atom truth — no reminder claim", atomPrompt.includes("You cannot set reminders"));
check("prompt: carries the owner context", atomPrompt.includes("Their name is Test Owner"));
check(
  "prompt: no Photon Switchboard send path",
  !atomPrompt.includes("Report to Prism 5 button"),
);
const photonPrompt = systemPromptFor("Juniper", "Juniper", null, owner);
check(
  "prompt: Photon prompt unchanged (APP_TRUTH still present)",
  photonPrompt.includes("How Switchboard works in this app"),
);

await stopApp(proc);
mockGemini.stop();

console.log(failures === 0 ? "\nALL ATOM CHAT TESTS PASSED" : `\n${failures} ATOM CHAT TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
