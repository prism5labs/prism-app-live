// Prism 5 — standalone client. Four tabs: Chat, Inboxes, Store, Upkeep.
// No provider or model names appear anywhere in the visible copy.

import { api, getAccountId, setAccountId, clearAccountId } from "./api";
import { portraitHtml } from "./ui";
import { SUPERNOVA, SATELLITE, UPKEEP, PRODUCTS, CATEGORIES } from "../src/shared/catalog";
import { TIER_COPY, UPKEEP_COPY, FREE_CHATS_COPY } from "../src/shared/tiers";
import { PHOTONS } from "../src/shared/photons";
import { VOICES, TUNING_QUESTIONS, LOOK_SETS, voiceById, lookSetById, tuningStyle } from "../src/shared/voices";

type Tab = "chat" | "inboxes" | "store" | "upkeep";

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

function portraitNameOf(p: any): string {
  return customFor(p.name).portrait || p.name;
}

function voiceNameOf(photon: string): string {
  return voiceById(customFor(photon).voice).name;
}

let state: any = null;
let tab: Tab = "chat";
let activePhoton: string | null = null;
let storeVariant: "personal" | "business" = "personal";
// Which Store sections are open. Remembered across re-renders, so the
// Personal/Business toggle doesn't collapse what the user opened.
let storeOpen: Record<string, boolean> = { photons: true, sparks: false, plugs: false };
let threadMessages: any[] = [];
let threadLoading = false;
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

// Proactive checks, reminders, push (Step 3): loaded when the Upkeep
// tab opens, so the tab shows a loading line instead of stale or empty
// cards.
let proactiveData: any = null;
let proactiveLoading = false;
let remindersData: any[] | null = null;
let pushData: any = null;
let lastCheck: any = null;
let checkRunning = false;
let upkeepLoading = false;

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

// Messenger (Step 9): Page threads, loaded with the Inboxes tab.
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
// high-contrast toggle, set from the Reading card in Upkeep, saved on
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

const SEND_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 20V6M6 11l6-6 6 6" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const NAV_ICONS: Record<Tab, string> = {
  chat: `<svg viewBox="0 0 24 24" fill="none"><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  inboxes: `<svg viewBox="0 0 24 24" fill="none"><path d="M3 13h5l2 3h4l2-3h5M4 6h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  store: `<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16l-1.5 12a1 1 0 0 1-1 .9h-11a1 1 0 0 1-1-.9L4 7Z M8 10V6a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
  upkeep: `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l2.2 5.3L20 9l-4 4 1 5.7L12 16l-5 2.7L8 13 4 9l5.8-.7L12 3Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
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
  }, 200);
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
  const owned = state?.freeCode === true || (state?.ownedPhotons || []).includes(p.name);
  const face = faceNameOf(p);
  const body = `
    <div class="card-hero">${portraitHtml(portraitNameOf(p), 140)}</div>
    <h2 class="card-title">${esc(face)}</h2>
    <p class="card-kind">Photon · Supernova · ${esc(p.pronoun)}</p>
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
    <p class="fine">A Supernova is unlimited in usefulness: each Photon has a focus out of the box but does far more, and becomes you through use.</p>
    <div class="card-actions">
      ${owned ? `<span class="owned-badge">Owned — yours already</span><button class="btn primary" data-action="card-chat" data-photon="${esc(p.name)}">Start chatting</button>` : buyButton(buyUrl(SUPERNOVA.url, "Photon-" + p.name), "$514.00", false)}
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
      `<div class="card-hero"><img class="card-poster" src="/brand/poster-supernova.jpg" alt="Supernova poster, the whole front office"></div>
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
      `<div class="card-hero"><img class="card-poster" src="/brand/poster-satellite.jpg" alt="Satellite poster, one Brain, one Face, one job duty"></div>
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
    `<div class="card-hero"><img class="card-poster" src="/brand/starburst.jpg" alt="Upkeep starburst"></div>
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

// ---------- Inboxes extras: Messages, Contacts, Calendar, Drive ----------
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

function photonCard(p: any, size = 220): string {
  const owned = p.owned;
  // The owner's chosen look set reskins this Photon's card, so the
  // choice is visible before the chat is even opened.
  const look = lookSetById(customFor(p.name).lookSet || "");
  return `<button class="photon-card${look ? ` look-${look.id}` : ""}" data-action="open-photon" data-photon="${esc(p.name)}" ${
    owned ? "" : "disabled"
  }>
    ${portraitHtml(portraitNameOf(p), size)}
    <span class="photon-name">${esc(faceNameOf(p))}</span>
    <span class="photon-tag">${esc(p.tagline)}</span>
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
      ? `<p class="fine">${esc(dayData.calendar.message || "Calendar is not connected yet.")}</p><div class="row"><button class="btn" data-action="goto" data-tab="inboxes">Go to Inboxes</button></div>`
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
function renderChatFront(): string {
  const owned = (state?.photons || []).filter((p: any) => p.owned);
  const customName = state?.customName || "";
  const ownedHtml =
    owned.length > 0
      ? `<div class="photon-grid">${owned.map((p: any) => photonCard(p)).join("")}</div>`
      : `<div class="card empty-panel">
          <div class="card-head"><img class="mark" src="/brand/gem.jpg" alt=""><h2>Nothing to talk to yet.</h2></div>
          <p>There is no one to talk to here yet. A Launch is what gives this app a personality. Grab a Spark and run it, or pick up a Photon, and you will have someone on the line.</p>
          <button class="btn store-outline store-btn" data-action="goto" data-tab="store">Visit the Store</button>
          <div class="redeem-row"><button class="btn" data-action="goto" data-tab="upkeep">Redeem a code</button></div>
        </div>`;
  return `
  <section class="front">
    <div class="sputnik-hero">
      <img class="sp-img" src="/brand/sputnik.jpg" alt="Sputnik emblem — gold crystal and orbit rings on deep teal, PRISM 5 LABS in gold">
    </div>
    <div class="front-body">
      <h3 class="greeting">Howdy, <span class="greeting-accent">neighbor!</span></h3>
      <p class="tagline">Truly Atomic AI Assistants</p>
      <p class="front-lede">One assistant that does it all, and becomes a second you. Pick a Photon and start talking.</p>
    </div>
    ${ownsStartMyDay()
      ? `<div class="card day-card">
          <h2>Start My Day</h2>
          <p>Your morning briefing, like a project manager for your day. It walks today top to bottom, one item at a time, and edits each item once you confirm it.</p>
          <button class="btn primary" data-action="day-start">Start My Day</button>
        </div>`
      : ""}
    ${ownedHtml}
    <div class="card make-yours">
      <h2>Make it yours</h2>
      <p>Give your assistant a name. It replaces "Prism 5" everywhere in this app until you clear it.</p>
      <form id="name-form" class="row">
        <input id="name-input" type="text" maxlength="40" placeholder="e.g. Megan" value="${esc(customName)}" aria-label="Your assistant's name">
        <button class="btn primary" type="submit">Save name</button>
        ${customName ? `<button class="btn" type="button" data-action="clear-name">Clear</button>` : ""}
      </form>
    </div>
    <div class="meter">${esc(meterLine())}${meterBar()}</div>
    <p class="fine">Upkeep is $29 a month for unlimited chat, updates, priority support, and live voice calls.</p>
    <div class="mission-strip">Let us handle the noise so you can focus on what you want and need to do.</div>
  </section>`;
}

// A Photon's backstory, from the day the owner's account was created.
// Display only, never saved into the thread. Empty for accounts that
// never signed in — the stories are an account-creation perk.
function backstoryBlock(photon: string): string {
  const story = (state as any)?.backstories?.[photon];
  if (!story) return "";
  return `<div class="msg bot">${portraitHtml(portraitNameOf(PHOTONS.find((x) => x.name === photon) || { name: photon }), 28)}<div><p><b>How ${esc(photon)} began.</b></p><p>${esc(story)}</p></div></div>`;
}

// ---------- Chat thread ----------
function renderChatThread(): string {
  const p = PHOTONS.find((x) => x.name === activePhoton);
  if (!p) return renderChatFront();
  const face = faceNameOf(p);
  const portrait = portraitNameOf(p);
  const customized = !!(state as any)?.customizations?.[p.name];
  // The owner's chosen look set reskins this Photon's whole chat.
  // The class lives on this section, and syncBodyLook() puts it on
  // <body> too, so the whole app follows; leaving the thread clears
  // the body class and restores the default look with no cleanup.
  const look = lookSetById(customFor(p.name).lookSet || "");
  // A streaming reply shows three dots until the first words land.
  const botMsg = (text: string, streaming = false) =>
    `<div class="msg bot${streaming ? " streaming" : ""}">${portraitHtml(portrait, 28)}<div><p>${text ? esc(text) : '<span class="typing"><span></span><span></span><span></span></span>'}</p></div></div>`;
  const msgs = threadMessages.length
    ? threadMessages
        .map((m: any) =>
          m.role === "user"
            ? `<div class="msg user"><p>${esc(m.content)}</p></div>`
            : botMsg(m.content, !!m.streaming),
        )
        .join("")
    // Empty thread: the Photon introduces itself, who it is and what it
    // was built for, instead of a generic greeting. Display only, never
    // saved into the thread. A signed-in owner also sees how this
    // Photon began — the backstory from the day the account was created.
    : botMsg(p.intro.replaceAll("{name}", face)) + backstoryBlock(p.name);
  return `
  <section class="thread${look ? ` look-${look.id}` : ""}">
    <div class="thread-head">
      <button class="back-btn" data-action="back-to-front">← <span>All Photons</span></button>
      ${portraitHtml(portrait, 56)}
      <div class="thread-title">
        <h2>${esc(face)}</h2>
        <span class="thread-tag">${esc(p.tagline)}</span>
        ${customized ? `<span class="thread-voice">Voice: ${esc(voiceNameOf(p.name))}</span>` : ""}
      </div>
      <details class="thread-menu">
        <summary aria-label="More options">···</summary>
        <div class="thread-menu-list">
          <button class="btn small" data-action="customize" data-photon="${esc(p.name)}">Customize</button>
          <button class="btn small call" data-action="call" data-photon="${esc(p.name)}">Call · Upkeep</button>
          <button class="btn small" data-action="report-prism" data-photon="${esc(p.name)}">Report to Prism 5</button>
        </div>
      </details>
    </div>
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
    <p>One name, like the install. It replaces "${esc(p.name)}" in chat for this Photon only.</p>
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
    <button class="back-btn" data-action="custom-back">← ${c.done ? "Back to chat" : "All Photons"}</button>
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
    toast("Connect a Gmail account in Inboxes first, then send.", "err");
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
    ${blocked ? `<div class="row call-blocked-actions"><button class="btn primary" data-action="goto" data-tab="upkeep">Go to Upkeep</button><button class="btn" data-action="goto" data-tab="store">Visit the Store</button></div>` : ""}
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
  const owned = (state?.ownedPhotons || []) as string[];
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
    <p class="fine">Switchboard is email and texts. A Photon can only send to a contact who approved the connection first, like a friend request. Names come from this book only — an unknown number stays an unknown number, never a guessed name.</p>
    ${prism ? row(prism) : `<p class="fine">Prism 5 (prism5labstest@gmail.com) — no connection yet. Ask a Photon to write a report, then tap Report to Prism 5 in chat.</p>`}
    ${others.map(row).join("") || `<p class="fine">No other contacts yet.</p>`}
    <form class="contact-form">
      <h4>Add someone by hand</h4>
      <input name="name" type="text" placeholder="Name" required>
      <input name="address" type="email" placeholder="Email address" required>
      <input name="phone" type="tel" placeholder="Phone (optional — needed for texts)">
      <select name="photon" aria-label="Photon">${photonOpts}</select>
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
// using the app, and it makes the Inboxes page look unfinished. When
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
        : `<p class="fine">Tap <b>Connect an account</b> above, then choose Google Calendar &amp; Drive. One sign-in covers both Calendar and Drive.</p>`}
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
        : `<p class="fine">Tap <b>Connect an account</b> above, then choose Google Calendar &amp; Drive. One sign-in covers both.</p>`}
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
  const read = state?.driveFileRead;
  const readBox = read
    ? read.ok && read.readable
      ? `<div class="drive-read"><h4>${esc(read.file?.name || "File")}</h4><pre class="drive-content">${esc(read.content || "")}</pre>${read.truncated ? `<p class="fine">Showing the first 100,000 characters — the file is longer than that.</p>` : ""}<button class="btn small" data-action="drive-close">Close file</button></div>`
      : read.ok && !read.readable
        ? `<div class="drive-read"><h4>${esc(read.file?.name || "File")}</h4><p>${esc(read.message || "This file type cannot be read as text.")}</p><button class="btn small" data-action="drive-close">Close</button></div>`
        : `<p class="chat-error">${esc(read.message || "That file didn't load. Try again.")}</p>`
    : "";
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
  const personal = `<p class="fine">Personal Messenger can't be connected — Meta offers messaging for Facebook Pages only, not personal accounts. For a personal thread, paste the messages into chat and your Photon will read them there.</p>`;
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
// connect: a Gmail account or an Outlook account (as many as you like,
// each a separate sign-in), Google Calendar & Drive (one sign-in covers
// both), or a Facebook Page (a Page access token, pasted in the
// Messenger section below). Each option is shown on its own: an option
// whose sign-in is not set up on this server says so plainly instead of
// pretending. Yahoo, Apple Mail, and other mail providers have no
// supported sign-in here, and texts, calls, and Facebook Page messaging
// are set up on the server, not from the app. The chooser reuses the
// character-card modal, so it dismisses the same four ways: the X, the
// Close button, a tap on the backdrop, or the Escape key.
// Connect-return state, set once in init from the OAuth return params:
// justConnected puts a plain confirmation at the top of the Email
// section (a toast alone is too easy to miss), connectError puts the
// failure there with a one-tap retry. Both clear when the owner leaves
// Inboxes, or when a later load shows the account is fine.
let justConnected: "" | "gmail" | "google" | "outlook" = "";
let connectError = "";
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

function connectChooserHtml(notice?: string): string {
  const google = state?.googleConfigured;
  const microsoft = state?.microsoftConfigured;
  const choices: string[] = [];
  if (google) {
    choices.push(`<a class="btn primary" href="/api/oauth/google/start?accountId=${encodeURIComponent(
      getAccountId(),
    )}&label=${nextGmailLabel()}">Add a Gmail account</a>
        <p class="fine">Sign in with Google. That account's inbox and drafts appear below.</p>`);
  } else {
    choices.push(`<p>Gmail sign-in isn't set up on this server yet. It needs a Google OAuth client (client ID, secret, and redirect).</p>`);
  }
  if (microsoft) {
    choices.push(`<a class="btn primary" href="/api/oauth/microsoft/start?accountId=${encodeURIComponent(
      getAccountId(),
    )}&label=${nextOutlookLabel()}">Add an Outlook account</a>
        <p class="fine">Sign in with Microsoft. That account's inbox and drafts appear below, next to your Gmail accounts.</p>`);
  } else {
    choices.push(`<p>Outlook sign-in isn't set up on this server yet. It needs a Microsoft OAuth client (client ID, secret, and redirect).</p>`);
  }
  if (google) {
    choices.push(`<a class="btn primary" href="/api/oauth/google/start-extra?accountId=${encodeURIComponent(
      getAccountId(),
    )}">Connect Calendar &amp; Drive</a>
        <p class="fine">One sign-in covers both Calendar and Drive. If you already connected Gmail, you'll sign in once more to add the permission.</p>`);
  }
  choices.push(`<button class="btn primary" data-action="goto-messenger">Connect a Facebook Page</button>
        <p class="fine">Your business Facebook Page connects in the Messenger section below — paste a Page access token there. Personal Messenger can't be connected: Meta offers messaging for Facebook Pages only.</p>`);
  const body = `${notice ? `<p class="chat-error">${esc(notice)}</p>` : ""}<p class="card-tagline">Add as many accounts as you like. Each one is a separate sign-in, and each shows up here as its own inbox.</p>
      <div class="connect-choices">
        ${choices.join("\n")}
      </div>
      <p class="fine">Google and Outlook can be connected from the app. Yahoo, Apple Mail, and other mail providers are not supported yet — they need a mail connection this app does not have. Texts and calls are set up on the server, not from the app.</p>`;
  return cardShell("Connect an account", body);
}

function openConnectChooser(opener: HTMLElement | null, notice?: string) {
  openCard(connectChooserHtml(notice), opener);
}

// ---------- Email summary cards ----------
// The inbox used to render every message the server returned, which
// read as an unbelievably huge dump. Now each account is a tidy
// summary: an unread count, then a short "needs attention" list —
// unread first, then the newest, capped at ten — and the whole message
// is one tap away. Older mail still lives in Gmail or Outlook (linked
// below the list); nothing here renders the entire inbox at once.
const EMAIL_SUMMARY_CAP = 10;

function emailRowHtml(m: any, provider: "gmail" | "outlook", label: string): string {
  const unread = m.unread === true;
  return `<button class="inbox-msg email-row${unread ? " unread" : " read"}" data-action="email-open" data-provider="${provider}" data-label="${esc(String(label))}" data-id="${esc(String(m.id || ""))}">
      <span class="email-row-top"><span class="unread-dot" aria-hidden="true"></span><span class="inbox-subject">${esc(m.subject || "(no subject)")}</span></span>
      <span class="inbox-meta">${esc(m.from || "")} · ${esc(m.date || "")}</span>
      <span class="inbox-snippet">${esc(m.snippet || "")}</span>
    </button>`;
}

function emailCard(acct: any, provider: "gmail" | "outlook"): string {
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
  const errorHtml =
    acct.error === "token_failed"
      ? `<p class="chat-error">That account's sign-in ran out, so the inbox wouldn't open. Reconnect it from the button above — nothing was lost.</p>`
      : acct.error
        ? `<p class="chat-error">That inbox didn't answer just now. <button class="btn small" data-action="inbox-retry">Try again</button></p>`
        : "";
  const webmail =
    provider === "outlook"
      ? `<p class="fine"><a href="https://outlook.live.com/mail/" target="_blank" rel="noopener">Open in Outlook</a> for older mail.</p>`
      : `<p class="fine"><a href="https://mail.google.com/" target="_blank" rel="noopener">Open in Gmail</a> for older mail.</p>`;
  return `<div class="card inbox-card">
        <h3>${esc(acct.title || acct.email || "Email")}</h3>
        <p class="fine">${esc(acct.email || "")} · ${provider === "outlook" ? "Outlook" : "Gmail"}</p>
        ${unreadLine}
        ${errorHtml || (msgs.length ? msgs.map((m: any) => emailRowHtml(m, provider, label)).join("") : `<p class="fine">Nothing in the inbox right now.</p>`)}
        ${msgs.length ? webmail : ""}
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
let emailOpenRetry: { provider: "gmail" | "outlook"; label: string; id: string } | null = null;

async function openEmailMessage(
  provider: "gmail" | "outlook",
  label: string,
  id: string,
  opener: HTMLElement | null,
): Promise<void> {
  emailOpenRetry = { provider, label, id };
  openCard(cardShell("Message", `<p class="fine">Opening that message…</p>`), opener);
  const r: any =
    provider === "gmail" ? await api.gmailMessage(label, id) : await api.outlookMessage(label, id);
  if (r && r.ok) {
    emailOpenRetry = null;
    openCard(
      cardShell(
        r.subject || "Message",
        `<h2 class="card-title">${esc(r.subject || "(no subject)")}</h2>
        <p class="card-kind">${esc(r.from || "")} · ${esc(r.date || "")}</p>
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

function renderInboxes(): string {
  const accounts = (state?.inboxAccounts || []) as any[];
  const outlookAccounts = (state?.outlookAccounts || []) as any[];
  const googleConfigured = state?.googleConfigured;
  const microsoftConfigured = state?.microsoftConfigured;
  const cards = [
    ...accounts.map((acct: any) => emailCard(acct, "gmail")),
    ...outlookAccounts.map((acct: any) => emailCard(acct, "outlook")),
  ].join("");
  const emailEmpty =
    inboxesLoading && !accounts.length && !outlookAccounts.length
      ? `<p class="fine">Checking your inbox…</p>`
      : googleConfigured || microsoftConfigured
        ? `<p class="fine">No email accounts connected yet — tap <b>Connect an account</b> above to add one.</p>`
        : `<p class="fine">Email sign-in isn't set up on this server yet.</p>`;
  const connectedBanner =
    justConnected === "gmail"
      ? `<p class="inbox-connected">Gmail connected — your inbox is below.</p>`
      : justConnected === "outlook"
        ? `<p class="inbox-connected">Outlook connected — your inbox is below.</p>`
        : justConnected === "google"
          ? `<p class="inbox-connected">Calendar and Drive connected.</p>`
          : "";
  const connectErrorHtml = connectError
    ? `<p class="chat-error">${esc(connectError)} <button class="btn small" data-action="connect-open">Try again</button></p>`
    : "";
  return `
  <section>
    <h1 class="page-title">Inboxes</h1>
    <p class="page-lede">Messages, contacts, calendar, and Drive — plus your email accounts. Drafts you save here land in that account's drafts.</p>
    <div class="connect-bar"><button class="btn primary" data-action="connect-open">Connect an account</button></div>
    <div class="switchboard-strip"><img src="/brand/switchboard.jpg" alt=""><p><b>On Switchboard.</b> Inboxes is where Switchboard lives — every Launch in the Lab, one board.</p></div>
    <div class="inbox-jump" aria-label="Jump to a section">
      <a href="#messages">Messages</a>
      <a href="#contacts">Contacts</a>
      <a href="#calendar">Calendar</a>
      <a href="#drive">Drive</a>
      <a href="#gmail-accounts">Email</a>
      <a href="#about-you">About you</a>
      <a href="#memory-import">Memory</a>
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
    ${accounts.length || outlookAccounts.length ? "" : emailEmpty}
    ${renderProfile()}
    ${renderMemoryImport()}
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
    ? `<p class="fine">Saved. Your Photons know you now.</p>`
    : "";
  return `<div class="card" id="about-you"><h3>About you</h3>
    <p class="fine">Tell your Photons who you are, so they know you instead of starting cold. This stays on the server for your account only. It is never shared with anyone else.</p>
    <form id="profile-form" class="profile-form">
      <label class="field-label">What should they call you?
        <input name="displayName" type="text" placeholder="Your name" value="${esc(p.displayName || "")}" maxlength="80">
      </label>
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
function buyUrl(url: string, hint: string): string {
  const sep = url.includes("?") ? "&" : "?";
  let out = `${url}${sep}client_reference_id=${encodeURIComponent(getAccountId() + ":" + hint)}`;
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
  const ownedPhotons: string[] = state?.ownedPhotons || [];
  const allOwned = state?.freeCode === true;
  const variant = storeVariant;
  const photonCards = PHOTONS.map((p) => {
    const owned = allOwned || ownedPhotons.includes(p.name);
    return `<div class="card product-card photon-store">
      <button class="portrait-btn" data-action="photon-info" data-photon="${esc(p.name)}" aria-label="More about ${esc(p.name)}">${portraitHtml(p.name, 220)}</button>
      <h3 class="photon-name">${esc(p.name)}</h3>
      <p>${esc(p.tagline)}</p>
      <p class="fine">${esc(p.focus)} And so much more.</p>
      <p class="price">$499.00 <span class="fine">($514.00 at checkout)</span></p>
      ${buyButton(buyUrl(SUPERNOVA.url, "Photon-" + p.name), "$514.00", owned)}
    </div>`;
  }).join("");

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

  return `
  <section>
    <div class="store-head"><img src="/brand/starburst.jpg" alt=""><div><h1 class="page-title">Store</h1><p>A Launch is the helper you talk with in this app. Pick the helper that fits your day, then pick how you want to pay. The prices are further down, after a plain explanation of how it all works.</p></div></div>
    ${perkBanner()}
    ${stripeStatusData
      ? `<p class="fine stripe-line">${stripeStatusData.configured ? "Automatic unlocks are on — a purchase unlocks as soon as Stripe confirms the payment." : "Automatic unlocks are off — the Stripe webhook isn't set up yet. Purchases still unlock by code (redeem one in Upkeep) until it is."}</p>`
      : `<p class="fine">Checking automatic unlocks…</p>`}
    <div class="chrome-thin"></div>

    <details class="store-group pricing-explainer" id="store-pricing" ${storeOpen.pricing ? "open" : ""}>
      <summary><span class="summary-title">Understand our pricing</span><span class="fine">tap to read, in plain words</span></summary>
      <div class="pricing-body">
        <p><b>First, what are these things?</b> A Launch is what gives this app someone to talk to. With no Launch, there is no one to talk to. Each Launch is called a Photon, and each Photon has its own way of helping, like keeping on top of your messages, sorting your calendar, or drafting notes in your words.</p>
        <p><b>A Spark</b> is one button for one job. You press it, it does that one job, and you can press it again as often as you like. It never runs out and it never dies. <b>A Plug</b> is the same idea, except you do not press anything. It runs on its own, in the background, and does its job without being asked.</p>
        <p><b>A Supernova</b> is the full helper. It is the whole front office in one: messages, calendar, paperwork, and anything else that comes up, and it learns how you like things done. <b>A Satellite</b> is a smaller version of the same thing, for one job at a time, with one way of talking and one way of looking.</p>
        <p><b>Upkeep</b> is the care that keeps your helper working well: unlimited chats, updates as they come out, help first when you need it, and talking out loud instead of typing. Upkeep is never required. Every purchase already includes 300 chats a month, free forever, with no monthly payment needed.</p>
        <p><b>How paying works.</b> Some things you pay for once, and then they are yours forever. That is how Sparks, Plugs, Supernova, and Satellite work when you buy them outright. Or you can pay month by month instead. Paying monthly costs less at the start, and if you stop paying, the live help pauses until you start again. What you already bought stays on your phone, nothing is deleted and nothing is chased. Paying for two years at a time costs less each month, because you are committing for longer. Paying for a whole year at once costs the same as 11 months, so the 12th month is free.</p>
        <p><b>Why does it cost what it does?</b> Each helper is written out, line by line, for the way you actually work, then tested until it works properly, and then kept working with updates. A Supernova is about 300 hours of that careful building and testing. A Satellite is about 150 hours, a Plug about 50 hours, and a Spark about 25 hours. You are paying for that time, and for a helper that is built around your day, not a generic one.</p>
        <p><b>The small print, in plain words.</b> When you pay, the card company adds a small fee of 3 percent, and the checkout page shows you the full total before you pay anything, so there are no surprises. You can try things free for 14 days, with no card details, no charge, and nothing that renews on its own. If you buy Upkeep with your first purchase, you get 15 percent off your purchases while Upkeep stays on.</p>
        <p class="pricing-contact"><b>Questions? Please ask.</b> No question is too small, and you do not need to know anything about technology to ask it. Email us at <a href="mailto:prism5labscontact@gmail.com">prism5labscontact@gmail.com</a> or call <a href="tel:+19203937294">(920) 393-7294</a>. We will explain it in plain words, and help you pick what fits.</p>
      </div>
    </details>

    <div class="store-jump" aria-label="Jump to a section">
      <a href="#store-supernova">Supernova</a>
      <a href="#store-satellite">Satellite</a>
      <a href="#store-photons">Photons</a>
      <a href="#store-upkeep">Upkeep</a>
      <a href="#store-sparks-plugs">Sparks &amp; Plugs</a>
    </div>

    <h2 class="section-title">Launches</h2>
    <div class="poster-row" id="store-supernova"><button class="poster-btn" data-action="tier-info" data-tier="supernova" aria-label="More about Supernova"><img src="/brand/poster-supernova.jpg" alt="Supernova poster, the whole front office"></button><div class="pr-txt"><b>Supernova</b><span class="desc">${esc(TIER_COPY.supernova.body)}</span><span class="desc">${esc(TIER_COPY.supernova.hours)}</span><span class="price">$499.00</span><span class="at">$514.00 at checkout</span>${buyButton(buyUrl(SUPERNOVA.url, "supernova"), "$514.00", allOwned || ownedProducts.includes("supernova"))}<p class="fine">Or pay monthly:</p><div class="row monthly-row">
        <a class="btn small" href="${esc(buyUrl(SUPERNOVA.monthly.url, "supernova-monthly"))}" target="_blank" rel="noopener">$49/mo</a>
        <a class="btn small" href="${esc(buyUrl(SUPERNOVA.twoYear.url, "supernova-two-year"))}" target="_blank" rel="noopener">$39/mo · 2-year</a>
        <a class="btn small" href="${esc(buyUrl(SUPERNOVA.annual.url, "supernova-annual"))}" target="_blank" rel="noopener">$539/yr</a>
      </div></div></div>

    <div class="poster-row" id="store-satellite"><button class="poster-btn" data-action="tier-info" data-tier="satellite" aria-label="More about Satellite"><img src="/brand/poster-satellite.jpg" alt="Satellite poster, one Brain, one Face, one job duty"></button><div class="pr-txt"><b>Satellite</b><span class="desc">${esc(TIER_COPY.satellite.body)}</span><span class="desc">${esc(TIER_COPY.satellite.hours)}</span><span class="price">$99.00</span><span class="at">$101.97 at checkout</span>${buyButton(buyUrl(SATELLITE.url, "satellite"), "$101.97", allOwned || ownedProducts.includes("satellite"))}<p class="fine">Or pay monthly:</p><div class="row monthly-row">
        <a class="btn small" href="${esc(buyUrl(SATELLITE.monthly.url, "satellite-monthly"))}" target="_blank" rel="noopener">$33/mo</a>
        <a class="btn small" href="${esc(buyUrl(SATELLITE.twoYear.url, "satellite-two-year"))}" target="_blank" rel="noopener">$26/mo · 2-year</a>
        <a class="btn small" href="${esc(buyUrl(SATELLITE.annual.url, "satellite-annual"))}" target="_blank" rel="noopener">$363/yr</a>
      </div></div></div>

    <details class="store-group" id="store-photons" ${storeOpen.photons ? "open" : ""}>
      <summary><span class="summary-title">Meet the Photons</span><span class="fine">12 Supernovas · tap to hide</span></summary>
      <p class="page-lede">Each Photon is a Supernova on its own. Buy one and it drops into your app, ready to talk.</p>
      <div class="product-grid">${photonCards}</div>
    </details>

    <div class="card upkeep-card" id="store-upkeep"><button class="poster-btn upkeep-poster-btn" data-action="tier-info" data-tier="upkeep" aria-label="More about Upkeep"><img src="/brand/starburst.jpg" alt=""></button><div><h2>Upkeep</h2><p>${esc(UPKEEP_COPY.body)}</p><p class="price">$29.00/month <span class="fine">($29.87 at checkout)</span></p><div class="row">${buyButton(buyUrl(UPKEEP.url, "upkeep"), "$29.87", state?.upkeep === true)}<button class="btn small more-info" data-action="tier-info" data-tier="upkeep">More info</button></div></div></div>

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
    // No server unsubscribe route: drop the local subscription here; the
    // server drops dead ones on its own when a send bounces.
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch {
      // Already gone.
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

async function loadUpkeep() {
  if (upkeepLoading) return;
  upkeepLoading = true;
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
    upkeepLoading = false;
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
  const auth = (state as any)?.auth;
  if (!auth || !auth.signedIn) {
    return `<div class="card">
      <h2>Your account</h2>
      <p>You are not signed in. Your Photons, chats, and purchases live on this device only right now — sign in with Google and they follow you to any device, and they survive a new phone.</p>
      <p class="fine">Signing in creates your account, and it comes with two things: a story for your first Photon, and 15% off your first order for 10 days.</p>
      <div class="row"><button class="btn primary" data-action="signin">Sign in with Google</button></div>
      <p class="fine">We see only your name and email. Nothing else from your Google account is read or kept.</p>
    </div>`;
  }
  const perk = (state as any)?.perk;
  const prismStory = (state as any)?.backstories?.Prism;
  return `<div class="card">
    <h2>Your account</h2>
    <p>Signed in as <b>${esc(auth.name || auth.email || "")}</b>${auth.email && auth.name ? ` (${esc(auth.email)})` : ""}.</p>
    <p class="fine">Account since ${esc(fmtDateOnly(auth.since || ""))}. Your Photons, chats, and purchases follow this account to any device.</p>
    <div class="row"><button class="btn" data-action="signout">Sign out</button></div>
  </div>
  ${perk && perk.active ? `<div class="card perk-card">
    <h2>Your welcome offer — 15% off your first order</h2>
    <p>Your code is <b>${esc(perk.code)}</b>, good until ${esc(fmtDateOnly(perk.expiresAt))}. It is already filled in at checkout in the Store, so the discount is there when the page opens. One order only.</p>
    <div class="row"><button class="btn primary" data-action="goto" data-tab="store">Go to the Store</button></div>
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
    <p class="fine">Bigger text and stronger contrast, for older eyes. Saved on this device, and it follows you across Chat, Inboxes, the Store, and Upkeep.</p>
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

function renderUpkeep(): string {
  const ownedPhotons: string[] = state?.ownedPhotons || [];
  const ownedProducts: string[] = state?.ownedProducts || [];
  const ownedList =
    ownedPhotons.length || ownedProducts.length
      ? `<ul class="owned-list">${ownedPhotons.map((n) => `<li>${esc(n)} — Photon</li>`).join("")}${ownedProducts
          .map((s) => `<li>${esc(s)}</li>`)
          .join("")}</ul>`
      : `<p class="fine">Nothing owned yet. Buy in the Store, or redeem a code below.</p>`;
  return `
  <section>
    <h1 class="page-title">Upkeep</h1>
    <p class="page-lede">${esc(UPKEEP_COPY.body)}</p>

    ${accountCard()}

    ${readabilityCard()}

    <div class="card">
      <h2>Your chats</h2>
      <p class="meter-line">${esc(meterLine())}</p>
      ${meterBar()}
      <p class="fine">Every purchase includes 300 chats a month, free forever. No subscription needed.</p>
    </div>

    <div class="card">
      <h2>Redeem a code</h2>
      <p>Have a friends-and-family code? Enter it here and everything unlocks.</p>
      <form id="redeem-form" class="row">
        <input id="redeem-input" type="text" inputmode="numeric" autocomplete="off" placeholder="10-digit code" aria-label="Redeem code">
        <button class="btn primary" type="submit">Redeem</button>
      </form>
      <p id="redeem-msg" class="fine"></p>
    </div>

    <div class="card">
      <h2>What you own</h2>
      ${ownedList}
      <div class="row"><button class="btn primary" data-action="goto" data-tab="store">Go to the Store</button></div>
    </div>

    <div class="card upkeep-card">
      <img src="/brand/starburst.jpg" alt="">
      <div>
      <h2>Upkeep — $29 a month</h2>
      <ul class="included-list">${UPKEEP_COPY.included.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      ${
        state?.upkeep
          ? `<p><span class="owned-badge">Upkeep is on</span></p>`
          : `<a class="btn primary" href="${esc(buyUrl(UPKEEP.url, "upkeep"))}" target="_blank" rel="noopener">Buy Upkeep — $29.87</a>`
      }
      <p class="fine">Upkeep is never required to use what you bought.</p>
      <p class="fine">Questions about Upkeep or any price? Email <a href="mailto:prism5labscontact@gmail.com">prism5labscontact@gmail.com</a> or call <a href="tel:+19203937294">(920) 393-7294</a>.</p>
      </div>
    </div>

    ${renderProactive()}
  </section>`;
}

// ---------- Shell ----------
function renderNav() {
  const tabs: { id: Tab; label: string }[] = [
    { id: "chat", label: "Chat" },
    { id: "inboxes", label: "Inboxes" },
    { id: "store", label: "Store" },
    { id: "upkeep", label: "Upkeep" },
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

// The active Photon's look reskins the whole app, not just the thread:
// the look class rides on <body> so the header, nav, composer dock and
// every page follow the same skin, and picking a look matters like a
// reskin, not a few colors. Leaving the thread (or picking no look)
// clears the class, so the default gallery look returns. The thread
// section and the Photon card keep their own look classes too.
function syncBodyLook() {
  const p =
    tab === "chat" && activePhoton && !customizePhoton && !callPhotonName
      ? PHOTONS.find((x) => x.name === activePhoton)
      : null;
  const look = p ? lookSetById(customFor(p.name).lookSet || "") : null;
  for (const s of LOOK_SETS) document.body.classList.remove(`look-${s.id}`);
  if (look) document.body.classList.add(`look-${look.id}`);
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
const TAB_ORDER: Tab[] = ["chat", "inboxes", "store", "upkeep"];
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
  }, 220);
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
// in gently over 200ms instead of cutting in: the app reads as one
// coherent thing, not pieces stuck together. Same-view re-renders —
// data arriving, chat streaming — swap instantly, so nothing flickers
// while it works. The animation lives in styles.css (.view-enter) and
// is off under prefers-reduced-motion.
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
  else if (tab === "inboxes") v.innerHTML = renderInboxes();
  else if (tab === "store") v.innerHTML = renderStore();
  else v.innerHTML = renderUpkeep();
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
  // The chat input is never focused for the user: focusing it after
  // every render keeps the keyboard up and can scroll the messages
  // around. The owner taps it when they want to write.
}

async function refreshState() {
  const r = await api.state();
  if (r && r.ok) state = r;
}

async function loadInboxes() {
  // The first five calls are independent: fire them together instead
  // of queuing them one by one — the old serial chain was a big part
  // of why opening Inboxes felt claggy. The flag keeps the Email
  // section honest while they fly ("Checking your inbox…", not a
  // false "nothing connected yet").
  inboxesLoading = true;
  try {
    const [r, o, c, prof, mem] = await Promise.all([
      api.inboxes(),
      api.outlookInboxes(),
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
    }
  },
  true,
);

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
  const action = t.dataset.action;
  if (action === "goto") {
    tab = t.dataset.tab as Tab;
    activePhoton = null;
    customizePhoton = null;
    dayOpen = false;
    // A connect confirmation only lives on the Inboxes it belongs to,
    // and so does a connect failure.
    if (tab !== "inboxes") {
      justConnected = "";
      connectError = "";
    }
    // Ending a call leaves the thread; the call screen is chat-only.
    if (callPhotonName) endCall();
    if (tab === "inboxes") loadInboxes().then(render);
    if (tab === "upkeep") loadUpkeep().then(render);
    if (tab === "store") loadStripeStatus().then(render);
    render();
  } else if (action === "email-open") {
    // A summary row opens the whole message, one tap.
    openEmailMessage(
      t.dataset.provider === "outlook" ? "outlook" : "gmail",
      t.dataset.label || "",
      t.dataset.id || "",
      t,
    );
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
    loadInboxes().then(render);
  } else if (action === "end-call") {
    endCall();
  } else if (action === "signin") {
    // App sign-in with Google. The server redirects to Google and back;
    // the return lands on Upkeep with a one-time session token. Say so
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
  } else if (action === "landing-skip") {
    // First-run landing: continue into the app without an account.
    // The landing stays dismissed on this device from here on.
    dismissLanding();
  } else if (action === "signout") {
    // Sign-out is local only: drop this device's account id and start
    // a fresh anonymous one. Everything stays on the server, and
    // signing back in with the same Google account brings it all back.
    clearAccountId();
    await refreshState();
    render();
    toast("Signed out. This device has a fresh, unsigned-in account now.");
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
  } else if (action === "product-info") {
    openProductCard(t.dataset.slug || "", t);
  } else if (action === "tier-info") {
    openTierCard((t.dataset.tier as "supernova" | "satellite" | "upkeep") || "supernova", t);
  } else if (action === "card-close") {
    closeCard();
  } else if (action === "connect-open") {
    // The one generic connect button: asks what to connect, then starts
    // that sign-in. Any number of accounts, any supported type.
    openConnectChooser(t);
  } else if (action === "goto-messenger") {
    // The chooser's "Connect a Facebook Page": close the chooser and
    // jump to the Messenger section, where the Page token goes in.
    closeCard();
    tab = "inboxes";
    render();
    const el = document.getElementById("messenger");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
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
  } else if (action === "back-to-front") {
    activePhoton = null;
    customizePhoton = null;
    dayOpen = false;
    render();
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
    render();
    const box = document.querySelector(".drive-read");
    if (box) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } else if (action === "drive-close") {
    state.driveFileRead = null;
    render();
  } else if (action === "drive-clear") {
    driveQuery = "";
    state.driveFileRead = null;
    const r = await api.driveSearch();
    if (r && r.ok) state.driveFiles = r.files || [];
    render();
  } else if (action === "import-add") {
    // One tap per person: files the friend-request email for that
    // contact. The import itself sent nothing.
    const idx = parseInt(t.dataset.idx || "-1", 10);
    const entry = importedContacts[idx];
    if (!entry) return;
    const owned = (state?.ownedPhotons || []) as string[];
    const photon = owned[0] || "Prism";
    const r = await api.requestContact(photon, entry.name, entry.email, entry.phone || undefined);
    if (r && r.ok) {
      toast(`Connection request sent to ${entry.name}.`);
      importedContacts = importedContacts.filter((_, i) => i !== idx);
      await loadInboxes();
      render();
    } else if (r?.error === "already_requested") {
      toast("Request already sent — still waiting on their approval.");
      importedContacts = importedContacts.filter((_, i) => i !== idx);
      render();
    } else if (r?.error === "gmail_not_connected") {
      toast("Connect a Gmail account in Inboxes first.", "err");
    } else {
      toast("That request didn't send. Try again.", "err");
    }
  }
});

document.addEventListener("submit", async (e) => {
  const form = e.target as HTMLFormElement;
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
    const provider = form.dataset.provider === "outlook" ? "outlook" : "gmail";
    const to = String(fd.get("to") || "");
    const subject = String(fd.get("subject") || "");
    const body = String(fd.get("body") || "");
    const r =
      provider === "outlook"
        ? await api.outlookDraft(label, to, subject, body)
        : await api.saveDraft(label, to, subject, body);
    if (r && r.ok) {
      toast(provider === "outlook" ? "Draft saved to Outlook drafts." : "Draft saved to Gmail drafts.");
      form.reset();
    } else {
      toast("That draft didn't save. Check the account is connected.", "err");
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
    });
    if (r && r.ok) {
      profileData = r.profile || profileData;
      profileSaved = true;
      toast("Saved. Your Photons know you now.");
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
      await loadInboxes();
      render();
    } else if (r?.error === "already_requested") {
      toast("Request already sent — still waiting on their approval.");
    } else if (r?.error === "contact_declined") {
      toast("That contact was declined.", "err");
    } else if (r?.error === "gmail_not_connected") {
      toast("Connect a Gmail account in Inboxes first.", "err");
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
// The v4 opening film plays on every app open, then fades to the
// chat. The chat renders underneath while it plays, so nothing waits
// on it, and it never touches settings or the chosen Face — it is only
// a full-screen overlay that removes itself. Reduced motion skips it
// entirely (the CSS hides it too, so it never shows even before this
// runs). Tap skips it early: the owner never has to wait out the
// full 10s. If the v4 film fails to load, the v3 opening plays
// instead; if that fails too, the splash just goes away.
//
// First ever open reads "Welcome"; every open after that reads
// "Welcome back" — same film either way, the words are an overlay
// because the film itself carries no text. The coloring around the
// animation rotates through ten schemes, one per open, cycling in order: the
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
function playOpeningSplash(returning: boolean): void {
  const splash = document.getElementById("opening-splash");
  const video = document.getElementById("opening-splash-video") as HTMLVideoElement | null;
  const greeting = document.getElementById("opening-splash-greeting");
  if (!splash || !video) return;
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
    if (!splash.isConnected) return;
    splash.classList.add("is-fading");
    window.setTimeout(() => {
      splash.remove();
      maybeShowLanding();
    }, 800);
  };
  if (returning) {
    // Coming back from Google (a sign-in or a connect): the film
    // already played on the way out, and sitting through it again is
    // a dead pause before the thing the owner just did. The splash
    // stays as a static branded cover in the scheme color while the
    // app loads underneath — no video, no 10s wait — and init
    // dismisses it fast the moment the first render lands.
    splash.addEventListener("click", dismiss, { once: true });
    return;
  }
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    splash.remove();
    maybeShowLanding();
    return;
  }
  splash.addEventListener("click", dismiss, { once: true });
  video.addEventListener("ended", dismiss, { once: true });
  // If the v5 film fails to load or play, fall back to the v3 opening
  // instead of a black screen. If that fails too, dismiss — the chat
  // is already rendered underneath.
  let fellBack = false;
  const tryV3Fallback = () => {
    if (fellBack) {
      dismiss();
      return;
    }
    fellBack = true;
    video.src = "/opening-animation-v3.mp4";
    video.load();
    const q = video.play();
    if (q) q.catch(() => dismiss());
  };
  video.addEventListener("error", tryV3Fallback);
  // Fallback: if the ended event never fires, do not trap the owner
  // behind the splash. The film is 10s, so the cutoff sits past it.
  window.setTimeout(dismiss, 13000);
  // Stall watchdog: play() can resolve while no frames ever arrive
  // (a slow connection, a stuck range request) — and a stall fires no
  // error event, so nothing above rescues it until the 13s backstop.
  // If the film has not advanced past the first frames a few seconds
  // in, fall back to the v3 film instead of sitting on a black splash.
  window.setTimeout(() => {
    if (!splash.isConnected) return;
    if (video.ended) return;
    if (video.currentTime < 0.5 && video.readyState < 3) tryV3Fallback();
  }, 5000);
  const p = video.play();
  if (p) p.catch(() => tryV3Fallback());
  // If the video already finished before this ran, dismiss now.
  if (video.ended) dismiss();
}

// The fast dismiss for an OAuth return: the static cover goes away in
// 200ms once the first render has landed, instead of the film's 800ms
// fade after a 10s play. The landing check runs after, as usual.
function dismissSplashFast(): void {
  const splash = document.getElementById("opening-splash");
  if (!splash || !splash.isConnected) return;
  splash.classList.add("is-fading-fast");
  splash.classList.add("is-fading");
  window.setTimeout(() => {
    splash.remove();
    maybeShowLanding();
  }, 250);
}

// ---------- First-run landing ----------
// Shown once, after the opening film, only when the account has never
// signed in and the owner has never dismissed it. It exists so the
// account benefits are offered up front instead of hiding at the
// bottom of Upkeep: the sign-in is the same Google flow as the
// Upkeep card (same endpoint, same return), and skipping is always
// possible — nothing here forces an account.
const LANDING_DISMISSED_KEY = "prism.landingDismissed";
let landingShown = false;
// Set once in init on a connect return (gmail/google/outlook
// connected): the owner just finished a task, and the first-run pitch
// landing over the inbox they just connected would be jarring. Only
// this boot is suppressed — a later fresh open can still show it.
let suppressLandingOnce = false;
function landingDismissed(): boolean {
  try {
    return localStorage.getItem(LANDING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}
function maybeShowLanding(): void {
  if (landingShown) return;
  if (suppressLandingOnce) return;
  // State is not loaded yet (the reduced-motion path dismisses the
  // film before refreshState finishes): init calls this again after
  // render, so returning here loses nothing.
  if (!state || (state as any)?.auth?.signedIn) return;
  if (landingDismissed()) return;
  // The film is still playing: its dismiss calls this again when it
  // goes away, so the landing never covers the film.
  if (document.getElementById("opening-splash")?.isConnected) return;
  landingShown = true;
  const el = document.createElement("div");
  el.id = "landing";
  el.className = "landing";
  el.innerHTML = `<div class="landing-card">
    <img class="landing-mark" src="/brand/gem.jpg" alt="">
    <h1>Prism 5</h1>
    <p class="landing-lede">One assistant that does it all, and becomes a second you.</p>
    <ul class="landing-benefits">
      <li>A backstory for every Photon, written with your name.</li>
      <li>15% off your first order, revealed once you sign up.</li>
      <li>Signing up also signs you up for the newsletter, with exclusive rotating offers of merch and more.</li>
      <li>Your Photons, chats, and purchases follow you to any device.</li>
      <li>Restore purchases anywhere, just by signing back in.</li>
    </ul>
    <button class="btn primary landing-signin" data-action="signin">Sign in or create account with Google</button>
    <p class="fine">Signing in with Google creates your account. No password, no form — we see only your name and email.</p>
    <button class="landing-skip" data-action="landing-skip">Continue without signing in</button>
  </div>`;
  document.body.appendChild(el);
}
function hideLanding(): void {
  document.getElementById("landing")?.remove();
}
function dismissLanding(): void {
  try {
    localStorage.setItem(LANDING_DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable: the landing still goes away for this open.
  }
  hideLanding();
}

// ---------- Boot ----------
(async function init() {
  const params = new URLSearchParams(location.search);
  // A return from Google (app sign-in or any connect) skips the film:
  // it already played on the way out, and sitting through it again is
  // a dead pause before the thing the owner just did. The splash stays
  // as a static cover until the first render lands, then goes away
  // fast (dismissSplashFast, below).
  const returning =
    params.has("signin") || params.has("gmail") || params.has("google") || params.has("outlook");
  playOpeningSplash(returning);
  setupKeyboardDock();
  const t = params.get("tab");
  if (t === "inboxes" || t === "store" || t === "upkeep" || t === "chat") tab = t as Tab;
  // The connect-return flags are set here, before the first render, so
  // the confirmation banner (or the plain-word error with its retry)
  // is already in the Inboxes the owner lands on — not painted in
  // after the fact.
  const gmailParam = params.get("gmail");
  const googleParam = params.get("google");
  const outlookParam = params.get("outlook");
  if (gmailParam === "connected") {
    justConnected = "gmail";
    suppressLandingOnce = true;
  } else if (gmailParam === "error") {
    connectError = "Gmail sign-in didn't finish. Try again.";
  }
  if (googleParam === "connected") {
    justConnected = "google";
    suppressLandingOnce = true;
  } else if (googleParam === "error") {
    connectError = "Calendar and Drive sign-in didn't finish. Try again.";
  }
  if (outlookParam === "connected") {
    justConnected = "outlook";
    suppressLandingOnce = true;
  } else if (outlookParam === "error") {
    connectError = "Outlook sign-in didn't finish. Try again.";
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
      // The landing must not sit over a freshly signed-in account:
      // the film is still playing on the way back from Google, so the
      // landing cannot have shown yet, but if it did, take it down.
      hideLanding();
    } else {
      signinResult = "error";
    }
    history.replaceState(null, "", "/?tab=upkeep");
  } else if (signin === "error") {
    signinResult = "error";
    history.replaceState(null, "", "/?tab=upkeep");
  }
  if (!state) await refreshState();
  if (tab === "inboxes") await loadInboxes();
  if (tab === "upkeep") await loadUpkeep();
  if (tab === "store") await loadStripeStatus();
  render();
  if (returning) dismissSplashFast();
  maybeShowLanding();
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
  if ((gmailParam || googleParam || outlookParam) && tab === "inboxes") {
    history.replaceState(null, "", "/?tab=inboxes");
  }
  // A failed connect drops back on Inboxes with the chooser reopened,
  // so the retry is one tap instead of a hunt for the button. The
  // failure notice rides inside the chooser: the toast sits behind the
  // modal (lower z-index) and cannot be seen while it is open. The
  // landing sits above the chooser when it shows, so it stays shut
  // then — its own sign-in button is the way forward there, and the
  // toast carries the message instead.
  const connectErrorNotice =
    gmail === "error"
      ? "Gmail sign-in didn't finish. Try again."
      : google === "error"
        ? "Calendar and Drive sign-in didn't finish. Try again."
        : outlook === "error"
          ? "Outlook sign-in didn't finish. Try again."
          : "";
  if (connectErrorNotice && !document.getElementById("landing")) {
    openConnectChooser(null, connectErrorNotice);
  }
  if (signinResult === "new") {
    toast(
      `Account created — welcome to Prism 5${signinName ? ", " + signinName : ""}. Your welcome offer and Prism's story are in Upkeep.`,
    );
  } else if (signinResult === "back") {
    toast(`Signed in — welcome back${signinName ? ", " + signinName : ""}.`);
  } else if (signinResult === "error") {
    toast("Sign-in didn't finish. Try again.", "err");
  }
  if (state && !state.brain) {
    // The brain is off until a key is set; the app still works.
    console.info("Brain not connected: set ANTHROPIC_API_KEY to turn chat on.");
  }
})();
