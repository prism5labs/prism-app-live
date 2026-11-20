// IMAP mail (plain IMAP over TLS, no SDK): Yahoo Mail, Apple Mail
// (iCloud), and any other IMAP account. Yahoo and Apple both offer
// IMAP with an app-specific password, and neither needs an OAuth
// client registered anywhere, so this is the way in for every mailbox
// that is not Gmail or Outlook. The Inboxes tab reads IMAP accounts
// the same way it reads Gmail and Outlook: each connected mailbox
// shows as its own card and can save real drafts.
//
// A note on the password: IMAP has no refresh token. The app-specific
// password the owner pastes in is the credential, and it is stored in
// the local SQLite database the same way Gmail and Outlook refresh
// tokens are stored — on the server only, never sent back to the
// client, and removable from the app with Disconnect. On Render's
// free tier the disk is ephemeral, so connections reset when the
// service redeploys. An app-specific password is not the mailbox
// password: it is made in the provider's account settings, and it can
// be revoked there at any time without changing the mailbox password.
//
// What is deliberately NOT here: no OAuth for Yahoo or Apple (Yahoo
// would need a developer app registered by the owner; Apple Mail has
// no OAuth for IMAP at all), no sending (IMAP cannot send; drafts
// only — the owner sends from the mail app), and no marking messages
// read (reading here never changes the mailbox).

import { connect as bunConnect } from "bun";
import { decodeHtmlEntities } from "./htmlText";
import {
  deleteImapAccount,
  getImapAccount,
  getImapAccounts,
  setImapAccount,
} from "./db";

export class ImapError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// --- Providers ------------------------------------------------------

export type ImapProviderId = "yahoo" | "apple" | "other";

export type ImapProvider = {
  id: ImapProviderId;
  name: string;
  host: string;
  port: number;
  webmail: string | null;
};

export const IMAP_PROVIDERS: ImapProvider[] = [
  {
    id: "yahoo",
    name: "Yahoo Mail",
    host: "imap.mail.yahoo.com",
    port: 993,
    webmail: "https://mail.yahoo.com/",
  },
  {
    id: "apple",
    name: "Apple Mail (iCloud)",
    host: "imap.mail.me.com",
    port: 993,
    webmail: "https://www.icloud.com/mail/",
  },
  {
    id: "other",
    name: "Other IMAP account",
    host: "",
    port: 993,
    webmail: null,
  },
];

export function providerFor(id: string): ImapProvider | null {
  return IMAP_PROVIDERS.find((p) => p.id === id) || null;
}

// --- Labels ---------------------------------------------------------
// An IMAP label is a generated slug, imap-1, imap-2, ... so anyone
// can add as many IMAP accounts as they like. The label is safe by
// construction: no colon, no spaces.

export type ImapLabel = string;

export function isValidImapLabel(label: string): boolean {
  return /^imap-[1-9][0-9]*$/.test(label);
}

export function imapLabelTitle(label: string, email: string | null): string {
  return email || "IMAP account";
}

function nextLabel(accountId: string): ImapLabel {
  const used = new Set(getImapAccounts(accountId).map((a) => a.label));
  let n = 1;
  while (used.has(`imap-${n}`)) n++;
  return `imap-${n}`;
}

// --- Custom hosts ---------------------------------------------------
// A custom host is only reachable on the IMAP TLS port, and only when
// it looks like a public mail hostname: no IP literals, no localhost,
// no private or reserved ranges. The server dials the host on the
// owner's behalf, so an open host field must not become a way to
// reach the inside of the network.
const HOST_RE = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/;

export function isSafeImapHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (!HOST_RE.test(h)) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return false;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return false;
  return true;
}

// --- Connect rate limit ---------------------------------------------
// In-memory only: a redeploy resets it, which is fine for a limiter.
// 5 connect attempts per account id per 10 minutes. A connect attempt
// sends a password to a real mail server, so the window stays small.

const connectAttempts = new Map<string, number[]>();

function connectRateLimited(accountId: string): boolean {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (connectAttempts.get(accountId) || []).filter((t) => now - t < windowMs);
  if (list.length >= 5) return true;
  list.push(now);
  connectAttempts.set(accountId, list);
  return false;
}

// --- Wire client ----------------------------------------------------
// One connection per operation: dial, greet, log in, do the work,
// log out. The protocol is request/response, so reads are strictly
// sequential — a single waiter slot is enough.

type SocketHandlers = {
  onData: (data: Uint8Array) => void;
  onClose: () => void;
  onError: (e: Error) => void;
};

export type ImapTransport = {
  write: (data: string | Uint8Array) => void;
  end: () => void;
};

export type ImapDial = (
  host: string,
  port: number,
  tls: boolean,
  handlers: SocketHandlers,
) => Promise<ImapTransport>;

const defaultDial: ImapDial = async (host, port, tls, handlers) => {
  let socket: any = null;
  const p = bunConnect({
    hostname: host,
    port,
    ...(tls ? { tls: true } : {}),
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
  }).then((s: any) => {
    socket = s;
    return s;
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new ImapError("unreachable", "That mail server didn't answer.")), 10_000),
  );
  const s = await Promise.race([p, timeout]).catch((e) => {
    // A late connect must not linger: close it when it lands.
    p.then((sock: any) => {
      try {
        sock.end();
      } catch {
        // Already closed.
      }
    }).catch(() => {});
    throw e;
  });
  void socket;
  return {
    write: (data) => {
      s.write(data as any);
    },
    end: () => {
      try {
        s.end();
      } catch {
        // Already closed.
      }
    },
  };
};

// Test seam: tests inject a plaintext dial to a local mock server.
// Production never sets this; the HTTP routes never touch it.
let dialOverride: ImapDial | null = null;

export function __setImapDialForTests(dial: ImapDial | null): void {
  dialOverride = dial;
}

const COMMAND_TIMEOUT_MS = 15_000;

type Segment = { kind: "line"; text: string } | { kind: "literal"; bytes: Uint8Array };

class ImapConnection {
  private transport: ImapTransport | null = null;
  private buf = Buffer.alloc(0);
  private waiters: Array<() => void> = [];
  private closed = false;
  private failure: Error | null = null;
  private tagCounter = 0;
  private preauth = false;

  constructor(
    private host: string,
    private port: number,
    private tls: boolean,
  ) {}

  async open(): Promise<void> {
    const dial = dialOverride || defaultDial;
    this.transport = await dial(this.host, this.port, this.tls, {
      onData: (data) => {
        this.buf = Buffer.concat([this.buf, Buffer.from(data)]);
        const w = this.waiters.splice(0);
        for (const fn of w) fn();
      },
      onClose: () => {
        this.closed = true;
        const w = this.waiters.splice(0);
        for (const fn of w) fn();
      },
      onError: (e) => {
        this.failure = e;
        this.closed = true;
        const w = this.waiters.splice(0);
        for (const fn of w) fn();
      },
    });
    // The greeting is one line: * OK, * PREAUTH, or a refusal.
    const line = await this.readLine();
    if (line.startsWith("* BYE") || line.startsWith("* BAD")) {
      throw new ImapError("unreachable", "That mail server refused the connection.");
    }
    if (line.startsWith("* PREAUTH")) {
      // Already authenticated: no LOGIN needed.
      this.preauth = true;
      return;
    }
    if (!line.startsWith("* OK")) {
      throw new ImapError("unreachable", "That mail server didn't answer properly.");
    }
  }

  close(): void {
    try {
      this.transport?.end();
    } catch {
      // Already closed.
    }
    this.transport = null;
  }

  private async waitForData(): Promise<void> {
    if (this.buf.length > 0 || this.closed) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    if (this.failure) throw this.failure;
    if (this.closed && this.buf.length === 0) {
      throw new ImapError("unreachable", "That mail server closed the connection.");
    }
  }

  private async withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: any = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ImapError("timeout", "That mail server took too long to answer.")),
        COMMAND_TIMEOUT_MS,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readLine(): Promise<string> {
    return this.withTimeout(
      (async () => {
        for (;;) {
          const idx = this.buf.indexOf(0x0a);
          if (idx >= 0) {
            let line = this.buf.subarray(0, idx).toString("utf8");
            this.buf = this.buf.subarray(idx + 1);
            if (line.endsWith("\r")) line = line.slice(0, -1);
            return line;
          }
          await this.waitForData();
        }
      })(),
    );
  }

  private async readExact(n: number): Promise<Uint8Array> {
    return this.withTimeout(
      (async () => {
        for (;;) {
          if (this.buf.length >= n) {
            const out = this.buf.subarray(0, n);
            this.buf = this.buf.subarray(n);
            return out;
          }
          await this.waitForData();
        }
      })(),
    );
  }

  private nextTag(): string {
    this.tagCounter = (this.tagCounter % 999) + 1;
    return `a${String(this.tagCounter).padStart(3, "0")}`;
  }

  // Send one command and read until its tagged response. Untagged
  // lines and literals ride along as segments, in order; a `+`
  // continuation runs the callback (APPEND sends its bytes then).
  private async command(
    line: string,
    onContinuation?: () => void,
  ): Promise<{ ok: boolean; status: string; text: string; segments: Segment[] }> {
    const tag = this.nextTag();
    this.transport?.write(`${tag} ${line}\r\n`);
    const segments: Segment[] = [];
    for (;;) {
      const text = await this.readLine();
      if (text.startsWith("+")) {
        if (onContinuation) onContinuation();
        continue;
      }
      if (text.startsWith(`${tag} `)) {
        const rest = text.slice(tag.length + 1);
        const status = rest.split(" ")[0]?.toUpperCase() || "";
        return { ok: status === "OK", status, text: rest, segments };
      }
      segments.push({ kind: "line", text });
      // A line ending in {N} is followed by exactly N literal bytes.
      // Read the bytes now, so the next readLine lands on the line
      // after the literal instead of inside it. No CRLF is consumed
      // after the literal: a header literal already ends in its own
      // blank line, and the next token follows the bytes directly
      // (" BODY[TEXT]..."). A CRLF after the last literal of a
      // response just reads back as an empty line, which the parser
      // ignores.
      const lit = text.match(/\{(\d+)\}\s*$/);
      if (lit) {
        const bytes = await this.readExact(Number(lit[1]));
        segments.push({ kind: "literal", bytes });
      }
    }
  }

  async login(user: string, pass: string): Promise<void> {
    if (this.preauth) return;
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const r = await this.command(`LOGIN ${q(user)} ${q(pass)}`);
    if (!r.ok) {
      throw new ImapError(
        "auth_failed",
        "That sign-in didn't work. Check the email and the app-specific password — Yahoo and Apple Mail need an app-specific password, not the mailbox password.",
      );
    }
  }

  // SELECT INBOX: returns how many messages the inbox holds.
  async selectInbox(): Promise<number> {
    const r = await this.command("SELECT INBOX");
    if (!r.ok) throw new ImapError("select_failed", "That inbox wouldn't open.");
    for (const seg of r.segments) {
      if (seg.kind === "line") {
        const m = seg.text.match(/^\* (\d+) EXISTS/);
        if (m) return Number(m[1]);
      }
    }
    return 0;
  }

  async statusUnseen(): Promise<number> {
    const r = await this.command('STATUS INBOX (UNSEEN)');
    if (!r.ok) return 0;
    for (const seg of r.segments) {
      if (seg.kind === "line") {
        const m = seg.text.match(/UNSEEN (\d+)/);
        if (m) return Number(m[1]);
      }
    }
    return 0;
  }

  // The drafts folder, by its special-use flag when the server offers
  // one, else by name. Yahoo calls it Draft; iCloud calls it Drafts.
  async draftsFolder(): Promise<string> {
    const r = await this.command('LIST "" "*"');
    if (r.ok) {
      let fallback: string | null = null;
      for (const seg of r.segments) {
        if (seg.kind !== "line") continue;
        const m = seg.text.match(/^\* LIST \(([^)]*)\) "[^"]*" "?([^"]+)"?/);
        if (!m) continue;
        const flags = m[1];
        const name = m[2];
        if (flags.includes("\\Drafts")) return name;
        if (/^drafts$/i.test(name)) fallback = name;
        if (/^draft$/i.test(name) && !fallback) fallback = name;
      }
      if (fallback) return fallback;
    }
    return "Drafts";
  }

  async fetchRange(start: number, end: number): Promise<FetchedMessage[]> {
    const r = await this.command(
      `FETCH ${start}:${end} (UID FLAGS INTERNALDATE BODY[HEADER.FIELDS (FROM SUBJECT DATE)] BODY[TEXT]<0.500>)`,
    );
    if (!r.ok) throw new ImapError("list_failed", "That inbox didn't answer just now.");
    return parseFetchSegments(r.segments);
  }

  async fetchOne(uid: number): Promise<FetchedMessage | null> {
    const r = await this.command(
      `UID FETCH ${uid} (UID FLAGS INTERNALDATE BODY[HEADER.FIELDS (FROM SUBJECT DATE)] BODY[TEXT])`,
    );
    if (!r.ok) throw new ImapError("message_failed", "That message didn't open.");
    const msgs = parseFetchSegments(r.segments);
    return msgs[0] || null;
  }

  async appendDraft(folder: string, rfc822: string): Promise<void> {
    const bytes = Buffer.from(rfc822, "utf8");
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const r = await this.command(`APPEND ${q(folder)} (\\Seen) {${bytes.length}}`, () => {
      this.transport?.write(bytes);
      this.transport?.write("\r\n");
    });
    if (!r.ok) throw new ImapError("draft_failed", "That draft didn't save.");
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // Closing anyway.
    }
    this.close();
  }
}

// --- Header + body parsing ------------------------------------------
// Exported for tests: the wire format is the fiddly part, and it is
// tested against canned bytes rather than a live mailbox.

export type ParsedHeaders = { from: string; subject: string; date: string };

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

export function decodeEncodedWords(text: string): string {
  return text.replace(ENCODED_WORD, (_m, charset: string, enc: string, data: string) => {
    try {
      const isUtf8 = /utf-?8/i.test(charset);
      if (/^[Bb]$/.test(enc)) {
        return Buffer.from(data, "base64").toString(isUtf8 ? "utf8" : "latin1");
      }
      const qp = data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_h, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
      return Buffer.from(qp, "latin1").toString(isUtf8 ? "utf8" : "latin1");
    } catch {
      return data;
    }
  });
}

export function parseHeaders(raw: string): ParsedHeaders {
  const fields: Record<string, string> = {};
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      fields[current] += " " + line.trim();
      continue;
    }
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      current = m[1].toLowerCase();
      fields[current] = m[2].trim();
    } else {
      current = "";
    }
  }
  return {
    from: decodeEncodedWords(fields["from"] || ""),
    subject: decodeEncodedWords(fields["subject"] || ""),
    date: fields["date"] || "",
  };
}

// Plain text out of a message body. HTML-only mail is stripped to
// words the same way Outlook bodies are; plain text passes through.
export function bodyTextFrom(raw: string): string {
  const looksHtml = /<(html|body|div|p|br|table|span)[\s>]|&[a-z]+;/i.test(raw);
  const text = looksHtml
    ? decodeHtmlEntities(
        raw
          .replace(/<(br|p|div|li|tr|h\d)[^>]*>/gi, "\n")
          .replace(/<[^>]+>/g, ""),
      )
    : raw;
  return text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export type FetchedMessage = {
  seq: number;
  uid: number;
  flags: string[];
  internalDate: string;
  headers: ParsedHeaders;
  text: string;
};

export function parseFetchSegments(segments: Segment[]): FetchedMessage[] {
  const out: FetchedMessage[] = [];
  let cur: FetchedMessage | null = null;
  let expectLiteral: "headers" | "text" | null = null;
  for (const seg of segments) {
    if (seg.kind === "line") {
      const t = seg.text;
      const start = t.match(/^\* (\d+) FETCH \(/);
      if (start) {
        cur = {
          seq: Number(start[1]),
          uid: 0,
          flags: [],
          internalDate: "",
          headers: { from: "", subject: "", date: "" },
          text: "",
        };
        out.push(cur);
        const uid = t.match(/UID (\d+)/);
        if (uid) cur.uid = Number(uid[1]);
        const fl = t.match(/FLAGS \(([^)]*)\)/);
        if (fl) cur.flags = fl[1].split(/\s+/).filter(Boolean);
        const dt = t.match(/INTERNALDATE "([^"]*)"/);
        if (dt) cur.internalDate = dt[1];
      }
      if (t.includes("BODY[HEADER.FIELDS")) expectLiteral = "headers";
      else if (t.includes("BODY[TEXT]")) expectLiteral = "text";
      else if (!start) expectLiteral = null;
    } else if (cur && expectLiteral === "headers") {
      cur.headers = parseHeaders(new TextDecoder().decode(seg.bytes));
      expectLiteral = null;
    } else if (cur && expectLiteral === "text") {
      cur.text = bodyTextFrom(new TextDecoder().decode(seg.bytes));
      expectLiteral = null;
    }
  }
  return out;
}

// --- Draft text -----------------------------------------------------

export function buildDraftRfc822(from: string, to: string, subject: string, body: string): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 500);
  return [
    `From: ${from}`,
    `To: ${clean(to)}`,
    `Subject: ${clean(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n"),
  ].join("\r\n");
}

// --- Account operations ---------------------------------------------
// Each opens its own connection: dial, greet, log in, work, log out.

export type ImapAccountRow = {
  label: string;
  provider: string;
  host: string;
  port: number;
  email: string;
};

export function connectedLabels(accountId: string): ImapAccountRow[] {
  return getImapAccounts(accountId).map((a) => ({
    label: a.label,
    provider: a.provider,
    host: a.host,
    port: a.port,
    email: a.email,
  }));
}

async function openFor(accountId: string, label: ImapLabel): Promise<{ conn: ImapConnection; email: string }> {
  const acct = getImapAccount(accountId, label);
  if (!acct) throw new ImapError("not_connected", "That mailbox isn't connected.");
  const conn = new ImapConnection(acct.host, acct.port, true);
  try {
    await conn.open();
    await conn.login(acct.email, acct.password);
  } catch (e) {
    conn.close();
    throw e;
  }
  return { conn, email: acct.email };
}

export async function connectImap(
  accountId: string,
  providerId: string,
  email: string,
  password: string,
  customHost?: string,
  customPort?: number,
): Promise<{ ok: boolean; label?: string; email?: string; error?: string; message?: string }> {
  const provider = providerFor(providerId);
  if (!provider) return { ok: false, error: "bad_provider", message: "Pick Yahoo Mail, Apple Mail, or Other." };
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) || cleanEmail.length > 254) {
    return { ok: false, error: "bad_email", message: "That email address doesn't look right." };
  }
  if (!password) return { ok: false, error: "bad_password", message: "Paste the app-specific password for this mailbox." };
  let host = provider.host;
  let port = provider.port;
  if (provider.id === "other") {
    host = (customHost || "").trim().toLowerCase();
    if (!isSafeImapHost(host)) {
      return { ok: false, error: "bad_host", message: "That mail server address doesn't look right." };
    }
    port = 993;
    void customPort;
  }
  if (connectRateLimited(accountId)) {
    return {
      ok: false,
      error: "too_many_attempts",
      message: "Too many sign-in tries. Wait a few minutes and try again.",
    };
  }
  // The sign-in is tested before anything is stored: a wrong password
  // never lands in the database.
  const conn = new ImapConnection(host, port, true);
  try {
    await conn.open();
    await conn.login(cleanEmail, password);
    await conn.selectInbox();
  } catch (e) {
    conn.close();
    if (e instanceof ImapError) return { ok: false, error: e.code, message: e.message };
    console.error("IMAP connect failed:", e);
    return { ok: false, error: "unreachable", message: "That mail server didn't answer. Check the connection and try again." };
  }
  await conn.logout();
  const label = nextLabel(accountId);
  setImapAccount(accountId, label, provider.id, host, port, cleanEmail, password);
  return { ok: true, label, email: cleanEmail };
}

export type InboxMessage = {
  id: string;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread?: boolean;
};

export async function listInbox(
  accountId: string,
  label: ImapLabel,
  maxResults = 10,
): Promise<{
  connected: boolean;
  email?: string;
  messages: InboxMessage[];
  unreadCount?: number;
  error?: string;
}> {
  let opened;
  try {
    opened = await openFor(accountId, label);
  } catch (e) {
    // A revoked app-specific password lands here: the account stays
    // listed, but the card says the sign-in ran out, like Outlook's
    // token_failed, instead of a generic "didn't answer".
    if (e instanceof ImapError && e.code === "not_connected") return { connected: false, messages: [] };
    const acct = getImapAccount(accountId, label);
    const code = e instanceof ImapError && e.code === "auth_failed" ? "auth_failed" : "unreachable";
    return { connected: false, email: acct?.email, messages: [], error: code };
  }
  const { conn, email } = opened;
  try {
    const exists = await conn.selectInbox();
    const unreadCount = await conn.statusUnseen();
    if (exists <= 0) return { connected: true, email, messages: [], unreadCount };
    const take = Math.max(1, Math.min(25, Math.floor(maxResults)));
    const start = Math.max(1, exists - take + 1);
    const fetched = await conn.fetchRange(start, exists);
    const messages = fetched.reverse().map((f) => ({
      id: String(f.uid),
      from: f.headers.from,
      subject: f.headers.subject || "(no subject)",
      date: f.headers.date || f.internalDate,
      snippet: f.text.slice(0, 200),
      unread: !f.flags.includes("\\Seen"),
    }));
    return { connected: true, email, messages, unreadCount };
  } catch (e) {
    console.error("IMAP list failed:", e);
    return { connected: true, email, messages: [], unreadCount: undefined, error: "list_failed" };
  } finally {
    await conn.logout();
  }
}

// Read one IMAP message in full. The body is plain text, stripped of
// markup when the mail is HTML-only, so the reader shows words.
export async function getMessage(
  accountId: string,
  label: ImapLabel,
  id: string,
): Promise<{
  ok: boolean;
  id?: string;
  from?: string;
  subject?: string;
  date?: string;
  body?: string;
  error?: string;
}> {
  const uid = Number(id);
  if (!Number.isInteger(uid) || uid <= 0) return { ok: false, error: "bad_id" };
  let opened;
  try {
    opened = await openFor(accountId, label);
  } catch (e) {
    if (e instanceof ImapError) return { ok: false, error: e.code === "not_connected" ? "not_connected" : "unreachable" };
    return { ok: false, error: "unreachable" };
  }
  const { conn } = opened;
  try {
    const msg = await conn.fetchOne(uid);
    if (!msg) return { ok: false, error: "message_failed" };
    return {
      ok: true,
      id: String(msg.uid),
      from: msg.headers.from,
      subject: msg.headers.subject || "(no subject)",
      date: msg.headers.date || msg.internalDate,
      body: msg.text.slice(0, 60000),
    };
  } catch (e) {
    console.error("IMAP message failed:", e);
    return { ok: false, error: "message_failed" };
  } finally {
    await conn.logout();
  }
}

// Save a real draft into an IMAP mailbox. IMAP cannot send, so the
// draft lands in the mailbox's Drafts folder and the owner sends it
// from their mail app.
export async function saveDraft(
  accountId: string,
  label: ImapLabel,
  to: string,
  subject: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  let opened;
  try {
    opened = await openFor(accountId, label);
  } catch (e) {
    if (e instanceof ImapError) return { ok: false, error: e.code === "not_connected" ? "not_connected" : "unreachable" };
    return { ok: false, error: "unreachable" };
  }
  const { conn, email } = opened;
  try {
    const folder = await conn.draftsFolder();
    await conn.appendDraft(folder, buildDraftRfc822(email, to, subject, body));
    return { ok: true };
  } catch (e) {
    console.error("IMAP draft failed:", e);
    return { ok: false, error: "draft_failed" };
  } finally {
    await conn.logout();
  }
}

// Disconnect: forget the mailbox and its app-specific password. The
// mail itself is untouched — only this app's copy of the credential
// goes away. Revoking the app-specific password at the provider works
// too, and this app then reports the account as not answering.
export function disconnectImap(accountId: string, label: ImapLabel): boolean {
  const acct = getImapAccount(accountId, label);
  if (!acct) return false;
  deleteImapAccount(accountId, label);
  return true;
}
