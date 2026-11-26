// Prism 5 — standalone client. Four places, each a different kind of
// thing (redesign, Nov 19, 2026): Chat (talk to your Faces, start the
// day), Connected (every connection, with its state, plus the inboxes
// themselves), Store (the only place to buy or redeem), You (your
// account and how the app behaves — nothing for sale here).
// No provider or model names appear anywhere in the visible copy.

import { api, getAccountId, setAccountId, clearAccountId } from "./api";
import { portraitHtml, atomPortraitHtml, logoHtml } from "./ui";
import { soundsEnabled, setSoundsEnabled, playClick, playToggle, playSwoosh } from "./sounds";
import { SUPERNOVA, SATELLITE, UPKEEP, NOVA, PERSONAL_UPKEEP, PRODUCTS, CATEGORIES } from "../src/shared/catalog";
import { TIER_COPY, UPKEEP_COPY, FREE_CHATS_COPY } from "../src/shared/tiers";
import { PERSONAL_FEATURES, BUSINESS_FEATURES } from "../src/shared/features";
import { PHOTONS } from "../src/shared/photons";
import { ATOMS } from "../src/shared/atoms";
import { VOICES, TUNING_QUESTIONS, LOOK_SETS, voiceById, lookSetById, tuningStyle } from "../src/shared/voices";

// Set the moment this bundle runs, so the inline splash backstop in
// index.html knows main.js loaded. Without it, a bundle that never
// runs leaves the splash over the app forever.
(window as any).__prismMainLoaded = true;

type Tab = "chat" | "connected" | "store" | "you";

// Per-Photon customization, saved on the server (state.customizations).
// Null row means the owner has not started customizing that Photon yet.
type Customization = {
  faceName: string | null;
  voice: string;
  tuning: Record<string, boolean> | null;
  lookSet: string | null;
  portrait: string | null;
  step: number;
  done: boolean;
};

function customFor(photon: string): Customization {
  const c = (state as any)?.customizations?.[photon];
  return c || { faceName: null, voice: "house", tuning: null, lookSet: null, portrait: null, step: 0, done: false };
}

function faceNameOf(p: any): string {
  return customFor(p.name).faceName || p.name;
}

// Display labels (Nov 25, 2026): an assistant is presented as its tier
// word plus its name — "Supernova Prism", "Nova Mabel". An owner's own
// chosen name for their Supernova stands alone, as they gave it.
function superLabel(p: any): string {
  return customFor(p.name).faceName || "Supernova " + p.name;
}
function novaLabel(a: any): string {
  return "Nova " + a.name;
}
function labelForName(name: string): string {
  const p = PHOTONS.find((x) => x.name === name);
  if (p) return superLabel(p);
  if (ATOMS.some((x) => x.name === name)) return "Nova " + name;
  return name;
}

function portraitNameOf(p: any): string {
  return customFor(p.name).portrait || p.name;
}

function voiceNameOf(photon: string): string {
  return voiceById(customFor(photon).voice).name;
}

let state: any = null;
// The last state load failed (server unreachable, timed out): the app
// has no state to show, and the account card must say that plainly
// instead of claiming "not signed in" or sitting on a loading line.
let stateFailed = false;
// Set when boot (or a return from the browser) adopted the linked
// account for this device through sign-in recovery, so the welcome
// toast can say the sign-in landed.
let authRecovered = false;
let tab: Tab = "chat";
let activePhoton: string | null = null;
// Which door the owner came through: Business or Personal (the
// first-open chooser, Nov 19, 2026). Saved on this device, in
// localStorage, under one key — the same pattern as the reading and
// opening settings. "" means never chosen: the app shows the business
// side until a door is picked, because the app was business-first,
// and the chooser still shows on the next open until a door is picked.
type Side = "business" | "personal";
const SIDE_KEY = "prism.side.v1";
function loadSide(): Side | "" {
  try {
    const v = localStorage.getItem(SIDE_KEY) || "";
    return v === "personal" || v === "business" ? v : "";
  } catch {
    return "";
  }
}
let side: Side | "" = loadSide();
function sideOrDefault(): Side {
  return side || "business";
}
function setSide(s: Side): void {
  side = s;
  try {
    localStorage.setItem(SIDE_KEY, s);
  } catch {
    // Private mode: the choice lasts for this session only.
  }
  // The Store follows the side: its Personal/Business prices open on
  // the side the owner picked.
  storeVariant = s;
  // And the account follows too: the side lives on the account profile
  // (POST /api/profile), so the website reads it from GET /api/state
  // and a signed-in owner lands on their chosen door everywhere. The
  // save runs in the background — a failure leaves the local choice
  // standing, and the next state load pushes it again.
  api.profileSave({ side: s }).catch(() => {});
}
let storeVariant: "personal" | "business" = sideOrDefault();
// Which Store sections are open. Remembered across re-renders, so the
// Personal/Business toggle doesn't collapse what the user opened.
let storeOpen: Record<string, boolean> = { supernovas: true, novas: true, sparks: false, plugs: false };
let threadMessages: any[] = [];
let threadLoading = false;
let pinnedFaces: string[] = [];

function isPinnedFace(name: string): boolean {
  return pinnedFaces.includes(name);
}

async function loadPinnedFaces(): Promise<void> {
  const r = await api.pinned();
  if (r && r.ok && Array.isArray(r.pinned)) pinnedFaces = r.pinned;
}
// Conversation search on the Chat front: the last query and its
// results. Results are null until a search has run, so the front can
// tell "not searched yet" apart from "searched, nothing found".
let conversationSearchQuery = "";
let conversationSearchResults: any[] | null = null;
let toastTimer: number | null = null;
// Customization wizard: which Photon is being customized, which step,
// and the design-your-own tuning draft (answered yes/no, saved on Save).
let customizePhoton: string | null = null;
let customizeStep: number = 1;
let customizeDesign = false;
let customizeTuning: Record<string, boolean> = {};

// Live voice call screen (Step 5): turn-based only. One Photon at a time;
// the call screen replaces the thread until the owner ends the call.
let callPhotonName: string | null = null;
let callPhase: "checking" | "idle" | "recording" | "transcribing" | "speaking" | "blocked" = "checking";
let callHeard = "";
let callRecorder: MediaRecorder | null = null;
let callStream: MediaStream | null = null;
let callChunks: Blob[] = [];
let callAudio: HTMLAudioElement | null = null;

// Proactive checks, reminders, push (Step 3): loaded when the You
// tab opens, so the tab shows a loading line instead of stale or empty
// cards.
let proactiveData: any = null;
let proactiveLoading = false;
let remindersData: any[] | null = null;
let pushData: any = null;
let lastCheck: any = null;
let checkRunning = false;
let youLoading = false;

// Start My Day — the morning briefing Plug. dayOpen is a sub-view of
// the Chat tab, like the thread and the customizer. dayData is the last
// briefing response; the server is the source of truth, so every confirm
// re-fetches and the next item is always items[0]. dayHandled counts
// the items confirmed in this briefing session.
let dayOpen = false;
let dayData: any = null;
let dayLoading = false;
let dayBusy = false;
let dayHandled = 0;
let dayMoveOpen = false;

// Messenger (Step 9): Page threads, loaded with the Connected tab.
let messengerStatusData: any = null;
let messengerThreadsData: any[] | null = null;
let messengerOpenId: string | null = null;
let messengerOpenMessages: any[] | null = null;
let messengerOpenError = "";
// Pages connected from the app (a Page access token pasted in by the
// owner). Null means the server's Page, when one is set up. The token
// itself is never in this state: the server only ever sends back the
// Page id and name.
let messengerPagesData: any[] | null = null;
let messengerSelectedPageId: string | null = null;

// About you: what the owner tells Prism about themselves, loaded with
// the Inboxes tab. The form edits a local copy until Save.
let profileData: any = null;
let profileSaved = false;

// Memory imported from another AI. The parsed file waits on this device
// until the owner taps Import; nothing is sent by picking a file.
let memoryImportsData: any[] = [];
let memoryParsed: { source: string; title: string; content: string; summary: string } | null = null;
let memoryParseError = "";

// Stripe webhook status (Step 10): loaded when the Store tab opens.
let stripeStatusData: any = null;
let stripeLoading = false;

// ---------- Readability: text size + high contrast ----------
// Older eyes: text size (Normal / Large / Extra-large) and a
// high-contrast toggle, set from the Reading card in You, saved on
// this device only (localStorage). The classes ride on <html> so every
// reading surface follows — chat bubbles, cards, inbox rows, forms —
// and they are applied at module load, before the first render, so the
// app never flashes the wrong size. The composer keeps its layout: the
// input flexes and the send button is a fixed circle, so bigger text
// only wraps to more lines.
type ReadSize = "normal" | "large" | "xl";
const READABILITY_KEY = "prism.readability.v1";
let readSize: ReadSize = "normal";
let readContrast = false;
function loadReadability(): void {
  try {
    const raw = localStorage.getItem(READABILITY_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (p.size === "large" || p.size === "xl") readSize = p.size;
    if (typeof p.contrast === "boolean") readContrast = p.contrast;
  } catch {
    // A bad or unreadable value keeps the defaults.
  }
}
function applyReadability(): void {
  const el = document.documentElement;
  el.classList.toggle("read-large", readSize === "large");
  el.classList.toggle("read-xl", readSize === "xl");
  el.classList.toggle("read-contrast", readContrast);
}
function saveReadability(): void {
  try {
    localStorage.setItem(READABILITY_KEY, JSON.stringify({ size: readSize, contrast: readContrast }));
  } catch {
    // Storage unavailable: the setting still holds for this open.
  }
}
function setReadSize(size: ReadSize): void {
  readSize = size;
  saveReadability();
  applyReadability();
  render();
}
function setReadContrast(on: boolean): void {
  readContrast = on;
  saveReadability();
  applyReadability();
  render();
}
loadReadability();
applyReadability();

// ---------- Opening animation: play it or skip it ----------
// The opening (her light gathering and splitting into the Faces —
// see the splash section) plays on every open — unless the owner
// turns it off. Same pattern as Reading above: saved on this device
// only, in localStorage, under one key, read at module load before
// the first render so the choice holds from the very first paint.
// Default is ON: a missing or unreadable value plays the opening,
// exactly as before. Turning it off skips the opening entirely on
// every later open until it is turned back on, in Upkeep or from
// the control on the opening itself.
const OPENING_KEY = "prism5.opening.v1";
let playOpening = true;
function loadOpeningPref(): void {
  try {
    const raw = localStorage.getItem(OPENING_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (typeof p.play === "boolean") playOpening = p.play;
  } catch {
    // A bad or unreadable value keeps the default: play it.
  }
}
function saveOpeningPref(): void {
  try {
    localStorage.setItem(OPENING_KEY, JSON.stringify({ play: playOpening }));
  } catch {
    // Storage unavailable: the setting still holds for this open.
  }
}
function setPlayOpening(on: boolean): void {
  playOpening = on;
  saveOpeningPref();
  render();
}
loadOpeningPref();

const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 20V6M6 11l6-6 6 6" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const NAV_ICONS: Record<Tab, string> = {
  chat: `<svg viewBox="0 0 24 24" fill="none"><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  connected: `<svg viewBox="0 0 24 24" fill="none"><path d="M3 13h5l2 3h4l2-3h5M4 6h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  store: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16l-1.5 12a1 1 0 0 1-1 .9h-11a1 1 0 0 1-1-.9L4 7Z M8 10V6a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  you: `<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" stroke-width="2"/><path d="M4 21a8 8 0 0 1 16 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
};

const view = () => document.getElementById("view") as HTMLElement;
const nav = () => document.getElementById("nav") as HTMLElement;

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toast(msg: string, kind: "ok" | "err" = "ok") {
  const t = document.getElementById("toast") as HTMLElement;
  t.textContent = msg;
  t.className = "toast show " + kind;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    t.className = "toast";
  }, 4500);
}

// ---------- Character cards ----------
// A pop-up card for every product in the Store: tap a Photon portrait (or
// the More info button on a Spark, a Plug, a tier, or the Personality
// Builder) and the card opens with the stats and specifics, Amazon-style.
// The card lives in a persistent node outside #view, so a Store re-render
// behind it never wipes it, and it is opened and closed by direct DOM
// work, never through render(). Everything shown comes from the app's own
// product data — nothing is invented. Dismissal: the X, the Close button,
// a tap on the backdrop, or the Escape key.
let cardOpener: HTMLElement | null = null;
let cardCloseTimer: number | null = null;

function cardModal(): HTMLElement {
  return document.getElementById("card-modal") as HTMLElement;
}

function openCard(html: string, opener: HTMLElement | null) {
  const m = cardModal();
  cardOpener = opener;
  // A close still fading out is cancelled: its timer would otherwise
  // hide the card that just opened.
  if (cardCloseTimer) {
    window.clearTimeout(cardCloseTimer);
    cardCloseTimer = null;
  }
  m.innerHTML = html;
  m.hidden = false;
  // The card pops in; the backdrop locks the page behind it.
  requestAnimationFrame(() => m.classList.add("open"));
  document.body.style.overflow = "hidden";
  const x = m.querySelector<HTMLButtonElement>("[data-action='card-close']");
  if (x) x.focus();
}

function closeCard() {
  const m = cardModal();
  if (m.hidden) return;
  // Fade out first, then hide: hiding at once cuts the sheet off
  // mid-transition and reads as a snap. The timer is guarded so a
  // second close (or a reopen) while fading never strands the modal.
  m.classList.remove("open");
  if (cardCloseTimer) window.clearTimeout(cardCloseTimer);
  cardCloseTimer = window.setTimeout(() => {
    m.hidden = true;
    m.innerHTML = "";
    document.body.style.overflow = "";
    if (cardOpener && document.contains(cardOpener)) cardOpener.focus();
    cardOpener = null;
    cardCloseTimer = null;
  }, 400);
}

function cardShell(title: string, bodyHtml: string): string {
  return `<div class="card-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <button class="card-x" data-action="card-close" aria-label="Close">✕</button>
    ${bodyHtml}
    <button class="btn card-close-btn" data-action="card-close">Close</button>
  </div>`;
}

function cardStats(rows: [string, string][]): string {
  return `<dl class="card-stats">${rows
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join("")}</dl>`;
}

function photonCardHtml(p: (typeof PHOTONS)[number]): string {
  const owned = state?.freeCode === true || (state?.ownedSupernovas || []).includes(p.name);
  const face = superLabel(p);
  const body = `
    <div class="card-hero">${portraitHtml(portraitNameOf(p), 140)}</div>
    <h2 class="card-title">${esc(face)}</h2>
    <p class="card-kind">Supernova · ${esc(p.pronoun)}</p>
    <p class="card-tagline">${esc(p.tagline)}</p>
    <p><b>What ${esc(face)} does out of the box:</b> ${esc(p.focus)}</p>
    <p class="card-intro">“${esc(p.intro.replaceAll("{name}", face))}”</p>
    ${cardStats([
      ["Price", "$499.00 ($514.00 at checkout)"],
      ["Or monthly", "$49/mo · $39/mo on a 2-year plan · $539/yr"],
      ["Built from", "About 90,000 lines of instructions"],
      ["Inside", "30 specialists, plus five tuning dials set to what matters to you"],
      ["Build time", "About 300 hours, about 37 working days"],
      ["Chats", "300 chats a month, free forever — no subscription needed"],
    ])}
    <p class="fine">A Supernova is unlimited in usefulness: each Supernova has a focus out of the box but does far more, and becomes you through use.</p>
    <div class="card-actions">
      ${owned ? `<span class="owned-badge">Owned — yours already</span><button class="btn primary" data-action="card-chat" data-photon="${esc(p.name)}">Start chatting</button>` : buyButton(buyUrl(SUPERNOVA.url, "Supernova-" + p.name), "$514.00", false)}
    </div>`;
  return cardShell(face, body);
}

function productCardHtml(p: (typeof PRODUCTS)[number]): string {
  const v = storeVariant === "personal" ? p.personal : p.business;
  const other = storeVariant === "personal" ? p.business : p.personal;
  const owned = state?.freeCode === true || (state?.ownedProducts || []).includes(p.slug);
  const isSpark = p.kind === "Spark";
  const body = `
    <h2 class="card-title">${esc(p.name)}</h2>
    <p class="card-kind">${esc(p.kind)} · ${esc(p.category)}</p>
    <p class="card-tagline">${esc(p.description)}</p>
    <p><b>How it works:</b> ${isSpark ? "One button, one job. You press it, it does that one job, and you can press it again as often as you like. It never runs out and it never dies." : "One job, fully automated. You do not press anything — it runs on its own, in the background, and does its job without being asked."}</p>
    ${cardStats([
      ["Kind", isSpark ? "Spark — one button, one job" : "Plug — runs on its own"],
      ["Category", p.category],
      ["Built from", isSpark ? "About 7,500 lines of instructions" : "About 15,000 lines of instructions"],
      ["Build time", isSpark ? "About 25 hours, about 3 working days" : "About 50 hours, about 6 working days"],
      ["Personal", `${v.price} (${v.total} at checkout)`],
      ["Business", `${other.price} (${other.total} at checkout)`],
    ])}
    <p class="fine">Yours forever once bought — nothing is deleted and nothing is chased if you stop paying for anything monthly.</p>
    <div class="card-actions">
      ${buyButton(buyUrl(v.url, p.slug + "-" + storeVariant), v.total, owned)}
    </div>`;
  return cardShell(p.name, body);
}

function tierCardHtml(tier: "supernova" | "satellite" | "upkeep"): string {
  if (tier === "supernova") {
    const owned = state?.freeCode === true || (state?.ownedProducts || []).includes("supernova");
    return cardShell(
      "Supernova",
      `<div class="card-hero"><img class="card-poster" src="/brand/poster-supernova.jpg" loading="lazy" decoding="async" alt="Supernova poster, the whole front office"></div>
      <h2 class="card-title">Supernova</h2>
      <p class="card-kind">The full helper · one Brain, one Face, every job duty</p>
      <p>${esc(TIER_COPY.supernova.body)}</p>
      ${cardStats([
        ["Price", "$499.00 ($514.00 at checkout)"],
        ["Or monthly", "$49/mo · $39/mo on a 2-year plan · $539/yr"],
        ["Built from", "About 90,000 lines of instructions"],
        ["Inside", "30 specialists, plus five tuning dials"],
        ["Build time", "About 300 hours, about 37 working days"],
        ["Chats", "300 chats a month, free forever — no subscription needed"],
      ])}
      <p class="fine">The whole front office in one: messages, calendar, paperwork, and anything else that comes up — and it learns how you like things done.</p>
      <div class="card-actions">${buyButton(buyUrl(SUPERNOVA.url, "supernova"), "$514.00", owned)}</div>`,
    );
  }
  if (tier === "satellite") {
    const owned = state?.freeCode === true || (state?.ownedProducts || []).includes("satellite");
    return cardShell(
      "Satellite",
      `<div class="card-hero"><img class="card-poster" src="/brand/poster-satellite.jpg" loading="lazy" decoding="async" alt="Satellite poster, one Brain, one Face, one job duty"></div>
      <h2 class="card-title">Satellite</h2>
      <p class="card-kind">The smaller build · one Brain, one Face, one job duty</p>
      <p>${esc(TIER_COPY.satellite.body)}</p>
      ${cardStats([
        ["Price", "$99.00 ($101.97 at checkout)"],
        ["Or monthly", "$33/mo · $26/mo on a 2-year plan · $363/yr"],
        ["Built from", "About 45,000 lines of instructions"],
        ["Build time", "About 150 hours, about 19 working days"],
        ["Chats", "300 chats a month, free forever — no subscription needed"],
      ])}
      <div class="card-actions">${buyButton(buyUrl(SATELLITE.url, "satellite"), "$101.97", owned)}</div>`,
    );
  }
  const owned = state?.upkeep === true;
  return cardShell(
    "Upkeep",
    `<div class="card-hero"><img class="card-poster" src="/brand/starburst.jpg" loading="lazy" decoding="async" alt="Upkeep starburst"></div>
    <h2 class="card-title">Upkeep</h2>
    <p class="card-kind">The care that keeps your Launch alive · $29.00/month</p>
    <p>${esc(UPKEEP_COPY.body)}</p>
    ${cardStats([
      ["Price", "$29.00/month ($29.87 at checkout)"],
      ["Includes", UPKEEP_COPY.included.join(" · ")],
      ["Required?", "Never — every purchase already includes 300 chats a month, free forever"],
    ])}
    <div class="card-actions">${buyButton(buyUrl(UPKEEP.url, "upkeep"), "$29.87", owned)}</div>`,
  );
}

function personalityCardHtml(): string {
  return cardShell(
    "Personality Builder",
    `<h2 class="card-title">Personality Builder</h2>
    <p class="card-kind">Spark · one button, one job</p>
    <p class="card-tagline">The extra attribute that builds a personality for your interface — for a Spark or Plug that doesn't come with one.</p>
    ${cardStats([
      ["Kind", "Spark — one button, one job"],
      ["Price", "$19–$25"],
      ["Built from", "About 7,500 lines of instructions"],
      ["Build time", "About 25 hours, about 3 working days"],
    ])}`,
  );
}

function openPhotonCard(name: string, opener: HTMLElement | null) {
  const p = PHOTONS.find((x) => x.name === name);
  if (p) openCard(photonCardHtml(p), opener);
}

// An Atom's character card, mirroring a Photon's: portrait, tagline,
// focus, introduction, and the plain price. An owned Atom gets the
// same "Start chatting" button a Photon gets, opening its thread;
// an unowned Atom keeps the buy button.
function atomCardHtml(a: (typeof ATOMS)[number]): string {
  // The Nova product opens every Atom's chat on the server, so its
  // owners count as owning each Atom here too.
  const owned =
    state?.freeCode === true ||
    (state?.ownedNovas || []).includes(a.name) ||
    (state?.ownedProducts || []).includes("nova");
  // An Atom's backstory, from the day the owner's account was created —
  // the same welcome material as a Photon's. Empty for accounts that
  // never signed in. It is read here, on the card, and again as the
  // thread intro when the thread is opened.
  const story = (state as any)?.backstories?.[a.name] || "";
  const body = `
    <div class="card-hero">${atomPortraitHtml(a.name, 140)}</div>
    <h2 class="card-title">${esc(novaLabel(a))}</h2>
    <p class="card-kind">Nova · ${esc(a.pronoun)}</p>
    <p class="card-tagline">${esc(a.tagline)}</p>
    <p><b>What ${esc(novaLabel(a))} does out of the box:</b> ${esc(a.focus)}</p>
    <p class="card-intro">“${esc(a.intro.replaceAll("{name}", novaLabel(a)))}”</p>
    ${story ? `<p><b>How ${esc(novaLabel(a))} began:</b> ${esc(story)}</p>` : ""}
    ${cardStats([
      ["Price", "$79.00 ($81.37 at checkout)"],
      ["Or monthly", "$10/mo ($10.30 at checkout)"],
      ["Chats", "300 chats a month, free forever — no subscription needed"],
    ])}
    <p class="fine">A Nova is for your own day, not a business: your inbox, with replies drafted in your words, your calendar and reminders, a morning briefing, and gentle check-ins.</p>
    <div class="card-actions">
      ${owned ? `<span class="owned-badge">Owned — yours already</span><button class="btn primary" data-action="card-chat-atom" data-atom="${esc(a.name)}">Start chatting</button>` : buyButton(buyUrl(NOVA.url, "Nova-" + a.name), "$81.37", false)}
    </div>`;
  return cardShell(novaLabel(a), body);
}

function openAtomCard(name: string, opener: HTMLElement | null) {
  const a = ATOMS.find((x) => x.name === name);
  if (a) openCard(atomCardHtml(a), opener);
}

function openProductCard(slug: string, opener: HTMLElement | null) {
  if (slug === "personality-builder") {
    openCard(personalityCardHtml(), opener);
    return;
  }
  const p = PRODUCTS.find((x) => x.slug === slug);
  if (p) openCard(productCardHtml(p), opener);
}

function openTierCard(tier: "supernova" | "satellite" | "upkeep", opener: HTMLElement | null) {
  openCard(tierCardHtml(tier), opener);
}

// Dismissal: a tap on the backdrop itself (not on the sheet), and the
// Escape key. The X and Close buttons go through the click handler.
document.addEventListener("click", (e) => {
  const m = cardModal();
  if (!m.hidden && e.target === m) closeCard();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCard();
});

// ---------- Connected extras: Messages, Contacts, Calendar, Drive ----------
// Draft-first state: nothing sends, books, or cancels until the owner
// taps the confirm button on a review panel. These live outside `state`
// so a re-render never loses a draft the owner is looking at.
let textDraft: { to: string; toLabel: string; body: string } | null = null;
let bookDraft: { title: string; start: string; end: string; description: string; attendees: string[] } | null = null;
let confirmCancelId: string | null = null;
let driveQuery = "";
// Contacts imported from a .vcf / .csv file on the phone, waiting for the
// owner to tap "Request connection" on each one. Nothing is sent by the
// import itself; each tap files one friend-request email.
let importedContacts: { name: string; email: string; phone: string }[] = [];
let importSkipped = 0;

function fmtWhen(iso: string): string {
  if (!iso) return "";
  // All-day dates come back as YYYY-MM-DD; show the date, not midnight.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const d = new Date(iso + "T12:00:00");
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  }
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtDateOnly(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Parse a .vcf (vCard) file into { name, email, phone } rows. Folded
// lines (a continuation starting with a space) are unfolded first.
function parseVcf(text: string): { name: string; email: string; phone: string }[] {
  const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\r[ \t]/g, "").replace(/\n[ \t]/g, "");
  const out: { name: string; email: string; phone: string }[] = [];
  for (const card of unfolded.split(/BEGIN:VCARD/i).slice(1)) {
    const lines = card.split(/\r\n|\r|\n/);
    let name = "", email = "", phone = "";
    for (const line of lines) {
      const m = line.match(/^([^;:]+)(?:;[^:]*)?:(.*)$/);
      if (!m) continue;
      const key = m[1].toUpperCase();
      const val = m[2].trim();
      if (key === "FN" && !name) name = val;
      else if (key === "EMAIL" && !email) email = val;
      else if (key === "TEL" && !phone) phone = val;
    }
    if (email) out.push({ name: name || email, email, phone });
    else importSkipped++;
  }
  return out;
}

// Parse a .csv file into { name, email, phone } rows. A header row with
// name / email / phone (or e-mail / tel / telephone) sets the columns;
// without one, the columns are taken as name, email, phone in order.
function parseCsv(text: string): { name: string; email: string; phone: string }[] {
  const rows: string[][] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (!raw.trim()) continue;
    const cells: string[] = [];
    let cur = "", inQ = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (inQ) {
        if (ch === '"') {
          if (raw[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  if (!rows.length) return [];
  const head = rows[0].map((c) => c.toLowerCase());
  const hasHeader = head.some((c) => ["name", "email", "e-mail", "phone", "tel", "telephone"].includes(c));
  const col = (names: string[]) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const nameI = hasHeader ? col(["name"]) : 0;
  const emailI = hasHeader ? col(["email", "e-mail"]) : 1;
  const phoneI = hasHeader ? col(["phone", "tel", "telephone"]) : 2;
  const data = hasHeader ? rows.slice(1) : rows;
  const out: { name: string; email: string; phone: string }[] = [];
  for (const r of data) {
    const email = emailI >= 0 ? (r[emailI] || "") : "";
    const name = nameI >= 0 ? (r[nameI] || "") : "";
    const phone = phoneI >= 0 ? (r[phoneI] || "") : "";
    if (email && email.includes("@")) out.push({ name: name || email, email, phone });
    else importSkipped++;
  }
  return out;
}

function dedupeImported(rows: { name: string; email: string; phone: string }[]): { name: string; email: string; phone: string }[] {
  const seen = new Set<string>();
  const out: { name: string; email: string; phone: string }[] = [];
  for (const r of rows) {
    const key = r.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ---------- Memory from another AI ----------
// Parse a file the owner picked from their phone into one import: what
// they already told another assistant, so they keep continuity and do
// not start over. Accepted shapes, all read on this device only:
//   - ChatGPT export (.json): { conversations: [{ title, mapping: { id:
//     { message: { author: { role }, content: { parts: [...] } } } } }] }
//   - Claude export (.json): [{ name, chat_messages: [{ sender, text }] }]
//     or [{ name, messages: [{ role, content }] }]
//   - A plain list of messages (.json): [{ role, content }] or
//     { messages: [...] } or { conversations: [...] } in either shape.
//   - Notes (.md, .txt): the whole file as one memory note.
// Anything else says so plainly and imports nothing. A parsed import is
// capped at 200 messages and 1,000,000 characters; the server caps it
// again when it is stored.
const MEMORY_MAX_MESSAGES = 200;
const MEMORY_MAX_CHARS = 1_000_000;

function memoryLinesFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .map((p) => (typeof p === "string" ? p : typeof (p as any)?.text === "string" ? (p as any).text : ""))
    .filter(Boolean)
    .join("\n");
}

function memoryTurn(role: string, text: string): string | null {
  const t = String(text || "").trim();
  if (!t) return null;
  const who = role === "user" || role === "human" ? "You" : role === "assistant" ? "Assistant" : role;
  return `${who}: ${t}`;
}

function memoryFromChatGpt(data: any): { title: string; content: string; count: number } | null {
  const convos = Array.isArray(data?.conversations) ? data.conversations : null;
  if (!convos) return null;
  const lines: string[] = [];
  let count = 0;
  let title = "ChatGPT export";
  for (const c of convos) {
    if (count >= MEMORY_MAX_MESSAGES) break;
    const name = typeof c?.title === "string" && c.title ? c.title : "Conversation";
    if (convos.length === 1) title = `ChatGPT: ${name}`;
    const mapping = c?.mapping;
    if (!mapping || typeof mapping !== "object") continue;
    const nodes = Object.values(mapping) as any[];
    const turns: string[] = [];
    for (const n of nodes) {
      if (count >= MEMORY_MAX_MESSAGES) break;
      const msg = n?.message;
      if (!msg || typeof msg !== "object") continue;
      const role = msg.author?.role;
      if (role !== "user" && role !== "assistant") continue;
      const content = msg.content;
      if (!content || typeof content !== "object") continue;
      const text =
        content.content_type === "text" || Array.isArray(content.parts)
          ? memoryLinesFromParts(content.parts)
          : typeof content.text === "string"
            ? content.text
            : "";
      const turn = memoryTurn(role, text);
      if (turn) {
        turns.push(turn);
        count++;
      }
    }
    if (turns.length) lines.push(`--- ${name} ---\n${turns.join("\n")}`);
  }
  if (!count) return null;
  return { title, content: lines.join("\n\n").slice(0, MEMORY_MAX_CHARS), count };
}

function memoryFromClaude(data: any): { title: string; content: string; count: number } | null {
  const convos = Array.isArray(data)
    ? data
    : Array.isArray(data?.conversations)
      ? data.conversations
      : null;
  if (!convos) return null;
  const lines: string[] = [];
  let count = 0;
  let title = "Claude export";
  for (const c of convos) {
    if (count >= MEMORY_MAX_MESSAGES) break;
    const name = typeof c?.name === "string" && c.name ? c.name : typeof c?.title === "string" && c.title ? c.title : "Conversation";
    if (convos.length === 1) title = `Claude: ${name}`;
    const msgs = Array.isArray(c?.chat_messages)
      ? c.chat_messages
      : Array.isArray(c?.messages)
        ? c.messages
        : null;
    if (!msgs) continue;
    const turns: string[] = [];
    for (const m of msgs) {
      if (count >= MEMORY_MAX_MESSAGES) break;
      const role = m?.sender || m?.role;
      const text = typeof m?.text === "string" ? m.text : typeof m?.content === "string" ? m.content : memoryLinesFromParts(m?.content?.parts);
      const turn = memoryTurn(role, text);
      if (turn) {
        turns.push(turn);
        count++;
      }
    }
    if (turns.length) lines.push(`--- ${name} ---\n${turns.join("\n")}`);
  }
  if (!count) return null;
  return { title, content: lines.join("\n\n").slice(0, MEMORY_MAX_CHARS), count };
}

function memoryFromMessageList(data: any): { title: string; content: string; count: number } | null {
  const msgs = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : null;
  if (!msgs) return null;
  const turns: string[] = [];
  for (const m of msgs) {
    if (turns.length >= MEMORY_MAX_MESSAGES) break;
    const role = m?.role || m?.sender;
    const text = typeof m?.content === "string" ? m.content : typeof m?.text === "string" ? m.text : memoryLinesFromParts(m?.content?.parts);
    const turn = memoryTurn(role, text);
    if (turn) turns.push(turn);
  }
  if (!turns.length) return null;
  return { title: "Message list", content: turns.join("\n").slice(0, MEMORY_MAX_CHARS), count: turns.length };
}

// Parse one picked file. Returns the import, or an error in plain words.
// Nothing is sent by parsing; the import only happens when the owner
// taps Import this memory.
function parseMemoryFile(
  name: string,
  text: string,
): { source: string; title: string; content: string; summary: string } | { error: string } {
  const lower = name.toLowerCase();
  if (lower.endsWith(".md") || lower.endsWith(".txt")) {
    const clean = text.slice(0, MEMORY_MAX_CHARS);
    if (!clean.trim()) return { error: "That file is empty. Nothing was imported." };
    const title = name.replace(/\.(md|txt)$/i, "") || "Notes";
    return {
      source: "Notes file",
      title,
      content: clean,
      summary: `${clean.length.toLocaleString()} characters of notes from ${name}.`,
    };
  }
  if (!lower.endsWith(".json")) {
    return { error: "That file type is not accepted. Pick a .json export, or notes as .md or .txt." };
  }
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "That file is not valid JSON. Nothing was imported." };
  }
  const parsed =
    memoryFromChatGpt(data) || memoryFromClaude(data) || memoryFromMessageList(data);
  if (!parsed) {
    return {
      error:
        "That file did not look like a ChatGPT export, a Claude export, or a plain list of messages. Nothing was imported.",
    };
  }
  const source =
    memoryFromChatGpt(data) ? "ChatGPT export" : memoryFromClaude(data) ? "Claude export" : "Message list";
  return {
    source,
    title: parsed.title,
    content: parsed.content,
    summary: `${parsed.count} message${parsed.count === 1 ? "" : "s"} from ${name}, ${parsed.content.length.toLocaleString()} characters.`,
  };
}

function meterLine(): string {
  if (!state) return "";
  const m = state.meter;
  if (m.unlimited) return "Unlimited chat";
  return `${m.used} of ${m.limit} chats used this month`;
}

function meterBar(): string {
  if (!state) return "";
  const m = state.meter;
  if (m.unlimited) return `<div class="meter-bar"><div class="meter-fill" style="width:100%"></div></div>`;
  const pct = Math.min(100, Math.round((m.used / m.limit) * 100));
  return `<div class="meter-bar"><div class="meter-fill" style="width:${pct}%"></div></div>`;
}

function photonCard(p: any, size = 150): string {
  const owned = p.owned;
  // The owner's chosen look set tints this Photon's card, so the
  // choice is visible before the chat is even opened.
  const look = lookSetById(customFor(p.name).lookSet || "");
  // Picture-led (Nov 22, 2026 declutter): the portrait and the name
  // carry the card; the tagline lives on the character card in the
  // Store, not on the front.
  return `<button class="photon-card${look ? ` look-${look.id}` : ""}" data-action="open-photon" data-photon="${esc(p.name)}" ${
    owned ? "" : "disabled"
  }>
    ${portraitHtml(portraitNameOf(p), size)}
    <span class="photon-name">${esc(superLabel(p))}</span>
  </button>`;
}

// An Atom's card on the Chat front, mirroring a Photon's: tap opens
// the Atom's thread through the same openThread path.
function atomCard(a: (typeof ATOMS)[number], size = 150): string {
  return `<button class="photon-card" data-action="open-atom" data-atom="${esc(a.name)}">
    ${atomPortraitHtml(a.name, size)}
    <span class="photon-name">${esc(novaLabel(a))}</span>
  </button>`;
}

// ---------- Start My Day — the morning briefing Plug ----------
// The briefing walks the day top to bottom, one item at a time. The
// server is the source of truth: every confirm re-fetches, so the next
// item is always items[0]. Nothing is edited until the owner taps a
// choice on that item; dayConfirm is the only call that edits anything.
function ownsStartMyDay(): boolean {
  return state?.freeCode === true || (state?.ownedProducts || []).includes("start-my-day");
}

function todayWindow(): { timeMin: string; timeMax: string; date: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const date = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
  return { timeMin: start.toISOString(), timeMax: end.toISOString(), date };
}

async function loadDayBriefing() {
  if (dayLoading) return;
  dayLoading = true;
  render();
  const w = todayWindow();
  const r = await api.dayBriefing(w.timeMin, w.timeMax, w.date);
  dayLoading = false;
  if (r && r.ok) {
    dayData = r;
    dayMoveOpen = false;
  } else {
    toast(r?.error || "The briefing didn't come back. Try again.", "err");
  }
  render();
}

async function dayConfirmCurrent(action: string, extra?: Record<string, unknown>) {
  if (!dayData || dayBusy) return;
  const item = (dayData.items || [])[0];
  if (!item) return;
  dayBusy = true;
  const r = await api.dayConfirm(item.kind, item.id, action, extra);
  dayBusy = false;
  if (r && r.ok) {
    dayHandled++;
    dayMoveOpen = false;
    toast(r.message || "Done.");
    await loadDayBriefing();
  } else {
    toast(r?.message || "That didn't save. Try again.", "err");
    render();
  }
}

function dayMoveWith(start: Date) {
  const item = (dayData?.items || [])[0];
  if (!item) return;
  if (Number.isNaN(start.getTime())) {
    toast("That time doesn't work. Pick another.", "err");
    return;
  }
  if (item.kind === "event") {
    // Keep the event's length: end moves by the same amount as start.
    const dur =
      item.when && item.end ? Date.parse(item.end) - Date.parse(item.when) : 60 * 60 * 1000;
    const end = new Date(start.getTime() + Math.max(dur, 15 * 60 * 1000));
    dayConfirmCurrent("move", {
      start: start.toISOString(),
      end: end.toISOString(),
      title: item.title,
      description: item.description || undefined,
      location: item.location || undefined,
      attendees: item.attendees || [],
    });
  } else {
    dayConfirmCurrent("move", { when: start.toISOString() });
  }
}

function dayMoveQuick(when: string) {
  const item = (dayData?.items || [])[0];
  if (!item) return;
  const now = new Date();
  if (when === "later") {
    // Two hours from the item's time, or from now if it already started.
    const base = item.when ? new Date(item.when) : now;
    const from = new Date(Math.max(base.getTime(), now.getTime()));
    dayMoveWith(new Date(from.getTime() + 2 * 60 * 60 * 1000));
  } else {
    // Tomorrow: same time as the item, or 9 AM when it has no time.
    const base = item.when ? new Date(item.when) : null;
    if (base && !Number.isNaN(base.getTime())) {
      dayMoveWith(new Date(base.getTime() + 24 * 60 * 60 * 1000));
    } else {
      dayMoveWith(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0));
    }
  }
}

function renderDayBriefing(): string {
  const back = `<button class="back-btn" data-action="day-back">← Back to chat</button>`;
  if (dayLoading || !dayData) {
    return `<section class="front">${back}<div class="card"><h2>Start My Day</h2><p class="fine">Gathering today's items…</p></div></section>`;
  }
  const items = dayData.items || [];
  const counts = dayData.counts || { events: 0, reminders: 0, added: 0, total: 0 };
  const dateLabel = dayData.date ? fmtDateOnly(dayData.date) : "Today";
  const progress = `${dayHandled} handled · ${items.length} left`;
  const calNote =
    dayData.calendar && !dayData.calendar.connected
      ? `<p class="fine">${esc(dayData.calendar.message || "Calendar is not connected yet.")}</p><div class="row"><button class="btn" data-action="goto" data-tab="connected">Connect it in Connected</button></div>`
      : dayData.calendar && dayData.calendar.message
        ? `<p class="fine">${esc(dayData.calendar.message)}</p>`
        : "";
  let body = "";
  if (items.length) {
    const item = items[0];
    const whenLabel = item.when ? fmtTime(item.when) : "No set time";
    const endLabel = item.end ? ` — ${fmtTime(item.end)}` : "";
    const buttons =
      item.kind === "event"
        ? `<button class="btn primary" data-action="day-confirm" data-confirm="keep" ${dayBusy ? "disabled" : ""}>That's right</button>
           <button class="btn" data-action="day-move-show" ${dayBusy ? "disabled" : ""}>Move it</button>
           <button class="btn" data-action="day-confirm" data-confirm="cancel" ${dayBusy ? "disabled" : ""}>Cancel it</button>`
        : `<button class="btn primary" data-action="day-confirm" data-confirm="done" ${dayBusy ? "disabled" : ""}>Done</button>
           <button class="btn" data-action="day-move-show" ${dayBusy ? "disabled" : ""}>Move it</button>
           <button class="btn" data-action="day-confirm" data-confirm="skip" ${dayBusy ? "disabled" : ""}>Skip</button>`;
    const moveForm = dayMoveOpen
      ? `<div class="card day-move">
           <h3>Move it to when?</h3>
           <div class="row">
             <button class="btn small" data-action="day-move-quick" data-when="later">In 2 hours</button>
             <button class="btn small" data-action="day-move-quick" data-when="tomorrow">Tomorrow</button>
           </div>
           <div class="row">
             <input id="day-move-when" type="datetime-local" aria-label="New time">
             <button class="btn primary" data-action="day-move-custom">Move it</button>
           </div>
           <button class="btn small" data-action="day-move-show">Never mind</button>
         </div>`
      : "";
    body = `
      <div class="day-item">
        <p class="kind">${esc(item.source)}</p>
        <p class="day-when">${esc(whenLabel)}${esc(endLabel)}</p>
        <h3>${esc(item.title)}</h3>
        ${item.detail ? `<p>${esc(item.detail)}</p>` : ""}
      </div>
      <div class="row">${buttons}</div>
      ${moveForm}`;
  } else {
    body = `
      <h3>That's the day.</h3>
      <p>${dayHandled ? `You handled ${dayHandled} item${dayHandled === 1 ? "" : "s"} in this briefing.` : "Nothing on today's list."}${dayData.doneAddedToday ? ` ${dayData.doneAddedToday} added item${dayData.doneAddedToday === 1 ? "" : "s"} done today.` : ""}</p>`;
  }
  return `<section class="front">
    ${back}
    <div class="card day-card">
      <h2>Start My Day</h2>
      <p class="fine">${esc(dateLabel)} · ${esc(progress)}</p>
      <p class="fine">Today: ${counts.events} event${counts.events === 1 ? "" : "s"} · ${counts.reminders} reminder${counts.reminders === 1 ? "" : "s"} · ${counts.added} added</p>
      ${calNote}
      ${body}
      <h3>Add to today</h3>
      <form id="day-add-form" class="row day-add-form">
        <input id="day-add-title" type="text" maxlength="200" placeholder="Add something to today…" required aria-label="Item title">
        <input id="day-add-when" type="datetime-local" aria-label="When (optional)">
        <button class="btn primary" type="submit">Add to today</button>
      </form>
      <p class="fine">Anything you add joins today's plan and shows up here the next time you open the briefing.</p>
    </div>
  </section>`;
}

// ---------- Chat front page ----------
// One home screen, one job (redesign, Nov 19, 2026): your Faces and
// your day, and nothing else competing with them. The hero image, the
// name form, the usage meter, the upsell line and the mission strip
// all left this screen — the name and the meter live under You now,
// and buying lives in the Store. The empty state has one way forward:
// the Store tab, which is the one place to get a Face.
// ---------- Vending machines ----------
// The rosters live in two rotating-drum merchandisers now (Nov 22,
// 2026), modelled on the classic rotating-drum cabinet Neil picked
// from his reference photo: a lit Prism 5 Labs marquee, a curved
// glass-fronted drum whose compartments carry one Face each like a
// packaged good on a shelf, a side panel with a backlit display, a
// code keypad, a coin slot and a cherry DISPENSE button, a brass
// maker's plate, and a pickup bay underneath. The full roster also
// sits in a dropdown list under each machine, closed by default.
// The drum steps one compartment at a time — Prev/Next, the keypad,
// the list, or a horizontal drag on the glass — and the front
// compartment is the selection, lit behind the glass while the rest
// curve away and dim. There is NO auto-advance: the drum moves only
// when the visitor works it, and the turn is instant under reduced
// motion. In the Store, DISPENSE drops the selected Face's ordinary
// store card into the bay — the buy flow itself is unchanged, and
// the Store stays the only place to buy or redeem. On the Chat
// front, DISPENSE opens the selected Face's thread, exactly what
// tapping its card has always done, and the cards in the drum keep
// that same tap. The current selection is remembered per machine
// across re-renders, the same way storeOpen is.
const machineIndex: Record<string, number> = {};

interface MachineItem {
  code: string;
  name: string;
  // The name the open actions use (a Photon's base name; the display
  // name can differ once the owner renames a Face).
  openName: string;
  role: string;
  price: string;
  pack: string;
  bay?: string;
}

function machineCode(i: number): string {
  return `${i < 6 ? "A" : "B"}${(i % 6) + 1}`;
}

// Signed distance of compartment i from the front, in steps.
function machineOffset(i: number, idx: number, n: number): number {
  let off = (i - idx) % n;
  if (off > n / 2) off -= n;
  if (off < -n / 2) off += n;
  return off;
}

function machineHtml(
  id: string,
  opts: {
    title: string;
    priceLine: string;
    listLabel: string;
    dispenseAction: string;
    kind: "photon" | "atom";
    items: MachineItem[];
  },
): string {
  const items = opts.items;
  const n = items.length;
  const idx = Math.min(machineIndex[id] || 0, n - 1);
  const step = 360 / n;
  const radius = n <= 1 ? 0 : n === 2 ? 70 : Math.round(52 / Math.tan(Math.PI / n));
  const panels = items
    .map((it, i) => {
      const dist = Math.abs(machineOffset(i, idx, n));
      const style = `transform: rotateY(${i * step}deg) translateZ(${radius}px); opacity: ${dist === 0 ? 1 : dist === 1 ? 0.72 : dist === 2 ? 0.45 : 0}; visibility: ${dist <= 2 ? "visible" : "hidden"}`;
      return `<div class="machine-panel${dist === 0 ? " front" : ""}" data-index="${i}" data-code="${esc(it.code)}" data-name="${esc(it.name)}" data-open-name="${esc(it.openName)}" data-role="${esc(it.role)}" data-price="${esc(it.price)}" style="${style}">
        <div class="machine-pack">
          <div class="pack-top">${logoHtml(10)}<span>PRISM 5 LABS</span></div>
          ${it.pack}
          <div class="pack-code">${esc(it.code)}</div>
        </div>
      </div>`;
    })
    .join("");
  const sel = items[idx];
  const keys = items
    .map(
      (it, i) =>
        `<button class="machine-key${i === idx ? " active" : ""}" data-action="machine-key" data-machine="${id}" data-index="${i}" aria-label="Show ${esc(it.name)}">${esc(it.code)}</button>`,
    )
    .join("");
  const list = items
    .map(
      (it, i) =>
        `<button class="machine-list-item${i === idx ? " active" : ""}" data-action="machine-key" data-machine="${id}" data-index="${i}"><span class="list-code">${esc(it.code)}</span>${esc(it.name)}</button>`,
    )
    .join("");
  const bay = items.some((it) => it.bay)
    ? `<div class="machine-bay">
        <div class="machine-bay-flap" aria-hidden="true">PUSH</div>
        ${items.map((it, i) => `<div class="machine-bay-card${i === idx ? " active" : ""}">${it.bay || ""}</div>`).join("")}
      </div>`
    : "";
  return `<div class="machine" data-machine="${id}" data-kind="${opts.kind}" role="region" aria-label="${esc(opts.title)} vending machine">
    <div class="machine-marquee">
      <span class="machine-marquee-mark">${logoHtml(22)}</span>
      <span class="machine-marquee-brand">PRISM 5 LABS</span>
      <span class="machine-marquee-title">${esc(opts.title)}</span>
      ${opts.priceLine ? `<span class="machine-marquee-price">${esc(opts.priceLine)}</span>` : ""}
    </div>
    <div class="machine-body">
      <div class="machine-window">
        <div class="machine-drum" style="transform: rotateY(${-idx * step}deg)">${panels}</div>
        <div class="machine-glass" aria-hidden="true"></div>
      </div>
      <div class="machine-side">
        <div class="machine-lcd" aria-live="polite">
          <span class="lcd-code">${esc(sel.code)}</span>
          <span class="lcd-name">${esc(sel.name)}</span>
          <span class="lcd-role">${esc(sel.role)}</span>
          ${sel.price ? `<span class="lcd-price">${esc(sel.price)}</span>` : ""}
        </div>
        <div class="machine-keypad" role="group" aria-label="Pick a compartment by code">${keys}</div>
        <div class="machine-controls">
          <button class="btn machine-step-btn" data-action="machine-prev" data-machine="${id}" aria-label="Previous in ${esc(opts.title)}">← Prev</button>
          <span class="machine-coin" aria-hidden="true"></span>
          <button class="btn machine-step-btn" data-action="machine-next" data-machine="${id}" aria-label="Next in ${esc(opts.title)}">Next →</button>
        </div>
        <button class="machine-dispense-btn" data-action="${opts.dispenseAction}" data-machine="${id}">DISPENSE</button>
        <div class="machine-plate">${logoHtml(12)}<span>Prism 5 Labs</span></div>
      </div>
    </div>
    ${bay}
    <details class="machine-list">
      <summary>${esc(opts.listLabel)}</summary>
      <div class="machine-list-items">${list}</div>
    </details>
  </div>`;
}

// Step a machine without a full re-render: the drum turns in place,
// so the page does not jump and the Store's open sections stay open.
function machineGo(id: string, next: number): void {
  const root = document.querySelector(`.machine[data-machine="${id}"]`);
  if (!root) return;
  const panels = [...root.querySelectorAll(".machine-panel")] as HTMLElement[];
  if (!panels.length) return;
  const n = panels.length;
  const idx = ((next % n) + n) % n;
  machineIndex[id] = idx;
  const step = 360 / n;
  const drum = root.querySelector(".machine-drum") as HTMLElement | null;
  if (drum) drum.style.transform = `rotateY(${-idx * step}deg)`;
  panels.forEach((pn, i) => {
    const dist = Math.abs(machineOffset(i, idx, n));
    pn.classList.toggle("front", dist === 0);
    pn.style.opacity = dist === 0 ? "1" : dist === 1 ? "0.72" : dist === 2 ? "0.45" : "0";
    pn.style.visibility = dist <= 2 ? "visible" : "hidden";
  });
  const sel = panels[idx].dataset;
  const setText = (cls: string, v: string) => {
    const el = root.querySelector(`.${cls}`) as HTMLElement | null;
    if (el) el.textContent = v;
  };
  setText("lcd-code", sel.code || "");
  setText("lcd-name", sel.name || "");
  setText("lcd-role", sel.role || "");
  setText("lcd-price", sel.price || "");
  root.querySelectorAll(".machine-key, .machine-list-item").forEach((k) => {
    k.classList.toggle(
      "active",
      Number((k as HTMLElement).dataset.index || -1) === idx,
    );
  });
  root.querySelectorAll(".machine-bay-card").forEach((c, i) => {
    c.classList.toggle("active", i === idx);
  });
}

function renderChatFront(): string {
  // The state payload names this list "supernovas" (stateFor in
  // src/server.ts). This line read "photons" — a leftover the Nov 25
  // wording sweep missed — so the list was always empty and the Chat
  // front showed an owner's Novas but never their Supernovas
  // (Neil, Nov 25, 2026: "only seeing Novas and no Supernovas").
  const owned = (state?.supernovas || []).filter((p: any) => p.owned);
  // Owned Atoms, the same rule the server chats by: the Atom's own row,
  // the Nova product (which opens every Atom), or the free code.
  const ownsEveryAtom =
    state?.freeCode === true || (state?.ownedProducts || []).includes("nova");
  const ownedNovas = ATOMS.filter(
    (a) => ownsEveryAtom || (state?.ownedNovas || []).includes(a.name),
  );
  const supernovaShelf =
    owned.length > 0
      ? `<h2 class="front-strip-label">Your Supernovas</h2>` +
        machineHtml("front-supernovas", {
          title: "SUPERNOVAS",
          priceLine: "",
          listLabel: `See all ${owned.length} of your Supernovas`,
          dispenseAction: "machine-dispense-chat",
          kind: "photon",
          items: owned.map((p: any, i: number) => ({
            code: machineCode(i),
            name: faceNameOf(p),
            openName: p.name,
            role: PHOTONS.find((x) => x.name === p.name)?.tagline || "",
            price: "",
            pack: photonCard(p, 84),
          })),
        })
      : "";
  const novaShelf =
    ownedNovas.length > 0
      ? `<h2 class="front-strip-label">Your Novas</h2>` +
        machineHtml("front-novas", {
          title: "NOVAS",
          priceLine: "",
          listLabel: `See all ${ownedNovas.length} of your Novas`,
          dispenseAction: "machine-dispense-chat",
          kind: "atom",
          items: ownedNovas.map((a, i: number) => ({
            code: machineCode(i),
            name: a.name,
            openName: a.name,
            role: a.tagline,
            price: "",
            pack: atomCard(a, 84),
          })),
        })
      : "";
  // Both shelves show when both are owned; the side the owner is on
  // (the switch at the top of this front) puts its shelf first.
  const ownedHtml =
    supernovaShelf || novaShelf
      ? sideOrDefault() === "personal"
        ? novaShelf + supernovaShelf
        : supernovaShelf + novaShelf
      : `<div class="card empty-panel">
          <div class="card-head"><img class="mark" src="/brand/gem.jpg" alt=""><h2>Nothing to talk to yet.</h2></div>
          <button class="btn store-outline store-btn" data-action="goto" data-tab="store">Browse the Store</button>
        </div>`;
  // The Business / Personal switch, on the shelf view itself (Nov 25,
  // 2026): before this it lived only at the top of the Store and down
  // in You → Settings, so an owner on the Chat front had to hunt for
  // it. Same side-pick action as everywhere else — the choice
  // persists on the device and the account, and the Store follows.
  const isPersonalSide = sideOrDefault() === "personal";
  const sideSwitchHtml = `
    <div class="store-side-switch front-side-switch" role="group" aria-label="Business or Personal">
      <button class="btn${isPersonalSide ? "" : " primary"}" data-action="side-pick" data-side="business" aria-pressed="${isPersonalSide ? "false" : "true"}">Business</button>
      <button class="btn${isPersonalSide ? " primary" : ""}" data-action="side-pick" data-side="personal" aria-pressed="${isPersonalSide ? "true" : "false"}">Personal</button>
    </div>`;
  const ownedPhotonNames = new Set(owned.map((p: any) => p.name));
  const ownedAtomNames = new Set(ownedNovas.map((a) => a.name));
  const pinnedOwned = pinnedFaces.filter(
    (name) => ownedPhotonNames.has(name) || ownedAtomNames.has(name),
  );
  const pinnedHtml = pinnedOwned.length
    ? `<h2 class="front-strip-label">Pinned</h2><div class="pinned-list">` +
      pinnedOwned
        .map((name) => {
          const photonObj = owned.find((p: any) => p.name === name);
          const label = labelForName(name);
          return photonObj
            ? `<button class="btn pinned-row" data-action="open-photon" data-photon="${esc(name)}">${esc(label)}</button>`
            : `<button class="btn pinned-row" data-action="open-atom" data-atom="${esc(name)}">${esc(label)}</button>`;
        })
        .join("") +
      `</div>`
    : "";
  const searchResultsHtml =
    conversationSearchResults === null
      ? ""
      : conversationSearchResults.length === 0
        ? `<p class="fine">No conversations found for &ldquo;${esc(conversationSearchQuery)}&rdquo;.</p>`
        : conversationSearchResults
            .map(
              (r: any) => `<button class="inbox-msg" data-action="search-open-thread" data-photon="${esc(String(r.photon || ""))}"><span class="inbox-subject">${esc(labelForName(String(r.photon || "")))}</span><span class="inbox-snippet">${esc(String(r.snippet || ""))}</span><span class="inbox-meta">${esc(r.role === "user" ? "You" : labelForName(String(r.photon || "")))} · ${esc(fmtWhen(String(r.created_at || "")))}</span></button>`,
            )
            .join("");
  const searchHtml = `
    <div class="card" id="conversation-search">
      <h3>Search your conversations</h3>
      <form id="conversation-search-form" class="row">
        <input id="conversation-search-input" type="search" placeholder="Search your conversations…" value="${esc(conversationSearchQuery)}" aria-label="Search your conversations">
        <button class="btn primary" type="submit">Search</button>
        ${conversationSearchQuery ? `<button class="btn" type="button" data-action="search-clear">Clear</button>` : ""}
      </form>
      ${searchResultsHtml}
      <p class="fine"><a href="${esc(api.exportAllUrl())}" download>Export all conversations</a> — one Markdown file with every conversation you hold.</p>
    </div>`;
  return `
  <section class="front">
    ${sideSwitchHtml}
    <div class="front-body">
      <h3 class="greeting">Howdy, <span class="greeting-accent">neighbor!</span></h3>
    </div>
    ${ownsStartMyDay()
      ? `<button class="day-strip" data-action="day-start"><img src="/brand/gem.jpg" alt=""><span>Start My Day</span></button>`
      : ""}
    ${pinnedHtml}
    ${searchHtml}
    ${ownedHtml}
  </section>`;
}

// A helper's backstory, from the day the owner's account was created.
// Display only, never saved into the thread. Empty for accounts that
// never signed in — the stories are an account-creation perk. Atoms
// carry backstories the same way Photons do.
function backstoryBlock(photon: string): string {
  const story = (state as any)?.backstories?.[photon];
  if (!story) return "";
  const p = PHOTONS.find((x) => x.name === photon);
  const portrait = p
    ? portraitHtml(portraitNameOf(p), 28)
    : atomPortraitHtml(photon, 28);
  return `<div class="msg bot">${portrait}<div><p><b>How ${esc(labelForName(photon))} began.</b></p><p>${esc(story)}</p></div></div>`;
}

// ---------- Chat thread ----------
function renderChatThread(): string {
  // One thread view for both rosters: a Photon, or an Atom when the
  // active name is not a Photon. Atoms have no customization, look
  // set, or call/report menu — those endpoints are Photon-only — so
  // an Atom thread is the plain conversation: its own portrait, its
  // own intro, and the same composer.
  const photon = PHOTONS.find((x) => x.name === activePhoton);
  const atom = photon ? undefined : ATOMS.find((x) => x.name === activePhoton);
  const p: any = photon || atom;
  if (!p) return renderChatFront();
  const isAtom = !!atom;
  const face = isAtom ? novaLabel(p) : superLabel(p);
  const portrait = isAtom ? p.name : portraitNameOf(p);
  const portraitImg = (size: number) =>
    isAtom ? atomPortraitHtml(portrait, size) : portraitHtml(portrait, size);
  const customized = !isAtom && !!(state as any)?.customizations?.[p.name];
  // The owner's chosen look set tints this Photon's chat surfaces.
  // The class lives on this section only — the brand bar and bottom
  // nav keep the house palette (readability spec §3A.6).
  const look = isAtom ? null : lookSetById(customFor(p.name).lookSet || "");
  // A streaming reply shows three dots until the first words land.
  const botMsg = (text: string, streaming = false) =>
    `<div class="msg bot${streaming ? " streaming" : ""}">${portraitImg(28)}<div><p>${text ? esc(text) : '<span class="typing"><span></span><span></span><span></span></span>'}</p></div></div>`;
  const msgs = threadMessages.length
    ? threadMessages
        .map((m: any) =>
          m.role === "user"
            ? `<div class="msg user"><p>${esc(m.content)}</p></div>`
            : botMsg(m.content, !!m.streaming),
        )
        .join("")
    // Empty thread: the helper introduces itself, who it is and what it
    // was built for, instead of a generic greeting. Display only, never
    // saved into the thread. A signed-in owner also sees how this
    // helper began — the backstory from the day the account was created.
    : botMsg(p.intro.replaceAll("{name}", face)) + backstoryBlock(p.name);
  return `
  <section class="thread${look ? ` look-${look.id}` : ""}">
    <div class="thread-head">
      <button class="back-btn" data-action="back-to-front">← <span>${isAtom ? "Back" : "All Supernovas"}</span></button>
      <div class="thread-title">
        <h2>${esc(face)}</h2>
        <span class="thread-tag">${esc(p.tagline)}</span>
        ${customized ? `<span class="thread-voice">Voice: ${esc(voiceNameOf(p.name))}</span>` : ""}
      </div>
      <a class="btn small" href="${esc(api.threadExportUrl(p.name))}" download>Export</a>
      <button class="btn small" data-action="${isPinnedFace(p.name) ? "unpin-face" : "pin-face"}" data-photon="${esc(p.name)}">${isPinnedFace(p.name) ? "Unpin" : "Pin"}</button>
      ${isAtom ? "" : `<details class="thread-menu">
        <summary aria-label="More options">···</summary>
        <div class="thread-menu-list">
          <button class="btn small" data-action="customize" data-photon="${esc(p.name)}">Customize</button>
          <button class="btn small call" data-action="call" data-photon="${esc(p.name)}">Call · Upkeep</button>
          <button class="btn small" data-action="report-prism" data-photon="${esc(p.name)}">Report to Prism 5</button>
        </div>
      </details>`}
    </div>
    <div class="thread-hero">${portraitImg(160)}</div>
    <div class="messages" id="messages">${msgs}</div>
    <div class="composer-dock">
      <div id="chat-error" class="chat-error" hidden></div>
      <form id="chat-form" class="composer">
        <input id="chat-input" type="text" placeholder="Ask ${esc(face)} anything…" autocomplete="off" aria-label="Message">
        <button class="send" type="submit" aria-label="Send message">${SEND_SVG}</button>
      </form>
      <form id="research-form" class="research-row">
        <input id="research-input" type="text" placeholder="Look something up live…" autocomplete="off" aria-label="Look something up live">
        <button class="btn small" type="submit">Look it up</button>
      </form>
      <div id="research-results" class="research-results" hidden></div>
    </div>
  </section>`;
}

// ---------- Customization wizard ----------
// Mirrors the install steps: 1 name, 2 voice, 3 look. Every step
// skippable, progress saved per Photon, never blocks chatting.
async function saveCustom(patch: Record<string, unknown>): Promise<boolean> {
  if (!customizePhoton) return false;
  const r = await api.customizeSave(customizePhoton, patch);
  if (r && r.ok && r.customization) {
    if (!state.customizations) state.customizations = {};
    state.customizations[customizePhoton] = r.customization;
    return true;
  }
  toast("That didn't save. Try again.", "err");
  return false;
}

function finishCustom() {
  const name = customizePhoton || "";
  customizePhoton = null;
  customizeDesign = false;
  if (name) openThread(name);
  else render();
}

function renderCustomName(p: any, c: Customization): string {
  return `
  <div class="card">
    <h3>Step 1 — One name for your Face</h3>
    <p>One name, like the install. It replaces "${esc(p.name)}" in chat for this Supernova only.</p>
    <form id="custom-name-form" class="row">
      <input id="custom-name-input" type="text" maxlength="40" placeholder="${esc(p.name)}" value="${esc(c.faceName || "")}" aria-label="Face name">
      <button class="btn primary" type="submit">Save name &amp; continue</button>
    </form>
    <p class="fine">Leave it blank to keep ${esc(p.name)}.</p>
    <button class="btn" data-action="custom-skip-step">Skip this step</button>
  </div>`;
}

function renderCustomVoice(p: any, c: Customization): string {
  const face = c.faceName || p.name;
  if (customizeDesign) {
    const answered = TUNING_QUESTIONS.filter((q) => q.key in customizeTuning).length;
    const rows = TUNING_QUESTIONS.map((q) => {
      const v = customizeTuning[q.key];
      return `<div class="tune-row">
        <p>${esc(q.question)}</p>
        <button class="tune-yn ${v === true ? "on" : ""}" data-action="custom-tune" data-q="${q.key}" data-v="yes">${esc(q.yes)}</button>
        <button class="tune-yn ${v === false ? "on" : ""}" data-action="custom-tune" data-q="${q.key}" data-v="no">${esc(q.no)}</button>
      </div>`;
    }).join("");
    const readback =
      answered === TUNING_QUESTIONS.length
        ? `<p class="fine">Your tuned voice: ${esc(tuningStyle(customizeTuning as any))}</p>`
        : `<p class="fine">Answer all seven, then read it back and save it.</p>`;
    return `
    <div class="card">
      <h3>Step 2 — Design your own voice</h3>
      <p>Seven plain yes-or-no questions. No long forms.</p>
      ${rows}
      ${readback}
      <div class="row">
        <button class="btn primary" data-action="custom-tune-save">Save voice &amp; continue</button>
        <button class="btn" data-action="custom-design-back">Back to voices</button>
      </div>
    </div>`;
  }
  const opts = VOICES.map((v) => {
    const sel = c.voice === v.id;
    return `<button class="voice-opt ${sel ? "selected" : ""}" data-action="custom-voice" data-voice="${esc(v.id)}">
      <b>${esc(v.name)}${v.id === "house" ? " · Default" : ""}${sel ? " ✓" : ""}</b>
      <span>${esc(v.blurb)}</span>
    </button>`;
  }).join("");
  return `
  <div class="card">
    <h3>Step 2 — Pick a voice</h3>
    <p>This is how ${esc(face)} talks in chat. The house voice is the default. Live voice calls are an Upkeep extra — tap Call in the chat menu and talk out loud, turn by turn.</p>
    ${opts}
    <button class="btn" data-action="custom-skip-step">Skip this step</button>
  </div>`;
}

function renderCustomLook(p: any, c: Customization): string {
  const face = c.faceName || p.name;
  const currentPortrait = c.portrait || p.name;
  const portraits = PHOTONS.map(
    (x) => `
    <button class="portrait-pick ${currentPortrait === x.name ? "selected" : ""}" data-action="custom-portrait" data-portrait="${esc(x.name)}" aria-label="Use the ${esc(x.name)} portrait">
      ${portraitHtml(x.name, 64)}
      <span>${esc(x.name)}</span>
    </button>`,
  ).join("");
  const sets = LOOK_SETS.map(
    (s) => `
    <button class="look-pick ${c.lookSet === s.id ? "selected" : ""}" data-action="custom-look" data-look="${esc(s.id)}">
      <b>${esc(s.name)}${c.lookSet === s.id ? " ✓" : ""}</b>
      <span>${esc(s.blurb)}</span>
    </button>`,
  ).join("");
  return `
  <div class="card">
    <h3>Step 3 — Pick a face and a look</h3>
    <p>Which portrait ${esc(face)} wears in chat, and the colors and style around it.</p>
    <div class="portrait-grid">${portraits}</div>
    ${sets}
    <div class="row">
      <button class="btn primary" data-action="custom-finish">Save &amp; start chatting</button>
      <button class="btn" data-action="custom-skip-step">Skip this step</button>
    </div>
  </div>`;
}

function renderCustomize(): string {
  const p = PHOTONS.find((x) => x.name === customizePhoton);
  if (!p) return renderChatFront();
  const c = customFor(p.name);
  const face = c.faceName || p.name;
  const tabs = [1, 2, 3]
    .map((n) => {
      const label = n === 1 ? "Name" : n === 2 ? "Voice" : "Look";
      const cls = n === customizeStep ? "active" : c.step >= n ? "done" : "";
      return `<button class="custom-step-tab ${cls}" data-action="custom-step" data-step="${n}">${n}. ${label}${c.step >= n && n !== customizeStep ? " ✓" : ""}</button>`;
    })
    .join("");
  return `
  <section class="customize">
    <button class="back-btn" data-action="custom-back">← ${c.done ? "Back to chat" : "All Supernovas"}</button>
    <h2 class="page-title">Make ${esc(face)} yours</h2>
    <p class="page-lede">Three quick steps, like the install. Skip any of them. Nothing here blocks chatting, and you can come back and change all of this later.</p>
    <div class="custom-steps">${tabs}</div>
    ${customizeStep === 1 ? renderCustomName(p, c) : customizeStep === 2 ? renderCustomVoice(p, c) : renderCustomLook(p, c)}
    <button class="btn custom-skip-all" data-action="custom-skip-all">Skip all — start chatting</button>
  </section>`;
}

async function openPhoton(name: string) {
  activePhoton = name;
  const c = customFor(name);
  if (!c.done) {
    // First time with this Photon: offer the customization steps, like
    // the install. Skipping everything drops straight into chat, and
    // progress is saved so the owner picks up where they left off.
    customizePhoton = name;
    customizeStep = Math.min(3, (c.step || 0) + 1);
    customizeDesign = false;
    customizeTuning = {};
    render();
    return;
  }
  openThread(name);
}

async function openThread(name: string) {
  activePhoton = name;
  customizePhoton = null;
  threadMessages = [];
  threadLoading = true;
  render();
  const r = await api.thread(name);
  threadLoading = false;
  if (r && r.ok) {
    threadMessages = r.messages || [];
  } else {
    threadMessages = [];
  }
  await loadPinnedFaces();
  render();
  scrollMessages();
}

function scrollMessages() {
  const m = document.getElementById("messages");
  if (m) m.scrollTop = m.scrollHeight;
}

function showChatError(msg: string) {
  const e = document.getElementById("chat-error") as HTMLElement | null;
  if (e) {
    e.textContent = msg;
    e.hidden = false;
  }
}

// The live streaming bubble: the <p> inside the last bot message, so
// tokens can be appended without re-rendering the thread (a re-render
// would rebuild the composer and eat anything the owner is typing).
function streamingBubbleText(): HTMLElement | null {
  const box = document.getElementById("messages");
  const p = box?.querySelector(".msg.bot.streaming p");
  return p as HTMLElement | null;
}

function appendStreamingText(text: string) {
  const p = streamingBubbleText();
  if (!p) return;
  const dots = p.querySelector(".typing");
  if (dots) dots.remove();
  p.appendChild(document.createTextNode(text));
  scrollMessages();
}

// Switchboard: send the Photon's latest reply to Prism 5 by email.
// The Photon drafts the report in chat; this button is the send. If the
// Prism 5 contact is not approved yet, the tap files the connection
// request instead, and nothing is sent until Prism 5 approves it.
async function reportToPrism(photon: string) {
  const last = [...threadMessages]
    .reverse()
    .find((m: any) => m.role === "assistant" && !m.streaming && String(m.content || "").trim());
  if (!last) {
    toast("Ask me to write the report first, then tap this.", "err");
    return;
  }
  const p = PHOTONS.find((x) => x.name === photon);
  const face = p ? faceNameOf(p) : photon;
  const r = await api.switchboardSend(
    photon,
    "prism5labstest@gmail.com",
    `Report from ${face}`,
    String(last.content),
    "Prism 5",
  );
  if (r && r.ok) toast("Report sent to Prism 5.");
  else if (r?.error === "connection_requested")
    toast("Connection request sent to Prism 5. Once they approve it, you can send reports.");
  else if (r?.error === "awaiting_approval")
    toast("Still waiting on Prism 5 to approve the connection.");
  else if (r?.error === "contact_declined") toast("Prism 5 declined the connection.");
  else if (r?.error === "gmail_not_connected")
    toast("Connect a Gmail account in Connected first, then send.", "err");
  else toast("That didn't send. Try again.", "err");
}

async function sendChat(text: string): Promise<string | null> {
  const input = document.getElementById("chat-input") as HTMLInputElement | null;
  // The keyboard goes away after sending, so the reply is readable
  // instead of hidden behind the text box.
  if (input) {
    input.value = "";
    input.blur();
  }
  const err = document.getElementById("chat-error") as HTMLElement | null;
  if (err) err.hidden = true;
  // Optimistic: show the user's message right away.
  threadMessages = [...threadMessages, { role: "user", content: text }];
  render();
  scrollMessages();
  // The reply bubble appears at once with three dots, so the app never
  // looks dead while the brain thinks. Tokens fill it in as they arrive.
  const streaming = { role: "assistant", content: "", streaming: true };
  threadMessages = [...threadMessages, streaming];
  render();
  scrollMessages();
  let gotText = "";
  let doneEv: any = null;
  let streamErr: any = null;
  let transportFailed = false;
  try {
    await api.chatStream(activePhoton || "", text, (ev) => {
      if (ev.delta) {
        gotText += ev.delta;
        streaming.content = gotText;
        appendStreamingText(ev.delta);
      }
      if (ev.done) doneEv = ev;
      if (ev.error) streamErr = ev;
    });
  } catch {
    transportFailed = true;
  }
  // Fold whatever arrived into the thread and render once, so the bubble
  // is a normal message from here on.
  threadMessages = threadMessages.filter((m) => m !== streaming);
  if (doneEv) {
    threadMessages = [...threadMessages, { role: "assistant", content: doneEv.reply || gotText }];
    if (doneEv.meter && state) state.meter = doneEv.meter;
    render();
    scrollMessages();
    return doneEv.reply || gotText || null;
  }
  if (gotText) {
    // A partial reply is better than none: show what arrived, plus why it stopped.
    threadMessages = [...threadMessages, { role: "assistant", content: gotText }];
    render();
    showChatError(streamErr?.message || "The reply stopped partway. Try that again in a moment.");
    scrollMessages();
    return gotText;
  }
  if (transportFailed) {
    // The stream never reached the server at all: one try on the plain
    // endpoint, which does not need streaming to work.
    const r = await api.chat(activePhoton || "", text);
    if (r && r.ok) {
      threadMessages = [...threadMessages, { role: "assistant", content: r.reply }];
      if (r.meter && state) state.meter = r.meter;
      render();
      scrollMessages();
      return r.reply || null;
    }
    threadMessages = threadMessages.slice(0, -1);
    render();
    showChatError(r?.message || "Something went wrong. Try that again in a moment.");
    return null;
  }
  // The brain answered with an error and nothing arrived. The message was
  // not saved and the meter was not touched. Show why.
  threadMessages = threadMessages.slice(0, -1);
  render();
  showChatError(streamErr?.message || "Something went wrong. Try that again in a moment.");
  return null;
}

// ---------- Live voice call screen (Step 5) ----------
// Turn-based only: the owner talks, then the Photon answers out loud.
// It is not a live phone call — there is no two-way audio, no barge-in.
// Mic record → POST /api/voice/transcribe → normal chat → POST /api/voice/say.
// The screen updates itself directly (no full render) while a turn is in
// flight, so the mic button and status line never lose their state.
let callStatusText = "";

function setCallStatus(text: string) {
  callStatusText = text;
  const el = document.getElementById("call-status");
  if (el) el.textContent = text;
}

function setCallPhase(phase: typeof callPhase) {
  callPhase = phase;
  const btn = document.getElementById("call-mic-btn") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = phase === "checking" || phase === "blocked" || phase === "transcribing" || phase === "speaking";
    btn.classList.toggle("recording", phase === "recording");
    btn.textContent = phase === "recording" ? "■ Stop" : "🎙️ Talk";
  }
  const heard = document.getElementById("call-heard");
  if (heard) heard.textContent = callHeard ? `You said: “${callHeard}”` : "";
}

function renderCallScreen(): string {
  const p = PHOTONS.find((x) => x.name === callPhotonName);
  if (!p) return renderChatFront();
  const face = faceNameOf(p);
  const blocked = callPhase === "blocked";
  const micDisabled = callPhase === "checking" || blocked;
  return `
  <section class="call-screen">
    <button class="back-btn" data-action="end-call">← Back to chat</button>
    <div class="call-hero">${portraitHtml(portraitNameOf(p), 120)}</div>
    <h2 class="page-title">Call ${esc(face)}</h2>
    <p class="page-lede">Turn-based voice: you talk, then ${esc(face)} answers out loud. It is not a live phone call — ${esc(face)} can't hear you while speaking.</p>
    <p id="call-status" class="call-status" role="status">${esc(callStatusText || "Checking voice…")}</p>
    <p id="call-heard" class="call-heard">${callHeard ? `You said: “${esc(callHeard)}”` : ""}</p>
    <button id="call-mic-btn" class="call-mic${callPhase === "recording" ? " recording" : ""}" data-action="call-mic" ${micDisabled ? "disabled" : ""}>${callPhase === "recording" ? "■ Stop" : "🎙️ Talk"}</button>
    ${blocked ? `<div class="row call-blocked-actions"><button class="btn primary" data-action="goto" data-tab="store" data-scroll="store-upkeep">Get Upkeep in the Store</button></div>` : ""}
    <p class="fine">Voice is an Upkeep extra, and it needs the server's ElevenLabs key. If either is missing, this screen says so instead of pretending the call works.</p>
  </section>`;
}

async function openCall(name: string) {
  callPhotonName = name;
  callHeard = "";
  callStatusText = "Checking voice…";
  callPhase = "checking";
  render();
  // The existing gate: owns the Photon, and has Upkeep.
  const gate = await api.voice(name);
  if (!gate || !gate.ok) {
    setCallPhase("blocked");
    setCallStatus(gate?.message || "Voice isn't available right now.");
    render();
    return;
  }
  const s = await api.voiceStatus();
  if (!s || !s.ok || !s.configured) {
    setCallPhase("blocked");
    setCallStatus(
      s?.message || "Live voice isn't set up yet — the server needs an ElevenLabs key.",
    );
    render();
    return;
  }
  if (!s.upkeep) {
    setCallPhase("blocked");
    setCallStatus("Live voice is set up, and it comes with Upkeep.");
    render();
    return;
  }
  setCallPhase("idle");
  setCallStatus("Tap the mic, talk, tap again — I'll answer out loud.");
}

function stopCallMedia() {
  if (callRecorder && callRecorder.state !== "inactive") {
    try {
      callRecorder.stop();
    } catch {
      // Already stopped.
    }
  }
  callRecorder = null;
  if (callStream) {
    callStream.getTracks().forEach((t) => t.stop());
    callStream = null;
  }
  if (callAudio) {
    callAudio.pause();
    callAudio = null;
  }
}

function endCall() {
  stopCallMedia();
  callPhotonName = null;
  callPhase = "idle";
  callHeard = "";
  render();
}

async function speakReply(photon: string, text: string) {
  const sayText = text.slice(0, 2000);
  setCallPhase("speaking");
  setCallStatus("Speaking…");
  const r = await api.voiceSay(photon, sayText);
  if (!r.ok || !r.blob) {
    setCallPhase("idle");
    setCallStatus(r.message || "I couldn't say that one out loud.");
    return;
  }
  if (r.fallback) {
    setCallStatus(
      "That voice pick has no matching ElevenLabs voice, so I'm using the house voice for this one.",
    );
  }
  if (!callAudio) callAudio = new Audio();
  const url = URL.createObjectURL(r.blob);
  const oldSrc = callAudio.src;
  callAudio.src = url;
  if (oldSrc.startsWith("blob:")) URL.revokeObjectURL(oldSrc);
  callAudio.onended = () => {
    if (callPhotonName) {
      setCallPhase("idle");
      setCallStatus("Tap the mic, talk, tap again — I'll answer out loud.");
    }
  };
  try {
    await callAudio.play();
  } catch {
    setCallPhase("idle");
    setCallStatus("The reply wouldn't play. Try again in a moment.");
  }
}

async function toggleCallMic() {
  const photon = callPhotonName || "";
  if (!photon) return;
  if (callRecorder && callRecorder.state === "recording") {
    callRecorder.stop(); // stopping ends the turn; transcription starts in onstop
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    setCallStatus("This browser can't record voice. Try a modern phone browser.");
    return;
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    setCallStatus("Microphone access was denied — allow it in the browser and try again.");
    return;
  }
  callStream = stream;
  callChunks = [];
  const recorder = new MediaRecorder(stream);
  callRecorder = recorder;
  recorder.ondataavailable = (e) => {
    if (e.data.size) callChunks.push(e.data);
  };
  recorder.onstop = async () => {
    if (callStream) {
      callStream.getTracks().forEach((t) => t.stop());
      callStream = null;
    }
    callRecorder = null;
    setCallPhase("transcribing");
    setCallStatus("Heard you — writing that down…");
    const blob = new Blob(callChunks, { type: recorder.mimeType || "audio/webm" });
    const tr = await api.voiceTranscribe(photon, blob);
    if (!tr.ok || !tr.text || !tr.text.trim()) {
      setCallPhase("idle");
      setCallStatus(tr.message || "I didn't catch any words in that one.");
      return;
    }
    callHeard = tr.text.trim();
    setCallStatus(`You said: “${callHeard}”`);
    const heard = document.getElementById("call-heard");
    if (heard) heard.textContent = `You said: “${callHeard}”`;
    // The transcribed text goes through the normal chat, so it is saved
    // and metered exactly like a typed message.
    const reply = await sendChat(callHeard);
    if (!reply) {
      setCallPhase("idle");
      setCallStatus("The reply didn't come through. Try that again in a moment.");
      return;
    }
    await speakReply(photon, reply);
  };
  recorder.start();
  setCallPhase("recording");
  setCallStatus("Listening… tap stop when you're done.");
}

async function callPhoton(name: string) {
  await openCall(name);
}

// ---------- Contacts address book ----------
// Switchboard contacts: who this owner's Photons may reach. A contact
// starts pending and the recipient approves or declines by tapping a link
// in the request email, like a friend request. Only approved contacts
// receive sends, and the Photon matches names from this book only — it
// never guesses a name for an unknown number or address.
// Channels are derived from what the server stores, nothing invented:
// approved + email = email; approved + a phone number on file = texts
// too; pending or declined = nothing can be sent yet.
function channelsFor(c: any): string {
  if (c.status === "declined") return "Declined — nothing can be sent";
  if (c.status !== "approved") return "Waiting for approval — nothing can be sent yet";
  return c.phone ? "Email ✓ · Texts ✓" : "Email ✓ · Texts — add a phone number";
}

function renderSwitchboardContacts(): string {
  const contacts = (state?.contacts || []) as any[];
  const prism = contacts.find(
    (c: any) => String(c.address || "").toLowerCase() === "prism5labstest@gmail.com",
  );
  const others = contacts.filter(
    (c: any) => String(c.address || "").toLowerCase() !== "prism5labstest@gmail.com",
  );
  const statusWord = (s: string) =>
    s === "approved" ? "Approved — can send" : s === "declined" ? "Declined" : "Waiting for approval";
  const row = (c: any) =>
    `<div class="inbox-msg"><p class="inbox-subject">${esc(c.name || c.address)}</p><p class="inbox-meta">${esc(c.address)}${c.phone ? ` · ${esc(c.phone)}` : ""} · ${esc(c.photon)} · ${statusWord(c.status)}</p><p class="inbox-meta">Channels: ${esc(channelsFor(c))}</p></div>`;
  const owned = (state?.ownedSupernovas || []) as string[];
  const photonOpts = (owned.length ? owned : ["Prism"])
    .map((n: string) => `<option value="${esc(n)}">${esc(n)}</option>`)
    .join("");
  const importRows = importedContacts
    .map(
      (c, i) => `<div class="inbox-msg"><p class="inbox-subject">${esc(c.name)}</p><p class="inbox-meta">${esc(c.email)}${c.phone ? ` · ${esc(c.phone)}` : ""}</p><button class="btn small primary" data-action="import-add" data-idx="${i}">Request connection</button></div>`,
    )
    .join("");
  return `<div class="card" id="contacts">
    <h3>Contacts — address book</h3>
    <p class="fine">Switchboard is email and texts. A Supernova can only send to a contact who approved the connection first, like a friend request. Names come from this book only — an unknown number stays an unknown number, never a guessed name.</p>
    ${prism ? row(prism) : `<p class="fine">Prism 5 (prism5labstest@gmail.com) — no connection yet. Ask a Supernova to write a report, then tap Report to Prism 5 in chat.</p>`}
    ${others.map(row).join("") || `<p class="fine">No other contacts yet.</p>`}
    <form class="contact-form">
      <h4>Add someone by hand</h4>
      <input name="name" type="text" placeholder="Name" required>
      <input name="address" type="email" placeholder="Email address" required>
      <input name="phone" type="tel" placeholder="Phone (optional — needed for texts)">
      <select name="photon" aria-label="Supernova">${photonOpts}</select>
      <button class="btn primary" type="submit">Send connection request</button>
    </form>
    <div class="import-box">
      <h4>Import from your phone</h4>
      <p class="fine">Pick a .vcf (contacts export) or .csv file (name, email, phone). It is read on this device only. Nothing is sent by importing — tap Request connection on each person to send their request.</p>
      <label class="btn" for="import-file">Choose a .vcf or .csv file</label>
      <input id="import-file" type="file" accept=".vcf,.csv,text/vcard,text/csv" hidden>
      ${importedContacts.length ? `<p class="fine">${importedContacts.length} contact${importedContacts.length === 1 ? "" : "s"} ready to add.</p>${importRows}` : ""}
      ${importSkipped ? `<p class="fine">${importSkipped} row${importSkipped === 1 ? "" : "s"} skipped — no email address on them, and the server needs an email to send the request.</p>` : ""}
    </div>
  </div>`;
}

// ---------- Messages (texts & calls) ----------
// Status from GET /api/texts/status drives the honest state: until the
// server says a number is connected, the section is not shown at all —
// a "not connected, go fix the server" card is a dead end for the person
// using the app, and it makes the Connected page look unfinished. When
// Twilio is configured, the section appears with the real texts and calls.
function renderMessagesSection(): string {
  const st = state?.textsStatus;
  const configured = !!(st && st.ok && st.configured);
  if (!st) return `<div class="card" id="messages"><h3>Messages</h3><p class="fine">Loading…</p></div>`;
  if (!configured) return "";

  const texts = (state?.texts || []) as any[];
  const calls = (state?.calls || []) as any[];
  const textRows = texts.length
    ? texts
        .map(
          (m: any) => `<div class="inbox-msg"><p class="inbox-subject">${esc(m.direction === "outbound" ? `To ${m.toLabel || m.to}` : `${m.fromLabel || m.from} · inbound`)}</p><p class="inbox-snippet">${esc(m.body || "")}</p><p class="inbox-meta">${esc(m.direction === "outbound" ? String(m.to || "") : String(m.from || ""))} · ${esc(fmtWhen(m.createdAt || ""))}</p></div>`,
        )
        .join("")
    : `<p class="fine">No texts yet.</p>`;
  const callRows = calls.length
    ? calls
        .map((c: any) => {
          const isVm = c.status === "voicemail";
          const title = isVm
            ? `Voicemail from ${c.fromLabel || c.from}`
            : `${c.direction === "outbound" ? "Call to " + (c.toLabel || c.to) : "Call from " + (c.fromLabel || c.from)}`;
          const body = c.transcript
            ? esc(c.transcript)
            : isVm
              ? "Voicemail left, but no transcript came back."
              : c.status === "voicemail_failed"
                ? "Voicemail transcription failed — no transcript."
                : `Status: ${c.status}${c.durationSeconds != null ? ` · ${c.durationSeconds}s` : ""}`;
          return `<div class="inbox-msg"><p class="inbox-subject">${esc(title)}</p><p class="inbox-snippet">${body}</p><p class="inbox-meta">${esc(c.direction === "outbound" ? String(c.to || "") : String(c.from || ""))} · ${esc(fmtWhen(c.createdAt || ""))}${c.recordingUrl ? ` · <a href="${esc(c.recordingUrl)}" target="_blank" rel="noopener">Listen</a>` : ""}</p></div>`;
        })
        .join("")
    : `<p class="fine">No calls yet.</p>`;

  // Send box: approved contacts with a phone number only. The server
  // refuses anything else, and this list never offers it.
  const approved = ((state?.contacts || []) as any[]).filter(
    (c: any) => c.status === "approved" && c.phone,
  );
  const sendBox = approved.length
    ? textDraft
      ? `<div class="review-box">
          <h4>Review before sending</h4>
          <p><b>To:</b> ${esc(textDraft.toLabel)} (${esc(textDraft.to)})</p>
          <p class="review-body">${esc(textDraft.body)}</p>
          <div class="row">
            <button class="btn primary" data-action="text-send-confirm">Send text</button>
            <button class="btn" data-action="text-send-edit">Edit it</button>
          </div>
        </div>`
      : `<form id="text-form" class="text-form">
          <h4>Send a text</h4>
          <select name="to" aria-label="Send to">${approved
            .map((c: any) => `<option value="${esc(c.phone)}" data-label="${esc(c.name || c.address)}">${esc(c.name || c.address)} · ${esc(c.phone)}</option>`)
            .join("")}</select>
          <textarea name="body" rows="3" placeholder="Write the text…" required></textarea>
          <button class="btn primary" type="submit">Review text</button>
          <p class="fine">Only approved contacts are listed. Nothing sends until you review it and tap Send text.</p>
        </form>`
    : `<p class="fine">No approved contacts with a phone number yet — add one in Contacts below, and once they approve, they'll show up here.</p>`;

  return `<div class="card" id="messages">
    <h3>Messages</h3>
    <p class="fine">Your number: ${esc(st.phoneNumber || "")} · Texts and calls go out from this number, only to contacts you've approved, and only when you tap send.</p>
    <h4>Texts</h4>
    ${textRows}
    <h4>Calls &amp; voicemail</h4>
    ${callRows}
    ${sendBox}
  </div>`;
}

// ---------- Calendar ----------
// Status from GET /api/calendar/status drives the honest state: until
// Google is signed in with the calendar permission, this section says
// so and points at the sign-in, and never guesses what's on the calendar.
function renderCalendarSection(): string {
  const st = state?.calendarStatus;
  if (!st) return `<div class="card" id="calendar"><h3>Calendar</h3><p class="fine">Loading…</p></div>`;
  if (!st.connected) {
    return `<div class="card" id="calendar"><h3>Calendar</h3>
      <p>${esc(st.message || "Calendar isn't connected yet.")}</p>
      ${st.googleConfigured === false
        ? ""
        : `<p class="fine">Tap <b>Connect Google</b> above. One sign-in covers both Calendar and Drive.</p>`}
    </div>`;
  }
  const events = (state?.calendarEvents || []) as any[];
  const busy = (state?.freeBusy || []) as any[];
  const eventRows = events.length
    ? events
        .map((ev: any) => {
          const cancelling = confirmCancelId === String(ev.id);
          return `<div class="inbox-msg"><p class="inbox-subject">${esc(ev.summary || "(no title)")}</p><p class="inbox-meta">${esc(fmtWhen(ev.start || ""))}${ev.end ? ` – ${esc(fmtWhen(ev.end || ""))}` : ""}${ev.location ? ` · ${esc(ev.location)}` : ""}</p>${ev.attendees && ev.attendees.length ? `<p class="inbox-meta">With: ${esc(ev.attendees.join(", "))}</p>` : ""}${ev.description ? `<p class="inbox-snippet">${esc(ev.description)}</p>` : ""}
          ${cancelling
            ? `<div class="row"><button class="btn primary" data-action="cal-cancel-confirm" data-id="${esc(String(ev.id))}">Yes, cancel it</button><button class="btn" data-action="cal-cancel-abort">Keep it</button></div>`
            : `<button class="btn small" data-action="cal-cancel" data-id="${esc(String(ev.id))}">Cancel event</button>`}
        </div>`;
        })
        .join("")
    : `<p class="fine">Nothing on the calendar in the next 7 days.</p>`;
  const busyRows = busy.length
    ? `<h4>Busy times</h4>` + busy.map((b: any) => `<p class="inbox-meta">Busy ${esc(fmtWhen(b.start || ""))} – ${esc(fmtWhen(b.end || ""))}</p>`).join("")
    : `<p class="fine">No busy times in the next 7 days.</p>`;
  const bookBox = bookDraft
    ? `<div class="review-box">
        <h4>Review before booking</h4>
        <p><b>${esc(bookDraft.title)}</b></p>
        <p class="inbox-meta">${esc(fmtWhen(bookDraft.start))} – ${esc(fmtWhen(bookDraft.end))}</p>
        ${bookDraft.description ? `<p class="inbox-snippet">${esc(bookDraft.description)}</p>` : ""}
        ${bookDraft.attendees.length ? `<p class="inbox-meta">Invite: ${esc(bookDraft.attendees.join(", "))}</p>` : ""}
        <div class="row">
          <button class="btn primary" data-action="cal-book-confirm">Book this event</button>
          <button class="btn" data-action="cal-book-edit">Edit it</button>
        </div>
      </div>`
    : `<form id="cal-book-form" class="book-form">
        <h4>Book an event</h4>
        <input name="title" type="text" placeholder="Title" required>
        <label class="field-label">Starts <input name="start" type="datetime-local" required></label>
        <label class="field-label">Ends <input name="end" type="datetime-local" required></label>
        <input name="attendees" type="text" placeholder="Invite (emails, comma-separated — optional)">
        <textarea name="description" rows="2" placeholder="Notes (optional)"></textarea>
        <button class="btn primary" type="submit">Review booking</button>
        <p class="fine">Nothing is booked until you review it and tap Book this event.</p>
      </form>`;
  return `<div class="card" id="calendar"><h3>Calendar</h3>
    <p class="fine">${esc(st.email || "")} · Next 7 days</p>
    ${eventRows}
    ${busyRows}
    ${bookBox}
    <button class="btn small" data-action="inbox-refresh">Refresh calendar</button>
  </div>`;
}

// ---------- Drive ----------
// Status from GET /api/drive/status drives the honest state. Files read
// as text (Docs as text, Sheets as CSV); a type that cannot be read says
// so plainly instead of inventing content.
function renderDriveSection(): string {
  const st = state?.driveStatus;
  if (!st) return `<div class="card" id="drive"><h3>Drive</h3><p class="fine">Loading…</p></div>`;
  if (!st.connected) {
    return `<div class="card" id="drive"><h3>Drive</h3>
      <p>${esc(st.message || "Drive isn't connected yet.")}</p>
      ${st.googleConfigured === false
        ? ""
        : `<p class="fine">Tap <b>Connect Google</b> above. One sign-in covers both.</p>`}
    </div>`;
  }
  const files = (state?.driveFiles || []) as any[];
  const fileRows = files.length
    ? files
        .map(
          (f: any) => `<div class="inbox-msg"><button class="drive-file" data-action="drive-open" data-id="${esc(String(f.id))}"><span class="inbox-subject">${esc(f.name || "(no name)")}</span><span class="inbox-meta">${esc(f.mimeType || "")} · ${esc(fmtDateOnly(f.modifiedTime || ""))}</span></button></div>`,
        )
        .join("")
    : `<p class="fine">No files found${driveQuery ? ` for “${esc(driveQuery)}”` : ""}.</p>`;
  // A read file no longer renders inline as a boxed pane: it opens as
  // a document page in the Level-2 sheet (see openDriveDocument,
  // called from the drive-open action), so this section is list only.
  const readBox = "";
  return `<div class="card" id="drive"><h3>Drive</h3>
    <p class="fine">${esc(st.email || "")}</p>
    <form id="drive-search-form" class="row">
      <input id="drive-search-input" type="search" placeholder="Search Drive…" value="${esc(driveQuery)}" aria-label="Search Drive">
      <button class="btn primary" type="submit">Search</button>
      ${driveQuery ? `<button class="btn" type="button" data-action="drive-clear">Clear</button>` : ""}
    </form>
    ${fileRows}
    ${readBox}
  </div>`;
}

// Messenger (Step 9): Facebook Page messaging only. Personal Messenger
// has no supported API, so the section says so instead of pretending.
// A Page can be connected from here with a Page access token, pasted in
// below; the token is tested before it is stored, and it is never shown
// back. Tap a thread to read it; a reply is drafted here and goes out
// only when the owner taps Send.
function renderMessenger(): string {
  const s = messengerStatusData as any;
  const threads = (messengerThreadsData || []) as any[];
  const pages = (messengerPagesData || []) as any[];
  const personal = `<p class="fine">Personal Messenger can't be connected — Meta offers messaging for Facebook Pages only, not personal accounts. For a personal thread, paste the messages into chat and your Supernova will read them there.</p>`;
  const connectForm = `<form id="page-connect-form" class="page-connect-form">
        <h4>Connect your Facebook Page</h4>
        <p class="fine">Paste a Page access token from Meta's developer console (your Page's settings, under Messenger). It is tested before it is stored, it is kept on the server like your Gmail sign-in, and it is never shown back to you.</p>
        <input name="token" type="password" placeholder="Page access token" required autocomplete="off">
        <button class="btn primary" type="submit">Connect this Page</button>
        <p class="fine">Messages that arrive on the Page come in through the server. Connecting here lets you read threads and reply from the app.</p>
      </form>`;
  if (!s) return `<div class="card" id="messenger"><h3>Messenger</h3><p class="fine">Loading…</p></div>`;
  const usable = pages.length > 0 || s.configured;
  if (!usable) {
    return `<div class="card" id="messenger"><h3>Messenger</h3><p>Your business Facebook Page isn't connected yet.</p>${connectForm}${personal}</div>`;
  }
  // Which Page's threads are showing: a Page connected here, or the
  // server's Page when none is connected here.
  const pageChips = [
    ...pages.map(
      (p: any) => `<span class="page-chip${messengerSelectedPageId === String(p.pageId) ? " selected" : ""}">
        <button class="page-chip-btn" data-action="page-select" data-id="${esc(String(p.pageId))}">${esc(p.pageName || p.pageId)}</button>
        <button class="page-chip-x" data-action="page-disconnect" data-id="${esc(String(p.pageId))}" aria-label="Disconnect ${esc(p.pageName || p.pageId)}">✕</button>
      </span>`,
    ),
    ...(s.configured
      ? [`<span class="page-chip${messengerSelectedPageId === null ? " selected" : ""}">
        <button class="page-chip-btn" data-action="page-select" data-id="">Server Page</button>
      </span>`]
      : []),
  ].join("");
  const rows = threads
    .map(
      (t: any) => `<button class="inbox-msg msg-thread${messengerOpenId === t.id ? " open" : ""}" data-action="msg-thread" data-id="${esc(t.id)}">
      <span class="inbox-subject">${esc((t.participants || []).map((p: any) => p.name).filter(Boolean).join(", ") || t.id)}</span>
      <span class="inbox-snippet">${esc(t.snippet || "")}</span>
      <span class="inbox-meta">${esc(t.updatedTime || "")}${typeof t.unreadCount === "number" && t.unreadCount > 0 ? ` · ${t.unreadCount} unread` : ""}</span>
    </button>`,
    )
    .join("");
  let openHtml = "";
  if (messengerOpenId) {
    if (messengerOpenError) {
      openHtml = `<p class="chat-error">${esc(messengerOpenError)}</p>`;
    } else if (!messengerOpenMessages) {
      openHtml = `<p class="fine">Loading messages…</p>`;
    } else {
      const msgs = messengerOpenMessages
        .map(
          (m: any) => `<div class="inbox-msg"><p class="inbox-subject">${esc(m.from?.name || m.from?.id || "Page")}</p><p class="inbox-snippet">${esc(m.text || "")}</p><p class="inbox-meta">${esc(m.createdTime || "")}</p></div>`,
        )
        .join("");
      openHtml = `${msgs || `<p class="fine">No messages in this thread yet.</p>`}
      <form class="msg-send-form" data-id="${esc(messengerOpenId)}">
        <h4>Reply as the Page</h4>
        <textarea name="text" rows="3" placeholder="Write the reply…" required maxlength="2000"></textarea>
        <p class="fine">Draft it here, then tap send — nothing goes out until you do. Meta only lets a Page reply inside the 24-hour window.</p>
        <button class="btn primary" type="submit">Send reply</button>
      </form>`;
    }
  }
  return `<div class="card" id="messenger"><h3>Messenger — your Page</h3>
    <p class="fine">Page messaging is connected. Replies go out only when you tap send.</p>
    ${pageChips ? `<div class="page-chips" aria-label="Choose a Page">${pageChips}</div>` : ""}
    ${rows || `<p class="fine">No Page conversations yet.</p>`}
    ${openHtml}
    ${connectForm}
    ${personal}</div>`;
}

// The Drive document page: the Level-2 sheet, a caption + card-title
// head, and the file's text at reading size on the page's own scroll —
// no inner scrollbar, no boxed pane (readability spec §3A.3).
function openDriveDocument(opener: HTMLElement | null) {
  const read: any = state?.driveFileRead;
  if (!read) return;
  const name = read.file?.name || "File";
  if (read.ok && read.readable) {
    openCard(
      cardShell(
        name,
        `<div class="doc-head"><p class="doc-meta">${esc(read.file?.mimeType || "Document")}</p><h2 class="card-title">${esc(name)}</h2></div><pre class="drive-content">${esc(read.content || "")}</pre>${read.truncated ? `<p class="fine">Showing the first 100,000 characters — the file is longer than that.</p>` : ""}`,
      ),
      opener,
    );
  } else if (read.ok && !read.readable) {
    openCard(
      cardShell(
        name,
        `<div class="doc-head"><h2 class="card-title">${esc(name)}</h2></div><p>${esc(read.message || "This file type cannot be read as text.")}</p>`,
      ),
      opener,
    );
  } else {
    openCard(
      cardShell(name, `<p class="chat-error">${esc(read.message || "That file didn't load. Try again.")}</p>`),
      opener,
    );
  }
}

async function reloadMessengerThreads() {
  const th = await api.messengerThreads(messengerSelectedPageId || undefined);
  if (th && th.ok) {
    messengerThreadsData = th.threads || [];
  } else {
    messengerThreadsData = [];
  }
}

async function openMessengerThread(id: string) {
  messengerOpenId = id;
  messengerOpenMessages = null;
  messengerOpenError = "";
  render();
  const r = await api.messengerMessages(id, messengerSelectedPageId || undefined);
  if (r && r.ok) {
    messengerOpenMessages = r.messages || [];
  } else if (r?.error === "messenger_not_configured") {
    messengerOpenError = "Facebook Page messaging isn't connected yet.";
  } else if (r?.error === "meta_error") {
    messengerOpenError = r.metaError?.message || r.message || "Meta refused that read.";
  } else {
    messengerOpenError = r?.message || "Those messages didn't load. Try again.";
  }
  render();
}

// ---------- Connect an account ----------
// One generic button, not three named slots. Tapping it asks what to
// connect: one Google sign-in for Gmail, Calendar, and Drive (redesign,
// Nov 19, 2026 — the old chooser offered Gmail and Calendar & Drive as
// two separate Google sign-ins; one consent now covers all three), an
// Outlook account (as many as you like, each a separate sign-in), or a
// Facebook Page (a Page access token, pasted in the Messenger section
// below). There is no separate chooser any more: each row of the
// Connections card carries its own single control, and a failed
// connect retries from the same sign-in it failed on (see
// connectErrorKind). Yahoo, Apple Mail, and other mail providers have
// no supported sign-in here, and texts, calls, and Facebook Page
// messaging are set up on the server, not from the app.
// Connect-return state, set once in init from the OAuth return params:
// justConnected puts a plain confirmation at the top of the Email
// section (a toast alone is too easy to miss), connectError puts the
// failure there with a one-tap retry. Both clear when the owner leaves
// Connected, or when a later load shows the account is fine.
let justConnected: "" | "gmail" | "google" | "outlook" | "imap" = "";
let connectError = "";
// Which sign-in failed, so the retry goes straight back to it.
let connectErrorKind: "" | "gmail" | "google" | "outlook" = "";
// IMAP providers (Yahoo, Apple Mail, Other), from the server; the
// connect form's select is built from these.
let imapProvidersData: any[] | null = null;
// The last IMAP connect result, shown under the connect form.
let imapConnectMsg = "";
let imapConnectOk = false;
// True while an inbox load is in flight: the Email section says
// "Checking your inbox…" instead of flashing the false "No email
// accounts connected yet" empty state before the data lands.
let inboxesLoading = false;
function nextGmailLabel(): string {
  const used = new Set((state?.inboxAccounts || []).map((a: any) => String(a.label || "")));
  let n = 1;
  while (used.has(`gmail-${n}`)) n++;
  return `gmail-${n}`;
}

function nextOutlookLabel(): string {
  const used = new Set((state?.outlookAccounts || []).map((a: any) => String(a.label || "")));
  let n = 1;
  while (used.has(`outlook-${n}`)) n++;
  return `outlook-${n}`;
}

function nextImapLabel(): string {
  const used = new Set((state?.imapAccounts || []).map((a: any) => String(a.label || "")));
  let n = 1;
  while (used.has(`imap-${n}`)) n++;
  return `imap-${n}`;
}

// ---------- Email summary cards ----------
// The inbox used to render every message the server returned, which
// read as an unbelievably huge dump. Now each account is a tidy
// summary: an unread count, then a short "needs attention" list —
// unread first, then the newest, capped at ten — and the whole message
// is one tap away. Older mail still lives in Gmail or Outlook (linked
// below the list); nothing here renders the entire inbox at once.
const EMAIL_SUMMARY_CAP = 10;

function emailRowHtml(m: any, provider: "gmail" | "outlook" | "imap", label: string): string {
  const unread = m.unread === true;
  return `<button class="inbox-msg email-row${unread ? " unread" : " read"}" data-action="email-open" data-provider="${provider}" data-label="${esc(String(label))}" data-id="${esc(String(m.id || ""))}">
      <span class="email-row-top"><span class="unread-dot" aria-hidden="true"></span><span class="inbox-subject">${esc(m.subject || "(no subject)")}</span></span>
      <span class="inbox-meta">${esc(m.from || "")} · ${esc(m.date || "")}</span>
      <span class="inbox-snippet">${esc(m.snippet || "")}</span>
    </button>`;
}

function emailCard(acct: any, provider: "gmail" | "outlook" | "imap"): string {
  const label = String(acct.label || "");
  const unreadCount = typeof acct.unreadCount === "number" ? acct.unreadCount : null;
  const unreadLine =
    unreadCount === null
      ? ""
      : unreadCount === 0
        ? `<p class="fine email-unread">All caught up — nothing unread.</p>`
        : `<p class="fine email-unread"><b>${unreadCount} unread</b></p>`;
  // Unread first, then the newest — the server already sends newest
  // first, and sort is stable, so unread messages rise without
  // scrambling the recency order inside each group.
  const msgs = [...(acct.messages || [])]
    .sort((a: any, b: any) => Number(b.unread === true) - Number(a.unread === true))
    .slice(0, EMAIL_SUMMARY_CAP);
  // A dead sign-in gets its remedy right here in the card: a reconnect
  // button for THIS account. (The old copy pointed at "the button
  // above", but the connections row shows no button at all when it
  // believes everything is connected — a dead end.) Gmail's sign-in
  // is the unified Google consent, so reconnecting here also restores
  // Calendar and Drive; Outlook's button restarts its own sign-in.
  // IMAP has no OAuth to restart — its remedy is the connect form
  // above, where the app-specific password is re-entered.
  const ranOut = acct.error === "token_failed" || acct.error === "auth_failed";
  const reconnectHref =
    provider === "gmail"
      ? `/api/oauth/google/start?accountId=${encodeURIComponent(getAccountId())}&label=${encodeURIComponent(label)}`
      : provider === "outlook"
        ? `/api/oauth/microsoft/start?accountId=${encodeURIComponent(getAccountId())}&label=${encodeURIComponent(label)}`
        : "";
  const errorHtml = ranOut
    ? provider === "imap"
      ? `<p class="chat-error">That account's sign-in ran out, so the inbox wouldn't open. Reconnect it from the button above — nothing was lost.</p>`
      : `<p class="chat-error">That account's sign-in ran out, so the inbox wouldn't open — nothing was lost.</p><div class="row"><a class="btn primary" href="${reconnectHref}">Reconnect this account</a></div>`
    : acct.error
      ? `<p class="chat-error">That inbox didn't answer just now. <button class="btn small" data-action="inbox-retry">Try again</button></p>`
      : "";
  // Gmail and Outlook have no disconnect in the app; an IMAP account
  // does, because its app-specific password must be removable here.
  // The provider name rides on the card, and the webmail link goes to
  // that provider's own webmail when there is one.
  const providerName =
    provider === "imap"
      ? String(acct.providerName || "IMAP")
      : provider === "outlook"
        ? "Outlook"
        : "Gmail";
  const webmailUrl =
    provider === "imap"
      ? String(acct.webmail || "")
      : provider === "outlook"
        ? "https://outlook.live.com/mail/"
        : "https://mail.google.com/";
  const webmail = webmailUrl
    ? `<p class="fine"><a href="${esc(webmailUrl)}" target="_blank" rel="noopener">Open in ${esc(providerName)}</a> for older mail.</p>`
    : "";
  const disconnect =
    provider === "imap"
      ? `<p class="fine"><button class="btn small" data-action="imap-disconnect" data-label="${esc(String(acct.label || ""))}">Disconnect this mailbox</button></p>`
      : "";
  return `<div class="card inbox-card">
        <h3>${esc(acct.title || acct.email || "Email")}</h3>
        <p class="fine">${esc(acct.email || "")} · ${esc(providerName)}</p>
        ${unreadLine}
        ${errorHtml || (msgs.length ? msgs.map((m: any) => emailRowHtml(m, provider, label)).join("") : `<p class="fine">Nothing in the inbox right now.</p>`)}
        ${msgs.length ? webmail : ""}
        ${disconnect}
        <form class="draft-form" data-label="${esc(String(acct.label || ""))}" data-provider="${provider}">
          <h4>Save a draft</h4>
          <input name="to" type="text" placeholder="To" required>
          <input name="subject" type="text" placeholder="Subject">
          <textarea name="body" rows="3" placeholder="Write the draft…" required></textarea>
          <button class="btn primary" type="submit">Save draft</button>
        </form>
      </div>`;
}

// ---------- Reading one email in full ----------
// A summary row opens the whole message in the character-card modal:
// subject, sender, date, and the plain-text body. While it loads the
// modal says so; if it fails, plain words and a one-tap retry.
let emailOpenRetry: { provider: "gmail" | "outlook" | "imap"; label: string; id: string } | null = null;

async function openEmailMessage(
  provider: "gmail" | "outlook" | "imap",
  label: string,
  id: string,
  opener: HTMLElement | null,
): Promise<void> {
  emailOpenRetry = { provider, label, id };
  openCard(cardShell("Message", `<p class="fine">Opening that message…</p>`), opener);
  const r: any =
    provider === "gmail"
      ? await api.gmailMessage(label, id)
      : provider === "outlook"
        ? await api.outlookMessage(label, id)
        : await api.imapMessage(label, id);
  if (r && r.ok) {
    emailOpenRetry = null;
    openCard(
      cardShell(
        r.subject || "Message",
        `<div class="doc-head"><p class="doc-meta">${esc(r.from || "")} · ${esc(r.date || "")}</p><h2 class="card-title">${esc(r.subject || "(no subject)")}</h2></div>
        <div class="email-body">${esc(r.body || "Nothing in the body.")}</div>`,
      ),
      opener,
    );
  } else {
    openCard(
      cardShell(
        "Message didn't open",
        `<h2 class="card-title">That message didn't open</h2>
        <p class="card-tagline">The inbox didn't answer just now. Nothing was changed.</p>
        <div class="card-actions"><button class="btn primary" data-action="email-retry-open">Try again</button></div>`,
      ),
      opener,
    );
  }
}

// ---------- Connections ----------
// The one named place for every connection (redesign, Nov 19, 2026):
// each service shows its state in plain words — Connected (with the
// account), Not connected, or Checking — and carries its own single
// control. There is no separate chooser any more: the Google row's
// button is the Google sign-in, the Outlook row's is Outlook's, the
// IMAP row carries its own connect form (Yahoo, Apple Mail, or any
// other IMAP mailbox, with an app-specific password), and the Page row
// jumps to the Messenger form below, where the Page token goes in. One
// Google sign-in covers Gmail, Calendar, and Drive; an account
// connected before that change shows Calendar and Drive as not
// connected until it signs in once more, and the row's button is the
// one place to do that. Gmail and Outlook have no disconnect in the
// app — a connected account stays connected — so a connected row shows
// a badge, not a button that pretends otherwise. An IMAP account does
// disconnect, from its card below, because its app-specific password
// must be removable here. The Facebook Page disconnects from its chip
// in the Messenger section, the one place that control lives.
function renderConnections(): string {
  const accounts = (state?.inboxAccounts || []) as any[];
  const outlookAccounts = (state?.outlookAccounts || []) as any[];
  const googleConfigured = state?.googleConfigured;
  const microsoftConfigured = state?.microsoftConfigured;
  const cal = (state as any)?.calendarStatus;
  const drv = (state as any)?.driveStatus;
  const pages = (messengerPagesData || []) as any[];

  // Google: Gmail, Calendar, Drive — one sign-in, three services.
  // While the first load is still flying, say Checking instead of
  // flashing a false "not connected".
  const googleChecking = inboxesLoading && !accounts.length && !cal && !drv;
  const gmailOn = accounts.length > 0;
  const calOn = cal?.connected === true;
  const drvOn = drv?.connected === true;
  const googleEmail = gmailOn ? String(accounts[0].email || "") : "";
  // A stored account whose sign-in Google has revoked still counts as
  // "on" by record — the row must not call that connected. Any Gmail
  // account whose last read came back token_failed / auth_failed is
  // broken, whatever the records say, and the row's job is to offer
  // the reconnect, not the badge.
  const brokenGmail = accounts.filter(
    (a: any) => a.error === "token_failed" || a.error === "auth_failed",
  );
  const gmailState = brokenGmail.length
    ? `Gmail — sign-in ran out${
        brokenGmail.length === 1 && brokenGmail[0].email
          ? ` for ${esc(String(brokenGmail[0].email))}`
          : ""
      }; reconnect needed`
    : gmailOn
      ? `Gmail — connected${googleEmail ? ` as ${esc(googleEmail)}` : ""}`
      : "Gmail — not connected";
  const googleState = googleChecking
    ? `<p class="fine">Checking your Google connection…</p>`
    : `<p class="fine">${gmailState} · Calendar — ${calOn ? "connected" : "not connected"} · Drive — ${drvOn ? "connected" : "not connected"}</p>`;
  const googleControl = googleChecking
    ? ""
    : !googleConfigured
      ? `<p class="fine">Google sign-in isn't set up on this server yet. It needs a Google OAuth client (client ID, secret, and redirect).</p>`
      : brokenGmail.length
        ? `<div class="row">${brokenGmail
            .map(
              (a: any, i: number) =>
                `<a class="${i === 0 ? "btn primary" : "btn"}" href="/api/oauth/google/start?accountId=${encodeURIComponent(getAccountId())}&label=${encodeURIComponent(String(a.label || ""))}">Reconnect ${esc(String(a.email || "Google"))}</a>`,
            )
            .join("")}</div>`
        : gmailOn && calOn && drvOn
          ? `<p><span class="owned-badge">Google connected</span></p>`
          : gmailOn
            ? `<div class="row"><a class="btn primary" href="/api/oauth/google/start-extra?accountId=${encodeURIComponent(getAccountId())}">Connect Calendar &amp; Drive</a></div>`
            : `<div class="row"><a class="btn primary" href="/api/oauth/google/start?accountId=${encodeURIComponent(getAccountId())}&label=${nextGmailLabel()}">Connect Google</a></div>`;

  // Outlook: one row, one button, as many accounts as the owner likes.
  const outlookChecking = inboxesLoading && !outlookAccounts.length;
  const outlookOn = outlookAccounts.length > 0;
  const outlookEmail = outlookOn ? String(outlookAccounts[0].email || "") : "";
  const outlookState = outlookChecking
    ? `<p class="fine">Checking your Outlook connection…</p>`
    : outlookOn
      ? `<p class="fine">Connected${outlookEmail ? ` as ${esc(outlookEmail)}` : ""}${outlookAccounts.length > 1 ? ` · ${outlookAccounts.length} accounts` : ""}</p>`
      : `<p class="fine">Not connected</p>`;
  const outlookControl = outlookChecking
    ? ""
    : !microsoftConfigured
      ? `<p class="fine">Outlook sign-in isn't set up on this server yet. It needs a Microsoft OAuth client (client ID, secret, and redirect).</p>`
      : outlookOn
        ? `<p><span class="owned-badge">Outlook connected</span></p><div class="row"><a class="btn" href="/api/oauth/microsoft/start?accountId=${encodeURIComponent(getAccountId())}&label=${nextOutlookLabel()}">Add another Outlook account</a></div>`
        : `<div class="row"><a class="btn primary" href="/api/oauth/microsoft/start?accountId=${encodeURIComponent(getAccountId())}&label=${nextOutlookLabel()}">Connect Outlook</a></div>`;

  // Other mail (IMAP): Yahoo Mail, Apple Mail (iCloud), or any other
  // IMAP mailbox. No OAuth setup anywhere: the owner signs in with an
  // app-specific password, and the server tests it against the real
  // mail server before storing it. The form stays visible so another
  // mailbox can be added the same way.
  const imapAccounts = (state?.imapAccounts || []) as any[];
  const imapChecking = inboxesLoading && !imapAccounts.length;
  const imapOn = imapAccounts.length > 0;
  const imapEmail = imapOn ? String(imapAccounts[0].email || "") : "";
  const imapState = imapChecking
    ? `<p class="fine">Checking your other mailboxes…</p>`
    : imapOn
      ? `<p class="fine">Connected${imapEmail ? ` as ${esc(imapEmail)}` : ""}${imapAccounts.length > 1 ? ` · ${imapAccounts.length} accounts` : ""}</p>`
      : `<p class="fine">Not connected</p>`;
  const imapProviderOptions = (
    imapProvidersData && imapProvidersData.length
      ? imapProvidersData
      : [
          { id: "yahoo", name: "Yahoo Mail" },
          { id: "apple", name: "Apple Mail (iCloud)" },
          { id: "other", name: "Other IMAP account" },
        ]
  )
    .map((p: any) => `<option value="${esc(String(p.id))}">${esc(String(p.name))}</option>`)
    .join("");
  const imapControl = `<form id="imap-connect-form" class="row">
      <select name="provider" id="imap-provider-select" aria-label="Mail provider">${imapProviderOptions}</select>
      <input name="email" type="email" inputmode="email" autocapitalize="off" autocomplete="email" placeholder="Email address" required aria-label="Email address">
      <input name="password" type="password" placeholder="App-specific password" required autocomplete="off" aria-label="App-specific password">
      <input name="host" type="text" id="imap-custom-host" placeholder="Mail server, e.g. imap.example.com" aria-label="Mail server (other providers only)" hidden>
      <button class="btn primary" type="submit">Connect mailbox</button>
    </form>
    <p class="fine">Yahoo and Apple Mail need an app-specific password — made in the provider's account settings — not the mailbox password. It is tested before it is stored, kept on the server like a Gmail sign-in, and never shown back. IMAP can read mail and save drafts; it cannot send, so a draft is sent from the mail app.</p>
    ${imapConnectMsg ? `<p class="${imapConnectOk ? "inbox-connected" : "chat-error"}">${esc(imapConnectMsg)}</p>` : ""}`;

  // Facebook Page: connected from the Messenger form below, where the
  // token goes in and the disconnect chip lives.
  const pageChecking = inboxesLoading && messengerPagesData === null;
  const pageOn = pages.length > 0;
  const pageName = pageOn ? String(pages[0].pageName || pages[0].pageId || "") : "";
  const pageState = pageChecking
    ? `<p class="fine">Checking your Facebook Page…</p>`
    : pageOn
      ? `<p class="fine">Connected — ${esc(pageName)}. Manage it below, in Messenger.</p>`
      : `<p class="fine">Not connected — your business Facebook Page connects in the Messenger section below, with a Page access token. Personal Messenger can't be connected: Meta offers messaging for Facebook Pages only.</p>`;
  const pageControl = pageChecking
    ? ""
    : pageOn
      ? `<p><span class="owned-badge">Facebook Page connected</span></p>`
      : `<div class="row"><button class="btn primary" data-action="goto-messenger">Connect a Facebook Page</button></div>`;

  return `<div class="card" id="connections">
    <h2>Connections</h2>
    <p class="fine">Every account Prism watches, and whether it's connected. The button on a row is the way to connect it.</p>
    <h3>Google</h3>
    ${googleState}
    ${googleControl}
    <h3>Outlook</h3>
    ${outlookState}
    ${outlookControl}
    <h3>Other mail (Yahoo, Apple Mail, IMAP)</h3>
    ${imapState}
    ${imapControl}
    <h3>Facebook Page</h3>
    ${pageState}
    ${pageControl}
    <p class="fine">Google and Outlook connect from here. Yahoo, Apple Mail, and other mail providers connect above with an app-specific password. Texts and calls are set up on the server, not from the app.</p>
  </div>`;
}

function renderConnected(): string {
  const accounts = (state?.inboxAccounts || []) as any[];
  const outlookAccounts = (state?.outlookAccounts || []) as any[];
  const imapAccounts = (state?.imapAccounts || []) as any[];
  const googleConfigured = state?.googleConfigured;
  const microsoftConfigured = state?.microsoftConfigured;
  const cards = [
    ...accounts.map((acct: any) => emailCard(acct, "gmail")),
    ...outlookAccounts.map((acct: any) => emailCard(acct, "outlook")),
    ...imapAccounts.map((acct: any) => emailCard(acct, "imap")),
  ].join("");
  const emailEmpty =
    inboxesLoading && !accounts.length && !outlookAccounts.length && !imapAccounts.length
      ? `<p class="fine">Checking your inbox…</p>`
      : googleConfigured || microsoftConfigured
        ? `<p class="fine">No email accounts connected yet — tap Connect Google or Connect Outlook above, or connect a Yahoo, Apple Mail, or other IMAP mailbox below, to add one.</p>`
        : `<p class="fine">No email accounts connected yet — connect a Yahoo, Apple Mail, or other IMAP mailbox above to add one.</p>`;
  const connectedBanner =
    justConnected === "gmail"
      ? `<p class="inbox-connected">Gmail connected — your inbox is below.</p>`
      : justConnected === "outlook"
        ? `<p class="inbox-connected">Outlook connected — your inbox is below.</p>`
        : justConnected === "imap"
          ? `<p class="inbox-connected">Mailbox connected — your inbox is below.</p>`
          : justConnected === "google"
            ? `<p class="inbox-connected">Calendar and Drive connected.</p>`
            : "";
  // A failed connect retries from the same place it failed: the
  // banner's button goes straight to that sign-in, not to a chooser.
  const connectRetry =
    connectErrorKind === "gmail"
      ? `<a class="btn small" href="/api/oauth/google/start?accountId=${encodeURIComponent(getAccountId())}&label=${nextGmailLabel()}">Try again</a>`
      : connectErrorKind === "google"
        ? `<a class="btn small" href="/api/oauth/google/start-extra?accountId=${encodeURIComponent(getAccountId())}">Try again</a>`
        : connectErrorKind === "outlook"
          ? `<a class="btn small" href="/api/oauth/microsoft/start?accountId=${encodeURIComponent(getAccountId())}&label=${nextOutlookLabel()}">Try again</a>`
          : "";
  const connectErrorHtml = connectError
    ? `<p class="chat-error">${esc(connectError)} ${connectRetry}</p>`
    : "";
  return `
  <section>
    <h1 class="page-title">Connected</h1>
    <p class="page-lede">Your email, messages, calendar, and Drive.</p>
    ${renderConnections()}
    <div class="switchboard-strip"><img src="/brand/switchboard.jpg" alt="" loading="lazy" decoding="async"><p><b>On Switchboard</b> — every Launch in the Lab, one board.</p></div>
    <div class="inbox-jump" aria-label="Jump to a section">
      <a href="#messages">Messages</a>
      <a href="#contacts">Contacts</a>
      <a href="#calendar">Calendar</a>
      <a href="#drive">Drive</a>
      <a href="#messenger">Messenger</a>
      <a href="#gmail-accounts">Email</a>
    </div>
    ${renderMessagesSection()}
    ${renderSwitchboardContacts()}
    ${renderCalendarSection()}
    ${renderDriveSection()}
    ${renderMessenger()}
    ${state?.inboxError ? `<p class="chat-error">${esc(state.inboxError)}</p>` : ""}
    <h2 class="section-title" id="gmail-accounts">Email</h2>
    ${connectedBanner}
    ${connectErrorHtml}
    <div class="inbox-grid">${cards}</div>
    ${accounts.length || outlookAccounts.length || imapAccounts.length ? "" : emailEmpty}
  </section>`;
}

// ---------- About you ----------
// What the owner tells Prism about themselves, so the Photons know them
// instead of starting cold. The form edits a local copy until Save; the
// server stores it for this account only, and the Photons read it in the
// chat system prompt. It is never shared with anyone else.
function renderProfile(): string {
  const p = profileData || {};
  const saved = profileSaved
    ? `<p class="fine">Saved. Your Supernovas know you now.</p>`
    : "";
  return `<div class="card" id="about-you"><h3>About you</h3>
    <p class="fine">Tell your Supernovas who you are, so they know you instead of starting cold. This stays on the server for your account only. It is never shared with anyone else.</p>
    <form id="profile-form" class="profile-form">
      <label class="field-label">What should they call you?
        <input name="displayName" type="text" placeholder="Your name" value="${esc(p.displayName || "")}" maxlength="80">
      </label>
      <label class="field-label">How should they address you?
        <select name="title">
          <option value=""${!p.title ? " selected" : ""}>No title — just my name</option>
          <option value="Mr."${p.title === "Mr." ? " selected" : ""}>Mr.</option>
          <option value="Ms."${p.title === "Ms." ? " selected" : ""}>Ms.</option>
          <option value="Mx."${p.title === "Mx." ? " selected" : ""}>Mx.</option>
          <option value="Dr."${p.title === "Dr." ? " selected" : ""}>Dr.</option>
          <option value="Sir"${p.title === "Sir" ? " selected" : ""}>Sir</option>
          <option value="M'Lady"${p.title === "M'Lady" ? " selected" : ""}>M'Lady</option>
          <option value="M'Lord"${p.title === "M'Lord" ? " selected" : ""}>M'Lord</option>
        </select>
      </label>
      <label class="field-label">Pronouns (optional)
        <input name="pronouns" type="text" placeholder="she/her, he/him, they/them…" value="${esc(p.pronouns || "")}" maxlength="40">
      </label>
      <p class="fine">Leave the title blank and they will just use your name — never sir or ma'am unless you ask for a title.</p>
      <label class="field-label">About you
        <textarea name="about" rows="3" placeholder="Who you are, what matters to you, what you do…">${esc(p.about || "")}</textarea>
      </label>
      <label class="field-label">How you like things done
        <textarea name="preferences" rows="3" placeholder="How you like answers, what to remember, what to never do…">${esc(p.preferences || "")}</textarea>
      </label>
      <label class="field-label">Anything else they should know
        <textarea name="notes" rows="2" placeholder="Anything else…">${esc(p.notes || "")}</textarea>
      </label>
      <button class="btn primary" type="submit">Save who you are</button>
      ${saved}
    </form>
  </div>`;
}

// ---------- Memory from another AI ----------
// Bring what the owner already told another assistant, so they keep
// continuity and do not start over. The file is read on this device
// only; nothing is sent until the owner taps Import. Accepted: a
// ChatGPT export (.json), a Claude export (.json), a plain list of
// messages (.json), or notes as Markdown or text (.md, .txt). What is
// imported is stored on the server for this account only, and a short
// digest of it is read into the chat system prompt as background, never
// as instructions.
function renderMemoryImport(): string {
  const rows = memoryImportsData
    .map(
      (m: any) => `<div class="inbox-msg"><p class="inbox-subject">${esc(m.title || "Imported memory")}</p>
        <p class="inbox-meta">${esc(m.source || "file")} · ${Number(m.chars || 0).toLocaleString()} characters · ${esc(fmtDateOnly(m.importedAt || ""))}</p>
        <button class="btn small" data-action="memory-delete" data-id="${esc(String(m.id))}">Delete</button></div>`,
    )
    .join("");
  const parsed = memoryParsed
    ? `<div class="memory-preview">
        <p><b>${esc(memoryParsed.title)}</b></p>
        <p class="fine">${esc(memoryParsed.summary)}</p>
        <div class="row">
          <button class="btn primary" data-action="memory-import">Import this memory</button>
          <button class="btn" data-action="memory-discard">Discard</button>
        </div>
      </div>`
    : "";
  const err = memoryParseError ? `<p class="chat-error">${esc(memoryParseError)}</p>` : "";
  return `<div class="card" id="memory-import"><h3>Memory from another AI</h3>
    <p class="fine">Bring what you already told another assistant, so you do not start over. Pick a file from your phone. It is read on this device only, and only what you tap Import is sent to the server.</p>
    <p class="fine">Accepted: a ChatGPT export (.json), a Claude export (.json), a plain list of messages (.json), or notes as Markdown or text (.md, .txt).</p>
    <div class="import-box">
      <label class="btn" for="memory-file">Choose a memory file</label>
      <input id="memory-file" type="file" accept=".json,.md,.txt,application/json,text/markdown,text/plain" hidden>
    </div>
    ${parsed}
    ${err}
    ${rows || `<p class="fine">Nothing imported yet.</p>`}
  </div>`;
}

// ---------- Store ----------
// Step 10: every Stripe checkout carries the account id, so the webhook
// can unlock the purchase on the buyer's account. Format:
// "<accountId>:<hint>". The server only trusts an account part starting
// with "acc_"; a bare hint unlocks nothing.
//
// A live welcome offer rides along too: while the account's 15%-off
// first-order perk is active, the code is prefilled at checkout, so the
// discount is already there when the page opens. No code to type, and
// the offer simply stops prefilling once its 10 days are up or it is used.
// The Nova links were created with a default client_reference_id
// (nova-personal, nova-monthly, personal-upkeep) baked into the link
// itself. A link that arrives with one already set gets its value
// replaced with "<accountId>:<hint>" — the webhook can only unlock a
// purchase when the account id rides along, and a second
// client_reference_id on the same URL would leave Stripe guessing
// which one counts. Links without one get it appended, as before.
function buyUrl(url: string, hint: string): string {
  const ref = encodeURIComponent(getAccountId() + ":" + hint);
  let out: string;
  if (/[?&]client_reference_id=/.test(url)) {
    out = url.replace(/([?&]client_reference_id=)[^&]*/, "$1" + ref);
  } else {
    const sep = url.includes("?") ? "&" : "?";
    out = `${url}${sep}client_reference_id=${ref}`;
  }
  const perk = (state as any)?.perk;
  if (perk && perk.active && perk.code) {
    out += `&prefilled_promo_code=${encodeURIComponent(perk.code)}`;
  }
  return out;
}

function buyButton(url: string, label: string, owned: boolean): string {
  if (owned) return `<span class="owned-badge">Owned — yours already</span>`;
  return `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">Buy — ${esc(label)}</a>`;
}

// The welcome offer, shown while it is live: 15% off the first order,
// 10 days from account creation. The code is already filled in at
// checkout, so there is nothing to type and nothing to remember. When
// the offer is used or its 10 days are up, this says nothing at all.
function perkBanner(): string {
  const perk = (state as any)?.perk;
  if (!perk || !perk.active) return "";
  return `<div class="card perk-card">
    <h2>Your welcome offer — 15% off your first order</h2>
    <p>Your code is <b>${esc(perk.code)}</b>, good until ${esc(fmtDateOnly(perk.expiresAt))}. It is already filled in at checkout, so the discount is there when the page opens. One order only — after that, the offer is spent.</p>
  </div>`;
}

function productCard(p: (typeof PRODUCTS)[number]): string {
  const v = storeVariant === "personal" ? p.personal : p.business;
  const owned = state?.freeCode === true || (state?.ownedProducts || []).includes(p.slug);
  return `<div class="card product-card">
    <h3>${esc(p.name)}</h3>
    <p class="kind">${esc(p.kind)}</p>
    <p>${esc(p.description)}</p>
    <p class="price">${esc(v.price)} <span class="fine">(${esc(v.total)} at checkout)</span></p>
    <div class="row card-row">
      ${buyButton(buyUrl(v.url, p.slug + "-" + storeVariant), v.total, owned)}
      <button class="btn small more-info" data-action="product-info" data-slug="${esc(p.slug)}">More info</button>
    </div>
  </div>`;
}

// One kind (Spark or Plug), grouped by its categories. Categories with no
// products of that kind are skipped.
function kindGroups(kind: "Spark" | "Plug"): string {
  return CATEGORIES.map((cat) => {
    const items = PRODUCTS.filter((p) => p.category === cat && p.kind === kind);
    if (!items.length) return "";
    return `<h3 class="cat-title">${esc(cat)}</h3><div class="product-grid">${items
      .map((p) => productCard(p))
      .join("")}</div>`;
  }).join("");
}

function renderStore(): string {
  const ownedProducts: string[] = state?.ownedProducts || [];
  const ownedSupernovas: string[] = state?.ownedSupernovas || [];
  const ownedNovas: string[] = state?.ownedNovas || [];
  const allOwned = state?.freeCode === true;
  const variant = storeVariant;
  const photonCards = PHOTONS.map((p) => {
    const owned = allOwned || ownedSupernovas.includes(p.name);
    return `<div class="card product-card photon-store">
      <button class="portrait-btn" data-action="photon-info" data-photon="${esc(p.name)}" aria-label="More about ${esc(superLabel(p))}">${portraitHtml(p.name, 220)}</button>
      <h3 class="photon-name">${esc(superLabel(p))}</h3>
      <p>${esc(p.tagline)}</p>
      <p class="fine">${esc(p.focus)} And so much more.</p>
      <p class="price">$499.00 <span class="fine">($514.00 at checkout)</span></p>
      ${buyButton(buyUrl(SUPERNOVA.url, "Supernova-" + p.name), "$514.00", owned)}
    </div>`;
  });

  const sparkCount = PRODUCTS.filter((p) => p.kind === "Spark").length;
  const plugCount = PRODUCTS.filter((p) => p.kind === "Plug").length;
  // Start My Day is built and priced, but its two Stripe payment links
  // are not created yet, so the catalog generator skips it and it is not
  // in PRODUCTS. Until the links land it shows here as a coming-soon
  // card, with its price and an honest note instead of a Buy button.
  // The moment the links exist and the catalog is regenerated, this card
  // disappears and the standard product card takes its place.
  const startMyDayListed = PRODUCTS.some((p) => p.slug === "start-my-day");
  const plugShown = plugCount + (startMyDayListed ? 0 : 1);
  const startMyDaySoon = startMyDayListed
    ? ""
    : `<h3 class="cat-title">Everyday Life</h3><div class="product-grid"><div class="card product-card">
        <h3>Start My Day</h3>
        <p class="kind">Plug</p>
        <p>A morning briefing that walks your day top to bottom, one item at a time. Confirm each item and it gets done, moved, or cleared, and anything you add during the day joins the plan.</p>
        <p class="price">${storeVariant === "personal" ? "$39.00" : "$59.00"} <span class="fine">(${storeVariant === "personal" ? "$40.17" : "$60.77"} at checkout)</span></p>
        <p class="fine">Checkout links are being set up — the plug itself is ready. There is no Buy button until its two Stripe links exist.</p>
      </div></div>`;

  // The Store shows one side at a time. The side comes from the
  // first-open chooser (switch it on the Chat front, at the top of
  // the Store, or in You) — the Sparks & Plugs Personal/Business
  // toggle below only changes those prices, it never changes which
  // sections show.
  const isPersonal = sideOrDefault() === "personal";
  const atomCards = ATOMS.map((a) => {
    const owned = allOwned || ownedNovas.includes(a.name);
    return `<div class="card product-card photon-store">
      <button class="portrait-btn" data-action="atom-info" data-atom="${esc(a.name)}" aria-label="More about ${esc(novaLabel(a))}">${atomPortraitHtml(a.name, 220)}</button>
      <h3 class="photon-name">${esc(novaLabel(a))}</h3>
      <p>${esc(a.tagline)}</p>
      <p class="fine">${esc(a.focus)} And so much more.</p>
      <p class="price">$79.00 <span class="fine">($81.37 at checkout)</span></p>
      ${buyButton(buyUrl(NOVA.url, "Nova-" + a.name), "$81.37", owned)}
    </div>`;
  });
  const supernovaRow = `    <div class="poster-row" id="store-supernova"><button class="poster-btn" data-action="tier-info" data-tier="supernova" aria-label="More about Supernova"><img src="/brand/poster-supernova.jpg" alt="Supernova poster loading="lazy" decoding="async", the whole front office"></button><div class="pr-txt"><b>Supernova</b><span class="desc">${esc(TIER_COPY.supernova.body)}</span><span class="desc">${esc(TIER_COPY.supernova.hours)}</span><span class="price">$499.00</span><span class="at">$514.00 at checkout</span>${buyButton(buyUrl(SUPERNOVA.url, "supernova"), "$514.00", allOwned || ownedProducts.includes("supernova"))}<p class="fine">Or pay monthly:</p><div class="row monthly-row">
        <a class="btn small" href="${esc(buyUrl(SUPERNOVA.monthly.url, "supernova-monthly"))}" target="_blank" rel="noopener">$49/mo</a>
        <a class="btn small" href="${esc(buyUrl(SUPERNOVA.twoYear.url, "supernova-two-year"))}" target="_blank" rel="noopener">$39/mo · 2-year</a>
        <a class="btn small" href="${esc(buyUrl(SUPERNOVA.annual.url, "supernova-annual"))}" target="_blank" rel="noopener">$539/yr</a>
      </div></div></div>`;
  const satelliteRow = `    <div class="poster-row" id="store-satellite"><button class="poster-btn" data-action="tier-info" data-tier="satellite" aria-label="More about Satellite"><img src="/brand/poster-satellite.jpg" alt="Satellite poster loading="lazy" decoding="async", one Brain, one Face, one job duty"></button><div class="pr-txt"><b>Satellite</b><span class="desc">${esc(TIER_COPY.satellite.body)}</span><span class="desc">${esc(TIER_COPY.satellite.hours)}</span><span class="price">$99.00</span><span class="at">$101.97 at checkout</span>${buyButton(buyUrl(SATELLITE.url, "satellite"), "$101.97", allOwned || ownedProducts.includes("satellite"))}<p class="fine">Or pay monthly:</p><div class="row monthly-row">
        <a class="btn small" href="${esc(buyUrl(SATELLITE.monthly.url, "satellite-monthly"))}" target="_blank" rel="noopener">$33/mo</a>
        <a class="btn small" href="${esc(buyUrl(SATELLITE.twoYear.url, "satellite-two-year"))}" target="_blank" rel="noopener">$26/mo · 2-year</a>
        <a class="btn small" href="${esc(buyUrl(SATELLITE.annual.url, "satellite-annual"))}" target="_blank" rel="noopener">$363/yr</a>
      </div></div></div>`;
  const novaRow = `    <div class="poster-row" id="store-nova"><img src="/brand/starburst.jpg" alt="Nova, the helper loading="lazy" decoding="async" for your own day"><div class="pr-txt"><b>Nova</b><span class="desc">Nova is the helper for your own day, not a business. One inbox: new mail that needs you is brought to your chat, and replies are drafted in your words. Your calendar and reminders, a morning briefing, and gentle check-ins that nudge you to get started — never a nag.</span><span class="desc">What Nova opens:</span><ul class="included-list">${PERSONAL_FEATURES.map((f) => `<li>${esc(f.label)}</li>`).join("")}</ul><span class="price">$79.00</span><span class="at">$81.37 at checkout</span>${buyButton(buyUrl(NOVA.url, "nova-personal"), "$81.37", allOwned || ownedProducts.includes("nova"))}<p class="fine">Or pay monthly:</p><div class="row monthly-row">
        <a class="btn small" href="${esc(buyUrl(NOVA.monthly.url, "nova-monthly"))}" target="_blank" rel="noopener">$10/mo</a><span class="fine">$10.00/month ($10.30 at checkout)</span>
      </div><p class="fine">The business set stays locked on Nova alone — inbox, calendar and files worked in chat, Switchboard email to approved contacts, proactive checks and reminders, more than one account, and a helper who knows your business. Those open with a business Launch — Supernova or Satellite — on the Business side.</p></div></div>`;
  const personalUpkeepCard = `    <div class="card upkeep-card" id="store-personal-upkeep"><img src="/brand/starburst.jpg" alt="" loading="lazy" decoding="async"><div><h2>Personal Upkeep</h2><p>The care that keeps your personal helper working well: updates as they come out, and help first when you need it. It sits beside Nova. Your first three months come with Nova; after that it is $9 a month, only if you want it. Upkeep itself is the care plan for a business Launch.</p><p class="price">$9.00/month <span class="fine">($9.27 at checkout)</span></p><div class="row">${buyButton(buyUrl(PERSONAL_UPKEEP.url, "personal-upkeep"), "$9.27", allOwned || ownedProducts.includes("personal-upkeep"))}</div></div></div>`;
  const photonItems = PHOTONS.map((p, i) => ({
    code: machineCode(i),
    name: p.name,
    openName: p.name,
    role: p.tagline,
    price: "$499 one-time",
    pack: `<button class="machine-pack-btn" data-action="machine-goto" data-machine="store-supernovas" data-index="${i}" aria-label="Show ${esc(p.name)}">${portraitHtml(p.name, 84)}<span class="pack-name">${esc(p.name)}</span></button>`,
    bay: photonCards[i],
  }));
  const atomItems = ATOMS.map((a, i) => ({
    code: machineCode(i),
    name: a.name,
    openName: a.name,
    role: a.tagline,
    price: "$79 · or $10/mo",
    pack: `<button class="machine-pack-btn" data-action="machine-goto" data-machine="store-novas" data-index="${i}" aria-label="Show ${esc(a.name)}">${atomPortraitHtml(a.name, 84)}<span class="pack-name">${esc(a.name)}</span></button>`,
    bay: atomCards[i],
  }));
  const photonsGroup = `    <details class="store-group" id="store-supernovas" ${storeOpen.supernovas ? "open" : ""}>
      <summary><span class="summary-title">Meet the Supernovas</span><span class="fine">12 Supernovas · tap to hide</span></summary>
      <p class="page-lede">Each of the twelve is a Supernova on its own. Buy one and it drops into your app, ready to talk. Spin the drum to the one you want, then press DISPENSE — it drops into the tray below, ready to buy.</p>
      ${machineHtml("store-supernovas", { title: "SUPERNOVAS", priceLine: "$499 one-time", listLabel: "See all 12 Supernovas", dispenseAction: "machine-dispense", kind: "photon", items: photonItems })}
    </details>`;
  const atomsGroup = `<details class="store-group" id="store-novas" ${storeOpen.novas ? "open" : ""}>
      <summary><span class="summary-title">Meet the Novas</span><span class="fine">12 Novas · tap to hide</span></summary>
      <p class="page-lede">Each of the twelve is a Nova on its own. Buy one and it drops into your app, ready to help with your own day. Spin the drum to the one you want, then press DISPENSE — it drops into the tray below, ready to buy.</p>
      ${machineHtml("store-novas", { title: "NOVAS", priceLine: "$79 outright · or $10/month", listLabel: "See all 12 Novas", dispenseAction: "machine-dispense", kind: "atom", items: atomItems })}
    </details>`;
  const upkeepCard = `    <div class="card upkeep-card" id="store-upkeep"><button class="poster-btn upkeep-poster-btn" data-action="tier-info" data-tier="upkeep" aria-label="More about Upkeep"><img src="/brand/starburst.jpg" alt="" loading="lazy" decoding="async"></button><div><h2>Upkeep</h2><p>${esc(UPKEEP_COPY.body)}</p><p class="price">$29.00/month <span class="fine">($29.87 at checkout)</span></p><div class="row">${buyButton(buyUrl(UPKEEP.url, "upkeep"), "$29.87", state?.upkeep === true)}<button class="btn small more-info" data-action="tier-info" data-tier="upkeep">More info</button></div></div></div>`;
  return `
  <section>
    <div class="store-side-switch" role="group" aria-label="Business or Personal">
      <button class="btn${isPersonal ? "" : " primary"}" data-action="side-pick" data-side="business" aria-pressed="${isPersonal ? "false" : "true"}">Business</button>
      <button class="btn${isPersonal ? " primary" : ""}" data-action="side-pick" data-side="personal" aria-pressed="${isPersonal ? "true" : "false"}">Personal</button>
    </div>
    <div class="store-head"><img src="/brand/starburst.jpg" alt="" loading="lazy" decoding="async"><div><h1 class="page-title">Store</h1><p>${isPersonal ? "A Nova is the helper for your own day." : "A Launch is the helper you talk with in this app."} Pick the helper that fits your day, then pick how you want to pay. The prices are further down, after a plain explanation of how it all works.</p></div></div>
    ${perkBanner()}
    ${stripeStatusData
      ? `<p class="fine stripe-line">${stripeStatusData.configured ? "Automatic unlocks are on — a purchase unlocks as soon as Stripe confirms the payment." : "Automatic unlocks are off — the Stripe webhook isn't set up yet. Purchases still unlock by code (redeem one below) until it is."}</p>`
      : `<p class="fine">Checking automatic unlocks…</p>`}
    <div class="chrome-thin"></div>

    <details class="store-group pricing-explainer" id="store-pricing" ${storeOpen.pricing ? "open" : ""}>
      <summary><span class="summary-title">Understand our pricing</span><span class="fine">tap to read, in plain words</span></summary>
      <div class="pricing-body">
        <p><b>First, what are these things?</b> A Launch is what gives this app someone to talk to. With no Launch, there is no one to talk to. A Launch comes in two kinds: a Supernova for a business, or a Nova for your own day. Each one has its own way of helping, like reading your messages with you, checking your calendar, or drafting notes in your words.</p>
        <p><b>A Spark</b> is one button for one job. You press it, it does that one job, and you can press it again as often as you like. It never runs out and it never dies. <b>A Plug</b> is the same idea, except you do not press anything. It runs on its own, in the background, and does its job without being asked.</p>
        <p><b>A Supernova</b> is the full helper. It is the whole front office in one: messages, calendar, paperwork, and anything else that comes up, and it learns how you like things done. <b>A Satellite</b> is a smaller version of the same thing, for one job at a time, with one way of talking and one way of looking. <b>Nova</b> is the helper for your own day, not a business: one inbox, with replies drafted in your words, your calendar and reminders, a morning briefing, and gentle check-ins. The business set — inbox, calendar and files worked in chat, Switchboard email to approved contacts, proactive checks and reminders, more than one account, and a helper who knows your business — stays locked on Nova alone, and opens with a Supernova or a Satellite.</p>
        <p><b>Upkeep</b> is the care that keeps your helper working well: unlimited chats, updates as they come out, help first when you need it, and talking out loud instead of typing. Upkeep is never required. Every purchase already includes 300 chats a month, free forever, with no monthly payment needed.</p>
        <p><b>How paying works.</b> Some things you pay for once, and then they are yours forever. That is how Sparks, Plugs, Supernova, and Satellite work when you buy them outright. Or you can pay month by month instead. Paying monthly costs less at the start, and if you stop paying, the live help pauses until you start again. What you already bought stays on your phone, nothing is deleted and nothing is chased. Paying for two years at a time costs less each month, because you are committing for longer. Paying for a whole year at once costs the same as 11 months, so the 12th month is free.</p>
        <p><b>Why does it cost what it does?</b> Each helper is written out, line by line, for the way you actually work, then tested until it works properly, and then kept working with updates. A Supernova is about 300 hours of that careful building and testing. A Satellite is about 150 hours, a Plug about 50 hours, and a Spark about 25 hours. You are paying for that time, and for a helper that is built around your day, not a generic one.</p>
        <p><b>The small print, in plain words.</b> When you pay, the card company adds a small fee of 3 percent, and the checkout page shows you the full total before you pay anything, so there are no surprises. You can try things free for 14 days, with no card details, no charge, and nothing that renews on its own. If you buy Upkeep with your first purchase, you get 15 percent off your purchases while Upkeep stays on.</p>
        <p class="pricing-contact"><b>Questions? Please ask.</b> No question is too small, and you do not need to know anything about technology to ask it. Email us at <a href="mailto:prism5labscontact@gmail.com">prism5labscontact@gmail.com</a> or call <a href="tel:+19203937294">(920) 393-7294</a>. We will explain it in plain words, and help you pick what fits.</p>
      </div>
    </details>

    <div class="store-jump" aria-label="Jump to a section">
      ${isPersonal ? `<a href="#store-nova">Nova</a>
      <a href="#store-novas">Novas</a>
      <a href="#store-personal-upkeep">Personal Upkeep</a>` : `<a href="#store-supernova">Supernova</a>
      <a href="#store-satellite">Satellite</a>
      <a href="#store-supernovas">Supernovas</a>
      <a href="#store-upkeep">Upkeep</a>`}
      <a href="#store-sparks-plugs">Sparks &amp; Plugs</a>
    </div>

    <h2 class="section-title">${isPersonal ? "Nova" : "Launches"}</h2>
    ${isPersonal ? novaRow : supernovaRow + satelliteRow}
    ${isPersonal ? personalUpkeepCard : ""}
    ${isPersonal ? atomsGroup : photonsGroup}
    ${isPersonal ? "" : upkeepCard}

    <h2 class="section-title" id="store-sparks-plugs">Sparks &amp; Plugs</h2>
    <p class="page-lede">One job each. A Spark is a single button for one job, push it and it does the thing. A Plug is a Spark that runs on its own.</p>
    <div class="toggle" role="group" aria-label="Personal or Business">
      <button class="toggle-btn ${variant === "personal" ? "active" : ""}" data-action="variant" data-variant="personal">Personal</button>
      <button class="toggle-btn ${variant === "business" ? "active" : ""}" data-action="variant" data-variant="business">Business</button>
    </div>
    <details class="store-group" id="store-sparks" ${storeOpen.sparks ? "open" : ""}>
      <summary><span class="summary-title">Sparks</span><span class="fine">${sparkCount} · one button, one job · tap to browse</span></summary>
      <p class="page-lede">${esc(TIER_COPY.spark.body)} ${esc(TIER_COPY.spark.hours)}</p>
      <div class="addon-row featured"><div><b>Personality Builder</b><span>Spark · one button, one job</span><span class="pb-desc">The extra attribute that builds a personality for your interface — for a Spark or Plug that doesn't come with one.</span></div><div class="price">$19–$25</div><button class="btn small more-info" data-action="product-info" data-slug="personality-builder">More info</button></div>
      ${kindGroups("Spark")}
    </details>
    <details class="store-group" id="store-plugs" ${storeOpen.plugs ? "open" : ""}>
      <summary><span class="summary-title">Plugs</span><span class="fine">${plugShown} · runs on its own · tap to browse</span></summary>
      <p class="page-lede">${esc(TIER_COPY.plug.body)} ${esc(TIER_COPY.plug.hours)}</p>
      ${kindGroups("Plug")}
      ${startMyDaySoon}
    </details>
    <div class="card" id="store-redeem">
      <h2>Redeem a code</h2>
      <p>Have a friends-and-family code? Enter it here and everything unlocks. This is the only place to redeem one.</p>
      <form id="redeem-form" class="row">
        <input id="redeem-input" type="text" inputmode="numeric" autocomplete="off" placeholder="10-digit code" aria-label="Redeem code">
        <button class="btn primary" type="submit">Redeem</button>
      </form>
      <p id="redeem-msg" class="fine"></p>
    </div>
    <div class="store-foot">Questions about any price? Email <a href="mailto:prism5labscontact@gmail.com">prism5labscontact@gmail.com</a> or call <a href="tel:+19203937294">(920) 393-7294</a>.<br>Let us handle the noise so you can focus on what you want and need to do.<br>© 2026 Prism 5 Labs · Green Bay, Wisconsin</div>
  </section>`;
}

// ---------- Proactive checks, reminders, push (Step 3) ----------
function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function renderProactive(): string {
  if (!proactiveData) return `<div class="card"><h2>Checks &amp; reminders</h2><p class="fine">Loading…</p></div>`;
  const s = proactiveData.scheduler || {};
  const push = proactiveData.push || {};
  const channels = proactiveData.channels || {};
  const rems = (remindersData || []).filter((r: any) => !r.done);
  const doneCount = (remindersData || []).filter((r: any) => r.done).length;
  const remRows = rems
    .map(
      (r: any) => `<div class="inbox-msg"><p class="inbox-subject">${esc(r.text)}</p><p class="inbox-meta">Due ${esc(fmtTime(r.remindAt))}</p><button class="btn small" data-action="reminder-done" data-id="${esc(r.id)}">Mark done</button></div>`,
    )
    .join("");
  let checkHtml = "";
  if (lastCheck) {
    const items = [
      ...(lastCheck.gmail?.newItems || []),
      ...(lastCheck.texts?.newItems || []),
      ...(lastCheck.calendar?.newItems || []),
      ...(lastCheck.remindersDue || []),
    ];
    checkHtml = `<div class="check-result"><p><b>Last check (${esc(fmtTime(lastCheck.checkedAt))}):</b> ${lastCheck.newTotal} new.</p>${
      items.length
        ? `<ul>${items
            .map(
              (i: any) =>
                `<li><b>${esc(i.channel)}:</b> ${esc(i.summary)}${i.detail ? ` — ${esc(i.detail)}` : ""}</li>`,
            )
            .join("")}</ul>`
        : `<p class="fine">Nothing new — nothing needs a decision right now.</p>`
    }${lastCheck.push && lastCheck.push.configured ? `<p class="fine">Phone taps: ${lastCheck.push.sent} sent to your devices.</p>` : ""}</div>`;
  }
  let pushHtml = "";
  if (!push.configured) {
    pushHtml = `<p class="fine">Phone taps aren't set up on the server yet — it needs VAPID keys. Checks and reminders still run without them.</p>`;
  } else if (push.subscribed) {
    pushHtml = `<p><span class="owned-badge">Phone taps on</span> This device gets a tap when a check finds something new.</p><button class="btn small" data-action="push-toggle">Turn phone taps off</button>`;
  } else {
    pushHtml = `<p class="fine">Phone taps are set up, but this device isn't subscribed yet.</p><button class="btn primary" data-action="push-toggle">Turn phone taps on</button>`;
  }
  return `<div class="card">
    <h2>Checks &amp; reminders</h2>
    <p class="fine">${s.running ? `Checking every ${s.intervalMinutes || 5} minutes while the server is awake.` : "The checker isn't running right now."} ${s.lastCheckAt ? `Last check: ${esc(fmtTime(s.lastCheckAt))}.` : "No check has run yet."} ${s.totalNewFound ? `${s.totalNewFound} new item(s) found so far.` : ""}</p>
    <p class="fine">Watching Gmail. ${channels.texts ? "Texts and calendar too." : "Texts and calendar checks aren't built yet, so Gmail is all it watches for now."}</p>
    <div class="row"><button class="btn primary" data-action="check-now" ${checkRunning ? "disabled" : ""}>${checkRunning ? "Checking…" : "Check now"}</button></div>
    ${checkHtml}
    <h3>Reminders</h3>
    ${remRows || `<p class="fine">No reminders set.</p>`}
    ${doneCount ? `<p class="fine">${doneCount} done.</p>` : ""}
    <form id="reminder-form" class="row reminder-form">
      <input id="reminder-text" type="text" maxlength="500" placeholder="Remind me to…" required aria-label="Reminder text">
      <input id="reminder-when" type="datetime-local" required aria-label="Remind at">
      <button class="btn primary" type="submit">Set reminder</button>
    </form>
    <h3>Phone taps</h3>
    ${pushHtml}
  </div>`;
}

async function runProactiveCheck() {
  if (checkRunning) return;
  checkRunning = true;
  render();
  const r = await api.proactiveCheck();
  checkRunning = false;
  if (r && r.ok) {
    lastCheck = r;
    const p = await api.proactiveStatus();
    if (p && p.ok) proactiveData = p;
    const rems = await api.reminders();
    if (rems && rems.ok) remindersData = rems.reminders || [];
  } else {
    toast("That check didn't run. Try again.", "err");
  }
  render();
}

// The standard base64url → Uint8Array helper for the VAPID public key.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function togglePush() {
  if (!pushData) return;
  if (pushData.subscribed) {
    // Off means off on the server too: drop the local subscription, then
    // delete the stored server row(s) for this account before re-reading
    // status — otherwise status still reports subscribed and the toggle
    // flips straight back on. No endpoint (reinstall) deletes them all.
    let endpoint: string | undefined;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        endpoint = sub.endpoint;
        await sub.unsubscribe();
      }
    } catch {
      // Already gone.
    }
    try {
      await api.pushUnsubscribe(endpoint);
    } catch {
      // The local drop above still stands; status re-read shows the truth.
    }
    const r = await api.pushStatus();
    if (r && r.ok) pushData = r;
    render();
    toast("Phone taps off on this device.");
    return;
  }
  if (!pushData.configured || !pushData.publicKey) {
    toast("Phone taps aren't set up on the server yet.", "err");
    return;
  }
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    toast("This browser can't do phone taps.", "err");
    return;
  }
  let permission: NotificationPermission = "default";
  try {
    permission = await Notification.requestPermission();
  } catch {
    permission = "denied";
  }
  if (permission !== "granted") {
    toast("Notifications weren't allowed — turn them on in the browser to get taps.", "err");
    return;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(pushData.publicKey),
      }));
    const r = await api.pushSubscribe(sub.toJSON());
    if (r && r.ok) {
      const s = await api.pushStatus();
      if (s && s.ok) pushData = s;
      render();
      toast("Phone taps on — this device gets a tap when a check finds something new.");
    } else {
      toast("That subscription didn't save. Try again.", "err");
    }
  } catch {
    toast("That subscription didn't save. Try again.", "err");
  }
}

async function loadYou() {
  if (youLoading) return;
  youLoading = true;
  try {
    const [p, r, pu] = await Promise.all([
      api.proactiveStatus(),
      api.reminders(),
      api.pushStatus(),
    ]);
    if (p && p.ok) proactiveData = p;
    if (r && r.ok) remindersData = r.reminders || [];
    if (pu && pu.ok) pushData = pu;
  } finally {
    youLoading = false;
  }
}

async function loadStripeStatus() {
  if (stripeLoading) return;
  stripeLoading = true;
  try {
    const r = await api.stripeStatus();
    if (r && r.ok) stripeStatusData = r;
  } finally {
    stripeLoading = false;
  }
}

// ---------- Upkeep ----------
// Your account: sign in with Google so your Photons, chats, and
// purchases follow you to any device. Signing in is free and creates
// the account if there is not one yet. We see only your name and
// email. Signing out leaves everything on the server; signing back in
// with the same Google account brings it all back.
function accountCard(): string {
  // No state yet: say which of the two it is. While the server is
  // still answering, the card says it is checking — it must never
  // claim "not signed in" before the answer arrives, because that
  // false negative is what the owner kept seeing. When the server
  // did not answer at all, the card says so plainly and offers a
  // retry, instead of sitting on a loading line forever.
  if (!state) {
    if (stateFailed) {
      return `<div class="card">
      <h2>Your account</h2>
      <p>Prism didn't answer just now, so your Google connection couldn't be checked. Nothing about your account has changed — check your connection and try again.</p>
      <div class="row"><button class="btn primary" data-action="retry-state">Check again</button></div>
    </div>`;
    }
    return `<div class="card">
      <h2>Your account</h2>
      <p>Checking your Google connection…</p>
    </div>`;
  }
  const auth = (state as any)?.auth;
  if (!auth || !auth.signedIn) {
    return `<div class="card">
      <h2>Your account</h2>
      <p>You are not signed in. Your Supernovas, chats, and purchases live on this device only right now — sign in with Google and they follow you to any device, and they survive a new phone.</p>
      <p class="fine">Signing in creates your account, and it comes with two things: a story for your first Supernova, and 15% off your first order for 10 days.</p>
      <div class="row"><button class="btn primary" data-action="signin">Sign in with Google</button></div>
      <p class="fine">We see only your name and email. Nothing else from your Google account is read or kept.</p>
    </div>`;
  }
  const perk = (state as any)?.perk;
  const prismStory = (state as any)?.backstories?.Prism;
  return `<div class="card">
    <h2>Your account</h2>
    <p>Signed in as <b>${esc(auth.name || auth.email || "")}</b>${auth.email && auth.name ? ` (${esc(auth.email)})` : ""}.</p>
    <p class="fine">Account since ${esc(fmtDateOnly(auth.since || ""))}. Your Supernovas, chats, and purchases follow this account to any device.</p>
    <div class="row"><button class="btn" data-action="signout">Sign out</button></div>
  </div>
  ${perk && perk.active ? `<div class="card perk-card">
    <h2>Your welcome offer — 15% off your first order</h2>
    <p>Your code is <b>${esc(perk.code)}</b>, good until ${esc(fmtDateOnly(perk.expiresAt))}. It is already filled in at checkout in the Store, so the discount is there when the page opens. One order only.</p>
  </div>` : ""}
  ${prismStory ? `<div class="card">
    <h2>How Prism began</h2>
    <p>${esc(prismStory)}</p>
  </div>` : ""}`;
}

function readabilityCard(): string {
  const sizeBtn = (s: ReadSize, label: string) =>
    `<button class="btn${readSize === s ? " primary" : ""}" data-action="read-size" data-size="${s}" aria-pressed="${readSize === s}">${label}</button>`;
  return `<div class="card">
    <h2>Reading</h2>
    <p class="fine">Bigger text and stronger contrast, for older eyes. Saved on this device, and it follows you across Chat, Connected, the Store, and You.</p>
    <h4>Text size</h4>
    <div class="row" role="group" aria-label="Text size">
      ${sizeBtn("normal", "Normal")}${sizeBtn("large", "Large")}${sizeBtn("xl", "Extra-large")}
    </div>
    <h4>Contrast</h4>
    <div class="row">
      <button class="btn${readContrast ? " primary" : ""}" data-action="read-contrast" aria-pressed="${readContrast}">${readContrast ? "High contrast: on" : "High contrast: off"}</button>
    </div>
  </div>`;
}

// The opening-animation switch: the same on-this-device setting as
// Reading, in the same place. On means the opening plays every
// time the app opens; off means the app opens straight into Chat
// (or wherever it was left) with no opening at all, until it is
// turned back on here. Reduced motion still skips the opening on
// its own, whatever this says.
function openingCard(): string {
  return `<div class="card">
    <h2>Opening animation</h2>
    <p class="fine">The opening that plays when the app opens — a shaft of light that gathers and splits into your helpers. Turn it off and the app opens straight in, every time, until you turn it back on. Saved on this device.</p>
    <div class="row">
      <button class="btn${playOpening ? " primary" : ""}" data-action="opening-toggle" aria-pressed="${playOpening}">${playOpening ? "Opening animation: on" : "Opening animation: off"}</button>
    </div>
  </div>`;
}

// The interface-sounds switch: the same on-this-device setting as
// Reading and Opening, in the same place. On means every tap, switch,
// and screen change plays its tiny sound; off means silence, except
// the one blip that confirms flipping this very switch (so the switch
// never feels dead). The sounds are synthesized in the app itself, so
// they play instantly with nothing to download. Saved on this device.
function soundsCard(): string {
  const on = soundsEnabled();
  return `<div class="card">
    <h2>Interface sounds</h2>
    <p class="fine">Tiny sounds for taps, switches, and screen changes — a click, a toggle blip, a swoosh. Quiet on purpose: they sit under everything else and never get in the way.</p>
    <div class="row">
      <button class="btn${on ? " primary" : ""}" data-action="sound-toggle" aria-pressed="${on}">${on ? "Interface sounds: on" : "Interface sounds: off"}</button>
    </div>
  </div>`;
}

// ---------- You ----------
// Your account and how the app behaves — and nothing for sale
// (redesign, Nov 19, 2026). Settings used to sit here as a stack of
// cards interleaved with upsell cards on the Upkeep tab; now they
// live here, behind the account, and the Store does the selling.
// The name form and the chat meter moved here from the Chat home, and
// About you and Memory import moved here from Connected: everything
// about you, in the one place about you. Upkeep itself — the $29/mo
// subscription — lives only in the Store now, and redeeming a code
// lives only there too.
function nameCard(): string {
  const customName = state?.customName || "";
  return `<div class="card make-yours">
      <h2>Make it yours</h2>
      <p>Give your assistant a name. It replaces "Prism 5" everywhere in this app until you clear it.</p>
      <form id="name-form" class="row">
        <input id="name-input" type="text" maxlength="40" placeholder="e.g. Megan" value="${esc(customName)}" aria-label="Your assistant's name">
        <button class="btn primary" type="submit">Save name</button>
        ${customName ? `<button class="btn" type="button" data-action="clear-name">Clear</button>` : ""}
      </form>
    </div>`;
}

// What a product slug reads as in "What you own" — plain words, not slugs.
function productDisplayName(slug: string): string {
  if (slug === "nova") return "Nova — personal";
  if (slug === "supernova") return "Supernova";
  if (slug === "satellite") return "Satellite";
  if (slug === "personal-upkeep") return "Personal Upkeep";
  return slug
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// Nova, on its own card in You — distinct from the business Launches
// below it. The two gentler defaults ride here: check-ins and
// getting-started nudges, on from the moment Nova is owned, each with
// its own switch. Personal Upkeep state sits alongside it.
function novaCard(): string {
  const ownedProducts: string[] = state?.ownedProducts || [];
  const allOwned = state?.freeCode === true;
  if (!allOwned && !ownedProducts.includes("nova")) return "";
  const ns = state?.novaSettings || { checkIns: true, gettingStartedNudges: true };
  const hasPersonalUpkeep = allOwned || ownedProducts.includes("personal-upkeep");
  return `<div class="card">
    <h2>Nova — for your own day</h2>
    <p><span class="owned-badge">Yours</span></p>
    <p class="fine">Your personal helper. It opens the personal set:</p>
    <ul class="included-list">${PERSONAL_FEATURES.map((f) => `<li>${esc(f.label)}</li>`).join("")}</ul>
    <h3>Gentle, by default</h3>
    <p class="fine">Check-ins and getting-started nudges are on for Nova owners, from the start. Turn either off here and it stays off.</p>
    <div class="row">
      <button class="btn${ns.checkIns ? " primary" : ""}" data-action="nova-checkins" aria-pressed="${ns.checkIns ? "true" : "false"}">${ns.checkIns ? "Check-ins: on" : "Check-ins: off"}</button>
      <button class="btn${ns.gettingStartedNudges ? " primary" : ""}" data-action="nova-nudges" aria-pressed="${ns.gettingStartedNudges ? "true" : "false"}">${ns.gettingStartedNudges ? "Getting-started nudges: on" : "Getting-started nudges: off"}</button>
    </div>
    <p class="fine">Personal Upkeep: ${hasPersonalUpkeep ? "on — $9 a month, keeping your personal helper cared for." : "not on yet. Your first three months come with Nova; after that it is $9 a month in the Store, beside Nova."}</p>
  </div>`;
}

// The business set, shown locked for a Nova-only owner — never hidden,
// never half-open: the list says what it is and what opens it. The
// server's feature gate (state.features) decides; ownership is only
// the fallback for a state that predates it.
function businessLockedCard(): string {
  const ownedProducts: string[] = state?.ownedProducts || [];
  const allOwned = state?.freeCode === true;
  const features = state?.features as { personal: boolean; business: boolean } | undefined;
  const hasBusiness = features
    ? features.business
    : allOwned || ownedProducts.includes("supernova") || ownedProducts.includes("satellite");
  const hasPersonal = features
    ? features.personal
    : allOwned ||
      ownedProducts.includes("nova") ||
      ownedProducts.includes("supernova") ||
      ownedProducts.includes("satellite");
  if (!hasPersonal || hasBusiness) return "";
  return `<div class="card">
    <h2>The business set — locked</h2>
    <p class="fine">Nova is for your own day. These stay locked unless you own a business Launch — Supernova or Satellite:</p>
    <ul class="included-list">${BUSINESS_FEATURES.map((f) => `<li>${esc(f.label)}</li>`).join("")}</ul>
    <div class="row"><button class="btn primary" data-action="goto" data-tab="store">See business Launches in the Store</button></div>
  </div>`;
}

// The side switcher also lives here, in You, under Settings — the same
// place the other app-wide choices live. (Since Nov 25, 2026 the same
// switch sits on the Chat front and at the top of the Store too, so it
// is never more than a tap away.) Two doors, one app: Business shows
// the business Launches and prices, Personal shows Nova, the Atoms, and
// personal prices. Switching never touches what you own.
function sideCard(): string {
  const current = sideOrDefault();
  return `<div class="card">
    <h2>Business or Personal</h2>
    <p class="fine">Two doors, one app. Business shows the business Launches and prices; Personal shows Nova and personal prices. Switch any time — nothing you own changes.</p>
    <div class="row" role="group" aria-label="Business or Personal">
      <button class="btn${current === "business" ? " primary" : ""}" data-action="side-pick" data-side="business" aria-pressed="${current === "business" ? "true" : "false"}">For my business</button>
      <button class="btn${current === "personal" ? " primary" : ""}" data-action="side-pick" data-side="personal" aria-pressed="${current === "personal" ? "true" : "false"}">For me, personally</button>
    </div>
  </div>`;
}

function renderYou(): string {
  const ownedSupernovas: string[] = state?.ownedSupernovas || [];
  const ownedNovas: string[] = state?.ownedNovas || [];
  const ownedProducts: string[] = state?.ownedProducts || [];
  // Nova and Personal Upkeep have their own card above; the list below
  // is the business Launches and the Sparks and Plugs.
  const listedProducts = ownedProducts.filter((s) => s !== "nova" && s !== "personal-upkeep");
  const ownedList =
    ownedSupernovas.length || ownedNovas.length || listedProducts.length
      ? `<ul class="owned-list">${ownedSupernovas.map((n) => `<li>Supernova ${esc(n)}</li>`).join("")}${ownedNovas.map((n) => `<li>Nova ${esc(n)}</li>`).join("")}${listedProducts
          .map((s) => `<li>${esc(productDisplayName(s))}</li>`)
          .join("")}</ul>`
      : `<p class="fine">Nothing owned yet.</p>`;
  return `
  <section>
    <h1 class="page-title">You</h1>
    <p class="page-lede">Your account, and how the app behaves. Nothing for sale here — buying happens in the Store.</p>

    ${accountCard()}

    ${nameCard()}

    <div class="card">
      <h2>Your chats</h2>
      <p class="meter-line">${esc(meterLine())}</p>
      ${meterBar()}
      <p class="fine">Every purchase includes 300 chats a month, free forever. No subscription needed.</p>
    </div>

    <div class="card">
      <h2>What you own</h2>
      ${ownedList}
    </div>

    ${novaCard()}

    ${businessLockedCard()}

    <h2 class="section-title">Settings</h2>

    ${sideCard()}

    ${readabilityCard()}

    ${openingCard()}

    ${soundsCard()}

    ${renderProfile()}

    ${renderMemoryImport()}

    ${renderProactive()}
  </section>`;
}

// ---------- Shell ----------
function renderNav() {
  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "connected", label: "Connected" },
    { id: "store", label: "Store" },
    { id: "you", label: "You" },
  ];
  nav().innerHTML = tabs
    .map(
      (t) =>
        `<button class="nav-btn ${tab === t.id ? "active" : ""}" data-action="goto" data-tab="${t.id}">${NAV_ICONS[t.id]}${t.label}</button>`,
    )
    .join("");
  const headerName = document.getElementById("app-header-name");
  if (headerName) headerName.textContent = state?.displayName || "Prism 5";
}

// A Photon's look tints its thread's surfaces only (readability spec
// §3A.6, Nov 21, 2026): the brand bar and the bottom nav keep the
// house palette, so moving between Photons changes the room's light,
// not the building. The look class therefore rides on the thread
// section and the Photon card (set in their own markup), never on
// <body>; this only clears any body class an older build left behind.
function syncBodyLook() {
  for (const s of LOOK_SETS) document.body.classList.remove(`look-${s.id}`);
}

// ---------- Chat backgrounds: the room you talk in ----------
// On-brand poster art behind the chat. A dozen backgrounds that swap:
// every tab or Photon change steps to the next one in the cycle, and a
// timer steps to the next one every minute, so the room keeps changing
// as you move around instead of two black boxes talking to each other.
// Switching tabs (or Photons) slides the background along with the
// view: it fades and shifts out, the art swaps mid-fade, and it slides
// back in.
const CHAT_BACKGROUNDS = [
  "/chat-bg/bg-rocket.jpg",
  "/chat-bg/bg-helmets.jpg",
  "/chat-bg/bg-starburst.jpg",
  "/chat-bg/bg-robot.jpg",
  "/chat-bg/bg-saucer.jpg",
  "/chat-bg/bg-raygun.jpg",
  "/chat-bg/bg-car.jpg",
  "/chat-bg/bg-pilot.jpg",
  "/chat-bg/bg-moonbase.jpg",
  "/chat-bg/bg-diner.jpg",
  "/chat-bg/bg-launchpad.jpg",
  "/chat-bg/bg-spacestation.jpg",
];
const BG_SWAP_INTERVAL_MS = 60000;
const TAB_ORDER: Tab[] = ["chat", "connected", "store", "you"];
let bgIndex = 0;
let lastBgKey = "";
let lastTab: Tab = "chat";
let bgSwapTimer: number | null = null;
let bgIntervalTimer: number | null = null;

function bgSeed(): string {
  if (tab === "chat") return activePhoton ? "photon:" + activePhoton : "chat-front";
  return "tab:" + tab;
}

function applyBackground(url: string, dir: number): void {
  const bg = document.getElementById("app-bg") as HTMLElement | null;
  if (!bg) return;
  if (bgSwapTimer) window.clearTimeout(bgSwapTimer);
  bg.classList.add("is-sliding");
  bg.style.setProperty("--bg-shift", `${dir * 48}px`);
  bgSwapTimer = window.setTimeout(() => {
    bg.style.backgroundImage = `url("${url}")`;
    bg.classList.remove("is-sliding");
  }, 500);
}

function nextBackground(dir: number): void {
  bgIndex = (bgIndex + 1) % CHAT_BACKGROUNDS.length;
  applyBackground(CHAT_BACKGROUNDS[bgIndex], dir);
}

function startBgInterval(): void {
  if (bgIntervalTimer !== null) return;
  bgIntervalTimer = window.setInterval(() => {
    if (document.hidden) return;
    nextBackground(1);
  }, BG_SWAP_INTERVAL_MS);
}

function syncAppBackground(): void {
  const bg = document.getElementById("app-bg") as HTMLElement | null;
  if (!bg) return;
  startBgInterval();
  const key = bgSeed();
  // Slide direction follows the tab order: moving right through the tabs
  // slides the art in from the right, moving back slides it from the left.
  const dir = TAB_ORDER.indexOf(tab) >= TAB_ORDER.indexOf(lastTab) ? 1 : -1;
  const changed = key !== lastBgKey;
  lastBgKey = key;
  lastTab = tab;
  if (!changed && bg.style.backgroundImage) return;
  if (!bg.style.backgroundImage) {
    // First paint: show the current background without advancing.
    applyBackground(CHAT_BACKGROUNDS[bgIndex], dir);
    return;
  }
  // Tab or Photon change: step to the next background in the cycle.
  nextBackground(dir);
}

// A view change (tab, thread, customizer, call screen, briefing) fades
// in gently instead of cutting in: the app reads as one coherent thing,
// not pieces stuck together. Same-view re-renders — data arriving, chat
// streaming — swap instantly, so nothing flickers while it works. The
// animation lives in styles.css (.view-enter) and is off under
// prefers-reduced-motion. The fade is slow and symmetric — 600ms out
// and 600ms in (--t-view) by the fade rule (Nov 19, 2026) and the
// readability spec §2.5 (Nov 21, 2026): nothing may feel like a video
// popping up.

// A tab switch fades the old view out slowly first (fadeTo, below),
// then the new view fades in — the fade rule, both directions. A
// second tap while fading cancels the first fade, so fast tapping
// never strands the view half-faded. Same-view renders skip this
// entirely and stay instant.
let navFadeTimer: number | null = null;
function fadeTo(fn: () => void, after?: () => void): void {
  const v = view();
  if (navFadeTimer) {
    window.clearTimeout(navFadeTimer);
    navFadeTimer = null;
  }
  v.classList.add("view-leaving");
  navFadeTimer = window.setTimeout(() => {
    navFadeTimer = null;
    v.classList.remove("view-leaving");
    fn();
    if (after) after();
  }, 600);
}
let lastViewKey = "";
function viewKey(): string {
  return [tab, activePhoton || "", customizePhoton || "", callPhotonName || "", dayOpen ? "day" : ""].join("|");
}

function render() {
  renderNav();
  const v = view();
  const key = viewKey();
  const switched = key !== lastViewKey;
  lastViewKey = key;
  if (tab === "chat")
    v.innerHTML = callPhotonName
      ? renderCallScreen()
      : customizePhoton
        ? renderCustomize()
        : dayOpen
          ? renderDayBriefing()
          : activePhoton
            ? renderChatThread()
            : renderChatFront();
  else if (tab === "connected") v.innerHTML = renderConnected();
  else if (tab === "store") v.innerHTML = renderStore();
  else v.innerHTML = renderYou();
  if (switched) {
    // Restart the entrance animation even when switching fast: remove,
    // force a reflow, re-add.
    v.classList.remove("view-enter");
    void v.offsetWidth;
    v.classList.add("view-enter");
  }
  // Thread mode: a chat thread is a full-height flex column (see
  // body.is-thread in styles.css), so the keyboard never blocks the
  // conversation or the composer. Only a real thread gets it — the
  // front page, the call screen and the customizer keep the normal
  // document layout.
  document.body.classList.toggle(
    "is-thread",
    tab === "chat" && !callPhotonName && !customizePhoton && !!activePhoton,
  );
  syncBodyLook();
  syncAppBackground();
  syncGoogleState();
  // The chat input is never focused for the user: focusing it after
  // every render keeps the keyboard up and can scroll the messages
  // around. The owner taps it when they want to write.
}

async function refreshState(): Promise<boolean> {
  const r = await api.state();
  if (r && r.ok) {
    state = r;
    stateFailed = false;
    await loadPinnedFaces();
    // The side lives on the account: the account wins over the device
    // cache. When the account has no side yet but this device picked
    // one (while signed out, or on a device that never synced), push
    // the device choice up, so the account — and the website — follows
    // it from here on.
    const accountSide = (r as any)?.side === "personal" || (r as any)?.side === "business" ? (r as any).side : "";
    if (accountSide) {
      if (side !== accountSide) {
        side = accountSide;
        try {
          localStorage.setItem(SIDE_KEY, accountSide);
        } catch {
          // Private mode: the choice lasts for this session only.
        }
        storeVariant = accountSide;
      }
    } else if (side) {
      api.profileSave({ side }).catch(() => {});
    }
    return true;
  }
  stateFailed = true;
  return false;
}

// The Google connection, in plain words, from what the app actually
// knows right now. Five states, never a silent endless "connecting":
// checking (state still loading), connected, not connected,
// unreachable (the server did not answer), and reconnect (the app
// sign-in is fine, but a Gmail grant the Connected tab has actually
// tried came back dead — the pill must not say "connected" over a
// mailbox that will not open). The header pill and the You account
// card both read this, so the two can never disagree. The reconnect
// state only fires on evidence: inbox results loaded this session
// that carry a token failure. With no inbox data yet, the pill
// reports the sign-in, as before.
type GoogleConnection = "checking" | "connected" | "not-connected" | "unreachable" | "reconnect";
function googleConnectionState(): GoogleConnection {
  if (!state) return stateFailed ? "unreachable" : "checking";
  const accts = (state as any)?.inboxAccounts as any[] | undefined;
  if (
    Array.isArray(accts) &&
    accts.some((a: any) => a?.error === "token_failed" || a?.error === "auth_failed")
  ) {
    return "reconnect";
  }
  return (state as any)?.auth?.signedIn ? "connected" : "not-connected";
}

// The glanceable pill in the header: the owner can tell at a glance,
// on any tab, whether Google is connected. A state change fades the
// pill out and back in slowly (600ms) rather than swapping the words
// in a chop — the fade rule.
function syncGoogleState(): void {
  const el = document.getElementById("google-state");
  if (!el) return;
  const s = googleConnectionState();
  const label =
    s === "connected"
      ? "Google connected"
      : s === "reconnect"
        ? "Google reconnect needed"
        : s === "not-connected"
          ? "Google not connected"
          : s === "unreachable"
            ? "Google unreachable"
            : "Checking Google…";
  if (el.dataset.state === s && el.textContent === label) return;
  el.dataset.state = s;
  el.classList.add("is-changing");
  window.setTimeout(() => {
    el.textContent = label;
    el.classList.remove("is-changing");
  }, 300);
}

async function loadConnected() {
  // The first five calls are independent: fire them together instead
  // of queuing them one by one — the old serial chain was a big part
  // of why opening Connected felt claggy. The flag keeps the Email
  // section honest while they fly ("Checking your inbox…", not a
  // false "nothing connected yet").
  inboxesLoading = true;
  try {
    const [r, o, im, pr, c, prof, mem] = await Promise.all([
      api.inboxes(),
      api.outlookInboxes(),
      api.imapInboxes(),
      api.imapProviders(),
      api.contacts(),
      api.profileGet(),
      api.memoryList(),
    ]);
    if (r && r.ok) {
      state.inboxAccounts = r.accounts;
      state.googleConfigured = r.googleConfigured;
    }
    if (o && o.ok) {
      state.outlookAccounts = o.accounts;
      state.microsoftConfigured = o.microsoftConfigured;
    }
    if (im && im.ok) {
      state.imapAccounts = im.accounts;
    }
    if (pr && pr.ok) {
      imapProvidersData = pr.providers || [];
    }
    if (c && c.ok) state.contacts = c.contacts || [];
    if (prof && prof.ok) {
      profileData = prof.profile || null;
      profileSaved = false;
    }
    if (mem && mem.ok) memoryImportsData = mem.imports || [];
  // Messages, Calendar, Drive: each status endpoint answers honestly
  // when its service is not connected, so a failure here just leaves
  // that section in its "not connected yet" state.
  const [ts, tx, cl, cal, ev, fb, ds, dr] = await Promise.all([
    api.textsStatus(),
    api.texts(),
    api.calls(),
    api.calendarStatus(),
    api.calendarEvents(),
    api.calendarFreeBusy(),
    api.driveStatus(),
    api.driveSearch(driveQuery || undefined),
  ]);
  if (ts) state.textsStatus = ts;
  if (tx && tx.ok) state.texts = tx.texts || [];
  if (cl && cl.ok) state.calls = cl.calls || [];
  if (cal) state.calendarStatus = cal;
  if (ev && ev.ok) state.calendarEvents = ev.events || [];
  if (fb && fb.ok) state.freeBusy = fb.busy || [];
  if (ds) state.driveStatus = ds;
  if (dr && dr.ok) state.driveFiles = dr.files || [];
const ms = await api.messengerStatus();
  if (ms && ms.ok) {
    messengerStatusData = ms;
    const pg = await api.messengerPages();
    if (pg && pg.ok) {
      messengerPagesData = pg.pages || [];
      // The selected Page is the first one connected here, or the
      // server's Page when none is connected here. A selection that no
      // longer exists (a Page just disconnected) falls back the same way.
      const ids = new Set((messengerPagesData || []).map((p: any) => String(p.pageId)));
      if (messengerSelectedPageId && !ids.has(messengerSelectedPageId)) {
        messengerSelectedPageId = null;
        messengerOpenId = null;
        messengerOpenMessages = null;
      }
      if (!messengerSelectedPageId && (messengerPagesData || []).length) {
        messengerSelectedPageId = String((messengerPagesData || [])[0].pageId);
      }
    }
    if (ms.configured || (messengerPagesData && messengerPagesData.length)) {
      await reloadMessengerThreads();
    } else {
      messengerThreadsData = [];
    }
  }
  } finally {
    inboxesLoading = false;
  }
}

async function reloadCalendar() {
  const [cal, ev, fb] = await Promise.all([api.calendarStatus(), api.calendarEvents(), api.calendarFreeBusy()]);
  if (cal) state.calendarStatus = cal;
  if (ev && ev.ok) state.calendarEvents = ev.events || [];
  if (fb && fb.ok) state.freeBusy = fb.busy || [];
}

async function reloadMessages() {
  const [ts, tx, cl] = await Promise.all([api.textsStatus(), api.texts(), api.calls()]);
  if (ts) state.textsStatus = ts;
  if (tx && tx.ok) state.texts = tx.texts || [];
  if (cl && cl.ok) state.calls = cl.calls || [];}

// ---------- Events (delegation) ----------
// Remember which Store sections the user opened. The toggle event doesn't
// bubble, so listen in the capture phase on the document.
document.addEventListener(
  "toggle",
  (e) => {
    const d = e.target as HTMLDetailsElement;
    if (d && d.tagName === "DETAILS" && d.id.startsWith("store-")) {
      storeOpen[d.id.slice("store-".length)] = d.open;
      // A section opening or closing is a switch: the toggle blip,
      // up when it opens, down when it closes.
      playToggle(d.open);
    }
  },
  true,
);

// ---------- Vending machine drum drag ----------
// A horizontal drag across a machine's glass steps the drum, one
// compartment per stride, the way a thumb would turn the real drum.
// Vertical page scrolling is untouched (the window is pan-y), and a
// drag that actually turned the drum swallows the click it ends
// with, so a Face is never opened by accident mid-spin.
let machineDrag: { id: string; x: number } | null = null;
let machineDragMoved = false;
document.addEventListener("pointerdown", (e) => {
  machineDragMoved = false;
  const w = (e.target as HTMLElement).closest(".machine-window");
  const root = w?.closest(".machine") as HTMLElement | null;
  if (!root) return;
  machineDrag = { id: root.dataset.machine || "", x: e.clientX };
});
document.addEventListener("pointermove", (e) => {
  if (!machineDrag) return;
  const dx = e.clientX - machineDrag.x;
  if (Math.abs(dx) < 42) return;
  machineGo(
    machineDrag.id,
    (machineIndex[machineDrag.id] || 0) + (dx < 0 ? 1 : -1),
  );
  machineDrag.x = e.clientX;
  machineDragMoved = true;
});
document.addEventListener("pointerup", () => {
  machineDrag = null;
});
document.addEventListener("pointercancel", () => {
  machineDrag = null;
});
document.addEventListener(
  "click",
  (e) => {
    if (!machineDragMoved) return;
    machineDragMoved = false;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

// ---------- Interface sounds: which tap makes which sound ----------
// Every tap answers with its tiny sound, before anything else runs,
// so a slow network or a redirect never leaves the tap silent.
// A switch gets the toggle blip (up when it turns on, down when it
// turns off), a screen change or a dismissal gets the swoosh, and
// everything else gets the click. The sound-toggle itself is not in
// either set: its handler plays its own blip with force, so flipping
// sounds off still answers the tap.
const SWOOSH_ACTIONS = new Set([
  "goto",
  "back-to-front",
  "open-photon",
  "open-atom",
  "machine-dispense-chat",
  "card-chat",
  "card-chat-atom",
  "chooser-skip",
  "day-start",
  "day-back",
  "custom-back",
  "custom-design-back",
  "msg-thread",
  "goto-messenger",
  "drive-open",
  "drive-close",
  "research-close",
  "photon-info",
  "atom-info",
  "product-info",
  "tier-info",
  "card-close",
]);
const TOGGLE_DIRECTIONS: Record<string, () => boolean> = {
  // The direction is read before the handler runs, so the blip knows
  // which way the switch is going.
  "opening-toggle": () => !playOpening,
  "opening-off": () => false,
  "push-toggle": () => !(pushData && pushData.subscribed),
  "read-contrast": () => !readContrast,
  "nova-checkins": () => !(state?.novaSettings?.checkIns ?? true),
  "nova-nudges": () => !(state?.novaSettings?.gettingStartedNudges ?? true),
  "day-move-show": () => !dayMoveOpen,
  "call-mic": () => callPhase !== "recording",
  "pin-face": () => true,
  "unpin-face": () => false,
};

document.addEventListener("click", async (e) => {
  // A connect link leaves for Google or Microsoft: say so on the link
  // first, so the tap reads as answered while the sign-in loads
  // instead of sitting there looking dead.
  const oauthLink = (e.target as HTMLElement).closest('a[href^="/api/oauth/"]') as HTMLAnchorElement | null;
  if (oauthLink && !oauthLink.dataset.busy) {
    oauthLink.dataset.busy = "1";
    oauthLink.textContent = oauthLink.href.includes("microsoft") ? "Connecting to Microsoft…" : "Connecting to Google…";
    oauthLink.setAttribute("aria-disabled", "true");
  }
  const t = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!t) return;
  const action = t.dataset.action || "";
  if (action in TOGGLE_DIRECTIONS) playToggle(TOGGLE_DIRECTIONS[action]());
  else if (SWOOSH_ACTIONS.has(action)) playSwoosh();
  else if (action !== "sound-toggle") playClick();
  if (action === "goto") {
    const next = t.dataset.tab as Tab;
    const scrollTo = t.dataset.scroll || "";
    const doSwitch = () => {
      tab = next;
      activePhoton = null;
      customizePhoton = null;
      dayOpen = false;
      // A connect confirmation only lives on the Connected tab it
      // belongs to, and so does a connect failure.
      if (tab !== "connected") {
        justConnected = "";
        connectError = "";
        connectErrorKind = "";
      }
      // Ending a call leaves the thread; the call screen is chat-only.
      if (callPhotonName) endCall();
      if (tab === "connected") loadConnected().then(render);
      if (tab === "you") loadYou().then(render);
      if (tab === "store") loadStripeStatus().then(render);
      render();
      // A new place starts at its top: the last tab's scroll depth
      // must not carry over (a switch used to land mid-page).
      window.scrollTo(0, 0);
      // A jump inside the new view (the blocked-call button lands on
      // the Store's Upkeep card): scroll once the view has landed.
      if (scrollTo) {
        const el = document.getElementById(scrollTo);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    };
    // A real tab change fades the old view out slowly first (the fade
    // rule), then the new view fades in — no chop between places.
    // Staying on the same tab switches at once.
    if (next !== tab) fadeTo(doSwitch);
    else doSwitch();
  } else if (action === "email-open") {
    // A summary row opens the whole message, one tap.
    const p = t.dataset.provider || "";
    openEmailMessage(
      p === "outlook" ? "outlook" : p === "imap" ? "imap" : "gmail",
      t.dataset.label || "",
      t.dataset.id || "",
      t,
    );
  } else if (action === "imap-disconnect") {
    // Forget an IMAP mailbox and its app-specific password. The mail
    // itself is untouched; the card goes away with it.
    t.setAttribute("disabled", "");
    const label = t.dataset.label || "";
    const r = await api.imapDisconnect(label);
    if (r && r.ok) {
      toast("Mailbox disconnected.");
      justConnected = "";
      await loadConnected();
      render();
    } else {
      toast("That mailbox didn't disconnect. Try again.", "err");
      t.removeAttribute("disabled");
    }
  } else if (action === "email-retry-open") {
    // The message didn't open: same message, one more try.
    if (emailOpenRetry) {
      openEmailMessage(emailOpenRetry.provider, emailOpenRetry.label, emailOpenRetry.id, t);
    }
  } else if (action === "inbox-retry") {
    // An inbox that didn't answer: say so on the button, then reload
    // the inboxes and re-render.
    t.setAttribute("disabled", "");
    t.textContent = "Checking…";
    loadConnected().then(render);
  } else if (action === "end-call") {
    endCall();
  } else if (action === "signin") {
    // App sign-in with Google. The server redirects to Google and back;
    // the return lands on You with a one-time session token. Say so
    // on the button first: the redirect can take a moment, and a button
    // that does nothing while Google loads reads as broken.
    t.setAttribute("disabled", "");
    t.textContent = "Taking you to Google…";
    location.href = `/api/oauth/google/start-signin?accountId=${encodeURIComponent(getAccountId())}`;
  } else if (action === "read-size") {
    const s = t.dataset.size;
    setReadSize(s === "large" || s === "xl" ? s : "normal");
  } else if (action === "read-contrast") {
    setReadContrast(!readContrast);
  } else if (action === "opening-toggle") {
    // Upkeep switch: flip the opening on or off for every later
    // open, on this device. The change takes effect from the next
    // open — an opening already playing is untouched.
    setPlayOpening(!playOpening);
    toast(
      playOpening
        ? "The opening animation will play when the app opens."
        : "The opening animation is off — the app will open straight in.",
    );
  } else if (action === "sound-toggle") {
    // Upkeep switch: flip the interface sounds on or off, on this
    // device. The blip is forced, so flipping them off still answers
    // the tap and flipping them on is heard at once; every other
    // sound respects the setting from the next tap on.
    const on = !soundsEnabled();
    setSoundsEnabled(on);
    playToggle(on, true);
    render();
    toast(on ? "Interface sounds are on." : "Interface sounds are off.");
  } else if (action === "nova-checkins" || action === "nova-nudges") {
    // Nova's gentler default, switched by the owner: check-ins or
    // getting-started nudges, on until turned off. Saved on the server
    // for this account, so it follows the owner across devices — and
    // the state re-read is the save, so a failed save never shows as
    // flipped.
    const key = action === "nova-checkins" ? "checkIns" : "gettingStartedNudges";
    const label = action === "nova-checkins" ? "Check-ins" : "Getting-started nudges";
    const next = !(state?.novaSettings?.[key] ?? true);
    t.setAttribute("disabled", "");
    const r = await api.novaSettings({ [key]: next });
    if (r && r.ok && r.novaSettings) {
      state.novaSettings = r.novaSettings;
      toast(`${label} ${next ? "on" : "off"}.`);
    } else {
      toast("That switch didn't save. Try again.", "err");
    }
    render();
  } else if (action === "opening-off") {
    // The persistent off switch on the opening itself: turn the
    // opening off for every later open, then skip the rest of this one. The
    // splash's own tap-to-skip listener does the fade-out (this tap
    // bubbles up to it); this handler only records the choice.
    setPlayOpening(false);
    toast("The opening won't play again. Turn it back on in You, under Settings.");
  } else if (action === "side-pick") {
    // A door, picked in the first-open chooser or in the You tab: the
    // choice persists on this device, the chooser goes away, and the
    // Store follows the side at once.
    const picked = t.dataset.side === "personal" ? "personal" : "business";
    setSide(picked);
    hideChooser();
    render();
    toast(
      picked === "personal"
        ? "Personal side — Nova and personal prices."
        : "Business side — Supernova, Satellite, and business prices.",
    );
  } else if (action === "chooser-skip") {
    // Continue into the app without signing in — and without picking a
    // door. Nothing is stored, so the chooser shows again on the next
    // open until a door is picked.
    hideChooser();
  } else if (action === "signout") {
    // Sign-out is local only: drop this device's account id and start
    // a fresh anonymous one. Everything stays on the server, and
    // signing back in with the same Google account brings it all back.
    clearAccountId();
    await refreshState();
    render();
    toast("Signed out. This device has a fresh, unsigned-in account now.");
  } else if (action === "retry-state") {
    // The server didn't answer on boot, and the account card said so:
    // check again. The button answers while the check runs, and a
    // second failure says so instead of going quiet.
    t.setAttribute("disabled", "");
    t.textContent = "Checking…";
    await refreshState();
    render();
    if (!state) toast("Still can't reach Prism. Check your connection and try again.", "err");
  } else if (action === "call-mic") {
    toggleCallMic();
  } else if (action === "check-now") {
    runProactiveCheck();
  } else if (action === "reminder-done") {
    const id = t.dataset.id || "";
    api.reminderDone(id).then(async (r: any) => {
      if (r && r.ok) {
        const rems = await api.reminders();
        if (rems && rems.ok) remindersData = rems.reminders || [];
        render();
        toast("Reminder done.");
      } else {
        toast("That didn't save. Try again.", "err");
      }
    });
  } else if (action === "day-start") {
    if (!ownsStartMyDay()) {
      toast("Start My Day is a Plug — find it in the Store.", "err");
      return;
    }
    dayOpen = true;
    dayHandled = 0;
    dayData = null;
    dayMoveOpen = false;
    loadDayBriefing();
  } else if (action === "day-back") {
    dayOpen = false;
    dayData = null;
    render();
  } else if (action === "day-confirm") {
    dayConfirmCurrent(t.dataset.confirm || "");
  } else if (action === "day-move-show") {
    dayMoveOpen = !dayMoveOpen;
    render();
  } else if (action === "day-move-quick") {
    dayMoveQuick(t.dataset.when || "later");
  } else if (action === "day-move-custom") {
    const input = document.getElementById("day-move-when") as HTMLInputElement | null;
    const value = input?.value || "";
    if (!value) {
      toast("Pick a time first.", "err");
      return;
    }
    dayMoveWith(new Date(value));
  } else if (action === "push-toggle") {
    togglePush();
  } else if (action === "msg-thread") {
    const id = t.dataset.id || "";
    if (id) openMessengerThread(id);
  } else if (action === "research-close") {
    const box = document.getElementById("research-results");
    if (box) {
      box.hidden = true;
      box.innerHTML = "";
    }
  } else if (action === "open-photon") {
    const name = t.dataset.photon || "";
    dayOpen = false;
    if (name) openPhoton(name);
  } else if (action === "photon-info") {
    // A Photon portrait in the Store: the character card, not the chat.
    // The Chat front keeps its own tap-to-open-thread behavior.
    openPhotonCard(t.dataset.photon || "", t);
  } else if (action === "atom-info") {
    // An Atom portrait in the Store: the character card, same as a
    // Photon's. An owned Atom's card carries the chat button.
    openAtomCard(t.dataset.atom || "", t);
  } else if (action === "open-atom") {
    // An owned Atom on the Chat front: open its thread, the same
    // thread view a Photon uses.
    const name = t.dataset.atom || "";
    dayOpen = false;
    if (name) openThread(name);
  } else if (action === "machine-prev") {
    // A machine steps in place — no full re-render, so the page does
    // not jump and open Store sections stay open.
    machineGo(t.dataset.machine || "", (machineIndex[t.dataset.machine || ""] || 0) - 1);
  } else if (action === "machine-next") {
    machineGo(t.dataset.machine || "", (machineIndex[t.dataset.machine || ""] || 0) + 1);
  } else if (action === "machine-key" || action === "machine-goto") {
    machineGo(t.dataset.machine || "", Number(t.dataset.index || 0));
  } else if (action === "machine-dispense") {
    // Store: the selected Face's card drops into the pickup bay. The
    // card itself (and its Buy button) is already the bay's active
    // card — the drop is the machine answering the press.
    const root = t.closest(".machine") as HTMLElement | null;
    if (root) {
      root.classList.remove("dispensing");
      void root.offsetWidth;
      root.classList.add("dispensing");
      window.setTimeout(() => root.classList.remove("dispensing"), 950);
    }
  } else if (action === "machine-dispense-chat") {
    // Chat front: dispensing a Face opens its thread — the same
    // destinations the cards themselves have always opened.
    const root = t.closest(".machine") as HTMLElement | null;
    const id = t.dataset.machine || "";
    const panels = root
      ? ([...root.querySelectorAll(".machine-panel")] as HTMLElement[])
      : [];
    const sel = panels[machineIndex[id] || 0];
    const name = sel?.dataset.openName || "";
    if (name) {
      dayOpen = false;
      if (root?.dataset.kind === "atom") openThread(name);
      else openPhoton(name);
    }
  } else if (action === "product-info") {
    openProductCard(t.dataset.slug || "", t);
  } else if (action === "tier-info") {
    openTierCard((t.dataset.tier as "supernova" | "satellite" | "upkeep") || "supernova", t);
  } else if (action === "card-close") {
    closeCard();
  } else if (action === "goto-messenger") {
    // The Connections card's "Connect a Facebook Page": jump to the
    // Messenger section, where the Page token goes in. The fade-out
    // runs first (see fadeTo), and the scroll happens once the new
    // view has landed, so the section is there to scroll to.
    fadeTo(
      () => {
        tab = "connected";
        loadConnected().then(render);
        render();
      },
      () => {
        const el = document.getElementById("messenger");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      },
    );
  } else if (action === "page-select") {
    // Which connected Page's threads to show. Empty id = the server's Page.
    const id = t.dataset.id || "";
    messengerSelectedPageId = id || null;
    messengerOpenId = null;
    messengerOpenMessages = null;
    messengerOpenError = "";
    await reloadMessengerThreads();
    render();
  } else if (action === "page-disconnect") {
    const id = t.dataset.id || "";
    if (!id) return;
    const r = await api.messengerDisconnect(id);
    if (r && r.ok) {
      toast("That Page is disconnected.");
      if (messengerSelectedPageId === id) {
        messengerSelectedPageId = null;
        messengerOpenId = null;
        messengerOpenMessages = null;
      }
      const pg = await api.messengerPages();
      if (pg && pg.ok) {
        messengerPagesData = pg.pages || [];
        if (!messengerSelectedPageId && (messengerPagesData || []).length) {
          messengerSelectedPageId = String((messengerPagesData || [])[0].pageId);
        }
      }
      await reloadMessengerThreads();
      render();
    } else {
      toast(r?.message || "That Page didn't disconnect. Try again.", "err");
    }
  } else if (action === "memory-import") {
    // The owner picked a file, read the summary, and tapped Import.
    // Only now is anything sent.
    if (!memoryParsed) return;
    const parsed = memoryParsed;
    const r = await api.memoryImport(parsed.source, parsed.title, parsed.content);
    if (r && r.ok) {
      memoryParsed = null;
      memoryParseError = "";
      const mem = await api.memoryList();
      if (mem && mem.ok) memoryImportsData = mem.imports || [];
      const sections = typeof r.imported?.sections === "number" ? r.imported.sections : 0;
      toast(
        sections > 1
          ? `Imported: ${parsed.title} (${sections} sections).`
          : `Imported: ${parsed.title}.`,
      );
      render();
    } else {
      toast(r?.message || "That memory didn't import. Try again.", "err");
    }
  } else if (action === "memory-discard") {
    memoryParsed = null;
    memoryParseError = "";
    render();
  } else if (action === "memory-delete") {
    const id = Number(t.dataset.id || "0");
    if (!id) return;
    const r = await api.memoryDelete(id);
    if (r && r.ok) {
      const mem = await api.memoryList();
      if (mem && mem.ok) memoryImportsData = mem.imports || [];
      toast("That memory is deleted.");
      render();
    } else {
      toast(r?.message || "That memory didn't delete. Try again.", "err");
    }
  } else if (action === "card-chat") {
    // Owned Photon: close the card and open the thread.
    const name = t.dataset.photon || "";
    closeCard();
    if (name) openPhoton(name);
  } else if (action === "card-chat-atom") {
    // Owned Atom: close the card and open the thread, the same thread
    // view a Photon uses. Atoms have no customization flow, so this
    // goes straight to the thread.
    const name = t.dataset.atom || "";
    closeCard();
    if (name) openThread(name);
  } else if (action === "back-to-front") {
    activePhoton = null;
    customizePhoton = null;
    dayOpen = false;
    render();
  } else if (action === "pin-face") {
    const name = t.dataset.photon || "";
    if (name) {
      const r = await api.pin(name);
      if (r && r.ok) {
        pinnedFaces = Array.isArray(r.pinnedFaces) ? r.pinnedFaces : [...pinnedFaces, name];
        toast(`${name} pinned.`);
      } else {
        toast(r?.message || "That didn't pin. Try again.", "err");
      }
      render();
    }
  } else if (action === "unpin-face") {
    const name = t.dataset.photon || "";
    if (name) {
      const r = await api.unpin(name);
      if (r && r.ok) {
        pinnedFaces = Array.isArray(r.pinnedFaces)
          ? r.pinnedFaces
          : pinnedFaces.filter((x) => x !== name);
        toast(`${name} unpinned.`);
      } else {
        toast(r?.message || "That didn't unpin. Try again.", "err");
      }
      render();
    }
  } else if (action === "call") {
    callPhoton(t.dataset.photon || "");
  } else if (action === "report-prism") {
    reportToPrism(t.dataset.photon || "");
  } else if (action === "customize") {
    const name = t.dataset.photon || "";
    if (name) {
      customizePhoton = name;
      customizeStep = 1;
      customizeDesign = false;
      customizeTuning = {};
      render();
    }
  } else if (action === "custom-back") {
    const name = customizePhoton || "";
    if (name && customFor(name).done) openThread(name);
    else {
      customizePhoton = null;
      activePhoton = null;
      render();
    }
  } else if (action === "custom-step") {
    customizeStep = Math.max(1, Math.min(3, parseInt(t.dataset.step || "1", 10) || 1));
    customizeDesign = false;
    render();
  } else if (action === "custom-skip-step") {
    const step = customizeStep;
    saveCustom({ step }).then((ok) => {
      if (!ok) return;
      if (step < 3) {
        customizeStep = step + 1;
        customizeDesign = false;
        render();
      } else finishCustom();
    });
  } else if (action === "custom-skip-all") {
    saveCustom({ done: true }).then((ok) => {
      if (ok) finishCustom();
    });
  } else if (action === "custom-voice") {
    const voice = t.dataset.voice || "house";
    if (voice === "custom") {
      const c = customFor(customizePhoton || "");
      customizeTuning = { ...(c.tuning || {}) };
      customizeDesign = true;
      render();
      return;
    }
    saveCustom({ voice, step: 2 }).then((ok) => {
      if (!ok) return;
      customizeStep = 3;
      customizeDesign = false;
      render();
    });
  } else if (action === "custom-design-back") {
    customizeDesign = false;
    render();
  } else if (action === "custom-tune") {
    customizeTuning[t.dataset.q as string] = t.dataset.v === "yes";
    render();
  } else if (action === "custom-tune-save") {
    const missing = TUNING_QUESTIONS.filter((q) => !(q.key in customizeTuning));
    if (missing.length) {
      toast("Answer all seven questions first.", "err");
      return;
    }
    saveCustom({ voice: "custom", tuning: customizeTuning, step: 2 }).then((ok) => {
      if (!ok) return;
      customizeStep = 3;
      customizeDesign = false;
      render();
    });
  } else if (action === "custom-portrait") {
    saveCustom({ portrait: t.dataset.portrait || "" }).then((ok) => {
      if (ok) render();
    });
  } else if (action === "custom-look") {
    saveCustom({ lookSet: t.dataset.look || "" }).then((ok) => {
      if (ok) render();
    });
  } else if (action === "custom-finish") {
    saveCustom({ done: true, step: 3 }).then((ok) => {
      if (ok) finishCustom();
    });
  } else if (action === "variant") {
    storeVariant = (t.dataset.variant as "personal" | "business") || "personal";
    render();
  } else if (action === "clear-name") {
    api.setCustomName("").then(async (r: any) => {
      if (r && r.ok) {
        await refreshState();
        render();
        toast("Name cleared. You're back to Prism 5.");
      }
    });
  } else if (action === "text-send-confirm") {
    // The owner reviewed the draft and tapped Send. This is the only
    // tap that sends a text.
    if (!textDraft) return;
    const draft = textDraft;
    textDraft = null;
    const r = await api.sendText(draft.to, draft.body);
    if (r && r.ok) {
      toast(`Text sent to ${draft.toLabel}.`);
      await reloadMessages();
      render();
    } else if (r?.error === "contact_not_approved") {
      toast("That contact hasn't approved the connection yet — nothing was sent.", "err");
      render();
    } else if (r?.error === "not_connected") {
      toast("Texts aren't connected yet — nothing was sent.", "err");
      render();
    } else {
      toast(r?.message || "That text didn't send. Try again.", "err");
      textDraft = draft;
      render();
    }
  } else if (action === "text-send-edit") {
    textDraft = null;
    render();
  } else if (action === "cal-cancel") {
    // Two taps to cancel: first tap arms it, second confirms.
    confirmCancelId = t.dataset.id || null;
    render();
  } else if (action === "cal-cancel-abort") {
    confirmCancelId = null;
    render();
  } else if (action === "cal-cancel-confirm") {
    const id = t.dataset.id || "";
    confirmCancelId = null;
    const r = await api.cancelCalendar(id);
    if (r && r.ok) {
      toast("Event cancelled.");
      await reloadCalendar();
      render();
    } else {
      toast(r?.message || "That event didn't cancel. Try again.", "err");
      render();
    }
  } else if (action === "cal-book-confirm") {
    // The owner reviewed the booking and tapped Book. This is the only
    // tap that books.
    if (!bookDraft) return;
    const draft = bookDraft;
    bookDraft = null;
    const r = await api.bookCalendar(draft.title, draft.start, draft.end, draft.description || undefined, draft.attendees.length ? draft.attendees : undefined);
    if (r && r.ok) {
      toast(`Booked: ${draft.title}.`);
      await reloadCalendar();
      render();
    } else if (r?.error === "not_connected" || r?.error === "google_reauth") {
      toast("Calendar isn't connected — sign in again and try once more.", "err");
      render();
    } else {
      toast(r?.message || "That event didn't book. Try again.", "err");
      bookDraft = draft;
      render();
    }
  } else if (action === "cal-book-edit") {
    bookDraft = null;
    render();
  } else if (action === "inbox-refresh") {
    await reloadCalendar();
    render();
    toast("Calendar refreshed.");
  } else if (action === "drive-open") {
    const id = t.dataset.id || "";
    const r = await api.driveFile(id);
    state.driveFileRead = r || { ok: false, message: "That file didn't load." };
    openDriveDocument(t);
  } else if (action === "drive-close") {
    state.driveFileRead = null;
    closeCard();
    render();
  } else if (action === "drive-clear") {
    driveQuery = "";
    state.driveFileRead = null;
    const r = await api.driveSearch();
    if (r && r.ok) state.driveFiles = r.files || [];
    render();
  } else if (action === "search-open-thread") {
    const name = t.dataset.photon || "";
    dayOpen = false;
    if (name) openThread(name);
  } else if (action === "search-clear") {
    conversationSearchQuery = "";
    conversationSearchResults = null;
    render();
  } else if (action === "import-add") {
    // One tap per person: files the friend-request email for that
    // contact. The import itself sent nothing.
    const idx = parseInt(t.dataset.idx || "-1", 10);
    const entry = importedContacts[idx];
    if (!entry) return;
    const owned = (state?.ownedSupernovas || []) as string[];
    const photon = owned[0] || "Prism";
    const r = await api.requestContact(photon, entry.name, entry.email, entry.phone || undefined);
    if (r && r.ok) {
      toast(`Connection request sent to ${entry.name}.`);
      importedContacts = importedContacts.filter((_, i) => i !== idx);
      await loadConnected();
      render();
    } else if (r?.error === "already_requested") {
      toast("Request already sent — still waiting on their approval.");
      importedContacts = importedContacts.filter((_, i) => i !== idx);
      render();
    } else if (r?.error === "gmail_not_connected") {
      toast("Connect a Gmail account in Connected first.", "err");
    } else {
      toast("That request didn't send. Try again.", "err");
    }
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target as HTMLFormElement;
  // A submit button is a tap too, even though it carries no
  // data-action: the click answers it. (Enter key submits count the
  // same — the tap was still the owner's.)
  playClick();
  if (form.id === "name-form") {
    e.preventDefault();
    const input = document.getElementById("name-input") as HTMLInputElement;
    const name = input.value.trim();
    const r = await api.setCustomName(name);
    if (r && r.ok) {
      await refreshState();
      render();
      toast(name ? `Your assistant is ${name} now.` : "Name cleared. You're back to Prism 5.");
    } else {
      toast("That didn't save. Try again.", "err");
    }
  } else if (form.id === "custom-name-form") {
    e.preventDefault();
    const input = document.getElementById("custom-name-input") as HTMLInputElement;
    const name = input.value.trim();
    const ok = await saveCustom({ faceName: name, step: 1 });
    if (ok) {
      customizeStep = 2;
      customizeDesign = false;
      render();
      toast(name ? `Your Face is ${name} now.` : "Name kept as it was.");
    }
  } else if (form.id === "chat-form") {
    e.preventDefault();
    const input = document.getElementById("chat-input") as HTMLInputElement;
    const text = input.value.trim();
    if (text) sendChat(text);
  } else if (form.id === "redeem-form") {
    e.preventDefault();
    const input = document.getElementById("redeem-input") as HTMLInputElement;
    const msg = document.getElementById("redeem-msg") as HTMLElement | null;
    const code = input.value.trim();
    if (!code) return;
    const r = await api.redeem(code);
    if (r && r.ok) {
      await refreshState();
      if (msg) msg.textContent = r.message || "That's the one. Everything's yours now.";
      input.value = "";
      render();
      toast(r.message || "That's the one. Everything's yours now.");
    } else {
      if (msg) msg.textContent = r?.message || "That code doesn't match";
      toast(r?.message || "That code doesn't match", "err");
    }
  } else if (form.id === "text-form") {
    // Draft first: this tap only shows the review panel. Sending takes
    // a second, explicit tap on "Send text".
    e.preventDefault();
    const fd = new FormData(form);
    const to = String(fd.get("to") || "");
    const body = String(fd.get("body") || "").trim();
    if (!to || !body) return;
    const sel = form.querySelector("select[name='to']") as HTMLSelectElement | null;
    const opt = sel?.selectedOptions?.[0];
    const toLabel = opt?.dataset.label || opt?.textContent || to;
    textDraft = { to, toLabel, body };
    render();
  } else if (form.id === "cal-book-form") {
    // Draft first: this tap only shows the review panel. Booking takes
    // a second, explicit tap on "Book this event".
    e.preventDefault();
    const fd = new FormData(form);
    const title = String(fd.get("title") || "").trim();
    const start = String(fd.get("start") || "");
    const end = String(fd.get("end") || "");
    const description = String(fd.get("description") || "").trim();
    const attendees = String(fd.get("attendees") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!title || !start || !end) return;
    if (new Date(end).getTime() <= new Date(start).getTime()) {
      toast("The end time has to be after the start time.", "err");
      return;
    }
    bookDraft = { title, start, end, description, attendees };
    render();
  } else if (form.id === "conversation-search-form") {
    e.preventDefault();
    const input = document.getElementById("conversation-search-input") as HTMLInputElement | null;
    conversationSearchQuery = (input?.value || "").trim();
    if (conversationSearchQuery.length < 2) {
      toast("Type at least 2 characters to search.", "err");
      return;
    }
    const r = await api.searchThreads(conversationSearchQuery);
    if (r && r.ok) {
      conversationSearchResults = r.results || [];
      render();
    } else {
      toast(r?.error || r?.message || "That search didn't run. Try again.", "err");
    }
  } else if (form.id === "drive-search-form") {
    e.preventDefault();
    const input = document.getElementById("drive-search-input") as HTMLInputElement | null;
    driveQuery = (input?.value || "").trim();
    state.driveFileRead = null;
    const r = await api.driveSearch(driveQuery || undefined);
    if (r && r.ok) {
      state.driveFiles = r.files || [];
      render();
    } else {
      toast(r?.message || "That search didn't run. Try again.", "err");
    }
  } else if (form.classList.contains("draft-form")) {
    e.preventDefault();
    const fd = new FormData(form);
    const label = form.dataset.label || "";
    const rawProvider = form.dataset.provider || "";
    const provider = rawProvider === "outlook" ? "outlook" : rawProvider === "imap" ? "imap" : "gmail";
    const to = String(fd.get("to") || "");
    const subject = String(fd.get("subject") || "");
    const body = String(fd.get("body") || "");
    const r =
      provider === "outlook"
        ? await api.outlookDraft(label, to, subject, body)
        : provider === "imap"
          ? await api.imapDraft(label, to, subject, body)
          : await api.saveDraft(label, to, subject, body);
    if (r && r.ok) {
      toast(
        provider === "outlook"
          ? "Draft saved to Outlook drafts."
          : provider === "imap"
            ? "Draft saved to that mailbox's drafts."
            : "Draft saved to Gmail drafts.",
      );
      form.reset();
    } else {
      toast("That draft didn't save. Check the account is connected.", "err");
    }
  } else if (form.id === "imap-connect-form") {
    // Connect a Yahoo, Apple Mail, or other IMAP mailbox. The server
    // tests the app-specific password against the real mail server
    // before storing anything; a wrong password never lands in the
    // database. The custom host field only matters for Other.
    e.preventDefault();
    const fd = new FormData(form);
    const provider = String(fd.get("provider") || "");
    const email = String(fd.get("email") || "").trim();
    const password = String(fd.get("password") || "");
    const host = String(fd.get("host") || "").trim();
    if (!email || !password) return;
    imapConnectMsg = "";
    imapConnectOk = false;
    const r = await api.imapConnect(provider, email, password, host);
    if (r && r.ok) {
      imapConnectOk = true;
      imapConnectMsg = `Connected: ${r.email || email}.`;
      justConnected = "imap";
      form.reset();
      await loadConnected();
      render();
      toast(`Connected: ${r.email || email}.`);
    } else {
      imapConnectOk = false;
      imapConnectMsg = r?.message || "That mailbox didn't connect. Try again.";
      render();
      toast(imapConnectMsg, "err");
    }
  } else if (form.id === "profile-form") {
    // About you: what the owner tells Prism about themselves.
    e.preventDefault();
    const fd = new FormData(form);
    const r = await api.profileSave({
      displayName: String(fd.get("displayName") || ""),
      about: String(fd.get("about") || ""),
      preferences: String(fd.get("preferences") || ""),
      notes: String(fd.get("notes") || ""),
      title: String(fd.get("title") || ""),
      pronouns: String(fd.get("pronouns") || ""),
    });
    if (r && r.ok) {
      profileData = r.profile || profileData;
      profileSaved = true;
      toast("Saved. Your Supernovas know you now.");
      render();
    } else {
      toast(r?.message || "That didn't save. Try again.", "err");
    }
  } else if (form.id === "page-connect-form") {
    // Connect a Facebook Page with a Page access token. The token is
    // tested by the server before it is stored, and never shown back.
    e.preventDefault();
    const fd = new FormData(form);
    const token = String(fd.get("token") || "").trim();
    if (!token) return;
    const r = await api.messengerConnect(token);
    if (r && r.ok) {
      toast(`Connected: ${r.pageName || r.pageId}.`);
      form.reset();
      const pg = await api.messengerPages();
      if (pg && pg.ok) {
        messengerPagesData = pg.pages || [];
        if (!messengerSelectedPageId && (messengerPagesData || []).length) {
          messengerSelectedPageId = String((messengerPagesData || [])[0].pageId);
        }
      }
      await reloadMessengerThreads();
      render();
    } else {
      toast(r?.message || "That Page didn't connect. Check the token and try again.", "err");
    }
  } else if (form.id === "research-form") {
    e.preventDefault();
    const input = document.getElementById("research-input") as HTMLInputElement;
    const box = document.getElementById("research-results") as HTMLElement | null;
    const query = input.value.trim();
    if (!query || !box) return;
    box.hidden = false;
    box.innerHTML = `<p class="fine">Looking that up…</p>`;
    const r = await api.research(query);
    if (r && r.ok) {
      const results = (r.results || []) as any[];
      box.innerHTML = results.length
        ? `<div class="research-head"><b>Live results</b><button class="btn small" type="button" data-action="research-close">Close</button></div>` +
          results
            .map(
              (res: any) =>
                `<div class="research-item"><a href="${esc(res.url)}" target="_blank" rel="noopener">${esc(res.title || res.url)}</a><p>${esc(res.snippet || "")}</p><p class="fine">Source: ${esc(res.source || res.url)}</p></div>`,
            )
            .join("")
        : `<p class="fine">Nothing came back for that one.</p><button class="btn small" type="button" data-action="research-close">Close</button>`;
    } else {
      // Research not connected (or failed): the server's plain words,
      // never a guessed answer.
      box.innerHTML = `<p>${esc(r?.message || "The search didn't come back. Try that again in a moment.")}</p><button class="btn small" type="button" data-action="research-close">Close</button>`;
    }
  } else if (form.id === "reminder-form") {
    e.preventDefault();
    const textInput = document.getElementById("reminder-text") as HTMLInputElement;
    const whenInput = document.getElementById("reminder-when") as HTMLInputElement;
    const text = textInput.value.trim();
    const when = whenInput.value;
    if (!text || !when) return;
    const remindAt = new Date(when).toISOString();
    const r = await api.reminderCreate(text, remindAt);
    if (r && r.ok) {
      const rems = await api.reminders();
      if (rems && rems.ok) remindersData = rems.reminders || [];
      render();
      toast("Reminder set.");
    } else {
      toast(r?.error || "That reminder didn't save. Try again.", "err");
    }
  } else if (form.id === "day-add-form") {
    e.preventDefault();
    const titleInput = document.getElementById("day-add-title") as HTMLInputElement;
    const whenInput = document.getElementById("day-add-when") as HTMLInputElement;
    const title = titleInput.value.trim();
    if (!title) return;
    const due = whenInput.value ? new Date(whenInput.value).toISOString() : undefined;
    const r = await api.dayAddItem(title, undefined, due);
    if (r && r.ok) {
      toast("Added to today's plan.");
      await loadDayBriefing();
    } else {
      toast(r?.error || "That didn't save. Try again.", "err");
    }
  } else if (form.classList.contains("msg-send-form")) {
    e.preventDefault();
    const fd = new FormData(form);
    const conversationId = form.dataset.id || "";
    const text = String(fd.get("text") || "").trim();
    if (!conversationId || !text) return;
    const r = await api.messengerSend(conversationId, text, messengerSelectedPageId || undefined);
    if (r && r.ok) {
      toast("Reply sent as the Page.");
      form.reset();
      await openMessengerThread(conversationId);
    } else if (r?.error === "meta_error") {
      toast(r.message || "Meta refused the send.", "err");
    } else if (r?.error === "messenger_not_configured") {
      toast("Facebook Page messaging isn't connected yet.", "err");
    } else {
      toast(r?.message || "That reply didn't send. Try again.", "err");
    }
  } else if (form.classList.contains("contact-form")) {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get("name") || "");
    const address = String(fd.get("address") || "");
    const phone = String(fd.get("phone") || "");
    const photon = String(fd.get("photon") || "Prism");
    const r = await api.requestContact(photon, name, address, phone || undefined);
    if (r && r.ok) {
      toast(
        r.status === "approved"
          ? "Already connected — you can send to them."
          : "Connection request sent. They tap Approve or Decline in the email.",
      );
      form.reset();
      await loadConnected();
      render();
    } else if (r?.error === "already_requested") {
      toast("Request already sent — still waiting on their approval.");
    } else if (r?.error === "contact_declined") {
      toast("That contact was declined.", "err");
    } else if (r?.error === "gmail_not_connected") {
      toast("Connect a Gmail account in Connected first.", "err");
    } else {
      toast("That request didn't send. Try again.", "err");
    }
  }
});

// ---------- Contact import (.vcf / .csv) ----------
// Read on this device only. Importing parses the file and lists the
// people; it sends nothing. Each person is added with their own tap.
document.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  if (!input || input.id !== "import-file") return;
  const file = input.files?.[0];
  if (!file) return;
  let text = "";
  try {
    text = await file.text();
  } catch {
    toast("That file couldn't be read. Try again.", "err");
    return;
  }
  importSkipped = 0;
  const isVcf = /\.vcf$/i.test(file.name) || /BEGIN:VCARD/i.test(text);
  const parsed = isVcf ? parseVcf(text) : parseCsv(text);
  const fresh = dedupeImported(parsed).filter(
    (c) => !((state?.contacts || []) as any[]).some((x: any) => String(x.address || "").toLowerCase() === c.email.toLowerCase()),
  );
  const already = parsed.length - fresh.length - importSkipped;
  importedContacts = fresh;
  render();
  if (fresh.length) {
    toast(`${fresh.length} contact${fresh.length === 1 ? "" : "s"} ready — tap Request connection on each one to send their request.`);
  } else {
    toast("No new contacts in that file — they may already be in the book, or have no email address.", "err");
  }
  if (already > 0) console.info(`${already} imported contact(s) already in the address book.`);
  input.value = "";
});

// ---------- IMAP provider select ----------
// The custom mail-server field only matters for Other: Yahoo and Apple
// Mail fill their own server in. Show it when Other is picked, hide it
// otherwise, so the form never asks for what it does not need.
document.addEventListener("change", (e) => {
  const sel = e.target as HTMLSelectElement;
  if (!sel || sel.id !== "imap-provider-select") return;
  const host = document.getElementById("imap-custom-host") as HTMLInputElement | null;
  if (!host) return;
  host.hidden = sel.value !== "other";
  if (sel.value !== "other") host.value = "";
});

// ---------- Memory import (.json / .md / .txt) ----------
// The file is read on this device only. Parsing shows a summary and
// waits for the owner to tap Import; nothing is sent by picking a file.
document.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  if (!input || input.id !== "memory-file") return;
  const file = input.files?.[0];
  if (!file) return;
  let text = "";
  try {
    text = await file.text();
  } catch {
    memoryParsed = null;
    memoryParseError = "That file couldn't be read. Try again.";
    render();
    return;
  }
  const parsed = parseMemoryFile(file.name, text);
  if ("error" in parsed) {
    memoryParsed = null;
    memoryParseError = parsed.error;
  } else {
    memoryParsed = parsed;
    memoryParseError = "";
  }
  render();
  input.value = "";
});

// ---------- Keyboard-aware chat ----------
// The thread is a full-height flex column (see body.is-thread in
// styles.css): the messages area flexes to whatever space is left
// after the Photon header and the composer, so the conversation and
// the input always stay in view. When the on-screen keyboard opens,
// the layout viewport shrinks (Android Chrome, interactive-widget=
// resizes-content) or the visual viewport shrinks (iOS / older
// Android) — either way the body height follows (100dvh minus the
// measured keyboard gap --kb), the messages area shrinks with it,
// and the composer, in flow at the bottom of the thread, stays just
// above the keyboard. The bottom tab bar and the brand header are
// hidden while in a thread, so nothing but the conversation and the
// composer competes for the shrunken screen: the clean, minimal
// layout of a plain chat app.
//
// While the chat input is focused (html.kb-chat), the research row
// hides — it is clutter while typing a message — and returns when
// the input blurs. Tapping the conversation dismisses the keyboard
// (and brings the research row back).
function setupKeyboardDock(): void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const update = () => {
    const kb = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
    root.style.setProperty("--kb", kb + "px");
  };
  if (vv) {
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
  }
  document.addEventListener("focusin", (e) => {
    const id = (e.target as HTMLElement)?.id;
    if (id === "chat-input" || id === "research-input") {
      root.classList.toggle("kb-chat", id === "chat-input");
      root.classList.toggle("kb-research", id === "research-input");
    }
    if (id === "chat-input") {
      window.setTimeout(() => {
        document.getElementById("messages")?.scrollTo({ top: 999999, behavior: "smooth" });
      }, 350);
    }
  });
  document.addEventListener("focusout", (e) => {
    const id = (e.target as HTMLElement)?.id;
    if (id === "chat-input" || id === "research-input") {
      // Focus may just be moving between the two inputs, so only
      // clear the classes when it left both.
      const next = (e as FocusEvent).relatedTarget as HTMLElement | null;
      if (!next || (next.id !== "chat-input" && next.id !== "research-input")) {
        root.classList.remove("kb-chat", "kb-research");
      }
    }
  });
  // Tap the conversation to dismiss the keyboard.
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest("#messages") && !t.closest("input, textarea, button, a, summary")) {
      (document.activeElement as HTMLElement)?.blur?.();
    }
  });
}

// ---------- Opening splash ----------
// The opening plays on every app open, then fades to the chat. The
// chat renders underneath while it plays, so nothing waits on it,
// and it never touches settings or the chosen Face — it is only a
// full-screen overlay that removes itself. Reduced motion skips it
// entirely (the CSS hides it too, so it never shows even before
// this runs). Tap skips it early: the owner never has to wait it
// out.
//
// There is no film any more (Nov 25, 2026). The opening used to lead
// with the v5 film — the crystalline figure on the diner counter,
// cut on Nov 18 — with the still older v3 sparkle animation as its
// stall fallback. The website replaced that film, the app never
// did, and on fresh installs the app "kept playing the old video"
// (Neil, Nov 25, 2026). Both film files are retired. What remains
// is the opening Neil choreographed on Nov 23: the hero stage
// (below) opens directly on the splash — her light gathers, splits,
// and the Faces condense out of it — over a still backdrop of the
// film's first beat, light on the crystal, no figure.
//
// First ever open reads "Welcome"; every open after that reads
// "Welcome back" — the words are an overlay, as they always were.
// The coloring around the animation rotates through ten schemes, one per open, cycling in order: the
// open count lives in localStorage (prism5.splashOpens) and the scheme
// is SPLASH_SCHEME_IDS[(count - 1) % 10]. The scheme colors live in
// public/styles.css as [data-scheme] rules on .opening-splash.
// Order: 1 Diner Classic, 2 Cherry Soda, 3 Midnight Launch,
// 4 Jukebox Mint, 5 Atomic Sunset, 6 Bubblegum Chrome,
// 7 Drive-In Aqua, 8 Golden Rocket, 9 Starlight Lilac,
// 10 Checkered Flag.
const SPLASH_SCHEME_IDS = [
  "diner-classic",
  "cherry-soda",
  "midnight-launch",
  "jukebox-mint",
  "atomic-sunset",
  "bubblegum-chrome",
  "drive-in-aqua",
  "golden-rocket",
  "starlight-lilac",
  "checkered-flag",
] as const;
const SPLASH_OPENS_KEY = "prism5.splashOpens";
// A plain black layer that fades over the splash, or lifts off
// the app, so the splash never sits inside an element whose opacity
// animates (see .film-curtain in styles.css for why).
function filmCurtain(z: number): HTMLDivElement {
  const c = document.createElement("div");
  c.className = "film-curtain";
  c.style.zIndex = String(z);
  document.body.appendChild(c);
  return c;
}

let splashDismissing = false;
// Raise the curtain over the splash, take the splash away beneath
// it, and lift the curtain off the app. Shared by both dismiss
// paths; the splash itself is never faded. The fast variant (an
// OAuth return) keeps the whole move under a second so the owner
// is not left staring at black before the thing they just did.
function dismissSplashWithCurtain(fast = false): void {
  const splash = document.getElementById("opening-splash");
  if (!splash || !splash.isConnected || splashDismissing) return;
  splashDismissing = true;
  const c = filmCurtain(110);
  if (fast) c.style.transitionDuration = "0.35s";
  c.classList.add("in");
  window.setTimeout(() => {
    splash.remove();
    maybeShowChooser();
    c.classList.remove("in");
    if (fast) c.style.transitionDuration = "0.6s";
    c.classList.add("out");
    window.setTimeout(() => c.remove(), fast ? 700 : 1400);
  }, fast ? 400 : 750);
}

// ---------- Opening hero finale ----------
// Neil, Nov 23, 2026, second word on the opening: the v61 hero
// assembly was "the right idea, but executed wrong. Prism disc
// not appear, just her light. Light goes in, splits into the 24.
// Also, the 24 are not animated. They are cutouts that run
// about." So the choreography is rebuilt around her light:
//
// THE LIGHT BEAT is the stage's own now (Nov 25, 2026): the v5
// film that used to play the shaft of light falling on the
// crystal is retired (see the splash section above), so the
// stage opens on that beat itself — the still backdrop carries
// the light on the crystal, and the stage's shaft and core take
// it from there. Prism herself never appears: no figure, no
// disc, no portrait, anywhere in the opening. Only her light.
//
// THE LIGHT comes in on the stage: a shaft falls to the stage's
// heart and gathers there in a bright core, swelling gently
// for a breath.
//
// THE SPLIT: the gathered light divides. One ray of it travels
// to each hero's place — the light moves, the figures never do
// — and at each ray's end the Face condenses out of the light
// where they stand: a blaze of white-gold resolving into the
// painted figure. No hero drops, streaks, or rises in from
// off-stage; nobody runs about. The cast is the 23 Faces with
// hero art — the 11 Supernovas and the 12 Novas. The 24th Face
// is Prism herself, and she is the light they are born from,
// which is why she is never among them.
//
// THE HOLD: the assembly lives. Every figure with an animated
// clip (HERO_CLIPS, below) plays it, looped; the rest breathe
// on the sway each figure has always had. The owner's verdict
// stands over this build in one respect, stated plainly: the
// image-to-video pipeline was down when this choreography was
// built (two independent generation attempts, both upstream
// 502s), so HERO_CLIPS ships EMPTY and every figure currently
// holds as a still on its sway. The clip mechanism is wired
// and proven — a clip drops in by adding one file and one
// HERO_CLIPS line, no other code change — and the generation
// order is the priority list in public/heroes/manifest.json.
//
// THE FLASH-OUT is v61's, unchanged in spirit: the light
// charges, the figures brighten, and every hero streaks away
// as light along their own vector into the white-gold flash
// that fades into the curtain's handover to the Chat front.
// They arrived as light; they leave as light.
//
// The hero stage is a sibling of the splash backdrop (never an
// ancestor, so its fade cannot stall the backdrop's surface —
// the curtain rule).
// Stage timeline: the light gathers for ~1.2s, the split runs
// ~1.2–3.5s, the assembly holds alive, the charge fires at
// HERO_FLASH_AFTER_MS − 450, the flash-out at
// HERO_FLASH_AFTER_MS, and the dismiss follows. The whole
// opening runs ~8s plus the curtain — a breath shorter than the
// old film-led version, which spent its first 1.8s on the film.
const HERO_FLASH_AFTER_MS = 6600;
const HERO_DISMISS_AFTER_MS = 8100;
// How long a figure takes to condense out of the light.
const HERO_CONDENSE_MS = 780;
// The heart of the stage, where her light gathers: left % and
// top % of the stage. Juniper leads just below it.
const HERO_LIGHT_X = 47;
const HERO_LIGHT_Y = 38;

// Animated clips for the hold, one per Face, generated from the
// Face's hero art (image-to-video: subtle lifelike motion —
// breathing, a shift of stance, fabric and hair in a light
// breeze — camera locked, figure in place). EMPTY in this
// build: the video pipeline was unavailable (see the section
// comment above). When a clip lands it is served from
// /heroes/clips/<Name>.mp4, masked by the still's own alpha
// (the builder sets the mask from the hero webp), with the
// still as its poster and its fallback. Priority order for
// generation: Juniper, Encore, Keystone, Mabel, Pierce,
// Shopbell, then the rest by slot size (manifest.json holds
// the full list).
const HERO_CLIPS: Record<string, string> = {};

type HeroSlot = {
  // Centre-x in % of stage width; bottom in % of stage height
  // (figures are bottom-anchored, so a tall cape or a compact
  // figure never shifts its ground line); width in % of stage
  // width; ar is the art's height/width ratio, used to find the
  // figure's centre for its ray and burst; z is the layer; wave
  // staggers the split.
  x: number;
  b: number;
  w: number;
  ar: number;
  z: number;
  wave: number;
};
// The assembly, laid out by hand to be dynamic, not symmetrical:
// an off-centre lead, anchors staggered at different heights on
// each side, a high scattered rank, and two foreground figures
// cropped by the bottom corners of the frame. (Same stage as
// v61 — the owner's quarrel was with the execution, not the
// formation.)
const HERO_SLOTS: Record<string, HeroSlot> = {
  Juniper: { x: 47, b: 9, w: 47, ar: 2.06, z: 30, wave: 0 },
  Encore: { x: 78, b: 24, w: 37, ar: 1.95, z: 27, wave: 1 },
  Keystone: { x: 16, b: 13, w: 36, ar: 1.88, z: 27, wave: 1 },
  Barnstormer: { x: 89, b: 42, w: 30, ar: 1.97, z: 26, wave: 1 },
  Blueprint: { x: 11, b: 40, w: 29, ar: 2.1, z: 26, wave: 1 },
  Shopbell: { x: 64, b: 33, w: 31, ar: 2.01, z: 23, wave: 2 },
  Calendra: { x: 29, b: 32, w: 30, ar: 1.89, z: 23, wave: 2 },
  Goldstar: { x: 56, b: 53, w: 28, ar: 2.03, z: 24, wave: 2 },
  Vesper: { x: 85, b: 59, w: 25, ar: 2.04, z: 22, wave: 2 },
  Zero: { x: 19, b: 57, w: 26, ar: 1.95, z: 22, wave: 2 },
  Proof: { x: 37, b: 56, w: 25, ar: 2.13, z: 21, wave: 2 },
  Mabel: { x: 5, b: 0, w: 34, ar: 1.98, z: 34, wave: 3 },
  Pierce: { x: 96, b: 0, w: 33, ar: 2.18, z: 34, wave: 3 },
  Hazel: { x: 68, b: 65, w: 21, ar: 1.93, z: 18, wave: 3 },
  Willa: { x: 29, b: 69, w: 21, ar: 2.0, z: 18, wave: 3 },
  Ruby: { x: 91, b: 71, w: 20, ar: 2.0, z: 17, wave: 3 },
  Jude: { x: 12, b: 71, w: 21, ar: 2.05, z: 18, wave: 3 },
  Sadie: { x: 58, b: 77, w: 18, ar: 2.31, z: 16, wave: 3 },
  Bea: { x: 36, b: 81, w: 18, ar: 2.07, z: 16, wave: 3 },
  Flora: { x: 75, b: 81, w: 18, ar: 2.13, z: 16, wave: 3 },
  Iris: { x: 47, b: 72, w: 20, ar: 2.07, z: 17, wave: 3 },
  Clive: { x: 21, b: 85, w: 17, ar: 2.07, z: 15, wave: 3 },
  Nora: { x: 87, b: 87, w: 17, ar: 3.03, z: 15, wave: 3 },
};
// Split order inside each wave (the stagger index). Wave 0 is
// Juniper alone, born first from the heart of the light.
const HERO_WAVES: string[][] = [
  ["Juniper"],
  ["Encore", "Keystone", "Barnstormer", "Blueprint"],
  ["Shopbell", "Calendra", "Goldstar", "Vesper", "Zero", "Proof"],
  [
    "Mabel",
    "Pierce",
    "Hazel",
    "Willa",
    "Ruby",
    "Jude",
    "Sadie",
    "Bea",
    "Flora",
    "Iris",
    "Clive",
    "Nora",
  ],
];
// The light gathers first (the shaft and core animate in over
// ~1.1s); the waves split out of it on these delays.
const HERO_WAVE_DELAY = [1250, 1520, 1820, 2180];
const HERO_WAVE_STAGGER = [0, 70, 60, 50];

// Small deterministic scatter for the sparkle field, so every open
// lays the same sky (no Math.random in a boot path).
function heroRnd(n: number): number {
  const v = Math.sin(n * 127.1) * 43758.5453;
  return v - Math.floor(v);
}

// The splash's caption and controls bow out as the light gathers —
// the finale is the show, and a settings pill does not belong
// on it. Tap-to-skip still works everywhere on the splash.
function fadeSplashChrome(splash: HTMLElement): void {
  splash
    .querySelectorAll<HTMLElement>(".opening-splash-caption, .opening-splash-controls")
    .forEach((n) => {
      n.style.animation = "none";
      n.style.transition = "opacity 0.45s ease";
      void n.offsetWidth;
      n.style.opacity = "0";
    });
}

let heroStarted = false;
function runHeroFinale(
  splash: HTMLElement,
  backdrop: HTMLElement | null,
  dismiss: () => void,
): void {
  if (heroStarted) return;
  heroStarted = true;
  const stage = document.createElement("div");
  stage.className = "opening-hero-stage";
  stage.setAttribute("aria-hidden", "true");
  const glow = document.createElement("div");
  glow.className = "opening-hero-glow";
  stage.appendChild(glow);
  // Her light: a shaft falling in, and the bright core where it
  // gathers. Two plain elements of light — no figure, no disc,
  // no emblem.
  const shaft = document.createElement("div");
  shaft.className = "opening-hero-shaft";
  stage.appendChild(shaft);
  const core = document.createElement("div");
  core.className = "opening-hero-core";
  stage.appendChild(core);
  const ground = document.createElement("div");
  ground.className = "opening-hero-ground";
  stage.appendChild(ground);
  const raysBox = document.createElement("div");
  raysBox.className = "opening-hero-rays";
  stage.appendChild(raysBox);
  const castBox = document.createElement("div");
  castBox.className = "opening-hero-cast";
  stage.appendChild(castBox);
  const burstsBox = document.createElement("div");
  burstsBox.className = "opening-hero-bursts";
  stage.appendChild(burstsBox);
  const wind = document.createElement("div");
  wind.className = "opening-hero-wind";
  stage.appendChild(wind);
  const charge = document.createElement("div");
  charge.className = "opening-hero-charge";
  stage.appendChild(charge);
  const flash = document.createElement("div");
  flash.className = "opening-hero-flash";
  stage.appendChild(flash);
  const sparksBox = document.createElement("div");
  sparksBox.className = "opening-hero-sparks";
  stage.appendChild(sparksBox);
  // Drifting sparkle and a few still starbursts, laid over the
  // assembly for the whole finale.
  for (let i = 0; i < 18; i++) {
    const s = document.createElement("i");
    const star = i % 3 === 0;
    s.className = star ? "opening-hero-spark is-star" : "opening-hero-spark";
    s.style.left = `${6 + heroRnd(i + 1) * 88}%`;
    s.style.top = `${6 + heroRnd(i + 31) * 78}%`;
    const size = star ? 12 + heroRnd(i + 61) * 12 : 3 + heroRnd(i + 61) * 3.5;
    s.style.width = `${size}px`;
    s.style.height = `${size}px`;
    s.style.setProperty("--sx", `${((heroRnd(i + 91) - 0.5) * 26).toFixed(0)}px`);
    s.style.setProperty("--sy", `${(-(10 + heroRnd(i + 121) * 22)).toFixed(0)}px`);
    s.style.animationDelay = `${(heroRnd(i + 151) * 2400).toFixed(0)}ms`;
    s.style.animationDuration = `${(2300 + heroRnd(i + 181) * 1300).toFixed(0)}ms`;
    sparksBox.appendChild(s);
  }
  // The stage is full-screen, so the window's size is the
  // stage's size (the stage is not in the document yet, and a
  // hidden tab can report a 0 client size — the window is the
  // honest measure either way).
  const W = window.innerWidth || stage.clientWidth;
  const H = window.innerHeight || stage.clientHeight;
  // The heart of the light, in stage pixels.
  const hx = (HERO_LIGHT_X / 100) * W;
  const hy = (HERO_LIGHT_Y / 100) * H;
  type Built = {
    name: string;
    outer: HTMLElement;
    sway: HTMLElement;
    trail: HTMLElement;
    slot: HeroSlot;
    delay: number;
    idx: number;
  };
  const built: Built[] = [];
  let idx = 0;
  HERO_WAVES.forEach((names, wave) => {
    names.forEach((name, inWave) => {
      const slot = HERO_SLOTS[name];
      if (!slot) return;
      const delay = HERO_WAVE_DELAY[wave] + inWave * HERO_WAVE_STAGGER[wave];
      const outer = document.createElement("div");
      outer.className = "opening-hero";
      outer.dataset.hero = name;
      outer.style.left = `${slot.x}%`;
      outer.style.bottom = `${slot.b}%`;
      outer.style.width = `${slot.w}%`;
      outer.style.zIndex = String(slot.z);
      // The light trail rides behind the figure: it burns only
      // at the flash-out now — entrances are the light's work,
      // done by the rays, and no figure travels.
      const trail = document.createElement("div");
      trail.className = "opening-hero-trail";
      outer.appendChild(trail);
      // The sway rides a child element, so the living hold never
      // fights the condense and flash-out transforms on the outer.
      const sway = document.createElement("div");
      sway.className = "opening-hero-sway";
      const stillSrc = `/heroes/${encodeURIComponent(name)}.webp`;
      const clipSrc = HERO_CLIPS[name];
      if (clipSrc) {
        // The animated clip, masked by the still's own alpha so
        // the figure keeps its exact silhouette and place; the
        // still is its poster and, on any error, its replacement.
        const vid = document.createElement("video");
        vid.src = clipSrc;
        vid.poster = stillSrc;
        vid.muted = true;
        vid.loop = true;
        vid.autoplay = true;
        vid.playsInline = true;
        vid.preload = "auto";
        vid.setAttribute("aria-hidden", "true");
        const mask = `url("${stillSrc}")`;
        vid.style.webkitMaskImage = mask;
        vid.style.maskImage = mask;
        vid.style.webkitMaskSize = "100% 100%";
        vid.style.maskSize = "100% 100%";
        vid.addEventListener("error", () => {
          const img = document.createElement("img");
          img.src = stillSrc;
          img.alt = "";
          img.decoding = "async";
          vid.replaceWith(img);
        });
        sway.appendChild(vid);
      } else {
        const img = document.createElement("img");
        img.src = stillSrc;
        img.alt = "";
        img.decoding = "async";
        img.addEventListener("error", () => {
          outer.style.visibility = "hidden";
        });
        sway.appendChild(img);
      }
      outer.appendChild(sway);
      castBox.appendChild(outer);
      // This hero's centre, in stage pixels — where their ray
      // ends and their burst blooms.
      const heroWp = (slot.w / 100) * W;
      const heroHp = heroWp * slot.ar;
      const cx = (slot.x / 100) * W;
      const cy = H - (slot.b / 100) * H - heroHp / 2;
      // THE SPLIT, for this hero: one ray of her light runs from
      // the heart to the hero's centre, opening along its line
      // and spent as it arrives.
      const ray = document.createElement("div");
      ray.className = "opening-hero-ray";
      ray.dataset.hero = name;
      ray.style.left = `${HERO_LIGHT_X}%`;
      ray.style.top = `${HERO_LIGHT_Y}%`;
      const dist = Math.hypot(cx - hx, cy - hy);
      const ang = (Math.atan2(cy - hy, cx - hx) * 180) / Math.PI;
      ray.style.width = `${dist.toFixed(0)}px`;
      const rayBase = `translate(0, -50%) rotate(${ang.toFixed(1)}deg)`;
      raysBox.appendChild(ray);
      ray.animate(
        [
          { transform: `${rayBase} scaleX(0)`, opacity: 0 },
          { opacity: 0.95, offset: 0.25 },
          { transform: `${rayBase} scaleX(1)`, opacity: 0.9, offset: 0.75 },
          { transform: `${rayBase} scaleX(1)`, opacity: 0 },
        ],
        { duration: 340, delay, easing: "ease-out", fill: "both" },
      );
      // The burst at the ray's end: the light arriving, out of
      // which the figure condenses.
      const burst = document.createElement("div");
      burst.className = "opening-hero-burst";
      burst.style.left = `${slot.x}%`;
      burst.style.bottom = `${(slot.b + (heroHp / 2 / H) * 100).toFixed(1)}%`;
      burst.style.width = `${slot.w * 1.7}%`;
      burstsBox.appendChild(burst);
      burst.animate(
        [
          { transform: "translate(-50%, 50%) scale(0.3)", opacity: 0 },
          { opacity: 0.9, offset: 0.25 },
          { transform: "translate(-50%, 50%) scale(1.5)", opacity: 0 },
        ],
        { duration: 560, delay: delay + 120, easing: "ease-out", fill: "both" },
      );
      built.push({ name, outer, sway, trail, slot, delay, idx: idx++ });
    });
  });
  // Directly after the backdrop still, under the caption and the
  // controls (their z-indexes keep them on top).
  if (backdrop) splash.insertBefore(stage, backdrop.nextSibling);
  else splash.appendChild(stage);
  fadeSplashChrome(splash);
  requestAnimationFrame(() => stage.classList.add("is-in"));
  // Once the stage covers the backdrop, hide the still — the
  // stage's own background carries the scene from here.
  window.setTimeout(() => {
    if (backdrop) backdrop.style.visibility = "hidden";
  }, 620);
  const base = "translate(-50%, 0px)";
  // Aim a hero's trail along a travel vector: the trail element
  // is centred on the figure and rotated to the vector, then
  // stretched and faded by the caller's keyframes.
  const aimTrail = (b: Built, dxPx: number, dyPx: number) => {
    const ang = (Math.atan2(dyPx, dxPx) * 180) / Math.PI;
    b.trail.style.transform = `translate(-50%, -50%) rotate(${ang.toFixed(1)}deg)`;
  };
  // HER LIGHT COMES IN: the shaft falls and the core gathers,
  // swelling at the stage's heart. Nothing else is on the stage
  // yet — the light is alone, as she is.
  shaft.animate(
    [
      { transform: "translateX(-50%) scaleY(0.25)", opacity: 0 },
      { opacity: 0.85, offset: 0.45 },
      { transform: "translateX(-50%) scaleY(1)", opacity: 0.8 },
    ],
    { duration: 1050, delay: 60, easing: "ease-out", fill: "both" },
  );
  core.animate(
    [
      { transform: "translate(-50%, -50%) scale(0.45)", opacity: 0 },
      { opacity: 1, offset: 0.55 },
      { transform: "translate(-50%, -50%) scale(1)", opacity: 0.95 },
    ],
    { duration: 1000, delay: 140, easing: "ease-out", fill: "both" },
  );
  for (const b of built) {
    // BORN OF THE SPLIT: the figure condenses where it stands —
    // a blaze of her light resolving into the painted figure.
    // The figure never travels; only the light did.
    b.outer.animate(
      [
        {
          transform: `${base} scale(0.92)`,
          opacity: 0,
          filter: "brightness(3.4) blur(7px)",
        },
        { opacity: 1, offset: 0.35 },
        {
          transform: `${base} scale(1)`,
          opacity: 1,
          filter: "brightness(1) blur(0px)",
        },
      ],
      {
        duration: HERO_CONDENSE_MS,
        delay: b.delay + 130,
        easing: "ease-out",
        fill: "both",
      },
    );
    // The living hold: from the moment the figure has condensed,
    // a slow breathing rise and fall with the faintest wind sway
    // — every figure on its own period and phase, a few pixels
    // at most, transforms only, cheap on any phone GPU. A figure
    // with an animated clip plays the clip as well; the sway is
    // the stage's breath under both.
    const swayAmp = 1.4 + (b.idx % 3) * 0.5;
    b.sway.animate(
      [
        { transform: "translateY(0px) rotate(0deg)" },
        {
          transform: `translateY(${(-swayAmp).toFixed(1)}px) rotate(${(0.18 + (b.idx % 4) * 0.07).toFixed(2)}deg)`,
          offset: 0.38,
        },
        {
          transform: `translateY(${(swayAmp * 0.7).toFixed(1)}px) rotate(${(-0.16 - (b.idx % 3) * 0.06).toFixed(2)}deg)`,
          offset: 0.72,
        },
        { transform: "translateY(0px) rotate(0deg)" },
      ],
      {
        duration: 2900 + ((b.idx * 149) % 1800),
        delay: b.delay + 130 + HERO_CONDENSE_MS,
        iterations: Infinity,
        easing: "ease-in-out",
      },
    );
  }
  // The ground lights as the split lands.
  ground.animate([{ opacity: 0 }, { opacity: 0.55 }], {
    duration: 1500,
    delay: 1150,
    easing: "ease-out",
    fill: "both",
  });
  // One soft band of light drifts across the held assembly, the
  // wind made visible, while the group breathes.
  wind.animate(
    [
      { transform: "translateX(-65%) rotate(10deg)", opacity: 0 },
      { opacity: 0.12, offset: 0.35 },
      { transform: "translateX(65%) rotate(10deg)", opacity: 0 },
    ],
    { duration: 2100, delay: 4300, easing: "ease-in-out", fill: "both" },
  );
  // The charge: just before the flash-out, the stage's heart
  // surges — the core of her light flares, the glow swells, and
  // the whole assembly brightens, gathering the light it is
  // about to leave as.
  window.setTimeout(() => {
    if (!splash.isConnected) return;
    charge.animate([{ opacity: 0 }, { opacity: 0.55 }], {
      duration: 450,
      easing: "ease-in",
      fill: "both",
    });
    glow.animate(
      [
        { transform: "translate(-50%, -50%) scale(1)", opacity: 0.58 },
        { transform: "translate(-50%, -50%) scale(1.22)", opacity: 0.95 },
      ],
      { duration: 450, easing: "ease-in", fill: "both" },
    );
    core.animate(
      [
        { transform: "translate(-50%, -50%) scale(1)", opacity: 0.95 },
        { transform: "translate(-50%, -50%) scale(1.4)", opacity: 1 },
      ],
      { duration: 450, easing: "ease-in", fill: "both" },
    );
    for (const b of built) {
      b.sway.animate([{ filter: "brightness(1)" }, { filter: "brightness(1.3)" }], {
        duration: 450,
        easing: "ease-in",
        fill: "both",
      });
    }
  }, HERO_FLASH_AFTER_MS - 450);
  // THE FLASH-OUT: every hero streaks away as light along their
  // own vector — up and out, each in a different direction, the
  // centre of the assembly first and the edges a ripple behind —
  // with their trails burning, into the white-gold flash. The
  // gathered light goes with them.
  window.setTimeout(() => {
    if (!splash.isConnected) return;
    shaft.animate([{ opacity: 0.8 }, { opacity: 0 }], {
      duration: 800,
      delay: 100,
      easing: "ease-out",
      fill: "both",
    });
    core.animate(
      [
        { transform: "translate(-50%, -50%) scale(1.4)", opacity: 1 },
        { transform: "translate(-50%, -50%) scale(1.9)", opacity: 0 },
      ],
      { duration: 800, delay: 100, easing: "ease-out", fill: "both" },
    );
    for (const b of built) {
      const dxu = (b.slot.x - 50) / 50;
      const ex = dxu * W * 1.3;
      const ey = -(0.6 + ((100 - b.slot.b) / 100) * 0.65) * H * 1.15;
      aimTrail(b, ex, ey);
      const dist = Math.hypot(dxu, (b.slot.b - 38) / 60);
      const delay = Math.round(dist * 240);
      b.outer.animate(
        [
          { transform: `${base} scale(1.04)`, opacity: 1 },
          { opacity: 1, offset: 0.5 },
          {
            transform: `${base} translate(${ex.toFixed(0)}px, ${ey.toFixed(0)}px) scale(0.88)`,
            opacity: 0,
          },
        ],
        { duration: 560, delay, easing: "cubic-bezier(.55,.06,.85,.4)", fill: "both" },
      );
      b.trail.animate(
        [
          { opacity: 0, scale: "0.4 1" },
          { opacity: 0.9, offset: 0.35 },
          { opacity: 0, scale: "1.7 1" },
        ],
        { duration: 560, delay, easing: "ease-out", fill: "both" },
      );
    }
    // The flash itself: a white-gold bloom at the assembly's
    // heart that peaks as the last heroes leave, then fades —
    // the fade rule — into the curtain's handover.
    flash.animate(
      [
        { opacity: 0 },
        { opacity: 0.95, offset: 0.18 },
        { opacity: 0.55, offset: 0.45 },
        { opacity: 0 },
      ],
      { duration: 1250, delay: 150, easing: "ease-out", fill: "both" },
    );
  }, HERO_FLASH_AFTER_MS);
  window.setTimeout(() => {
    if (splash.isConnected) dismiss();
  }, HERO_DISMISS_AFTER_MS);
}
function playOpeningSplash(returning: boolean): void {
  const splash = document.getElementById("opening-splash");
  const backdrop = document.getElementById("opening-splash-poster");
  const greeting = document.getElementById("opening-splash-greeting");
  if (!splash) return;
  if (!playOpening) {
    // The owner turned the opening off: no opening, no wait, no
    // open counted — straight into the app. The chooser check still
    // runs (init calls it again after render, when state is loaded).
    splash.remove();
    maybeShowChooser();
    return;
  }
  // Count this open, then pick the greeting and the scheme from it.
  // If storage is unavailable (private mode), fall back to open 1.
  let opens = 0;
  try {
    opens = Number(localStorage.getItem(SPLASH_OPENS_KEY) || "0") || 0;
  } catch {
    opens = 0;
  }
  opens += 1;
  try {
    localStorage.setItem(SPLASH_OPENS_KEY, String(opens));
  } catch {
    // Storage unavailable: the splash still plays, just as open 1.
  }
  const isFirst = opens === 1;
  splash.setAttribute("data-scheme", SPLASH_SCHEME_IDS[(opens - 1) % SPLASH_SCHEME_IDS.length]);
  if (greeting) greeting.textContent = isFirst ? "Welcome" : "Welcome back";
  const dismiss = () => {
    dismissSplashWithCurtain();
  };
  // A tap on the opening skips it with a swoosh — except a tap on
  // the "Don't play again" pill, which already answered with its
  // own toggle blip. The opening ending on its own, and the
  // backstop below, dismiss without a sound: no sound without a
  // user gesture.
  const dismissByTap = (e: Event) => {
    if (!(e.target as HTMLElement).closest("[data-action]")) playSwoosh();
    dismiss();
  };
  if (returning) {
    // Coming back from Google (a sign-in or a connect): the opening
    // already played on the way out, and sitting through it again is
    // a dead pause before the thing the owner just did. The splash
    // stays as a static branded cover in the scheme color while the
    // app loads underneath — no animation, no wait — and init
    // dismisses it fast the moment the first render lands.
    // Backstop: that fast dismiss only runs after the first render,
    // and a slow server can delay the render without bound — so the
    // cover goes away on the slow fade after 6s regardless. The app
    // underneath is usable, and state fills in when it arrives. A
    // cover with no escape hatch is the "connecting forever" the
    // owner reported.
    splash.addEventListener("click", dismissByTap, { once: true });
    window.setTimeout(() => {
      if (splash.isConnected) dismiss();
    }, 6000);
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    splash.remove();
    maybeShowChooser();
    return;
  }
  splash.addEventListener("click", dismissByTap, { once: true });
  // Warm the hero finale's full-figure art while the stage's light
  // gathers: 23 heroes at ~120 KB each, and the asset cache keeps
  // them for later opens. Prism is not among them — she is out of
  // the opening entirely (Neil, Nov 23, 2026).
  for (const p of PHOTONS) {
    if (p.name === "Prism") continue;
    const i = new Image();
    i.src = `/heroes/${encodeURIComponent(p.name)}.webp`;
  }
  for (const a of ATOMS) {
    const i = new Image();
    i.src = `/heroes/${encodeURIComponent(a.name)}.webp`;
  }
  // Backstop: if anything in the finale stalls, do not trap the
  // owner behind the splash. The stage dismisses itself at
  // HERO_DISMISS_AFTER_MS (~8.1s); this sits safely past it.
  window.setTimeout(dismiss, 13000);
  // The hero stage IS the opening now (Nov 25, 2026): with the film
  // retired there is no handoff to wait for, so the stage starts
  // the moment the splash is up — its own light beat (the shaft,
  // the gathering core) opens the show over the backdrop still.
  runHeroFinale(splash, backdrop, dismiss);
}

// The fast dismiss for an OAuth return: the same black curtain as
// the opening's exit, at a quicker tempo, once the first render has
// landed. The chooser check runs after, as usual.
function dismissSplashFast(): void {
  dismissSplashWithCurtain(true);
}

// ---------- First-open chooser ----------
// Shown once, after the opening, only when the account has never
// signed in and the owner has never dismissed it. It exists so the
// account benefits are offered up front instead of hiding at the
// bottom of Upkeep: the sign-in is the same Google flow as the
// Upkeep card (same endpoint, same return), and skipping is always
// possible — nothing here forces an account.
// ---------- First-open chooser ----------
// Two doors, one app (Nov 19, 2026): "For my business" / "For me,
// personally" — the website's two doors, as the front door of the app,
// before Chat / Connected / Store / You. The choice persists on this
// device (see SIDE_KEY, next to storeVariant); until a door is picked
// the chooser shows on every open, and the app shows the business side.
// This replaces the old first-run landing: the pitch and the Google
// sign-in live on the chooser card itself now, so there is one front
// door instead of two gates in a row.
let chooserShown = false;
// Set once in init on a connect return (gmail/google/outlook
// connected): the owner just finished a task, and the chooser over the
// inbox they just connected would be jarring. Only this boot is
// suppressed — a later fresh open can still show it.
let suppressChooserOnce = false;
function maybeShowChooser(): void {
  if (chooserShown) return;
  if (suppressChooserOnce) return;
  // A door already picked on this device: never show it again here.
  if (loadSide() !== "") return;
  // State is not loaded yet (the reduced-motion path dismisses the
  // splash before refreshState finishes): init calls this again after
  // render, so returning here loses nothing.
  if (!state) return;
  // A door already picked on the account — on another device, or on
  // the website: the account is the truth, so no asking again here.
  // (refreshState already adopted the account side into the device
  // cache above; this is the belt to its braces for a state that
  // arrived another way.)
  if ((state as any)?.side === "business" || (state as any)?.side === "personal") return;
  // The opening is still playing: its dismiss calls this again when
  // it goes away, so the chooser never covers the opening.
  if (document.getElementById("opening-splash")?.isConnected) return;
  chooserShown = true;
  const el = document.createElement("div");
  el.id = "side-chooser";
  el.className = "chooser";
  el.innerHTML = `<div class="chooser-card">
    <img class="chooser-mark" src="/brand/gem.jpg" alt="">
    <h1>Prism 5</h1>
    <p class="chooser-lede">One assistant that does it all, and becomes a second you.</p>
    <div class="chooser-doors">
      <button class="chooser-door" data-action="side-pick" data-side="business"><img src="/brand/poster-supernova.jpg" alt=""><span>For my business</span></button>
      <button class="chooser-door" data-action="side-pick" data-side="personal"><img src="/brand/starburst.jpg" alt="" loading="lazy" decoding="async"><span>For me, personally</span></button>
    </div>
    <button class="btn primary chooser-signin" data-action="signin">Sign in or create account with Google</button>
    <button class="chooser-skip" data-action="chooser-skip">Continue without signing in</button>
  </div>`;
  document.body.appendChild(el);
}
function hideChooser(): void {
  document.getElementById("side-chooser")?.remove();
}

// ---------- Boot ----------
(async function init() {
  const params = new URLSearchParams(location.search);
  // A return from Google (app sign-in or any connect) skips the opening:
  // it already played on the way out, and sitting through it again is
  // a dead pause before the thing the owner just did. The splash stays
  // as a static cover until the first render lands, then goes away
  // fast (dismissSplashFast, below).
  const returning =
    params.has("signin") || params.has("gmail") || params.has("google") || params.has("outlook");
  // main.js ran: the inline splash backstop in index.html stands down.
  window.clearTimeout((window as any).__prismSplashFallback);
  playOpeningSplash(returning);
  setupKeyboardDock();
  const t = params.get("tab");
  // Old tab names still land in the right place: a bookmark or an old
  // installed copy asking for Inboxes or Upkeep gets Connected or You.
  if (t === "inboxes") tab = "connected";
  else if (t === "upkeep") tab = "you";
  else if (t === "connected" || t === "store" || t === "you" || t === "chat") tab = t as Tab;
  // The connect-return flags are set here, before the first render, so
  // the confirmation banner (or the plain-word error with its retry)
  // is already in the Connected tab the owner lands on — not painted in
  // after the fact.
  const gmailParam = params.get("gmail");
  const googleParam = params.get("google");
  const outlookParam = params.get("outlook");
  if (gmailParam === "connected") {
    justConnected = "gmail";
    suppressChooserOnce = true;
  } else if (gmailParam === "error") {
    connectError = "Gmail sign-in didn't finish. Try again.";
    connectErrorKind = "gmail";
  }
  if (googleParam === "connected") {
    justConnected = "google";
    suppressChooserOnce = true;
  } else if (googleParam === "error") {
    connectError = "Calendar and Drive sign-in didn't finish. Try again.";
    connectErrorKind = "google";
  }
  if (outlookParam === "connected") {
    justConnected = "outlook";
    suppressChooserOnce = true;
  } else if (outlookParam === "error") {
    connectError = "Outlook sign-in didn't finish. Try again.";
    connectErrorKind = "outlook";
  }
  // App sign-in return: the OAuth callback hands back a one-time
  // session token, spent here once for the account id. The token is
  // then dropped from the address bar so it cannot be reused.
  // The exchange runs BEFORE the first state load and first paint.
  // Before this, boot loaded state for the old anonymous account,
  // painted "You are not signed in", and only then exchanged the
  // token — fixing the state in memory without repainting, so the
  // signed-out card stayed on screen until a reload. That was the
  // "not signed in" flash after coming back from Google: the first
  // render now already carries the signed-in account.
  const signin = params.get("signin");
  const session = params.get("session");
  let signinResult: "new" | "back" | "error" | null = null;
  let signinName = "";
  if (signin === "ok" && session) {
    const r: any = await api.authSession(session);
    if (r && r.ok) {
      // The exchange is the handoff: the browser now uses the linked
      // account id, so the sign-in survives a refresh and a new device
      // is one sign-in away from the same account.
      setAccountId(r.accountId);
      state = r;
      signinResult = r.isNew ? "new" : "back";
      signinName = r.auth?.name || r.auth?.email || "";
      // The chooser must not sit over a freshly signed-in account:
      // the opening is still playing on the way back from Google, so the
      // chooser cannot have shown yet, but if it did, take it down.
      hideChooser();
    } else {
      signinResult = "error";
    }
    history.replaceState(null, "", "/?tab=you");
  } else if (signin === "error") {
    signinResult = "error";
    history.replaceState(null, "", "/?tab=you");
  }
  // Sign-in recovery: the token above may have been spent in a
  // different browsing context than this one — on Android the
  // installed app's sign-in is diverted to a browser tab, the callback
  // loads there, and the token is burned there, so this context never
  // learns the linked account id from the URL. The server recorded
  // device id -> account id at link time, so ask for it here and adopt
  // it in this context instead of making the owner sign in again.
  // This runs whenever the token exchange did not already hand us a
  // state: a failed exchange (the token was already spent elsewhere)
  // is exactly the case it rescues.
  if (!state) {
    const rec: any = await api.authRecover();
    if (rec && rec.ok && rec.linked && rec.accountId && rec.accountId !== getAccountId()) {
      setAccountId(rec.accountId);
      authRecovered = true;
    }
  }
  if (!state) await refreshState();
  if (!state) {
    // Boot reached render with no state (the server did not answer in
    // 10s — a restart, a dead connection). Say so, and retry once a
    // few seconds later so a transient restart heals itself instead
    // of leaving an empty shell with no sign-in button.
    toast("Couldn't reach the server just now — checking again in a moment.", "err");
    window.setTimeout(async () => {
      await refreshState();
      render();
      maybeShowChooser();
    }, 5000);
  }
  // The tab's data loads before the first render, but it must never
  // hold the render hostage: the calls are bounded now (see req in
  // api.ts), and even so the first render lands after 8s at the
  // latest, with the load finishing in the background and re-rendering
  // when it arrives. Before this, a stalled load left the opening
  // cover up with nothing behind it — the "connecting forever".
  const preload =
    tab === "connected"
      ? loadConnected()
      : tab === "you"
        ? loadYou()
        : tab === "store"
          ? loadStripeStatus()
          : null;
  if (preload) {
    const settled = preload.catch(() => {});
    await Promise.race([settled, new Promise((r) => window.setTimeout(r, 8000))]);
    settled.then(() => render());
  }
  render();
  if (returning) dismissSplashFast();
  maybeShowChooser();
  const gmail = gmailParam;
  if (gmail === "connected") toast("Gmail account connected.");
  if (gmail === "error") toast("Gmail sign-in didn't finish. Try again.", "err");
  const google = googleParam;
  if (google === "connected") toast("Calendar and Drive connected.");
  if (google === "error") toast("Calendar and Drive sign-in didn't finish. Try again.", "err");
  const outlook = outlookParam;
  if (outlook === "connected") toast("Outlook account connected.");
  if (outlook === "error") toast("Outlook sign-in didn't finish. Try again.", "err");
  // The return params have done their job: drop them from the address
  // bar so a refresh doesn't replay the banners and toasts. The flags
  // above already carry this boot's state.
  if ((gmailParam || googleParam || outlookParam) && tab === "connected") {
    history.replaceState(null, "", "/?tab=connected");
  }
  // A failed connect drops back on Connected with the failure in the
  // Email section, where its retry goes straight back to the sign-in
  // that failed (see connectErrorKind). No chooser reopens: the retry
  // is one tap on the banner, not a hunt for a button.
  if (signinResult === "new") {
    toast(
      `Account created — welcome to Prism 5${signinName ? ", " + signinName : ""}. Your welcome offer and Prism's story are in You.`,
    );
  } else if (signinResult === "back") {
    toast(`Signed in — welcome back${signinName ? ", " + signinName : ""}.`);
  } else if (signinResult === "error") {
    toast("Sign-in didn't finish. Try again.", "err");
  }
  // Boot adopted the linked account through recovery (the sign-in was
  // completed in the browser tab, not in this context): say so, so the
  // owner can see the sign-in landed instead of wondering.
  if (authRecovered && state?.auth?.signedIn) {
    toast(`Signed in — welcome back${state.auth.name ? ", " + state.auth.name : ""}.`);
  }
  if (state && !state.brain) {
    // The brain is off until a key is set; the app still works.
    console.info("Brain not connected: set ANTHROPIC_API_KEY to turn chat on.");
  }
})();

// ---------- Return from the browser ----------
// The owner just came back to the installed app — most often from the
// browser tab a sign-in or a connect opened. The app process survived
// in the background with its old in-memory state, so a sign-in
// completed in that tab would otherwise sit invisible until the next
// cold open. Ask the server whether this device id was linked to an
// account in the meantime, and adopt it now. A re-render only happens
// when nothing the owner is typing would be lost: a focused composer,
// or one holding text, holds the render until the next navigation
// (the toast still says the account is connected).
function ownerIsTyping(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA")) return true;
  const chatInput = document.getElementById("chat-input") as HTMLInputElement | null;
  if (chatInput && chatInput.value) return true;
  const draft = document.querySelector("#view textarea") as HTMLTextAreaElement | null;
  if (draft && draft.value) return true;
  return false;
}
async function resumeRecover(): Promise<void> {
  const before = getAccountId();
  const rec: any = await api.authRecover();
  if (!rec || !rec.ok || !rec.linked || !rec.accountId || rec.accountId === before) return;
  setAccountId(rec.accountId);
  authRecovered = true;
  await refreshState();
  if (ownerIsTyping()) {
    toast("Your Google account is connected now.");
    return;
  }
  render();
  if (state?.auth?.signedIn) {
    toast(`Signed in — welcome back${state.auth.name ? ", " + state.auth.name : ""}.`);
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void resumeRecover();
});
