// The Prism newsletter list.
//
// The landing promises that signing up with Google also signs the user
// up for the newsletter ("with exclusive rotating offers of merch and
// more"), but until now no subscriber store existed — the promise had
// nowhere to land. This module is that store: one row per subscriber,
// a token-based unsubscribe link (no sign-in needed to leave), and a
// welcome acknowledgement sent from the owner's connected Gmail.
//
// The website's "Stay in the loop" form is the second door into the
// same list (subscribeFromWebsite, source "website") — it replaced a
// mailto form that stored nothing and welcomed no one (Nov 26, 2026).
//
// Sending goes through the OWNER's Gmail (sendFromAny), never the
// subscriber's — the owner is the sender, the subscriber is the
// recipient. The welcome is only ever sent once per subscriber
// (welcome_sent_at), and only while they are still subscribed.
// A drain runs at startup and hourly after that, so a welcome that
// could not send yet (no Gmail connected, no owner signed in) stays
// pending and goes out on its own once the connection exists. Nothing
// here ever throws out of the drain: a failed send is logged and the
// row stays pending for the next cycle.

import { db, getGmailAccounts } from "./db";
import { config, isOwnerEmail } from "./config";
import { sendFromAny } from "./gmail";
import { PERK_CODE, PERK_DAYS } from "./auth";

// --- Table (created here, in this module, at import, like auth.ts) ---
db.exec(`
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  email TEXT PRIMARY KEY,
  name TEXT,
  source TEXT,
  subscribed_at TEXT NOT NULL,
  unsubscribed_at TEXT,
  unsubscribe_token TEXT NOT NULL,
  welcome_sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_newsletter_pending ON newsletter_subscribers (welcome_sent_at, unsubscribed_at);
`);

export const NEWSLETTER_WELCOME_SUBJECT = "You're on the Prism newsletter — welcome";

export type NewsletterSubscriber = {
  email: string;
  name: string | null;
  source: string | null;
  subscribedAt: string;
  unsubscribedAt: string | null;
  unsubscribeToken: string;
  welcomeSentAt: string | null;
};

function rowToSubscriber(row: any): NewsletterSubscriber {
  return {
    email: row.email,
    name: row.name ?? null,
    source: row.source ?? null,
    subscribedAt: row.subscribed_at,
    unsubscribedAt: row.unsubscribed_at ?? null,
    unsubscribeToken: row.unsubscribe_token,
    welcomeSentAt: row.welcome_sent_at ?? null,
  };
}

function getSubscriber(email: string): NewsletterSubscriber | null {
  const row = db
    .query(`SELECT * FROM newsletter_subscribers WHERE email = ?`)
    .get(email) as any;
  return row ? rowToSubscriber(row) : null;
}

// Subscribe an email. Lowercased and trimmed, so the same address can
// never land twice. A re-subscribe after an unsubscribe clears the
// unsubscribe mark and keeps the original token, so the old link keeps
// working. Returns the row, including its token.
export function subscribeNewsletter(
  email: string,
  name: string | null,
  source: string,
): NewsletterSubscriber {
  const clean = email.trim().toLowerCase();
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error("subscribeNewsletter: a valid email is required");
  }
  const now = new Date().toISOString();
  const token = crypto.randomUUID().replace(/-/g, "");
  db.query(
    `INSERT OR IGNORE INTO newsletter_subscribers
       (email, name, source, subscribed_at, unsubscribed_at, unsubscribe_token, welcome_sent_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
  ).run(clean, name, source, now, token);
  // Re-subscribe: an unsubscribed row comes back in, token unchanged.
  db.query(
    `UPDATE newsletter_subscribers SET unsubscribed_at = NULL
     WHERE email = ? AND unsubscribed_at IS NOT NULL`,
  ).run(clean);
  const row = getSubscriber(clean);
  if (!row) throw new Error("subscribeNewsletter: row missing after insert");
  return row;
}

// Whether this email is currently on the list — subscribed and not
// unsubscribed. The website signup answers "you're already on the
// list" from this instead of writing a second row or sending a
// second welcome.
export function isSubscribed(email: string): boolean {
  const row = getSubscriber(email.trim().toLowerCase());
  return !!row && row.unsubscribedAt === null;
}

// Subscribe from the website's "Stay in the loop" form (Nov 26,
// 2026). The form used to compose a mailto in the visitor's own mail
// app — nothing was stored, no list existed, and no welcome ever
// arrived. Now the form posts here and the address lands on this
// same list, source "website", and the welcome drain below sends
// the acknowledgement. A repeat signup is the same subscription:
// it answers already = true and writes no second row and no second
// welcome. A re-subscribe after an unsubscribe rejoins the list
// (subscribeNewsletter clears the mark; the welcome is not resent —
// welcome_sent_at still stands from the first time).
export function subscribeFromWebsite(
  rawEmail: string,
): { ok: true; already: boolean; email: string } | { ok: false; error: string } {
  const clean = String(rawEmail || "").trim().toLowerCase();
  if (!clean || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    return { ok: false, error: "invalid_email" };
  }
  if (isSubscribed(clean)) return { ok: true, already: true, email: clean };
  subscribeNewsletter(clean, null, "website");
  return { ok: true, already: false, email: clean };
}

// Rate limit for the website signup, in-memory only (the same call
// the demo-request limiter made): 5 attempts per client address per
// 10 minutes. The harm in a flood is junk rows and junk welcome
// mail, and both stay capped.
const signupAttempts = new Map<string, number[]>();

export function newsletterSignupRateLimited(key: string): boolean {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const list = (signupAttempts.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= 5) return true;
  list.push(now);
  signupAttempts.set(key, list);
  return false;
}

// Unsubscribe by token. Returns true when a row was marked, false when
// the token matches nothing (already gone, or never existed).
export function unsubscribeNewsletter(token: string): boolean {
  const now = new Date().toISOString();
  const info = db
    .query(
      `UPDATE newsletter_subscribers SET unsubscribed_at = ?
       WHERE unsubscribe_token = ? AND unsubscribed_at IS NULL`,
    )
    .run(now, token);
  return info.changes > 0;
}

// Every subscriber, newest first. The owner's list endpoint shapes
// these rows before they leave the server.
export function listSubscribers(): NewsletterSubscriber[] {
  const rows = db
    .query(`SELECT * FROM newsletter_subscribers ORDER BY subscribed_at DESC, email ASC`)
    .all() as any[];
  return rows.map(rowToSubscriber);
}

function pendingSubscribers(): NewsletterSubscriber[] {
  const rows = db
    .query(
      `SELECT * FROM newsletter_subscribers
       WHERE welcome_sent_at IS NULL AND unsubscribed_at IS NULL
       ORDER BY subscribed_at ASC`,
    )
    .all() as any[];
  return rows.map(rowToSubscriber);
}

// The owner's Prism account id: the account whose Google identity email
// is an owner email. Null until an owner has signed in with Google —
// the welcome mail has no sender before that, so the drain waits.
export function ownerAccountId(): string | null {
  const rows = db
    .query(`SELECT account_id, email FROM google_identities`)
    .all() as { account_id: string; email: string }[];
  for (const row of rows) {
    if (isOwnerEmail(row.email)) return row.account_id;
  }
  return null;
}

// True when this account id belongs to the owner (signed in with Google
// under an owner email). The subscribers endpoint gates on this.
export function isOwnerAccount(accountId: string): boolean {
  const row = db
    .query(`SELECT email FROM google_identities WHERE account_id = ?`)
    .get(accountId) as { email: string } | null;
  return !!row && isOwnerEmail(row.email);
}

// The welcome acknowledgement. Two shapes, by how the subscriber
// arrived:
//  - Google sign-in (the original list): grounded in the landing
//    copy — the newsletter brings exclusive rotating offers of merch
//    and more, and the thank-you is the same 15% off the first order
//    the landing promises on sign-up (code WELCOME15, the sign-in
//    perk, good for 10 days from sign-up).
//  - The website form (source "website"): the visitor never signed
//    in and holds no perk, so this shape promises only what the
//    site itself promises — one short email when something new is
//    ready, and the 14-day money-back promise everything carries.
// Sent from the owner's connected Gmail, plain text, with the
// unsubscribe link at the foot. On success the row is marked sent
// so it never goes twice.
export async function sendNewsletterWelcome(
  ownerId: string,
  sub: NewsletterSubscriber,
): Promise<{ ok: boolean; error?: string }> {
  const base = config.appUrl.replace(/\/$/, "");
  const unsubscribeUrl = `${base}/api/newsletter/unsubscribe?token=${encodeURIComponent(sub.unsubscribeToken)}`;
  const greeting = sub.name ? `Hi ${sub.name},` : "Hi,";
  const website = sub.source === "website";
  const body = [
    greeting,
    ``,
    `Welcome to the Prism newsletter — you're in.`,
    ``,
    ...(website
      ? [
          `You signed up on prism5labs.com, and this is what it brings: one short email when something new is ready — new assistants, new tales, and offers for subscribers. No noise, ever.`,
          ``,
          `Everything we make comes with a 14-day money-back promise: if it isn't right for you, tell us within 14 days and we will refund it. Plain and simple.`,
          ``,
        ]
      : [
          `Signing up with Google signed you up for the newsletter, and this is what it brings: exclusive rotating offers of merch and more, straight to your inbox.`,
          ``,
          `As a thank-you, here's 15% off your first order. Use code ${PERK_CODE} at checkout — it's good for ${PERK_DAYS} days from when you signed up.`,
          ``,
        ]),
    `If you'd rather not hear from us, you can unsubscribe any time:`,
    unsubscribeUrl,
    ``,
    `— Prism 5 Labs`,
  ].join("\n");
  const r = await sendFromAny(ownerId, sub.email, NEWSLETTER_WELCOME_SUBJECT, body);
  if (!r.ok) return { ok: false, error: r.error || "send_failed" };
  db.query(`UPDATE newsletter_subscribers SET welcome_sent_at = ? WHERE email = ?`).run(
    new Date().toISOString(),
    sub.email,
  );
  return { ok: true };
}

// Send the welcome to every subscriber still waiting for one. When
// there is no owner account yet, or the owner has no Gmail connected,
// nothing sends and the rows stay pending — the next cycle retries.
// Never throws: a failed cycle is logged and reported, not raised.
export async function sendPendingNewsletterWelcomes(): Promise<{
  sent: number;
  pending: number;
  error?: string;
}> {
  try {
    const ownerId = ownerAccountId();
    const pending = pendingSubscribers();
    if (!ownerId) {
      return { sent: 0, pending: pending.length, error: "no_owner_account" };
    }
    if (getGmailAccounts(ownerId).length === 0) {
      return { sent: 0, pending: pending.length, error: "no_gmail_connected" };
    }
    let sent = 0;
    for (const sub of pending) {
      try {
        const r = await sendNewsletterWelcome(ownerId, sub);
        if (r.ok) sent += 1;
        else console.error(`newsletter welcome failed for ${sub.email}:`, r.error);
      } catch (e) {
        // One subscriber's send must never stop the rest.
        console.error(`newsletter welcome failed for ${sub.email}:`, e);
      }
    }
    return { sent, pending: pendingSubscribers().length };
  } catch (e) {
    console.error("newsletter welcome drain failed:", e);
    let pending = 0;
    try {
      pending = pendingSubscribers().length;
    } catch {
      // The count itself failed; report the drain failure, not a count.
    }
    return { sent: 0, pending, error: "drain_failed" };
  }
}

// --- Scheduler ---
// One drain cycle at startup, then hourly. Follows the proactive
// scheduler pattern: guard against double-start, try/catch around each
// cycle so a failed drain never kills the timer.
const NEWSLETTER_INTERVAL_MS = 60 * 60 * 1000;
let newsletterTimer: ReturnType<typeof setInterval> | null = null;

export function startNewsletterScheduler(): void {
  if (newsletterTimer) return;
  sendPendingNewsletterWelcomes().catch((e) =>
    console.error("newsletter initial drain failed:", e),
  );
  newsletterTimer = setInterval(() => {
    sendPendingNewsletterWelcomes().catch((e) =>
      console.error("newsletter drain failed:", e),
    );
  }, NEWSLETTER_INTERVAL_MS);
  console.log("newsletter: scheduler started (hourly welcome drain)");
}

export function stopNewsletterScheduler(): void {
  if (newsletterTimer) {
    clearInterval(newsletterTimer);
    newsletterTimer = null;
    console.log("newsletter: scheduler stopped");
  }
}

export function newsletterSchedulerRunning(): boolean {
  return newsletterTimer !== null;
}
