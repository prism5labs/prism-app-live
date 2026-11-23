// Hero-opening probe (jsdom). Loads the real built bundle against the
// running scratch server (port 3100, same harness as test-render.ts),
// forces the film's clock past the handoff, records every WAAPI call
// the finale makes, and verifies the hero sequence end to end:
//   - the stage appears and Prism is nowhere in the opening
//   - exactly 23 heroes, each once, all full-figure /heroes/ art
//   - the staging is asymmetric (no mirrored pairs, wide scale range)
//   - every hero gets its own entrance (all four kinds present),
//     a living-hold sway on its own period, and a flash-out
//   - the charge and the white-gold flash fire, and the splash is
//     dismissed afterwards with no console errors
// Run: bun scripts/probe-hero-opening.ts   (server on :3100)
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
(window as any).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
});
const realFetch = fetch;
(window as any).fetch = (input: any, init: any) => {
  const url = String(input);
  const abs = url.startsWith("http") ? url : BASE + url;
  const { signal, ...rest } = init || {};
  return realFetch(abs, rest);
};
const errors: string[] = [];
window.console.error = (...args: any[]) => {
  errors.push(args.map(String).join(" "));
};

// Speed the finale's clock: the bundle's window.setTimeout delays
// are scaled down so the probe does not sit through the sequence
// in real time. Ordering is preserved; only the tempo changes.
const realST = window.setTimeout.bind(window);
(window as any).setTimeout = (fn: any, ms?: number, ...rest: any[]) =>
  realST(fn, Math.max(1, Math.round((ms || 0) / 25)), ...rest);

// Record every WAAPI animation the bundle starts.
type AnimRec = {
  cls: string;
  hero: string | null;
  keyframes: any[];
  opts: any;
};
const anims: AnimRec[] = [];
(window as any).HTMLElement.prototype.animate = function (keyframes: any, opts: any) {
  const el = this as HTMLElement;
  const heroEl = el.closest(".opening-hero") as HTMLElement | null;
  anims.push({
    cls: el.className,
    hero: heroEl ? heroEl.dataset.hero || null : null,
    keyframes: Array.isArray(keyframes) ? keyframes : [keyframes],
    opts: opts || {},
  });
  return { cancel: () => {}, finish: () => {}, finished: Promise.resolve() };
};

// The film never plays in jsdom; hold its clock past the handoff
// so the rAF watcher starts the finale on its first tick, and the
// stall watchdog (which reads the same clock) stays quiet.
const video = window.document.getElementById("opening-splash-video") as any;
Object.defineProperty(video, "currentTime", { get: () => 6, configurable: true });

(window as any).eval(js);

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}
async function waitFor(fn: () => boolean, timeoutMs = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return fn();
}

const EXPECTED = [
  "Juniper", "Encore", "Zero", "Proof", "Barnstormer", "Blueprint",
  "Calendra", "Shopbell", "Keystone", "Vesper", "Goldstar",
  "Mabel", "Hazel", "Willa", "Ruby", "Jude", "Sadie",
  "Bea", "Flora", "Pierce", "Iris", "Clive", "Nora",
];

// 1. The stage appears.
const stageOk = await waitFor(() => !!window.document.querySelector(".opening-hero-stage"));
check("hero stage appears at the handoff", stageOk);

// 2. The cast: exactly the 23, each once, no Prism.
const heroEls = [...window.document.querySelectorAll(".opening-hero")] as HTMLElement[];
const names = heroEls.map((el) => el.dataset.hero || "");
check("exactly 23 heroes", heroEls.length === 23, `found ${heroEls.length}`);
check(
  "cast matches the 23 (11 Supernovas + 12 Novas), each exactly once",
  EXPECTED.every((n) => names.filter((x) => x === n).length === 1),
);
check("no Prism anywhere in the opening", !names.includes("Prism") &&
  ![...window.document.querySelectorAll("#opening-splash img")].some((i: any) =>
    (i.getAttribute("src") || "").includes("Prism")));

// 3. All art is the full-figure hero art.
const srcs = heroEls.map((el) => el.querySelector("img")?.getAttribute("src") || "");
check(
  "every figure uses /heroes/<Name>.webp (no portrait thumbs)",
  srcs.every((s, i) => s === `/heroes/${encodeURIComponent(names[i])}.webp`),
  srcs.slice(0, 3).join(", "),
);

// 4. Asymmetric staging, from the placed inline styles.
const slots = heroEls.map((el) => ({
  name: el.dataset.hero || "",
  x: parseFloat(el.style.left),
  b: parseFloat(el.style.bottom),
  w: parseFloat(el.style.width),
}));
const widths = new Set(slots.map((s) => s.w));
check("at least 6 distinct figure scales", widths.size >= 6, `${widths.size} distinct widths`);
const maxW = Math.max(...slots.map((s) => s.w));
const minW = Math.min(...slots.map((s) => s.w));
check("foreground-to-highest scale range at least 2.4x", maxW / minW >= 2.4, `${minW}%..${maxW}%`);
const mirrored = slots.some((a) =>
  slots.some((b) => b.name !== a.name && Math.abs(a.x + b.x - 100) < 0.01 && a.b === b.b && a.w === b.w));
check("no mirrored pairs (not a symmetrical grouping)", !mirrored);
const bottoms = new Set(slots.map((s) => s.b));
check("at least 12 distinct ground lines / heights", bottoms.size >= 12, `${bottoms.size} distinct bottoms`);

// 5. Entrances: one per hero, staggered, all four kinds present.
const entrances = anims.filter((a) => a.hero && a.cls === "opening-hero");
const byHero = new Map<string, AnimRec[]>();
for (const a of entrances) {
  const list = byHero.get(a.hero!) || [];
  list.push(a);
  byHero.set(a.hero!, list);
}
check("every hero has an entrance animation", EXPECTED.every((n) => (byHero.get(n) || []).length >= 1));
const delays = new Set(entrances.map((a) => a.opts.delay || 0));
check("entrances are staggered (at least 10 distinct delays)", delays.size >= 10, `${delays.size} distinct`);
function kindOf(a: AnimRec): string {
  const first = JSON.stringify(a.keyframes[0] || {});
  if (first.includes("scale(0.55)")) return "flash";
  const m = first.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
  if (m) {
    const oy = parseFloat(m[2]);
    if (oy < -300) return "drop";
    if (oy > 300) return "rise";
  }
  if (first.includes("scale(1.14)")) return "streak";
  return "unknown";
}
const kinds = new Map<string, string>();
for (const n of EXPECTED) {
  const first = (byHero.get(n) || [])[0];
  if (first) kinds.set(n, kindOf(first));
}
const kindCounts: Record<string, number> = {};
for (const k of kinds.values()) kindCounts[k] = (kindCounts[k] || 0) + 1;
check(
  "all four entrance kinds present (drop/streak/rise/flash)",
  ["drop", "streak", "rise", "flash"].every((k) => (kindCounts[k] || 0) >= 3),
  JSON.stringify(kindCounts),
);
// Streak heroes trail on the way in (their trail keyframes open
// stretched at "1.6 1"; the flash-out trails open at "0.4 1").
const trailIns = anims.filter(
  (a) => a.cls === "opening-hero-trail" && JSON.stringify(a.keyframes[0] || {}).includes("1.6 1"),
);
check("streak entrances burn a light trail", trailIns.length >= 5, `${trailIns.length} trail-ins`);

// 6. The living hold: an infinite sway per hero, on its own period.
const sways = anims.filter((a) => a.cls === "opening-hero-sway" && a.opts.iterations === Infinity);
check("every hero breathes in the hold (infinite sway)", sways.length === 23, `${sways.length} sways`);
const periods = new Set(sways.map((a) => a.opts.duration));
check("sway periods are per-hero (at least 10 distinct)", periods.size >= 10, `${periods.size} distinct`);

// 7. The charge and the flash-out fire; then the splash goes away.
const gone = await waitFor(() => !window.document.getElementById("opening-splash"), 12000);
const chargeAnim = anims.some((a) => a.cls === "opening-hero-charge");
check("the charge-up fires before the flash-out", chargeAnim);
const flashAnim = anims.find((a) => a.cls === "opening-hero-flash");
check(
  "the white-gold flash blooms (peaks at 0.95 opacity)",
  !!flashAnim && JSON.stringify(flashAnim.keyframes).includes("0.95"),
);
const outs = anims.filter(
  (a) => a.hero && a.cls === "opening-hero" && a.opts.duration === 560,
);
check("every hero flashes out (560ms streak, one per hero)", outs.length === 23, `${outs.length} flash-outs`);
check("splash dismissed after the flash", gone);
check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
