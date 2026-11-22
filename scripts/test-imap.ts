// IMAP mail tests: Yahoo / Apple Mail / other IMAP connect, over a
// local mock IMAP server — no real mailbox, no real password, no real
// network. The wire client is tested against canned bytes (header
// parsing, encoded words, FETCH literals) and against the mock server
// (login, list, read, draft, disconnect); the HTTP routes are tested
// against the real server booted as a child process; the client render
// is tested in jsdom with the built bundle.
//
// Run: DATA_DIR=/tmp/prism-imap-test bun scripts/test-imap.ts
// The server boots on :3112 with the same DATA_DIR; the function tests
// share that database with it. The mock IMAP server speaks plaintext
// on 127.0.0.1; the tests inject a dial that redirects every host to
// it, so no connect ever leaves the machine. A real Yahoo or iCloud
// login is NOT tested here: it needs a real account and an
// app-specific password, which only the owner has.

import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as bunConnect } from "bun";
import { JSDOM } from "jsdom";

const ROOT = join(import.meta.dir, "..");
const PORT = 3112;
const BASE = `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || mkdtempSync(join(tmpdir(), "prism-imap-test-"));
const DEVICE = "acc_imaptest000000001";
const DEVICE_B = "acc_imaptest000000002";

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
const eq = (name: string, got: unknown, want: unknown) =>
  check(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// The client render tests boot the built bundle, so build it first.
const built = spawnSync("bun", ["run", "build"], { cwd: ROOT, encoding: "utf8" });
if (built.status !== 0) throw new Error(`client build failed:\n${built.stdout}\n${built.stderr}`);

process.env.DATA_DIR = DATA_DIR;
const imap = await import("../src/server/imap");
const lmDb = await import("../src/server/db");

// --- Pure functions ---------------------------------------------------
console.log("Pure functions");
eq("yahoo host is imap.mail.yahoo.com", imap.providerFor("yahoo")?.host, "imap.mail.yahoo.com");
eq("yahoo port is 993", imap.providerFor("yahoo")?.port, 993);
eq("apple host is imap.mail.me.com", imap.providerFor("apple")?.host, "imap.mail.me.com");
eq("other has no preset host", imap.providerFor("other")?.host, "");
eq("unknown provider is null", imap.providerFor("gmail"), null);
check("imap-1 is a valid label", imap.isValidImapLabel("imap-1"));
check("imap-12 is a valid label", imap.isValidImapLabel("imap-12"));
check("imap-0 is not a valid label", !imap.isValidImapLabel("imap-0"));
check("gmail-1 is not an IMAP label", !imap.isValidImapLabel("gmail-1"));
check("imap- is not a valid label", !imap.isValidImapLabel("imap-"));
check("yahoo host is safe", imap.isSafeImapHost("imap.mail.yahoo.com"));
check("icloud host is safe", imap.isSafeImapHost("imap.mail.me.com"));
check("a custom mail host is safe", imap.isSafeImapHost("imap.example.com"));
check("an IP literal is not a safe host", !imap.isSafeImapHost("127.0.0.1"));
check("localhost is not a safe host", !imap.isSafeImapHost("localhost"));
check("a private IP is not a safe host", !imap.isSafeImapHost("192.168.1.1"));
check("a hostname with a space is not safe", !imap.isSafeImapHost("bad host"));
check("a bare TLD is not a safe host", !imap.isSafeImapHost("example"));

const headers = imap.parseHeaders(
  "From: Ada Lovelace <ada@example.com>\r\nSubject: =?UTF-8?B?SGVsbG8gZnJvbSB0aGUgcGFzdA==?=\r\nDate: Mon, 16 Nov 2026 09:12:00 +0000\r\n\r\n",
);
eq("encoded-word subject decodes", headers.subject, "Hello from the past");
eq("from passes through", headers.from, "Ada Lovelace <ada@example.com>");
eq("date passes through", headers.date, "Mon, 16 Nov 2026 09:12:00 +0000");
const folded = imap.parseHeaders("Subject: a very long\r\n subject that folds\r\nFrom: x@y.z\r\n\r\n");
eq("a folded subject unfolds", folded.subject, "a very long subject that folds");
eq(
  "Q-encoded word decodes",
  imap.decodeEncodedWords("=?UTF-8?Q?caf=C3=A9?="),
  "café",
);
eq("plain text is untouched by the decoder", imap.decodeEncodedWords("no encoding here"), "no encoding here");
eq(
  "HTML body strips to words",
  imap.bodyTextFrom("<p>Hello <b>world</b></p>\nSecond line &amp; friends."),
  "Hello world\nSecond line & friends.",
);
eq("plain body passes through", imap.bodyTextFrom("Just words.\nTwo lines."), "Just words.\nTwo lines.");
const draft = imap.buildDraftRfc822("reader@yahoo.com", "a@b.c", "Hi\nInjected: x", "body\nline");
check("draft has a From line", draft.includes("From: reader@yahoo.com"));
check("draft has a To line", draft.includes("To: a@b.c"));
check("draft strips a newline out of the subject", !draft.includes("Hi\nInjected"));
check("draft uses CRLF line endings", draft.includes("\r\n"));

// parseFetchSegments against canned wire bytes.
const cannedHeader = Buffer.from(
  "From: Grace Hopper <grace@example.com>\r\nSubject: Plain subject\r\nDate: Tue, 17 Nov 2026 10:00:00 +0000\r\n\r\n",
  "utf8",
);
const cannedText = Buffer.from("<p>Hello <b>world</b></p>", "utf8");
const canned = imap.parseFetchSegments([
  {
    kind: "line",
    text: `* 2 FETCH (UID 102 FLAGS () INTERNALDATE "17-Nov-2026 10:00:00 +0000" BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${cannedHeader.length}}`,
  },
  { kind: "literal", bytes: cannedHeader },
  { kind: "line", text: ` BODY[TEXT]<0> {${cannedText.length}}` },
  { kind: "literal", bytes: cannedText },
  { kind: "line", text: ")" },
]);
eq("canned FETCH parses one message", canned.length, 1);
eq("canned FETCH uid", canned[0]?.uid, 102);
eq("canned FETCH unread (no Seen flag)", canned[0]?.flags.includes("\\Seen"), false);
eq("canned FETCH subject", canned[0]?.headers.subject, "Plain subject");
eq("canned FETCH text strips HTML", canned[0]?.text, "Hello world");

// --- Mock IMAP server -------------------------------------------------
// Speaks enough IMAP for the client: greeting, LOGIN, SELECT, STATUS,
// LIST, FETCH, UID FETCH, APPEND, LOGOUT. One mailbox, two messages.
console.log("Mock IMAP server");
type MsgDef = {
  uid: number;
  flags: string;
  internalDate: string;
  from: string;
  subject: string;
  date: string;
  text: string;
  fullText: string;
};
const MSG1: MsgDef = {
  uid: 101,
  flags: "\\Seen",
  internalDate: "16-Nov-2026 09:12:00 +0000",
  from: "Ada Lovelace <ada@example.com>",
  subject: "=?UTF-8?B?SGVsbG8gZnJvbSB0aGUgcGFzdA==?=",
  date: "Mon, 16 Nov 2026 09:12:00 +0000",
  text: "First message body here.",
  fullText: "First message body here.\nIt has two lines.",
};
const MSG2: MsgDef = {
  uid: 102,
  flags: "",
  internalDate: "17-Nov-2026 10:00:00 +0000",
  from: "Grace Hopper <grace@example.com>",
  subject: "Plain subject",
  date: "Tue, 17 Nov 2026 10:00:00 +0000",
  text: "<p>Hello <b>world</b></p>\nSecond line &amp; friends.",
  fullText: "Full body of the second message.\nIt has two lines.",
};

function fetchResponse(which: 1 | 2, full: boolean): string {
  const msg = which === 1 ? MSG1 : MSG2;
  const header = `From: ${msg.from}\r\nSubject: ${msg.subject}\r\nDate: ${msg.date}\r\n\r\n`;
  const text = full ? msg.fullText : msg.text;
  const hbuf = Buffer.from(header, "utf8");
  const tbuf = Buffer.from(text, "utf8");
  return (
    `* ${which} FETCH (UID ${msg.uid} FLAGS (${msg.flags}) INTERNALDATE "${msg.internalDate}" ` +
    `BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {${hbuf.length}}\r\n${header}` +
    ` BODY[TEXT]<0> {${tbuf.length}}\r\n${text}\r\n)\r\n`
  );
}

const appended: string[] = [];
const mockLogins: { user: string; pass: string; ok: boolean }[] = [];
const mock = net.createServer((socket) => {
  socket.write("* OK Mock IMAP ready\r\n");
  let buf = Buffer.alloc(0);
  let pendingAppend: { n: number; tag: string } | null = null;
  const send = (s: string) => socket.write(s);
  const handleLine = (line: string) => {
    const m = line.match(/^(\S+) (.*)$/);
    if (!m) return;
    const [, tag, rest] = m;
    const cmd = rest.split(" ")[0].toUpperCase();
    if (cmd === "LOGIN") {
      const qm = rest.match(/LOGIN "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"/);
      const user = qm ? qm[1] : "";
      const pass = qm ? qm[2] : "";
      const ok = pass === "app-pass-123";
      mockLogins.push({ user, pass, ok });
      send(ok ? `${tag} OK Logged in\r\n` : `${tag} NO Bad login\r\n`);
    } else if (cmd === "SELECT") {
      send(
        `* 2 EXISTS\r\n* 1 RECENT\r\n* OK [UNSEEN 1] First unseen\r\n* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n${tag} OK [READ-WRITE] SELECT completed\r\n`,
      );
    } else if (cmd === "STATUS") {
      send(`* STATUS "INBOX" (UNSEEN 1)\r\n${tag} OK STATUS completed\r\n`);
    } else if (cmd === "LIST") {
      send(
        `* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\HasNoChildren \\Drafts) "/" "Drafts"\r\n${tag} OK LIST completed\r\n`,
      );
    } else if (cmd === "FETCH") {
      send(fetchResponse(1, false) + fetchResponse(2, false));
      send(`${tag} OK Fetch completed\r\n`);
    } else if (cmd === "UID") {
      const uidm = rest.match(/UID FETCH (\d+)/);
      const uid = uidm ? Number(uidm[1]) : 102;
      send(fetchResponse(uid === 101 ? 1 : 2, true));
      send(`${tag} OK Fetch completed\r\n`);
    } else if (cmd === "APPEND") {
      const lit = rest.match(/\{(\d+)\}\s*$/);
      pendingAppend = { n: lit ? Number(lit[1]) : 0, tag };
      send("+ OK Ready for literal\r\n");
    } else if (cmd === "LOGOUT") {
      send(`* BYE Mock logging out\r\n${tag} OK LOGOUT completed\r\n`);
      socket.end();
    } else {
      send(`${tag} BAD Unknown command\r\n`);
    }
  };
  socket.on("data", (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (pendingAppend) {
        const need = pendingAppend.n + 2;
        if (buf.length < need) return;
        appended.push(buf.subarray(0, pendingAppend.n).toString("utf8"));
        buf = buf.subarray(need);
        const tag = pendingAppend.tag;
        pendingAppend = null;
        send(`${tag} OK [APPENDUID 12345 201] APPEND completed\r\n`);
        continue;
      }
      const idx = buf.indexOf(0x0a);
      if (idx < 0) return;
      let line = buf.subarray(0, idx).toString("utf8");
      buf = buf.subarray(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      handleLine(line);
    }
  });
});
const mockPort = await new Promise<number>((resolve) => {
  mock.listen(0, "127.0.0.1", () => resolve((mock.address() as net.AddressInfo).port));
});

// Every dial, whatever host it names, goes to the mock on 127.0.0.1.
// The mock speaks plaintext; the production dial speaks TLS, and the
// seam below is the only place that difference lives.
imap.__setImapDialForTests(async (_host, _port, _tls, handlers) => {
  const sock = await bunConnect({
    hostname: "127.0.0.1",
    port: mockPort,
    socket: {
      data(_s: any, data: any) {
        handlers.onData(data instanceof Uint8Array ? data : new TextEncoder().encode(String(data)));
      },
      close() {
        handlers.onClose();
      },
      error(_s: any, e: any) {
        handlers.onError(e instanceof Error ? e : new Error(String(e)));
      },
      connectError(_s: any, e: any) {
        handlers.onError(e instanceof Error ? e : new Error(String(e)));
      },
    },
  });
  return {
    write: (data) => {
      sock.write(data as any);
    },
    end: () => {
      try {
        sock.end();
      } catch {
        // Already closed.
      }
    },
  };
});

// --- Integration: connect, list, read, draft, disconnect -------------
console.log("Integration against the mock");
const bad = await imap.connectImap(DEVICE, "yahoo", "reader@yahoo.com", "wrong-password");
check("a wrong password is refused as auth_failed", bad.ok === false && bad.error === "auth_failed", JSON.stringify(bad));
eq("a refused connect stores nothing", lmDb.getImapAccounts(DEVICE).length, 0);

const good = await imap.connectImap(DEVICE, "yahoo", "reader@yahoo.com", "app-pass-123");
check("a good password connects", good.ok === true && good.label === "imap-1", JSON.stringify(good));
eq("the account is stored", lmDb.getImapAccounts(DEVICE).length, 1);
eq("the stored host is Yahoo's", lmDb.getImapAccounts(DEVICE)[0]?.host, "imap.mail.yahoo.com");

const listed = await imap.listInbox(DEVICE, "imap-1", 10);
check("list connects", listed.connected === true, JSON.stringify(listed.error));
eq("list returns two messages", listed.messages.length, 2);
eq("newest first", listed.messages[0]?.id, "102");
eq("the newest is unread", listed.messages[0]?.unread, true);
eq("the older is read", listed.messages[1]?.unread, false);
eq("encoded-word subject decodes in the list", listed.messages[1]?.subject, "Hello from the past");
eq("HTML snippet strips to words", listed.messages[0]?.snippet, "Hello world\nSecond line & friends.");
eq("unread count is 1", listed.unreadCount, 1);

const one = await imap.getMessage(DEVICE, "imap-1", "102");
check("one message reads", one.ok === true, JSON.stringify(one.error));
eq("the full body comes back", one.body, "Full body of the second message.\nIt has two lines.");
eq("the message subject", one.subject, "Plain subject");

const drafted = await imap.saveDraft(DEVICE, "imap-1", "friend@example.com", "Hello there", "Draft body here.");
check("a draft saves", drafted.ok === true, JSON.stringify(drafted.error));
eq("one APPEND reached the mock", appended.length, 1);
check("the APPEND carries the recipient", appended[0]?.includes("To: friend@example.com") || false);
check("the APPEND carries the subject", appended[0]?.includes("Subject: Hello there") || false);
check("the APPEND carries the body", appended[0]?.includes("Draft body here.") || false);

const apple = await imap.connectImap(DEVICE, "apple", "reader@icloud.com", "app-pass-123");
check("a second mailbox connects as imap-2", apple.ok === true && apple.label === "imap-2", JSON.stringify(apple));
eq("two accounts stored", lmDb.getImapAccounts(DEVICE).length, 2);
check("disconnect forgets the mailbox", imap.disconnectImap(DEVICE, "imap-2") === true);
eq("one account left after disconnect", lmDb.getImapAccounts(DEVICE).length, 1);
const gone = await imap.listInbox(DEVICE, "imap-2", 10);
check("a disconnected mailbox reports not connected", gone.connected === false);

// --- HTTP: the real server as a child process -------------------------
console.log("HTTP");
const server: ChildProcess = spawn("bun", ["src/server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR },
  stdio: "ignore",
});
async function waitForHealth(ms = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
try {
  if (!(await waitForHealth())) throw new Error("test server did not come up");

  const providers: any = await (await fetch(`${BASE}/api/imap/providers`)).json();
  check("providers lists Yahoo, Apple, Other", providers.ok === true && providers.providers?.length === 3);
  eq("providers Yahoo first", providers.providers?.[0]?.id, "yahoo");
  eq("providers Apple second", providers.providers?.[1]?.id, "apple");

  const empty: any = await (await fetch(`${BASE}/api/imap/inboxes?accountId=${DEVICE_B}`)).json();
  check("a fresh account has no IMAP mailboxes", empty.ok === true && empty.accounts.length === 0);

  const badProvider = await fetch(`${BASE}/api/imap/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: DEVICE_B, provider: "gmail", email: "a@b.c", password: "x" }),
  });
  const badProviderBody: any = await badProvider.json();
  check("an unknown provider is refused", badProviderBody.ok === false && badProviderBody.error === "bad_provider");

  const noPass = await fetch(`${BASE}/api/imap/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: DEVICE_B, provider: "yahoo", email: "a@yahoo.com", password: "" }),
  });
  const noPassBody: any = await noPass.json();
  check("a missing password is refused", noPassBody.ok === false && noPassBody.error === "bad_password");

  const badHost = await fetch(`${BASE}/api/imap/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: DEVICE_B, provider: "other", email: "a@example.com", password: "x", host: "127.0.0.1" }),
  });
  const badHostBody: any = await badHost.json();
  check("an IP literal host is refused", badHostBody.ok === false && badHostBody.error === "bad_host");

  const unreachable = await fetch(`${BASE}/api/imap/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: DEVICE_B, provider: "other", email: "a@example.com", password: "x", host: "imap.example.invalid" }),
  });
  const unreachableBody: any = await unreachable.json();
  check(
    "an unresolvable host fails honestly as unreachable",
    unreachableBody.ok === false && unreachableBody.error === "unreachable",
    JSON.stringify(unreachableBody),
  );

  const badLabel = await fetch(`${BASE}/api/imap/message?accountId=${DEVICE_B}&label=gmail-1&id=1`);
  check("a bad label is 400", badLabel.status === 400);

  const noAccount = await fetch(`${BASE}/api/imap/disconnect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId: DEVICE_B, label: "imap-9" }),
  });
  const noAccountBody: any = await noAccount.json();
  check("disconnecting nothing is not_connected", noAccountBody.ok === false && noAccountBody.error === "not_connected");

  // --- Client render (jsdom): the Connected tab with an IMAP card ---
  console.log("Client render");
  const html = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  const js = readFileSync(join(ROOT, "public", "main.js"), "utf8");
  const state = {
    ok: true,
    accountId: DEVICE,
    displayName: "Test",
    customName: null,
    ownedPhotons: ["Prism"],
    ownedProducts: [],
    meter: { used: 0, limit: 300, unlimited: false },
    upkeep: false,
    freeCode: false,
    brain: true,
    googleConfigured: true,
    microsoftConfigured: false,
    auth: { signedIn: false },
    customizations: {},
    photons: [{ name: "Prism", pronoun: "she/her", tagline: "For anyone", focus: "Front desk", owned: true }],
  };
  const dom = new JSDOM(html, { url: `${BASE}/?tab=connected`, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom as any;
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
  window.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes("/api/state")) return new Response(JSON.stringify(state), { headers: { "content-type": "application/json" } });
    if (url.includes("/api/imap/inboxes"))
      return new Response(
        JSON.stringify({
          ok: true,
          accounts: [
            {
              label: "imap-1",
              title: "reader@yahoo.com",
              provider: "yahoo",
              providerName: "Yahoo Mail",
              webmail: "https://mail.yahoo.com/",
              connected: true,
              email: "reader@yahoo.com",
              messages: [
                { id: "102", from: "Grace Hopper <grace@example.com>", subject: "Plain subject", date: "Tue, 17 Nov 2026 10:00:00 +0000", snippet: "Hello world", unread: true },
              ],
              unreadCount: 1,
              error: null,
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (url.includes("/api/imap/providers"))
      return new Response(
        JSON.stringify({
          ok: true,
          providers: [
            { id: "yahoo", name: "Yahoo Mail", host: "imap.mail.yahoo.com", port: 993 },
            { id: "apple", name: "Apple Mail (iCloud)", host: "imap.mail.me.com", port: 993 },
            { id: "other", name: "Other IMAP account", host: "", port: 993 },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    if (url.includes("/api/inboxes") || url.includes("/api/outlook/inboxes"))
      return new Response(JSON.stringify({ ok: true, accounts: [] }), { headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  };
  window.localStorage.setItem("prism5.accountId", DEVICE);
  window.eval(js);
  await new Promise((r) => setTimeout(r, 1200));
  const view = window.document.getElementById("view")?.innerHTML || "";
  check("Connections shows the IMAP row", view.includes("Other mail (Yahoo, Apple Mail, IMAP)"));
  check("Connections shows the connect form", view.includes("Connect mailbox") && view.includes("App-specific password"));
  check("Connections no longer says Yahoo and Apple are unsupported", !view.includes("aren't supported yet"));
  check("the IMAP card shows the mailbox", view.includes("reader@yahoo.com") && view.includes("Yahoo Mail"));
  check("the IMAP card shows the message", view.includes("Plain subject"));
  check("the IMAP card offers disconnect", view.includes("Disconnect this mailbox"));
  check("the IMAP card offers a draft form", view.includes("Save a draft"));
} finally {
  server.kill();
  mock.close();
  imap.__setImapDialForTests(null);
  rmSync(DATA_DIR, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
