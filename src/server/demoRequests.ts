// Website demo requests (Nov 23, 2026).
//
// The "Text me the demo" form on prism5labs.com used to compose a
// mailto: email in the visitor's own mail app. The request did not
// exist until the visitor pressed send in that app, and a visitor
// with no mail app set up never arrived at all — Neil hit exactly
// that testing the site himself. Now the form posts here instead.
//
// The request is stored (demo_requests in db.ts), and the business
// inbox gets the same email the mailto used to compose — same
// subject, same body — so the handling downstream does not change:
// the comms checks surface it, Neil approves the channel per the
// demo protocol, and the demo is texted by hand from the business
// number. This endpoint never texts anyone itself.
//
// The notification goes out through the business mailbox's own Gmail
// connection in this app, when one exists (the same send path the
// Switchboard uses). When no connection exists, or the send fails,
// the request is still stored and its row says notified = 0; the
// failure is logged, never hidden.

import {
  addDemoRequest,
  latestDemoRequest,
  markDemoRequestNotified,
  gmailConnectionForEmail,
} from "./db";
import { sendEmail } from "./gmail";

export const DEMO_INBOX = "prism5labscontact@gmail.com";

// The exact email the old mailto flow composed. Do not reword: the
// comms checks and Neil read this shape.
export function demoRequestEmail(phoneDisplay: string): {
  subject: string;
  body: string;
} {
  return {
    subject: "Demo request — text my demo",
    body: [
      "DEMO REQUEST — Prism 5 Labs",
      "",
      `Please text the demo to this number: ${phoneDisplay}`,
      "",
      "I understand texts from Prism 5 Labs include opt-out language (reply STOP to opt out, HELP for help) and that message & data rates may apply.",
    ].join("\n"),
  };
}

// US numbers only — the business texts US numbers. Accepts the shapes
// people actually type — (920) 555-0134, 920-555-0134, +1 920 555
// 0134, 9205550134 — and returns the E.164 form plus the display
// form the notification email carries, or null when the input is not
// a US number.
export function normalizeUsPhone(
  raw: string,
): { e164: string; display: string } | null {
  const digits = String(raw || "").replace(/\D/g, "");
  const ten =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  // NANP: the area code and the exchange cannot start with 0 or 1.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  return {
    e164: `+1${ten}`,
    display: `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`,
  };
}

// Rate limit, in-memory only: a redeploy resets it, which is fine
// for a limiter (the same call the Loremaster waitlist made). 5
// attempts per client address per 10 minutes; the harm in a flood
// is junk rows and junk email, and both stay capped.
const attempts = new Map<string, number[]>();

export function demoRequestRateLimited(key: string): boolean {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= 5) return true;
  list.push(now);
  attempts.set(key, list);
  return false;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Validate, store, and notify for one website demo request. A repeat
// of the same number within a day is the same request: it answers
// ok with already = true and writes no second row and no second
// email.
export async function recordDemoRequest(
  rawPhone: string,
): Promise<
  | { ok: true; already: boolean; display: string }
  | { ok: false; error: string }
> {
  const norm = normalizeUsPhone(rawPhone);
  if (!norm) return { ok: false, error: "invalid_phone" };
  const prior = latestDemoRequest(norm.e164);
  if (prior && Date.now() - Date.parse(prior.createdAt) < DAY_MS) {
    return { ok: true, already: true, display: prior.phoneDisplay };
  }
  const row = addDemoRequest(norm.e164, norm.display);
  const conn = gmailConnectionForEmail(DEMO_INBOX);
  if (!conn) {
    console.error(
      "demo request stored but NOT notified: no Gmail connection for",
      DEMO_INBOX,
    );
    return { ok: true, already: false, display: norm.display };
  }
  const mail = demoRequestEmail(norm.display);
  const sent = await sendEmail(
    conn.accountId,
    conn.label,
    DEMO_INBOX,
    mail.subject,
    mail.body,
  );
  if (sent.ok) {
    markDemoRequestNotified(row.id);
  } else {
    console.error(
      "demo request stored but notification send failed:",
      sent.error,
    );
  }
  return { ok: true, already: false, display: norm.display };
}
