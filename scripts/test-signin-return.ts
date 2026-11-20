// Sign-in return routing test: after Google, the owner must land back
// in the installed app, not stranded in a browser tab. The OAuth
// callback always lands on the single registered redirect URI, so the
// sign-in records the origin it started from, and the callback routes
// the owner through /oauth-return on that origin — a page with one tap
// that opens the app, because only a user-gesture tap (not a redirect)
// is routed by Android to the installed app window. The Google consent
// click itself needs a browser and a Google account, so the live success
// path (tap opens the app, token spent) is verified by hand; this tests
// everything around it: the start records the origin, the callback
// routes through /oauth-return on that origin, the fallback without a
// recorded start keeps the old direct redirect, the return page carries
// the session in its tap link, and the Gmail / Calendar-Drive callback
// branches are untouched.
//
// Run: DATA_DIR=/tmp/prism-return-test GOOGLE_CLIENT_ID=x
//   GOOGLE_CLIENT_SECRET=<redacted>
//   GOOGLE_REDIRECT_URI=http://localhost:3113/api/oauth/google/callback
//   bun scripts/test-signin-return.ts

import { spawn, type ChildProcess } from "node:child_process";

const ROOT = import.meta.dir + "/..";
const PORT = 3113;
const BASE = `http://localhost:${PORT}`;
const REDIRECT_URI = `http://localhost:${PORT}/api/oauth/google/callback`;

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

const server: ChildProcess = spawn("bun", ["src/server.ts"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: "ignore",
});

const acct = "acc_returnTest0123456789ab";
const acctNoStart = "acc_returnNoStart0123456789";

try {
  if (!(await waitForHealth())) throw new Error("test server did not come up");

  // --- HTTP: start-signin records the origin, still redirects to Google ---
  console.log("start-signin");
  const startRes = await fetch(`${BASE}/api/oauth/google/start-signin?accountId=${acct}`, {
    redirect: "manual",
  });
  const loc = startRes.headers.get("location") || "";
  check("start-signin redirects (302)", startRes.status === 302, `got ${startRes.status}`);
  check("start-signin points at Google", loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
  const locUrl = new URL(loc);
  check(
    "start-signin reuses the registered redirect URI",
    locUrl.searchParams.get("redirect_uri") === REDIRECT_URI,
    locUrl.searchParams.get("redirect_uri") || "",
  );
  check(
    "start-signin state ends :signin",
    (locUrl.searchParams.get("state") || "").endsWith(":signin"),
    locUrl.searchParams.get("state") || "",
  );

  // --- HTTP: callback with a recorded start routes via /oauth-return ---
  console.log("callback routing");
  const cbReturn = await fetch(
    `${BASE}/api/oauth/google/callback?code=fake-code&state=${acct}%3Asignin`,
    { redirect: "manual" },
  );
  const cbReturnLoc = cbReturn.headers.get("location") || "";
  check(
    "signin callback with a recorded start routes to /oauth-return on that origin",
    cbReturn.status === 302 && cbReturnLoc === `${BASE}/oauth-return?status=error`,
    `${cbReturn.status} ${cbReturnLoc}`,
  );

  // The start is spent on first read: a second callback falls back.
  const cbSecond = await fetch(
    `${BASE}/api/oauth/google/callback?code=fake-code&state=${acct}%3Asignin`,
    { redirect: "manual" },
  );
  const cbSecondLoc = cbSecond.headers.get("location") || "";
  check(
    "second callback falls back to the direct redirect (start spent)",
    cbSecond.status === 302 && cbSecondLoc.endsWith("/?tab=you&signin=error"),
    `${cbSecond.status} ${cbSecondLoc}`,
  );

  // No start recorded at all: the old direct redirect, unchanged.
  const cbNoStart = await fetch(
    `${BASE}/api/oauth/google/callback?code=fake-code&state=${acctNoStart}%3Asignin`,
    { redirect: "manual" },
  );
  const cbNoStartLoc = cbNoStart.headers.get("location") || "";
  check(
    "signin callback without a recorded start keeps the direct redirect",
    cbNoStart.status === 302 && cbNoStartLoc.endsWith("/?tab=you&signin=error"),
    `${cbNoStart.status} ${cbNoStartLoc}`,
  );

  // --- HTTP: the other callback branches are untouched ---
  const cbGmail = await fetch(
    `${BASE}/api/oauth/google/callback?code=fake-code&state=${acct}%3Apersonal`,
    { redirect: "manual" },
  );
  const cbGmailLoc = cbGmail.headers.get("location") || "";
  check(
    "Gmail label state still reaches the Gmail handler",
    cbGmail.status === 302 && cbGmailLoc.includes("tab=connected&gmail=error"),
    `${cbGmail.status} ${cbGmailLoc}`,
  );

  const cbExtra = await fetch(
    `${BASE}/api/oauth/google/callback?code=fake-code&state=${acct}%3Acalendar-drive`,
    { redirect: "manual" },
  );
  const cbExtraLoc = cbExtra.headers.get("location") || "";
  check(
    "calendar-drive state still reaches the extra handler",
    cbExtra.status === 302 && cbExtraLoc.includes("tab=inboxes&google=error"),
    `${cbExtra.status} ${cbExtraLoc}`,
  );

  // --- HTTP: the return page itself ---
  console.log("return page");
  const pageErr = await fetch(`${BASE}/oauth-return?status=error`);
  const pageErrText = await pageErr.text();
  check("return page (error) serves 200 HTML", pageErr.status === 200 && pageErrText.includes("<!doctype html>"), `${pageErr.status}`);
  check(
    "return page (error) offers a retry link to the app",
    pageErrText.includes('href="/?tab=you"') && pageErrText.includes("Try again"),
  );
  check("return page (error) carries no session", !pageErrText.includes("session="));

  const pageOk = await fetch(`${BASE}/oauth-return?status=ok&session=tok-abc123`);
  const pageOkText = await pageOk.text();
  check("return page (ok) serves 200 HTML", pageOk.status === 200 && pageOkText.includes("<!doctype html>"), `${pageOk.status}`);
  check(
    "return page (ok) tap link carries the session token",
    pageOkText.includes('href="/?tab=you&amp;signin=ok&amp;session=tok-abc123"') ||
      pageOkText.includes('href="/?tab=you&signin=ok&session=tok-abc123"'),
  );
  check(
    "return page (ok) auto-continues when already in the standalone app",
    pageOkText.includes("display-mode: standalone"),
  );
  check(
    "return page (ok) tells the owner the home-screen icon works too",
    pageOkText.includes("home screen"),
  );

  const pageNoSession = await fetch(`${BASE}/oauth-return?status=ok`);
  const pageNoSessionText = await pageNoSession.text();
  check(
    "return page (ok, no session) falls back to the error copy",
    pageNoSessionText.includes("Sign-in didn't finish") && pageNoSessionText.includes("Try again"),
  );
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
}

// --- Functions: start-origin helpers round-trip ---
console.log("start-origin helpers");
const { recordSigninStart, takeSigninStart } = await import("../src/server/auth");
recordSigninStart("helper-acct-1", "https://app.example.test");
check(
  "takeSigninStart returns the recorded origin",
  takeSigninStart("helper-acct-1") === "https://app.example.test",
);
check("takeSigninStart spends on first read", takeSigninStart("helper-acct-1") === null);
check("takeSigninStart returns null with nothing recorded", takeSigninStart("helper-acct-2") === null);
recordSigninStart("helper-acct-3", "not a url");
check("recordSigninStart refuses a malformed origin", takeSigninStart("helper-acct-3") === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
