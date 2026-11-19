// Newsletter list tests.
//
// DATA_DIR points at a throwaway tmpdir BEFORE any server module is
// imported (config reads it at module load), so these tests never touch
// the real app database. globalThis.fetch is mocked to match the real
// Gmail flow in src/server/gmail.ts: freshAccessToken refreshes a stale
// token via oauth2.googleapis.com/token, then sendEmail POSTs the MIME
// message to gmail/v1/users/me/messages/send.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeAll } from "bun:test";

const dataDir = mkdtempSync(join(tmpdir(), "prism-newsletter-test-"));
process.env.DATA_DIR = dataDir;
process.env.OWNER_EMAILS = "owner@example.com";
process.env.APP_URL = "https://prism.example.com";

const newsletter = await import("../src/server/newsletter");
const dbMod = await import("../src/server/db");
const { db, setGmailAccount } = dbMod;

const OWNER_ACCOUNT = "testacct-owner01";
const OTHER_ACCOUNT = "testacct-user01";

function decodeRaw(raw: string): string {
  const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

// Every Gmail send the mock sees, as the raw base64url MIME body.
const sentBodies: string[] = [];
let tokenRefreshes = 0;

globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u === "https://oauth2.googleapis.com/token") {
    tokenRefreshes += 1;
    return new Response(
      JSON.stringify({ access_token: "fresh-token", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (u === "https://gmail.googleapis.com/gmail/v1/users/me/messages/send") {
    const payload = JSON.parse(String(init?.body || "{}"));
    sentBodies.push(String(payload.raw || ""));
    return new Response(JSON.stringify({ id: "msg-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(`not mocked: ${u}`, { status: 500 });
}) as typeof fetch;

function seedIdentity(accountId: string, sub: string, email: string): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT OR IGNORE INTO google_identities
       (google_sub, account_id, email, name, refresh_token, created_at, last_signin_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  ).run(sub, accountId, email, null, now, now);
}

beforeAll(() => {
  // Owner signed in with Google; a second, non-owner account too.
  // No Gmail connected yet — the first drain test needs that state.
  seedIdentity(OWNER_ACCOUNT, "sub-owner-1", "owner@example.com");
  seedIdentity(OTHER_ACCOUNT, "sub-user-1", "reader@example.com");
});

describe("subscribeNewsletter", () => {
  test("subscribes, lowercases, and dedupes", () => {
    const first = newsletter.subscribeNewsletter("Reader@Example.com", "Reader", "google-signin");
    expect(first.email).toBe("reader@example.com");
    expect(first.name).toBe("Reader");
    expect(first.unsubscribeToken.length).toBeGreaterThan(10);
    expect(first.unsubscribedAt).toBeNull();
    expect(first.welcomeSentAt).toBeNull();

    const again = newsletter.subscribeNewsletter("reader@example.com", "Reader", "google-signin");
    expect(again.email).toBe("reader@example.com");
    expect(again.unsubscribeToken).toBe(first.unsubscribeToken);
    expect(newsletter.listSubscribers().filter((s) => s.email === "reader@example.com")).toHaveLength(1);
  });

  test("unsubscribe token round-trip, then re-subscribe", () => {
    const sub = newsletter.subscribeNewsletter("roundtrip@example.com", null, "google-signin");
    expect(newsletter.unsubscribeNewsletter(sub.unsubscribeToken)).toBe(true);
    const gone = newsletter.listSubscribers().find((s) => s.email === "roundtrip@example.com")!;
    expect(gone.unsubscribedAt).not.toBeNull();
    // A bogus token marks nothing.
    expect(newsletter.unsubscribeNewsletter("no-such-token")).toBe(false);
    // Re-subscribing clears the mark and keeps the same token.
    const back = newsletter.subscribeNewsletter("roundtrip@example.com", null, "google-signin");
    expect(back.unsubscribedAt).toBeNull();
    expect(back.unsubscribeToken).toBe(sub.unsubscribeToken);
  });
});

describe("sendPendingNewsletterWelcomes", () => {
  function pendingRows() {
    return newsletter
      .listSubscribers()
      .filter((s) => !s.welcomeSentAt && !s.unsubscribedAt);
  }

  test("no Gmail connected leaves the row pending", async () => {
    newsletter.subscribeNewsletter("pending@example.com", "Pending", "google-signin");
    const before = pendingRows().length;
    expect(before).toBeGreaterThan(0);
    const r = await newsletter.sendPendingNewsletterWelcomes();
    expect(r.sent).toBe(0);
    expect(r.pending).toBe(before);
    expect(r.error).toBe("no_gmail_connected");
    const row = newsletter.listSubscribers().find((s) => s.email === "pending@example.com")!;
    expect(row.welcomeSentAt).toBeNull();
    expect(sentBodies).toHaveLength(0);
  });

  test("no owner account leaves the row pending", async () => {
    db.query(`DELETE FROM google_identities WHERE account_id = ?`).run(OWNER_ACCOUNT);
    newsletter.subscribeNewsletter("orphan@example.com", null, "google-signin");
    const before = pendingRows().length;
    const r = await newsletter.sendPendingNewsletterWelcomes();
    expect(r.sent).toBe(0);
    expect(r.pending).toBe(before);
    expect(r.error).toBe("no_owner_account");
    expect(sentBodies).toHaveLength(0);
    // Put the owner back for the tests below.
    seedIdentity(OWNER_ACCOUNT, "sub-owner-1", "owner@example.com");
  });

  test("pending drain sends the ack and marks welcome_sent_at", async () => {
    // Stale token on purpose: the drain must refresh it first, then send.
    setGmailAccount(OWNER_ACCOUNT, "personal", "owner@example.com", "refresh-token", "stale-token", 0);
    const beforeRows = pendingRows();
    expect(beforeRows.length).toBeGreaterThan(0);
    const beforeSent = sentBodies.length;
    const r = await newsletter.sendPendingNewsletterWelcomes();
    expect(r.error).toBeUndefined();
    expect(r.sent).toBe(beforeRows.length);
    expect(r.pending).toBe(0);
    expect(tokenRefreshes).toBeGreaterThan(0);
    expect(sentBodies.length - beforeSent).toBe(beforeRows.length);

    for (const row of beforeRows) {
      const after = newsletter.listSubscribers().find((s) => s.email === row.email)!;
      expect(after.welcomeSentAt).not.toBeNull();
    }
    const bodies = sentBodies.slice(beforeSent).map(decodeRaw);
    const joined = bodies.join("\n");
    expect(joined).toContain("Subject: You're on the Prism newsletter — welcome");
    expect(joined).toContain("exclusive rotating offers of merch and more");
    expect(joined).toContain("WELCOME15");
    expect(joined).toContain("https://prism.example.com/api/newsletter/unsubscribe?token=");
    // Each body carries its own subscriber's token in the link.
    for (const row of beforeRows) {
      expect(joined).toContain(`token=${row.unsubscribeToken}`);
    }
  });

  test("a second drain sends nothing", async () => {
    const before = sentBodies.length;
    const r = await newsletter.sendPendingNewsletterWelcomes();
    expect(r.sent).toBe(0);
    expect(r.pending).toBe(0);
    expect(sentBodies.length).toBe(before);
  });

  test("an unsubscribed row never gets the welcome", async () => {
    const sub = newsletter.subscribeNewsletter("leaving@example.com", null, "google-signin");
    newsletter.unsubscribeNewsletter(sub.unsubscribeToken);
    const before = sentBodies.length;
    const r = await newsletter.sendPendingNewsletterWelcomes();
    expect(r.sent).toBe(0);
    expect(r.pending).toBe(0);
    expect(sentBodies.length).toBe(before);
  });
});

describe("owner gate", () => {
  test("ownerAccountId finds the owner, isOwnerAccount gates the rest", () => {
    expect(newsletter.ownerAccountId()).toBe(OWNER_ACCOUNT);
    expect(newsletter.isOwnerAccount(OWNER_ACCOUNT)).toBe(true);
    expect(newsletter.isOwnerAccount(OTHER_ACCOUNT)).toBe(false);
    expect(newsletter.isOwnerAccount("testacct-nobody1")).toBe(false);
  });
});

describe("scheduler", () => {
  test("double-start is guarded, stop works", () => {
    newsletter.startNewsletterScheduler();
    newsletter.startNewsletterScheduler();
    expect(newsletter.newsletterSchedulerRunning()).toBe(true);
    newsletter.stopNewsletterScheduler();
    expect(newsletter.newsletterSchedulerRunning()).toBe(false);
  });
});
