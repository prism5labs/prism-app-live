// Calendar + Drive connect routing test: the ":calendar-drive" state
// must reach the extra handler through the Gmail callback, because
// authUrlExtra reuses the single registered Gmail redirect URI.
// The Google consent click itself needs a browser and a Google account,
// so the live success path (google=connected) is verified by hand; this
// tests everything around it: the start-extra URL, the callback routing
// for all three states (calendar-drive / Gmail label / signin), and the
// extra handler's success path with a stubbed Google.
//
// Run: DATA_DIR=/tmp/prism-extra-test GOOGLE_CLIENT_ID=x
//   GOOGLE_CLIENT_SECRET=<redacted>
//   GOOGLE_REDIRECT_URI=http://localhost:3112/api/oauth/google/callback
//   bun scripts/test-google-extra-callback.ts

import { spawn, type ChildProcess } from "node:child_process";

const ROOT = import.meta.dir + "/..";
const PORT = 3112;
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

const acct = "acc_extraTest0123456789ab";

try {
  if (!(await waitForHealth())) throw new Error("test server did not come up");

  // --- HTTP: start-extra URL ---
  console.log("start-extra");
  const startRes = await fetch(`${BASE}/api/oauth/google/start-extra?accountId=${acct}`, {
    redirect: "manual",
  });
  const loc = startRes.headers.get("location") || "";
  check("start-extra redirects (302)", startRes.status === 302, `got ${startRes.status}`);
  check("start-extra points at Google", loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
  const locUrl = new URL(loc);
  check(
    "start-extra reuses the Gmail redirect URI",
    locUrl.searchParams.get("redirect_uri") === REDIRECT_URI,
    locUrl.searchParams.get("redirect_uri") || "",
  );
  check(
    "start-extra state ends :calendar-drive",
    (locUrl.searchParams.get("state") || "").endsWith(":calendar-drive"),
    locUrl.searchParams.get("state") || "",
  );
  const scope = locUrl.searchParams.get("scope") || "";
  check(
    "start-extra asks for calendar and Drive scopes",
    scope.includes("calendar") && scope.includes("drive"),
    scope,
  );

  // --- HTTP: callback routing, fake code (real Google rejects it) ---
  console.log("callback routing");
  const cbExtra = await fetch(
    `${BASE}/api/oauth/google/callback?code=fake-code&state=${acct}%3Acalendar-drive`,
    { redirect: "manual" },
  );
  const cbExtraLoc = cbExtra.headers.get("location") || "";
  check(
    "calendar-drive state reaches the extra handler (google=error, not gmail=error)",
    cbExtra.status === 302 && cbExtraLoc.includes("tab=inboxes&google=error"),
    `${cbExtra.status} ${cbExtraLoc}`,
  );

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

  const cbSignin = await fetch(
    `${BASE}/api/oauth/google/callback?code=fake-code&state=${acct}%3Asignin`,
    { redirect: "manual" },
  );
  const cbSigninLoc = cbSignin.headers.get("location") || "";
  check(
    "signin state still reaches the sign-in handler",
    cbSignin.status === 302 && cbSigninLoc.includes("tab=you&signin=error"),
    `${cbSignin.status} ${cbSigninLoc}`,
  );

  // A failed extra callback stores nothing.
  const calStatus: any = await (await fetch(`${BASE}/api/calendar/status?accountId=${acct}`)).json();
  check("failed extra callback leaves Calendar unconnected", calStatus.connected === false);
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 500));
}

// --- Functions: extra handler success path with a stubbed Google ---
console.log("extra handler (stubbed Google)");
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = String(url);
  if (u === "https://oauth2.googleapis.com/token") {
    return new Response(
      JSON.stringify({
        access_token: "stub-access-token",
        refresh_token: "stub-refresh-token",
        expires_in: 3600,
        token_type: "Bearer",
        scope:
          "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/drive.readonly",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  if (u === "https://www.googleapis.com/oauth2/v2/userinfo") {
    return new Response(JSON.stringify({ email: "owner@example.com" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return realFetch(url, init);
}) as typeof fetch;

const { handleExtraOAuthCallback, calendarStatus, driveStatus } = await import(
  "../src/server/google"
);
const ok = await handleExtraOAuthCallback("stub-code", `${acct}:calendar-drive`);
check(
  "extra handler stores the token on a good code",
  ok.ok === true && ok.email === "owner@example.com",
  JSON.stringify(ok),
);
check("Calendar reads connected after the extra callback", calendarStatus(acct).connected === true);
check("Drive reads connected after the extra callback", driveStatus(acct).connected === true);
const bad = await handleExtraOAuthCallback("stub-code", `${acct}:personal`);
check("extra handler refuses a non-calendar-drive state", bad.ok === false && bad.error === "bad_state");

globalThis.fetch = realFetch;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
