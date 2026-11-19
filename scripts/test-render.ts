// Client render smoke test (jsdom). Loads the real built bundle against the
// running server and checks the four tabs render, then drives the redeem box.
// Usage: bun scripts/test-render.ts (server must be running on :3100)
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The redeem code under test. Read from the environment only: no code value
// lives in this repo. Run with FREE_CODE set to the current code, and the
// server on :3100 started with the same value.
const FREE_CODE = process.env.FREE_CODE || "";
if (!FREE_CODE) {
  console.log("FREE_CODE is not set. Re-run with FREE_CODE set to the current code.");
  process.exit(1);
}

const BASE = "http://localhost:3100";
const ROOT = join(import.meta.dir, "..");

const html = readFileSync(join(ROOT, "public", "index.html"), "utf8");
const js = readFileSync(join(ROOT, "public", "main.js"), "utf8");

const dom = new JSDOM(html, {
  url: BASE + "/",
  runScripts: "outside-only",
  pretendToBeVisual: true,
});
const { window } = dom;

// jsdom has no matchMedia; the splash checks it on boot (same stub as
// scripts/test-auth.ts — without it the bundle throws before render).
(window as any).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});

// Route the client's relative fetches to the running server. The
// signal is dropped: the bundle's AbortSignal comes from the jsdom
// realm, and Node's fetch rejects it ("signal is not of type
// AbortSignal"). In a real browser both come from the same realm, so
// this is a harness-only difference.
const realFetch = fetch;
(window as any).fetch = (input: any, init: any) => {
  const url = String(input);
  const abs = url.startsWith("http") ? url : BASE + url;
  const { signal, ...rest } = init || {};
  return realFetch(abs, rest);
};

// Capture console errors from the app.
const errors: string[] = [];
window.console.error = (...args: any[]) => {
  errors.push(args.map(String).join(" "));
};

(window as any).eval(js);

function text(sel: string): string {
  const el = window.document.querySelector(sel);
  return el ? (el.textContent || "") : "";
}

async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!cond) process.exitCode = 1;
}

const ok = await waitFor(() => window.document.querySelectorAll("#nav .nav-btn").length === 4);
check("nav renders 4 tabs", ok, `found ${window.document.querySelectorAll("#nav .nav-btn").length}`);
check(
  "nav tabs are Chat, Connected, Store, You",
  [...window.document.querySelectorAll("#nav .nav-btn")].map((b) => b.textContent).join("|") === "Chat|Connected|Store|You",
  [...window.document.querySelectorAll("#nav .nav-btn")].map((b) => b.textContent).join("|"),
);
check("front page greeting", text("#view").includes("Howdy, neighbor!"));
check("front page empty panel", text("#view").includes("Nothing to talk to yet."));
// Redesign: the home screen is the assistant and the day only — the
// hero, the name form, the meter and the upsell left it.
check("front page has no hero banner", !window.document.querySelector("#view .sputnik-hero img"));
check("front page has no name form", !text("#view").includes("Make it yours"));
check("front page has no meter line", !text("#view").includes("0 of 300 chats used this month"));
check("front page has no upsell line", !text("#view").includes("Upkeep is $29 a month"));

// Switch to the Store tab.
const storeBtn = [...window.document.querySelectorAll("#nav .nav-btn")].find(
  (b) => b.textContent === "Store",
) as HTMLElement;
storeBtn.click();
await waitFor(() => text("#view").includes("Supernova"));
check("store shows Supernova", text("#view").includes("Supernova"));
check("store shows Satellite", text("#view").includes("Satellite"));
check("store shows a Spark", text("#view").includes("Morning Briefing"));
check("store shows Upkeep card", text("#view").includes("Upkeep"));
check("store has buy links", (window.document.querySelectorAll('#view a[href*="buy.stripe.com"]').length || 0) >= 40, `found ${window.document.querySelectorAll('#view a[href*="buy.stripe.com"]').length}`);
check("store shows Photon grid", text("#view").includes("Meet the Photons"));
check("store toggle present", !!window.document.querySelector('[data-action="variant"]'));
check("store shows redeem box", !!window.document.querySelector("#redeem-form"));

// Toggle to Business and confirm a Business price appears.
const bizBtn = window.document.querySelector('[data-variant="business"]') as HTMLElement;
bizBtn.click();
await new Promise((r) => setTimeout(r, 200));
check("business toggle shows $25.00", text("#view").includes("$25.00"));

// Switch to You and check the meter and the name form live there now
// (redesign: settings and account, nothing for sale).
const youBtn = [...window.document.querySelectorAll("#nav .nav-btn")].find(
  (b) => b.textContent === "You",
) as HTMLElement;
youBtn.click();
await waitFor(() => text("#view").includes("0 of 300 chats used this month"));
check("you shows meter", text("#view").includes("0 of 300 chats used this month"));
check("you shows make-it-yours", text("#view").includes("Make it yours"));
check("you shows no store button", !text("#view").includes("Go to the Store"));

// Back to the Store and redeem the free code through the UI.
const storeBtn2 = [...window.document.querySelectorAll("#nav .nav-btn")].find(
  (b) => b.textContent === "Store",
) as HTMLElement;
storeBtn2.click();
await waitFor(() => !!window.document.querySelector("#redeem-form"));
check("store shows redeem box", !!window.document.querySelector("#redeem-form"));
const input = window.document.querySelector("#redeem-input") as HTMLInputElement;
input.value = FREE_CODE;
const form = window.document.querySelector("#redeem-form") as HTMLFormElement;
form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
// The meter lives on You now: check the unlock there, not in the Store.
// Re-query the tab button: every render rebuilds the nav, so the
// element captured earlier is detached by now.
await waitFor(() => text("#toast").includes("Everything's yours now"), 8000);
const youBtn2 = [...window.document.querySelectorAll("#nav .nav-btn")].find(
  (b) => b.textContent === "You",
) as HTMLElement;
youBtn2.click();
await waitFor(
  () => window.document.querySelector(".meter-line")?.textContent === "Unlimited chat",
  8000,
);
check("redeem unlocks unlimited chat", window.document.querySelector(".meter-line")?.textContent === "Unlimited chat");
check("redeem shows owned list", text("#view").includes("Prism — Photon"));

// Back to Chat: the Photons should now be listed and tappable.
const chatBtn = [...window.document.querySelectorAll("#nav .nav-btn")].find(
  (b) => b.textContent === "Chat",
) as HTMLElement;
chatBtn.click();
await waitFor(() => window.document.querySelectorAll("#view .photon-card").length === 12);
check("chat lists all 12 owned Photons", window.document.querySelectorAll("#view .photon-card").length === 12, `found ${window.document.querySelectorAll("#view .photon-card").length}`);

// Open a Photon thread and send a message (mock brain is running).
const prismCard = [...window.document.querySelectorAll("#view .photon-card")].find(
  (c) => (c as HTMLElement).dataset.photon === "Prism",
) as HTMLElement;
prismCard.click();
// First time with a Photon, the app offers the customization steps
// before chat: skip them all, then the thread opens.
await waitFor(() => !!window.document.querySelector('[data-action="custom-skip-all"]'));
const skipAll = window.document.querySelector('[data-action="custom-skip-all"]') as HTMLElement;
if (skipAll) skipAll.click();
await waitFor(() => !!window.document.querySelector("#chat-form"));
check("thread view opens", !!window.document.querySelector("#chat-form"));
check("thread has Call button", text("#view").includes("Call · Upkeep"));
const chatInput = window.document.querySelector("#chat-input") as HTMLInputElement;
chatInput.value = "Hello from the render test";
const chatForm = window.document.querySelector("#chat-form") as HTMLFormElement;
chatForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await waitFor(() => text("#view").includes("Mock reply"), 8000);
check("chat reply renders in thread", text("#view").includes("Mock reply"));
// The thread itself never shows the meter — it lives on You. After a
// chat, it must still read Unlimited there.
const youBtn3 = [...window.document.querySelectorAll("#nav .nav-btn")].find(
  (b) => b.textContent === "You",
) as HTMLElement;
youBtn3.click();
await waitFor(
  () => window.document.querySelector(".meter-line")?.textContent === "Unlimited chat",
  8000,
);
check("meter still unlimited after a chat", window.document.querySelector(".meter-line")?.textContent === "Unlimited chat");

check("no console errors from the app", errors.length === 0, errors.join(" | ").slice(0, 500));
console.log("done");
