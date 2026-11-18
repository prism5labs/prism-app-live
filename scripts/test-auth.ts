// Google sign-in tests: the full account flow without a real Google
// login. The OAuth consent click itself needs a browser and a Google
// account, so it is tested live by hand; everything around it is
// tested here: the sign-in URL, the error path against real Google, the
// link/migrate/perk/backstory/session logic, and the client render.
//
// Run: DATA_DIR=/tmp/prism-auth-test GOOGLE_CLIENT_ID=x
//   GOOGLE_CLIENT_SECRET=y OWNER_EMAILS=prism5labscontact@gmail.com,aode1282@gmail.com
//   GOOGLE_REDIRECT_URI=http://localhost:3111/api/oauth/google/callback
//   bun scripts/test-auth.ts
// The server boots on :3111 with the same DATA_DIR; the function tests
// below share that database with it.

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const ROOT = join(import.meta.dir, "..");
const PORT = 3111;
const BASE = `http://localhost:${PORT}`;

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

try {
  if (!(await waitForHealth())) throw new Error("test server did not come up");

  // --- HTTP: unsigned account ---
  console.log("HTTP");
  const deviceA = "acc_deviceA0123456789ab";
  const deviceB = "acc_deviceB0123456789cd";
  const st1: any = await (await fetch(`${BASE}/api/auth/status?accountId=${deviceA}`)).json();
  check("auth status: unsigned account is not signed in", st1.ok === true && st1.signedIn === false);

  // --- HTTP: sign-in URL ---
  const startRes = await fetch(`${BASE}/api/oauth/google/start-signin?accountId=${deviceA}`, {
    redirect: "manual",
  });
  const loc = startRes.headers.get("location") || "";
  check("start-signin redirects (302)", startRes.status === 302, `got ${startRes.status}`);
  check("start-signin points at Google", loc.startsWith("https://accounts.google.com/o/oauth2/v2/auth"));
  const locUrl = new URL(loc);
  check(
    "start-signin uses the Gmail redirect URI",
    locUrl.searchParams.get("redirect_uri") === "http://localhost:3111/api/oauth/google/callback",
    locUrl.searchParams.get("redirect_uri") || "",
  );
  const scope = locUrl.searchParams.get("scope") || "";
  check(
    "start-signin asks only for identity scopes",
    scope.split(" ").sort().join(" ") === "email openid profile",
    scope,
  );
  check(
    "start-signin state names the device account",
    locUrl.searchParams.get("state") === `${deviceA}:signin`,
  );
  check("start-signin asks offline access", locUrl.searchParams.get("access_type") === "offline");

  // --- HTTP: callback with a fake code fails honestly (real Google) ---
  const cbRes = await fetch(
    `${BASE}/api/oauth/google/callback?code=fake-code&state=${deviceA}%3Asignin`,
    { redirect: "manual" },
  );
  check(
    "callback with a fake code redirects to the error page",
    cbRes.status === 302 &&
      (cbRes.headers.get("location") || "").includes("tab=upkeep&signin=error"),
    `${cbRes.status} ${(cbRes.headers.get("location") || "")}`,
  );

  // --- HTTP: bad session token ---
  const badSession: any = await (
    await fetch(`${BASE}/api/auth/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "nope-not-a-token" }),
    })
  ).json();
  check("bad session token is refused", badSession.ok === false && badSession.error === "bad_session");

  // --- Functions: link a new Google identity ---
  console.log("Link + perks + backstories");
  const { linkGoogleIdentity, authStatus, getPerk, getBackstories, createSigninSession, exchangeSigninSession, markPerkUsed } =
    await import("../src/server/auth");
  const { getOrCreateAccount, setCustomName, setUpkeep, ownPhoton, addMessage, setGmailAccount, getOwned, getThread, getGmailAccounts } =
    await import("../src/server/db");
  const { db } = await import("../src/server/db");

  const linked = linkGoogleIdentity(deviceA, { sub: "google-sub-1", email: "test@example.com", name: "Test Person" }, null);
  check("first link keeps the device account id", linked.accountId === deviceA && linked.isNew === true);
  const auth1 = authStatus(deviceA);
  check(
    "auth status after link: signed in with email and name",
    auth1.signedIn === true && auth1.email === "test@example.com" && auth1.name === "Test Person",
  );
  const perk1 = getPerk(deviceA);
  check("welcome perk created at sign-in", perk1 !== null && perk1.code === "WELCOME15" && perk1.percent === 15);
  const daysOut = perk1 ? (Date.parse(perk1.expiresAt) - Date.parse(perk1.createdAt)) / 86400000 : 0;
  check("welcome perk lasts 10 days", Math.abs(daysOut - 10) < 0.001, `got ${daysOut}`);
  check("welcome perk starts active", perk1?.active === true);
  check("non-owner sign-in does not grant Upkeep", getOrCreateAccount(deviceA).upkeep === false);
  const stories = getBackstories(deviceA, "Test Person", getOrCreateAccount(deviceA).created_at);
  check("backstories exist for all 12 Photons", Object.keys(stories).length === 12, `got ${Object.keys(stories).length}`);
  check(
    "Prism backstory is personalised with the owner's name",
    (stories.Prism || "").includes("Test Person") && !(stories.Prism || "").includes("{owner}"),
  );
  check(
    "backstory carries the meeting date, no placeholder left",
    !(stories.Prism || "").includes("{date}") && /\w+ \d{1,2}, \d{4}/.test(stories.Prism || ""),
  );

  // --- Functions: migration (second device, same Google account) ---
  console.log("Migration");
  getOrCreateAccount(deviceB);
  setCustomName(deviceB, "Helper");
  ownPhoton(deviceB, "Prism");
  addMessage(deviceB, "Prism", "user", "hello from device B");
  setGmailAccount(deviceB, "personal", "b@example.com", "refresh-b", null, null);
  const linked2 = linkGoogleIdentity(deviceB, { sub: "google-sub-1", email: "test@example.com", name: "Test Person" }, null);
  check("second device links to the same account", linked2.accountId === deviceA && linked2.isNew === false);
  check("migration moved rows", linked2.migrated > 0, `moved ${linked2.migrated}`);
  check("migrated Photon ownership lands on the account", getOwned(deviceA).photons.includes("Prism"));
  check(
    "migrated thread lands on the account",
    getThread(deviceA, "Prism").some((m) => m.content === "hello from device B"),
  );
  check(
    "migrated Gmail connection lands on the account",
    getGmailAccounts(deviceA).some((g) => g.email === "b@example.com"),
  );
  check(
    "custom name fills in when the account had none",
    getOrCreateAccount(deviceA).custom_name === "Helper",
  );
  const gone = db.query(`SELECT COUNT(*) AS n FROM accounts WHERE id = ?`).get(deviceB) as { n: number };
  check("old device account row is gone after migration", gone.n === 0);

  // --- Owner Upkeep grant: an owner signing in gets Upkeep free ---
  console.log("Owner Upkeep grant");
  const deviceD = "acc_deviceD0123456789gh";
  const linkedOwner = linkGoogleIdentity(deviceD, { sub: "google-sub-owner-1", email: "prism5labscontact@gmail.com", name: "Owner" }, null);
  check("owner sign-in is a new link", linkedOwner.isNew === true && linkedOwner.accountId === deviceD);
  check("owner sign-in grants Upkeep", getOrCreateAccount(deviceD).upkeep === true);
  // Re-sign-in re-grants: take Upkeep away by hand, link again.
  setUpkeep(deviceD, false);
  check("Upkeep taken away by hand reads off", getOrCreateAccount(deviceD).upkeep === false);
  linkGoogleIdentity(deviceD, { sub: "google-sub-owner-1", email: "prism5labscontact@gmail.com", name: "Owner" }, null);
  check("owner re-sign-in re-grants Upkeep", getOrCreateAccount(deviceD).upkeep === true);
  // Case-insensitive match, and the second owner email.
  const deviceE = "acc_deviceE0123456789ij";
  linkGoogleIdentity(deviceE, { sub: "google-sub-owner-2", email: "Prism5LabsContact@Gmail.com", name: "Owner Case" }, null);
  check("owner email matches case-insensitively", getOrCreateAccount(deviceE).upkeep === true);
  const deviceF = "acc_deviceF0123456789kl";
  linkGoogleIdentity(deviceF, { sub: "google-sub-owner-3", email: "aode1282@gmail.com", name: "Owner Personal" }, null);
  check("second owner email grants Upkeep", getOrCreateAccount(deviceF).upkeep === true);

  // --- Functions: sessions ---
  console.log("Sessions");
  const token = createSigninSession(deviceA, true);
  const spent = exchangeSigninSession(token);
  check("session spends once for the account", spent?.accountId === deviceA && spent?.isNew === true);
  check("session cannot be spent twice", exchangeSigninSession(token) === null);
  const token2 = createSigninSession(deviceA, false);
  db.query(`UPDATE signin_sessions SET expires_at = ? WHERE token = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    token2,
  );
  check("expired session is refused", exchangeSigninSession(token2) === null);

  // --- Functions: perk use + expiry ---
  console.log("Perk use");
  check("perk spends once", markPerkUsed(deviceA, "cs_test123") === true);
  check("perk cannot be spent twice", markPerkUsed(deviceA, "cs_test456") === false);
  const perkUsed = getPerk(deviceA);
  check("used perk is no longer active", perkUsed?.active === false && perkUsed?.usedAt !== null);
  // A second account's perk, expired by hand, reads inactive.
  const deviceC = "acc_deviceC0123456789ef";
  linkGoogleIdentity(deviceC, { sub: "google-sub-2", email: "c@example.com", name: "Casey" }, null);
  db.query(`UPDATE account_perks SET expires_at = ? WHERE account_id = ?`).run(
    new Date(Date.now() - 1000).toISOString(),
    deviceC,
  );
  check("expired perk reads inactive", getPerk(deviceC)?.active === false);

  // --- HTTP: state carries auth, perk, backstories ---
  console.log("State");
  const stA: any = await (await fetch(`${BASE}/api/state?accountId=${deviceA}`)).json();
  check("state says signed in", stA.auth?.signedIn === true && stA.auth?.email === "test@example.com");
  check("state carries the used perk", stA.perk?.code === "WELCOME15" && stA.perk?.active === false);
  check("state carries 12 backstories", Object.keys(stA.backstories || {}).length === 12);
} finally {
  server.kill();
}

// --- Client render (jsdom): signed-in Upkeep + Store with the perk ---
console.log("Client render");
{
  const html = readFileSync(join(ROOT, "public", "index.html"), "utf8");
  const js = readFileSync(join(ROOT, "public", "main.js"), "utf8");
  const signedInState = {
    ok: true,
    accountId: "acc_deviceA0123456789ab",
    displayName: "Prism 5",
    customName: null,
    ownedPhotons: ["Prism"],
    ownedProducts: [],
    meter: { used: 0, limit: 300, unlimited: false },
    upkeep: false,
    freeCode: false,
    brain: true,
    googleConfigured: true,
    microsoftConfigured: false,
    auth: { signedIn: true, email: "test@example.com", name: "Test Person", since: new Date().toISOString() },
    perk: {
      code: "WELCOME15",
      percent: 15,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 9 * 86400000).toISOString(),
      usedAt: null,
      active: true,
    },
    backstories: { Prism: "Prism was first switched on for Test Person, on a fine day." },
    customizations: {},
    photons: [
      { name: "Prism", pronoun: "she/her", tagline: "For anyone", focus: "Front desk", owned: true },
    ],
  };
  async function bootDom(tab: string) {
    const dom = new JSDOM(html, { url: `${BASE}/?tab=${tab}`, runScripts: "outside-only", pretendToBeVisual: true });
    const { window } = dom as any;
    // jsdom has no matchMedia; the splash checks it on boot.
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    (window as any).fetch = async (input: any) => {
      const url = String(input);
      if (url.includes("/api/state")) return new Response(JSON.stringify(signedInState), { headers: { "content-type": "application/json" } });
      if (url.includes("/api/stripe/status")) return new Response(JSON.stringify({ ok: true, configured: true }), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    };
    (window as any).localStorage.setItem("prism5.accountId", "acc_deviceA0123456789ab");
    (window as any).eval(js);
    await new Promise((r) => setTimeout(r, 800));
    return window;
  }
  const upWin = await bootDom("upkeep");
  const upHtml = upWin.document.getElementById("view")?.innerHTML || "";
  check("Upkeep shows the signed-in account", upHtml.includes("Signed in as") && upHtml.includes("test@example.com"));
  check("Upkeep shows the welcome offer with the code", upHtml.includes("WELCOME15") && upHtml.includes("15% off"));
  check("Upkeep shows Prism's backstory", upHtml.includes("How Prism began") && upHtml.includes("Test Person"));
  check("Upkeep offers sign-out, not sign-in", upHtml.includes("Sign out") && !upHtml.includes("Sign in with Google"));
  const stWin = await bootDom("store");
  const stHtml = stWin.document.getElementById("view")?.innerHTML || "";
  check("Store shows the welcome offer banner", stHtml.includes("WELCOME15") && stHtml.includes("15% off"));
  const buyLink = stWin.document.querySelector('#view a[href*="buy.stripe.com"]')?.getAttribute("href") || "";
  check(
    "Store buy links prefill the welcome code",
    buyLink.includes("prefilled_promo_code=WELCOME15") && buyLink.includes("client_reference_id="),
    buyLink.slice(0, 120),
  );

  // --- Client render (jsdom): first-run landing ---
  const unsignedState = {
    ...signedInState,
    auth: { signedIn: false },
    perk: null,
    backstories: {},
    upkeep: false,
    freeCode: false,
  };
  async function bootLandingDom(dismissed: boolean) {
    const dom = new JSDOM(html, { url: `${BASE}/?tab=chat`, runScripts: "outside-only", pretendToBeVisual: true });
    const { window } = dom as any;
    (window as any).matchMedia = () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    (window as any).fetch = async (input: any) => {
      const url = String(input);
      if (url.includes("/api/state")) return new Response(JSON.stringify(unsignedState), { headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    };
    (window as any).localStorage.setItem("prism5.accountId", "acc_deviceA0123456789ab");
    if (dismissed) (window as any).localStorage.setItem("prism.landingDismissed", "1");
    (window as any).eval(js);
    await new Promise((r) => setTimeout(r, 800));
    // The film dismisses itself in jsdom (the video cannot play, so
    // the fallback dismisses); tap the splash too if it is still there.
    const splash = window.document.getElementById("opening-splash");
    if (splash && splash.isConnected) (splash as any).click();
    await new Promise((r) => setTimeout(r, 1100));
    return window;
  }
  const landWin = await bootLandingDom(false);
  const landing = landWin.document.getElementById("landing");
  check("landing shows for a never-signed-in account", !!landing);
  check(
    "landing names the account benefits, without giving the code away",
    !(landing?.textContent || "").includes("WELCOME15") &&
      (landing?.textContent || "").includes("15% off your first order") &&
      (landing?.textContent || "").includes("newsletter") &&
      (landing?.textContent || "").includes("follow you to any device"),
  );
  check(
    "landing sign-in button reuses the Google flow",
    !!landing?.querySelector('[data-action="signin"]') &&
      (landing?.querySelector('[data-action="signin"]')?.textContent || "").includes(
        "Sign in or create account with Google",
      ),
  );
  check("landing offers a quiet skip", !!landing?.querySelector('[data-action="landing-skip"]'));
  // Skip: the landing goes away and stays dismissed on this device.
  (landing?.querySelector('[data-action="landing-skip"]') as any)?.click();
  await new Promise((r) => setTimeout(r, 100));
  check("skipping removes the landing", !landWin.document.getElementById("landing"));
  check(
    "skipping sets the dismiss flag",
    landWin.localStorage.getItem("prism.landingDismissed") === "1",
  );
  const dismissedWin = await bootLandingDom(true);
  check("dismissed landing does not show again", !dismissedWin.document.getElementById("landing"));
  // Signed-in account: no landing even after the film goes away.
  const signedWin = await bootDom("chat");
  const signedSplash = signedWin.document.getElementById("opening-splash");
  if (signedSplash && signedSplash.isConnected) (signedSplash as any).click();
  await new Promise((r) => setTimeout(r, 1100));
  check("signed-in account never sees the landing", !signedWin.document.getElementById("landing"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
