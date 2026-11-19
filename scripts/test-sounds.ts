// Interface-sound tests: the synthesized click / toggle / swoosh in
// client/sounds.ts, verified without a browser. A recording fake
// AudioContext stands in for the real one, so the test can prove the
// sounds are scheduled, the on/off setting persists, and nothing
// plays when sounds are off — or on module load.
//
// Run: bun scripts/test-sounds.ts
// Exits 1 on any failure.

import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`, {
  url: "https://app.prism5labs.com/",
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).localStorage = dom.window.localStorage;

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

// ---- Recording fake Web Audio ----
class FakeParam {
  value = 0;
  sets: { method: string; value: number; time: number }[] = [];
  setValueAtTime(v: number, t: number) {
    this.sets.push({ method: "set", value: v, time: t });
    this.value = v;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.sets.push({ method: "linear", value: v, time: t });
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.sets.push({ method: "exp", value: v, time: t });
  }
}
class FakeOscillator {
  type = "";
  frequency = new FakeParam();
  started: number[] = [];
  stopped: number[] = [];
  connect() {}
  start(t: number) {
    this.started.push(t);
  }
  stop(t: number) {
    this.stopped.push(t);
  }
}
class FakeGain {
  gain = new FakeParam();
  connect() {}
}
class FakeSource {
  buffer: unknown = null;
  started: number[] = [];
  stopped: number[] = [];
  connect() {}
  start(t: number) {
    this.started.push(t);
  }
  stop(t: number) {
    this.stopped.push(t);
  }
}
class FakeFilter {
  type = "";
  Q = new FakeParam();
  frequency = new FakeParam();
  connect() {}
}
class FakeAudioContext {
  static instances = 0;
  static oscillators: FakeOscillator[] = [];
  static gains: FakeGain[] = [];
  static sources: FakeSource[] = [];
  static filters: FakeFilter[] = [];
  state = "running";
  currentTime = 0;
  destination = {};
  constructor() {
    FakeAudioContext.instances++;
  }
  resume() {
    return Promise.resolve();
  }
  createOscillator() {
    const o = new FakeOscillator();
    FakeAudioContext.oscillators.push(o);
    return o;
  }
  createGain() {
    const g = new FakeGain();
    FakeAudioContext.gains.push(g);
    return g;
  }
  createBuffer(_ch: number, len: number, rate: number) {
    return {
      numberOfChannels: 1,
      length: len,
      sampleRate: rate,
      getChannelData: () => new Float32Array(len),
    };
  }
  createBufferSource() {
    const s = new FakeSource();
    FakeAudioContext.sources.push(s);
    return s;
  }
  createBiquadFilter() {
    const f = new FakeFilter();
    FakeAudioContext.filters.push(f);
    return f;
  }
}
(dom.window as any).AudioContext = FakeAudioContext;

const sounds = await import("../client/sounds");

console.log("interface sounds");

// 1. Importing the module makes no sound and creates no context.
check("no AudioContext on load", FakeAudioContext.instances === 0);

// 2. Default is on.
check("sounds on by default", sounds.soundsEnabled() === true);

// 3. A click schedules one short oscillator burst.
const oscBefore = FakeAudioContext.oscillators.length;
sounds.playClick();
check("click creates one context", FakeAudioContext.instances === 1);
check(
  "click starts one oscillator",
  FakeAudioContext.oscillators.length === oscBefore + 1 &&
    FakeAudioContext.oscillators[FakeAudioContext.oscillators.length - 1].started.length === 1,
);
const clickFreq = FakeAudioContext.oscillators[FakeAudioContext.oscillators.length - 1].frequency.sets[0]
  ?.value;
check("click is a soft tick (1250 Hz)", clickFreq === 1250, `got ${clickFreq}`);

// 4. Toggle on plays two notes, low then high; off plays high then low.
const freqs = () =>
  FakeAudioContext.oscillators.flatMap((o) => o.frequency.sets.map((s) => s.value));
const nBefore = freqs().length;
sounds.playToggle(true);
const onNotes = freqs().slice(nBefore);
check("toggle-on notes rise (620 -> 930)", onNotes[0] === 620 && onNotes[1] === 930, `got ${onNotes}`);
const nBefore2 = freqs().length;
sounds.playToggle(false);
const offNotes = freqs().slice(nBefore2);
check("toggle-off notes fall (930 -> 620)", offNotes[0] === 930 && offNotes[1] === 620, `got ${offNotes}`);

// 5. A swoosh sweeps a filtered noise buffer upward.
const srcBefore = FakeAudioContext.sources.length;
sounds.playSwoosh();
check("swoosh plays a noise source", FakeAudioContext.sources.length === srcBefore + 1);
const filter = FakeAudioContext.filters[FakeAudioContext.filters.length - 1];
const sweep = filter.frequency.sets.find((s) => s.method === "exp");
check("swoosh filter sweeps up to 2600 Hz", sweep?.value === 2600, `got ${sweep?.value}`);
check(
  "swoosh source is started and stopped",
  FakeAudioContext.sources[FakeAudioContext.sources.length - 1].started.length === 1 &&
    FakeAudioContext.sources[FakeAudioContext.sources.length - 1].stopped.length === 1,
);

// 6. Turning sounds off persists, and nothing more is scheduled.
sounds.setSoundsEnabled(false);
const stored = JSON.parse(dom.window.localStorage.getItem("prism5.sounds.v1") || "{}");
check("off persists in localStorage", stored.enabled === false, JSON.stringify(stored));
check("soundsEnabled reports off", sounds.soundsEnabled() === false);
const oscCount = FakeAudioContext.oscillators.length;
const srcCount = FakeAudioContext.sources.length;
sounds.playClick();
sounds.playToggle(true);
sounds.playSwoosh();
check("nothing scheduled while off", FakeAudioContext.oscillators.length === oscCount && FakeAudioContext.sources.length === srcCount);

// 7. The sounds switch itself still answers when forced — flipping it
// off answers the tap, flipping it on is heard at once.
sounds.playToggle(false, true);
check("forced toggle blip plays while off", FakeAudioContext.oscillators.length === oscCount + 2);

// 8. Turning sounds back on re-enables, and the setting persists.
sounds.setSoundsEnabled(true);
const stored2 = JSON.parse(dom.window.localStorage.getItem("prism5.sounds.v1") || "{}");
check("on persists in localStorage", stored2.enabled === true);
check("soundsEnabled reports on", sounds.soundsEnabled() === true);
const oscCount2 = FakeAudioContext.oscillators.length;
sounds.playClick();
check("click schedules again once back on", FakeAudioContext.oscillators.length === oscCount2 + 1);

// 9. No AudioContext at all (old browser, plain jsdom): every call is
// a silent no-op instead of a throw. Runs in a child process so the
// module loads fresh with no fake context installed.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
const probe = `
import { JSDOM } from ${JSON.stringify(join(dirname(import.meta.path), "..", "node_modules", "jsdom"))};
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "https://app.prism5labs.com/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
const s = await import(${JSON.stringify(join(dirname(import.meta.path), "..", "client", "sounds.ts"))});
s.playClick(); s.playToggle(true); s.playToggle(false); s.playSwoosh();
console.log("noctx-ok");
`;
writeFileSync("/tmp/prism-sounds-noctx-probe.ts", probe);
const res = spawnSync("bun", ["/tmp/prism-sounds-noctx-probe.ts"], { encoding: "utf8" });
check(
  "no AudioContext: all plays are silent no-ops",
  res.status === 0 && res.stdout.includes("noctx-ok"),
  (res.stderr || "").slice(0, 200),
);

// 10. The chosen opening line (Nov 18, 2026): option 3 with the
// gendered address removed. It must be exactly the chosen text, and
// it must carry no gendered form of address, so it fits every owner.
const GENDERED_ADDRESS = /\b(sir|ma'am|madam|gentleman|lady)\b/i;
check(
  "opening line is the chosen text",
  sounds.OPENING_LINE === "The prism is polished, the dust has settled, and I am entirely at your service.",
  JSON.stringify(sounds.OPENING_LINE),
);
check("opening line has no gendered address", !GENDERED_ADDRESS.test(sounds.OPENING_LINE));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
