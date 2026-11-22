// Verify the proactive loop end to end (local only, never production).
//   (a) telephony checkChannelItems returns [] when Twilio is not
//       configured, and the scheduler's texts channel reports
//       available:true.
//   (b) google checkChannelItems returns [] when Calendar is not
//       connected, and the calendar channel reports available:true.
//   (c) A check cycle with a seeded due reminder delivers ONE briefing
//       message into the owned Photon's thread; an account with no
//       Photon gets no thread message and no crash.
//   (d) Nova: an account with Nova access + check-ins on receives
//       exactly one Ruby thread message per day (sender run twice);
//       an account without Nova access receives none; June's nudge
//       stops after 3 days (pre-seeded seen_state).
// No real Google/Twilio calls: both providers are unconfigured in the
// test env, so the channel functions return [] before any network use.
// No real push: VAPID is unconfigured and test accounts have no push
// subscriptions; the check result must report push unconfigured/0 sent.
// Usage: bun scripts/test-proactive-loop.ts   (exit 0 = all pass)

import { rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { join } from "node:path";

const APP_PORT = 3125;
const DATA_DIR = "/tmp/prism-proactive-test";
const UNIT_DIR = "/tmp/prism-proactive-unit";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// --- (a)/(b) direct unit checks, in this process, on a throwaway DB ---
// Env is set BEFORE any server module is imported (config.ts reads it
// at import time). Providers are forced unconfigured.
process.env.DATA_DIR = UNIT_DIR;
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_PHONE_NUMBER;
await rm(UNIT_DIR, { recursive: true, force: true });
const telephony = await import("../src/server/telephony");
const telItems = await telephony.checkChannelItems("test-proactive-unit");
check("(a) telephony checkChannelItems returns [] when unconfigured", Array.isArray(telItems) && telItems.length === 0, JSON.stringify(telItems));
const google = await import("../src/server/google");
const calItems = await google.checkChannelItems("test-proactive-unit");
check("(b) google checkChannelItems returns [] when Calendar unconnected", Array.isArray(calItems) && calItems.length === 0, JSON.stringify(calItems));

// --- App server lifecycle (pattern from test-atom-chat.ts) ---
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
function runCheck(accountId: string) {
  return api("/api/proactive/check", {
    method: "POST",
    body: JSON.stringify({ accountId }),
  });
}
function grant(accountId: string, kind: string, ref: string) {
  const db = new Database(join(DATA_DIR, "app.db"));
  db.query(
    `INSERT OR IGNORE INTO owned (account_id, kind, ref, created_at) VALUES (?, ?, ?, ?)`,
  ).run(accountId, kind, ref, new Date().toISOString());
  db.close();
}
function seedSeen(accountId: string, channel: string, itemId: string) {
  const db = new Database(join(DATA_DIR, "app.db"));
  db.query(
    `INSERT OR IGNORE INTO seen_state (account_id, channel, item_id, seen_at) VALUES (?, ?, ?, ?)`,
  ).run(accountId, channel, itemId, new Date().toISOString());
  db.close();
}
async function seedDueReminder(accountId: string, text: string) {
  const r = await api("/api/reminders", {
    method: "POST",
    body: JSON.stringify({
      accountId,
      text,
      remind_at: new Date(Date.now() - 60_000).toISOString(),
    }),
  });
  if (!r.ok) throw new Error(`reminder seed failed: ${JSON.stringify(r).slice(0, 200)}`);
}

await rm(DATA_DIR, { recursive: true, force: true });

const proc = await startApp({
  TWILIO_ACCOUNT_SID: "",
  TWILIO_AUTH_TOKEN: "",
  TWILIO_PHONE_NUMBER: "",
  GOOGLE_CLIENT_ID: "",
  GOOGLE_CLIENT_SECRET: "",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  VAPID_SUBJECT: "",
  FREE_CODE: "proactive-test-code",
});

// --- (a)/(b) scheduler channel availability + status ---
const status = await api("/api/proactive/status?accountId=test-proactive-fresh");
check(
  "status: texts and calendar channels report built/available",
  status.channels?.texts === true && status.channels?.calendar === true,
  JSON.stringify(status.channels),
);
let r = await runCheck("test-proactive-fresh");
check("(a) scheduler: texts channel available:true, no items", r.texts?.available === true && r.texts?.newItems?.length === 0, JSON.stringify(r.texts));
check("(b) scheduler: calendar channel available:true, no items", r.calendar?.available === true && r.calendar?.newItems?.length === 0, JSON.stringify(r.calendar));

// --- (c) briefing into the owned Photon's thread ---
await api("/api/state?accountId=test-proactive-photon");
grant("test-proactive-photon", "photon", "Prism");
await seedDueReminder("test-proactive-photon", "Water the plants");
r = await runCheck("test-proactive-photon");
check("(c) check cycle surfaces the due reminder", r.ok === true && r.newTotal >= 1, JSON.stringify(r).slice(0, 200));
check(
  "(c) no real push attempted/sent (push unconfigured, no subscriptions)",
  r.push?.configured === false && r.push?.sent === 0,
  JSON.stringify(r.push),
);
let thread = await api("/api/threads/Prism?accountId=test-proactive-photon");
const briefings = (thread.messages || []).filter(
  (m: any) => m.role === "assistant" && typeof m.content === "string" && m.content.startsWith("While you were away:"),
);
check(
  "(c) briefing message delivered into the owned Photon's thread",
  briefings.length === 1 && briefings[0].content.includes("Water the plants"),
  JSON.stringify(thread.messages).slice(0, 300),
);

// --- (c) no Photon: no thread message, no crash ---
await api("/api/state?accountId=test-proactive-nophoton");
await seedDueReminder("test-proactive-nophoton", "Take out the recycling");
r = await runCheck("test-proactive-nophoton");
check("(c) no-Photon account: cycle still runs and surfaces the reminder", r.ok === true && r.newTotal >= 1, JSON.stringify(r).slice(0, 200));
thread = await api("/api/threads/Prism?accountId=test-proactive-nophoton");
check(
  "(c) no-Photon account: no thread message created",
  thread.owned === false && (thread.messages || []).length === 0,
  JSON.stringify(thread).slice(0, 200),
);

// --- (d) Nova check-in: exactly one Ruby message per day ---
await api("/api/state?accountId=test-proactive-nova");
grant("test-proactive-nova", "product", "nova");
await runCheck("test-proactive-nova");
await runCheck("test-proactive-nova");
thread = await api("/api/threads/Ruby?accountId=test-proactive-nova");
const rubyMsgs = (thread.messages || []).filter((m: any) => m.role === "assistant");
check("(d) Nova account: exactly one Ruby check-in after two cycles", rubyMsgs.length === 1, JSON.stringify(thread.messages).slice(0, 300));
thread = await api("/api/threads/June?accountId=test-proactive-nova");
const juneMsgs = (thread.messages || []).filter((m: any) => m.role === "assistant");
check("(d) Nova account: exactly one June nudge on day one", juneMsgs.length === 1, JSON.stringify(thread.messages).slice(0, 300));

// --- (d) no Nova access: nothing delivered ---
await api("/api/state?accountId=test-proactive-plain");
await runCheck("test-proactive-plain");
thread = await api("/api/threads/Ruby?accountId=test-proactive-plain");
check("(d) non-Nova account: no Ruby message", (thread.messages || []).length === 0, JSON.stringify(thread).slice(0, 200));
thread = await api("/api/threads/June?accountId=test-proactive-plain");
check("(d) non-Nova account: no June message", (thread.messages || []).length === 0, JSON.stringify(thread).slice(0, 200));

// --- (d) nudge stops after 3 days ---
await api("/api/state?accountId=test-proactive-nudge");
grant("test-proactive-nudge", "product", "nova");
seedSeen("test-proactive-nudge", "nova-nudge", "2026-11-18");
seedSeen("test-proactive-nudge", "nova-nudge", "2026-11-19");
seedSeen("test-proactive-nudge", "nova-nudge", "2026-11-20");
await runCheck("test-proactive-nudge");
thread = await api("/api/threads/June?accountId=test-proactive-nudge");
check("(d) nudge: no June message after 3 prior days", (thread.messages || []).length === 0, JSON.stringify(thread).slice(0, 200));

await stopApp(proc);

console.log(failures === 0 ? "\nALL PROACTIVE LOOP TESTS PASSED" : `\n${failures} PROACTIVE LOOP TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
