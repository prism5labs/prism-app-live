// Tiny interface sounds — synthesized with the Web Audio API, no audio
// files to download. That is what makes them dependable: nothing to
// fetch, nothing to fail on a slow connection, nothing cached stale,
// and they play instantly even offline. Three sounds, all quiet:
// a click for taps, a two-note blip for switches, a soft swoosh for
// screen changes and dismissing the opening.
//
// Rules the module keeps on its own:
// - Nothing plays before a user interaction. The AudioContext is only
//   created inside a gesture (a tap, or the pointerdown just before
//   it, which warms the context so the first tap has no lag). No sound
//   on page load, no sound on boot, no sound on a timer.
// - When the audio context is unavailable or blocked, every call is a
//   silent no-op. Sound can never break the UI or swallow a tap.
// - The on/off choice lives in localStorage (prism5.sounds.v1, same
//   per-device pattern as Reading and Opening), default ON.

const SOUND_KEY = "prism5.sounds.v1";

// The opening spoken line Neil chose (Nov 18, 2026): option 3 with the
// gendered address removed. No "sir", no title at all, so it fits every
// owner. Text only for now; the spoken-line voice and timing build is a
// separate step.
export const OPENING_LINE =
  "The prism is polished, the dust has settled, and I am entirely at your service.";

// Quiet: these sit under the voice and the film, never over them.
// Raised Nov 21, 2026, on Neil's order: every sound, all apps. The
// v1 palette stood at 0.09-0.1, a whisper on a phone speaker.
const CLICK_GAIN = 0.42;
const TOGGLE_GAIN = 0.42;
const SWOOSH_GAIN = 0.45;

let enabled = true;
let ctx: AudioContext | null = null;
let warmed = false;
let noiseBuf: AudioBuffer | null = null;

function loadEnabled(): void {
  try {
    const raw = localStorage.getItem(SOUND_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.enabled === "boolean") enabled = p.enabled;
  } catch {
    // A bad or unreadable value keeps the default: on.
  }
}

function saveEnabled(): void {
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify({ enabled }));
  } catch {
    // Storage unavailable: the setting still holds for this open.
  }
}

loadEnabled();

export function soundsEnabled(): boolean {
  return enabled;
}

export function setSoundsEnabled(on: boolean): void {
  enabled = on;
  saveEnabled();
}

// The context is created and resumed only from inside a user gesture,
// which is what the autoplay policy allows. A one-time pointerdown /
// keydown listener warms it just before the first tap, so the first
// real sound has no startup lag. Creating it here makes no sound.
function audioContext(): AudioContext | null {
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function warmUp(): void {
  if (warmed) return;
  warmed = true;
  audioContext();
}

if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", warmUp, { once: true, passive: true });
  window.addEventListener("keydown", warmUp, { once: true });
}

function blip(
  c: AudioContext,
  freq: number,
  at: number,
  dur: number,
  gain: number,
): void {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(gain, at + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

function getNoise(c: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf;
  const len = Math.floor(c.sampleRate * 0.25);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

// A button tap: one soft tick, 45ms, gone before the next paint.
export function playClick(): void {
  if (!enabled) return;
  const c = audioContext();
  if (!c) return;
  try {
    blip(c, 1250, c.currentTime, 0.045, CLICK_GAIN);
  } catch {
    // Sound never breaks the UI.
  }
}

// A switch flipping: two short notes, up when it turns on, down when
// it turns off, so the ear knows which way it went. The `force` flag
// is only for the sounds switch itself: flipping sounds off still
// answers the tap, and flipping them on is heard at once.
export function playToggle(on: boolean, force = false): void {
  if (!force && !enabled) return;
  const c = audioContext();
  if (!c) return;
  try {
    const t = c.currentTime;
    const notes = on ? [620, 930] : [930, 620];
    blip(c, notes[0], t, 0.05, TOGGLE_GAIN);
    blip(c, notes[1], t + 0.055, 0.05, TOGGLE_GAIN);
  } catch {
    // Sound never breaks the UI.
  }
}

// A screen change or a dismissal: filtered noise sweeping upward,
// 220ms, soft as a page turning.
export function playSwoosh(): void {
  if (!enabled) return;
  const c = audioContext();
  if (!c) return;
  try {
    const t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = getNoise(c);
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 1.1;
    filter.frequency.setValueAtTime(500, t);
    filter.frequency.exponentialRampToValueAtTime(2600, t + 0.2);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(SWOOSH_GAIN, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.connect(filter);
    filter.connect(g);
    g.connect(c.destination);
    src.start(t);
    src.stop(t + 0.25);
  } catch {
    // Sound never breaks the UI.
  }
}
