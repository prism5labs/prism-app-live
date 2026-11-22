// Verify Photon + Atom tool use end to end (local only, never production).
// A mock Anthropic server answers /v1/messages: on a plain user turn it
// replies with a tool_use block (add_reminder or list_inbox, by mode);
// once a tool_result is in the messages it replies with the final text.
// The real app server is then exercised over POST /api/chat:
//   (a) tools are included in the Anthropic request, a mock tool_use for
//       add_reminder executes against the local DB, the loop returns the
//       final text, and the reminder is actually stored;
//   (b) a mock tool_use for list_inbox against an account with no Gmail
//       connected returns the not_connected result to the model and the
//       loop completes;
//   (c) save_draft is among the tool definitions, and no send or
//       booking/cancelling tool is defined (checked both on the wire
//       and in src/server/tools.ts TOOL_DEFINITIONS);
//   (d) the Gemini-provider path is unchanged: the Gemini request
//       carries no tools field and plain chat still answers.
// No real Google APIs are ever called: the test accounts have no Gmail,
// Calendar, or Drive connected, and add_reminder writes only to the
// throwaway local database. The free code is a throwaway dummy passed
// through the spawned server's env, never the real code.
// Usage: bun scripts/test-tools.ts   (exit 0 = all pass)

import { rm } from "node:fs/promises";

const APP_PORT = 3132;
const MOCK_ANTHROPIC_PORT = 3131;
const MOCK_GEMINI_PORT = 3133;
const DATA_DIR = "/tmp/prism-tools-test";
const TEST_CODE = "tools-test-code";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!cond) failures++;
}

// --- Mock Anthropic -----------------------------------------------------
type Mode = "reminder" | "inbox";
let anthropicMode: Mode = "reminder";
const anthropicRequests: any[] = [];

function anthropicReply(body: any): any {
  const base = {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model: body.model || "mock",
    usage: { input_tokens: 10, output_tokens: 12 },
  };
  const hasToolResult = JSON.stringify(body.messages || []).includes("tool_result");
  if (hasToolResult) {
    return {
      ...base,
      stop_reason: "end_turn",
      content: [{ type: "text", text: `Final reply after ${anthropicMode} tool.` }],
    };
  }
  if (anthropicMode === "reminder") {
    return {
      ...base,
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: "toolu_reminder_1",
          name: "add_reminder",
          input: { text: "Water the plants", remindAt: "2027-01-02T15:00:00.000Z" },
        },
      ],
    };
  }
  return {
    ...base,
    stop_reason: "tool_use",
    content: [
      { type: "tool_use", id: "toolu_inbox_1", name: "list_inbox", input: {} },
    ],
  };
}

const mockAnthropic = Bun.serve({
  port: MOCK_ANTHROPIC_PORT,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as any;
    anthropicRequests.push(body);
    return new Response(JSON.stringify(anthropicReply(body)), {
      headers: { "content-type": "application/json" },
    });
  },
});

// --- Mock Gemini --------------------------------------------------------
const geminiRequests: any[] = [];
const mockGemini = Bun.serve({
  port: MOCK_GEMINI_PORT,
  async fetch(req) {
    const body = (await req.json().catch(() => ({}))) as any;
    geminiRequests.push(body);
    return new Response(
      JSON.stringify({
        candidates: [
          { content: { role: "model", parts: [{ text: "Mock Gemini reply." }] }, finishReason: "STOP" },
        ],
      }),
      { headers: { "content-type": "application/json" } },
    );
  },
});

// --- App server lifecycle ------------------------------------------------
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
async function redeem(accountId: string) {
  const r = await api("/api/redeem", {
    method: "POST",
    body: JSON.stringify({ accountId, code: TEST_CODE }),
  });
  check(`redeem ${accountId}`, r.ok === true, JSON.stringify(r).slice(0, 120));
}

await rm(DATA_DIR, { recursive: true, force: true });

// === Anthropic app =======================================================
const procA = await startApp({
  ANTHROPIC_API_KEY: "test-key",
  ANTHROPIC_BASE_URL: `http://localhost:${MOCK_ANTHROPIC_PORT}`,
  GEMINI_API_KEY: "",
  FREE_CODE: TEST_CODE,
});

// --- (a) add_reminder tool loop ------------------------------------------
anthropicMode = "reminder";
anthropicRequests.length = 0;
await redeem("test-tools-reminder");
let r = await chat("test-tools-reminder", "Prism", "Remind me to water the plants");
check(
  "(a) loop returns the final text after the tool round",
  r.ok === true && r.reply === "Final reply after reminder tool.",
  JSON.stringify(r).slice(0, 200),
);
check(
  "(a) two Anthropic requests were made (tool_use, then tool_result)",
  anthropicRequests.length === 2,
  `requests=${anthropicRequests.length}`,
);
const firstReq = anthropicRequests[0] || {};
const toolNames: string[] = Array.isArray(firstReq.tools)
  ? firstReq.tools.map((t: any) => t.name)
  : [];
check(
  "(a) tools are included in the Anthropic request",
  toolNames.length === 9 && toolNames.includes("add_reminder") && toolNames.includes("list_inbox"),
  toolNames.join(","),
);
check(
  "(a) system prompt carries the tools block and the no-send rule",
  String(firstReq.system || "").includes("YOUR TOOLS IN THIS CHAT") &&
    String(firstReq.system || "").includes("CANNOT send email"),
);
check(
  "(a) system prompt states Gmail is not connected for this account",
  String(firstReq.system || "").includes("Gmail is NOT connected for this account"),
);
const secondReq = anthropicRequests[1] || {};
check(
  "(a) the tool_result handed back carries the created reminder",
  JSON.stringify(secondReq.messages || []).includes("Water the plants"),
);
const reminders = await api("/api/reminders?accountId=test-tools-reminder");
check(
  "(a) the reminder is actually stored",
  reminders.ok === true &&
    Array.isArray(reminders.reminders) &&
    reminders.reminders.length === 1 &&
    reminders.reminders[0].text === "Water the plants" &&
    reminders.reminders[0].remindAt === "2027-01-02T15:00:00.000Z",
  JSON.stringify(reminders).slice(0, 240),
);

// --- (b) list_inbox with no Gmail connected -------------------------------
anthropicMode = "inbox";
anthropicRequests.length = 0;
r = await chat("test-tools-reminder", "Prism", "What is in my inbox?");
check(
  "(b) loop completes with the final text",
  r.ok === true && r.reply === "Final reply after inbox tool.",
  JSON.stringify(r).slice(0, 200),
);
const inboxSecond = anthropicRequests[1] || {};
check(
  "(b) the tool_result handed to the model says not_connected",
  JSON.stringify(inboxSecond.messages || []).includes("not_connected"),
  JSON.stringify(inboxSecond.messages || []).slice(0, 300),
);

// --- (c) definitions: save_draft present, send/booking absent -------------
check(
  "(c) save_draft is in the wire tool definitions",
  toolNames.includes("save_draft"),
  toolNames.join(","),
);
const forbidden = ["send_email", "sendEmail", "send_from_any", "sendFromAny", "book_calendar_event", "bookCalendarEvent", "cancel_calendar_event", "cancelCalendarEvent", "send", "book", "cancel"];
check(
  "(c) no send or booking/cancelling tool is on the wire",
  !toolNames.some((n) => forbidden.includes(n)),
  toolNames.join(","),
);
const { TOOL_DEFINITIONS, executeTool } = await import("../src/server/tools");
const defNames = TOOL_DEFINITIONS.map((t: any) => t.name);
check(
  "(c) TOOL_DEFINITIONS match the expected 9 read+draft tools",
  JSON.stringify([...defNames].sort()) ===
    JSON.stringify(
      ["add_reminder", "calendar_freebusy", "list_calendar_events", "list_inbox", "list_reminders", "read_drive_file", "read_email", "save_draft", "search_drive"].sort(),
    ),
  defNames.join(","),
);
const unknown = JSON.parse(await executeTool("test-tools-reminder", "send_email", {}));
check(
  "(c) the executor refuses a send tool name outright",
  unknown.ok === false && unknown.error === "unknown_tool",
  JSON.stringify(unknown).slice(0, 160),
);
const draftNoGmail = JSON.parse(
  await executeTool("test-tools-reminder", "save_draft", {
    to: "someone@example.com",
    subject: "Hi",
    body: "Draft body",
  }),
);
check(
  "(c) save_draft against an unconnected account returns not_connected (no Google call)",
  draftNoGmail.ok === false && draftNoGmail.error === "not_connected",
  JSON.stringify(draftNoGmail).slice(0, 160),
);

await stopApp(procA);

// === Gemini app (d) ========================================================
const procG = await startApp({
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "test-key",
  GEMINI_BASE_URL: `http://localhost:${MOCK_GEMINI_PORT}`,
  FREE_CODE: TEST_CODE,
});
geminiRequests.length = 0;
await redeem("test-tools-gemini");
r = await chat("test-tools-gemini", "Prism", "Hello Gemini");
check(
  "(d) gemini plain chat still answers",
  r.ok === true && r.reply === "Mock Gemini reply.",
  JSON.stringify(r).slice(0, 160),
);
check(
  "(d) the Gemini request carries no tools field",
  geminiRequests.length >= 1 && !("tools" in (geminiRequests[0] || {})) && !("toolConfig" in (geminiRequests[0] || {})),
  `requests=${geminiRequests.length} keys=${Object.keys(geminiRequests[0] || {}).join(",")}`,
);
check(
  "(d) the Gemini system prompt has no tools block",
  !(geminiRequests[0]?.systemInstruction?.parts?.[0]?.text || "").includes("YOUR TOOLS IN THIS CHAT"),
);

await stopApp(procG);
mockAnthropic.stop();
mockGemini.stop();

console.log(failures === 0 ? "\nALL TOOL TESTS PASSED" : `\n${failures} TOOL TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
