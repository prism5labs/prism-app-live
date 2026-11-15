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

// Route the client's relative fetches to the running server.
const realFetch = fetch;
(window as any).fetch = (input: any, init: any) => {
  const url = String(input);
  const abs = url.startsWith("http") ? url : BASE + url;
  return realFetch(abs, init);
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
check("front page greeting", text("#view").includes("Howdy, neighbor!"));
check("front page empty panel", text("#view").includes("Your counter's empty"));
check("front page make-it-yours", text("#view").includes("Make it yours"));
check("front page logo", !!window.document.querySelector("#view .logo-plate svg"));
check("front page meter line", text("#view").includes("0 of 300 chats used this month"));

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

// Toggle to Business and confirm a Business price appears.
const bizBtn = window.document.querySelector('[data-variant="business"]') as HTMLElement;
bizBtn.click();
await new Promise((r) => setTimeout(r, 200));
check("business toggle shows $25.00", text("#view").includes("$25.00"));

// Switch to Upkeep and redeem the free code through the UI.
const upkeepBtn = [...window.document.querySelectorAll("#nav .nav-btn")].find(
  (b) => b.textContent === "Upkeep",
) as HTMLElement;
upkeepBtn.click();
await waitFor(() => !!window.document.querySelector("#redeem-form"));
check("upkeep shows redeem box", !!window.document.querySelector("#redeem-form"));
check("upkeep shows meter", text("#view").includes("0 of 300 chats used this month"));
const input = window.document.querySelector("#redeem-input") as HTMLInputElement;
input.value = FREE_CODE;
const form = window.document.querySelector("#redeem-form") as HTMLFormElement;
form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
// Wait on the meter line itself, not the word "Unlimited chat" (which also
// appears in the Upkeep included list).
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
await waitFor(() => !!window.document.querySelector("#chat-form"));
check("thread view opens", !!window.document.querySelector("#chat-form"));
check("thread has Call button", text("#view").includes("Call · Upkeep"));
const chatInput = window.document.querySelector("#chat-input") as HTMLInputElement;
chatInput.value = "Hello from the render test";
const chatForm = window.document.querySelector("#chat-form") as HTMLFormElement;
chatForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
await waitFor(() => text("#view").includes("Mock reply"), 8000);
check("chat reply renders in thread", text("#view").includes("Mock reply"));
check("meter updated in thread", text("#view").includes("Unlimited chat"));

check("no console errors from the app", errors.length === 0, errors.join(" | ").slice(0, 500));
console.log("done");
