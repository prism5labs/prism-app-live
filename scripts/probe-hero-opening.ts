// Hero-opening probe (jsdom). Loads the real built bundle against the
// running scratch server (port 3100, same harness as test-render.ts),
// forces the film's clock past the handoff, records every WAAPI call
// the finale makes, and verifies the v64 choreography end to end:
//   - the stage appears; Prism is nowhere in the opening — no
//     figure, no disc (the orbit rings are gone), only her light:
//     one shaft and one gathering core
//   - exactly 23 heroes, each once, all full-figure /heroes/ art
//     (a still, or an animated clip wearing the still as poster)
//   - the staging is asymmetric (no mirrored pairs, wide scale range)
//   - the split: one ray of light per hero, running from the heart
//     to the hero's place; every hero then condenses out of the
//     light where they stand (a brightness/blur resolve) — no
//     figure travels in from off-stage any more
//   - a living-hold sway per hero on its own period
//   - the charge and the white-gold flash fire, every hero streaks
//     out, and the splash is dismissed with no console errors
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
    hero: heroEl ? heroEl.dataset.hero || null : el.dataset?.hero || null,
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

// 3. Her light, and only her light: a shaft and a core, no disc.
check("the light's shaft is on the stage", !!window.document.querySelector(".opening-hero-shaft"));
check("the light's core is on the stage", !!window.document.querySelector(".opening-hero-core"));
check(
  "no disc: the orbit rings are gone",
  !window.document.querySelector(".opening-hero-orbits"),
);
const coreIn = anims.find(
  (a) => a.cls === "opening-hero-core" && JSON.stringify(a.keyframes).includes("scale(0.45)"),
);
check("the core gathers (animates in from a point of light)", !!coreIn);
const shaftIn = anims.find((a) => a.cls === "opening-hero-shaft");
check("the shaft falls in (animates in)", !!shaftIn);

// 4. All art is the full-figure hero art: a still, or a clip that
// wears the still as its poster.
const artOk = heroEls.every((el, i) => {
  const img = el.querySelector("img");
  if (img) return img.getAttribute("src") === `/heroes/${encodeURIComponent(names[i])}.webp`;
  const vid = el.querySelector("video");
  return !!vid && vid.getAttribute("poster") === `/heroes/${encodeURIComponent(names[i])}.webp`;
});
check("every figure uses /heroes/<Name>.webp art (still or clip poster)", artOk);

// 5. Asymmetric staging, from the placed inline styles.
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

// 6. The split: one ray per hero, then the condense. The ray's
// delay and the condense's delay are one schedule (the figure
// condenses 130ms after its ray sets out).
const rays = anims.filter((a) => a.cls === "opening-hero-ray");
check("one ray of light per hero (23 rays)", rays.length === 23, `${rays.length} rays`);
check(
  "every hero is reached by a ray",
  EXPECTED.every((n) => rays.some((r) => r.hero === n)),
);
const condenses = anims.filter(
  (a) => a.hero && a.cls === "opening-hero" && JSON.stringify(a.keyframes).includes("brightness(3.4"),
);
check("every hero condenses out of the light (23 condenses)", condenses.length === 23, `${condenses.length} found`);
check(
  "each condense follows its ray by 130ms",
  EXPECTED.every((n) => {
    const ray = rays.find((r) => r.hero === n);
    const con = condenses.find((c) => c.hero === n);
    return !!ray && !!con && (con.opts.delay || 0) - (ray.opts.delay || 0) === 130;
  }),
);
const delays = new Set(condenses.map((a) => a.opts.delay || 0));
check("the split is staggered (at least 10 distinct delays)", delays.size >= 10, `${delays.size} distinct`);
// No figure travels: a condense keyframe never translates the
// figure by more than a few pixels (the base -50% centring is a
// percentage, and the flash-out is a separate 560ms animation).
const travels = condenses.some((a) =>
  JSON.stringify(a.keyframes).match(/translate\((-?\d{2,})px/) ||
  JSON.stringify(a.keyframes).match(/,\s*(-?\d{2,})px\)/));
check("no figure travels in from off-stage (no travelling cutouts)", !travels);

// 7. The living hold: an infinite sway per hero, on its own period.
const sways = anims.filter((a) => a.cls === "opening-hero-sway" && a.opts.iterations === Infinity);
check("every hero breathes in the hold (infinite sway)", sways.length === 23, `${sways.length} sways`);
const periods = new Set(sways.map((a) => a.opts.duration));
check("sway periods are per-hero (at least 10 distinct)", periods.size >= 10, `${periods.size} distinct`);

// 8. The charge and the flash-out fire; then the splash goes away.
const gone = await waitFor(() => !window.document.getElementById("opening-splash"), 12000);
const chargeAnim = anims.some((a) => a.cls === "opening-hero-charge");
check("the charge-up fires before the flash-out", chargeAnim);
const coreSurge = anims.some(
  (a) => a.cls === "opening-hero-core" && a.opts.duration === 450,
);
check("her light surges at the charge (the core flares)", coreSurge);
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
