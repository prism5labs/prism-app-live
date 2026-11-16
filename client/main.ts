// Prism 5 — standalone client. Four tabs: Chat, Inboxes, Store, Upkeep.
// No provider or model names appear anywhere in the visible copy.

import { api, getAccountId } from "./api";
import { portraitHtml } from "./ui";
import { SUPERNOVA, SATELLITE, UPKEEP, PRODUCTS, CATEGORIES, photonBuyUrl } from "../src/shared/catalog";
import { TIER_COPY, UPKEEP_COPY } from "../src/shared/tiers";
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
      <span class="round-portrait-wrap">${portraitHtml("Prism", 104)}</span>
    </div>
    <div class="front-body">
      <h3 class="greeting">Howdy, <span class="greeting-accent">neighbor!</span></h3>
      <p class="tagline">Truly Atomic AI Assistants</p>
      <p class="front-lede">One assistant that does it all, and becomes a second you. Pick a Photon and start talking.</p>
    </div>
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

// ---------- Chat thread ----------
function renderChatThread(): string {
  const p = PHOTONS.find((x) => x.name === activePhoton);
  if (!p) return renderChatFront();
  const face = faceNameOf(p);
  const portrait = portraitNameOf(p);
  const customized = !!(state as any)?.customizations?.[p.name];
  // The owner's chosen look set reskins this Photon's whole chat.
  // The class lives only on this section, so leaving the thread
  // restores the default look with no cleanup.
  const look = lookSetById(customFor(p.name).lookSet || "");
  // A streaming reply shows three dots until the first words land.
  const botMsg = (text: string, streaming = false) =>
    `<div class="msg bot${streaming ? " streaming" : ""}">${portraitHtml(portrait, 26)}<div><p>${text ? esc(text) : '<span class="typing"><span></span><span></span><span></span></span>'}</p></div></div>`;
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
    // saved into the thread.
    : botMsg(p.intro.replaceAll("{name}", face));
  return `
  <section class="thread${look ? ` look-${look.id}` : ""}">
    <div class="thread-head">
      <button class="back-btn" data-action="back-to-front">← <span>All Photons</span></button>
      ${portraitHtml(portrait, 38)}
      <div class="thread-title">
        <h2>${esc(face)}</h2>
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
    <p>This is how ${esc(face)} talks in chat. The house voice is the default. Live voice calls are an Upkeep extra, and the call line itself is still being built.</p>
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

async function sendChat(text: string) {
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
    return;
  }
  if (gotText) {
    // A partial reply is better than none: show what arrived, plus why it stopped.
    threadMessages = [...threadMessages, { role: "assistant", content: gotText }];
    render();
    showChatError(streamErr?.message || "The reply stopped partway. Try that again in a moment.");
    scrollMessages();
    return;
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
      return;
    }
    threadMessages = threadMessages.slice(0, -1);
    render();
    showChatError(r?.message || "Something went wrong. Try that again in a moment.");
    return;
  }
  // The brain answered with an error and nothing arrived. The message was
  // not saved and the meter was not touched. Show why.
  threadMessages = threadMessages.slice(0, -1);
  render();
  showChatError(streamErr?.message || "Something went wrong. Try that again in a moment.");
}

async function callPhoton(name: string) {
  const r = await api.voice(name);
  if (r && r.ok) {
    toast(r.message || "Live voice isn't wired up yet.", "ok");
  } else {
    toast(r?.message || "Voice isn't available right now.", "err");
    if (r?.error === "needs_upkeep") {
      tab = "upkeep";
      render();
    }
  }
}

// ---------- Inboxes ----------
// Switchboard contacts: who this owner's Photons may email. A contact
// starts pending and the recipient approves or declines by tapping a link
// in the request email, like a friend request. Only approved contacts
// receive sends.
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
    `<div class="inbox-msg"><p class="inbox-subject">${esc(c.name || c.address)}</p><p class="inbox-meta">${esc(c.address)} · ${esc(c.photon)} · ${statusWord(c.status)}</p></div>`;
  const owned = (state?.ownedPhotons || []) as string[];
  const photonOpts = (owned.length ? owned : ["Prism"])
    .map((n: string) => `<option value="${esc(n)}">${esc(n)}</option>`)
    .join("");
  return `<div class="card">
    <h3>Switchboard contacts</h3>
    <p class="fine">Switchboard is email. A Photon can only send to a contact who approved the connection first, like a friend request.</p>
    ${prism ? row(prism) : `<p class="fine">Prism 5 (prism5labstest@gmail.com) — no connection yet. Ask a Photon to write a report, then tap Report to Prism 5 in chat.</p>`}
    ${others.map(row).join("")}
    <form class="contact-form">
      <h4>Request a connection</h4>
      <input name="name" type="text" placeholder="Name" required>
      <input name="address" type="email" placeholder="Email address" required>
      <select name="photon" aria-label="Photon">${photonOpts}</select>
      <button class="btn primary" type="submit">Send connection request</button>
    </form>
  </div>`;
}

function renderInboxes(): string {
  const accounts = (state?.inboxAccounts || []) as any[];
  const configured = state?.googleConfigured;
  const cards = (["personal", "contact", "test"] as const)
    .map((label) => {
      const acct = accounts.find((a: any) => a.label === label);
      const title = label === "personal" ? "Personal" : label === "contact" ? "Labs contact" : "Labs test";
      if (!acct || !acct.connected) {
        return `<div class="card inbox-card">
          <h3>${title}</h3>
          <p>${configured ? "Not connected yet." : "Gmail sign-in isn't set up on this server yet."}</p>
          ${configured ? `<a class="btn primary" href="/api/oauth/google/start?accountId=${encodeURIComponent(
            getAccountId(),
          )}&label=${label}">Connect ${title}</a>` : ""}
        </div>`;
      }
      const msgs = (acct.messages || [])
        .map(
          (m: any) => `<div class="inbox-msg">
            <p class="inbox-subject">${esc(m.subject || "(no subject)")}</p>
            <p class="inbox-meta">${esc(m.from || "")} · ${esc(m.date || "")}</p>
            <p class="inbox-snippet">${esc(m.snippet || "")}</p>
          </div>`,
        )
        .join("");
      return `<div class="card inbox-card">
        <h3>${title}</h3>
        <p class="fine">${esc(acct.email || "")}</p>
        ${msgs || `<p class="fine">Nothing in the inbox right now.</p>`}
        <form class="draft-form" data-label="${label}">
          <h4>Save a draft</h4>
          <input name="to" type="text" placeholder="To" required>
          <input name="subject" type="text" placeholder="Subject">
          <textarea name="body" rows="3" placeholder="Write the draft…" required></textarea>
          <button class="btn primary" type="submit">Save draft</button>
        </form>
      </div>`;
    })
    .join("");
  return `
  <section>
    <h1 class="page-title">Inboxes</h1>
    <p class="page-lede">Your three Gmail accounts, side by side. Drafts you save here land in that account's Gmail drafts.</p>
    <div class="switchboard-strip"><img src="/brand/switchboard.jpg" alt=""><p><b>On Switchboard.</b> Inboxes is where Switchboard lives — every Launch in the Lab, one board.</p></div>
    ${renderSwitchboardContacts()}
    ${state?.inboxError ? `<p class="chat-error">${esc(state.inboxError)}</p>` : ""}
    <div class="inbox-grid">${cards}</div>
  </section>`;
}

// ---------- Store ----------
function buyButton(url: string, label: string, owned: boolean): string {
  if (owned) return `<span class="owned-badge">Owned — yours already</span>`;
  return `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">Buy — ${esc(label)}</a>`;
}

function productCard(p: (typeof PRODUCTS)[number]): string {
  const v = storeVariant === "personal" ? p.personal : p.business;
  const owned = state?.freeCode === true || (state?.ownedProducts || []).includes(p.slug);
  return `<div class="card product-card">
    <h3>${esc(p.name)}</h3>
    <p class="kind">${esc(p.kind)}</p>
    <p>${esc(p.description)}</p>
    <p class="price">${esc(v.price)} <span class="fine">(${esc(v.total)} at checkout)</span></p>
    ${buyButton(v.url + "?client_reference_id=" + p.slug + "-" + storeVariant, v.total, owned)}
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
      ${portraitHtml(p.name, 220)}
      <h3 class="photon-name">${esc(p.name)}</h3>
      <p>${esc(p.tagline)}</p>
      <p class="fine">${esc(p.focus)} And so much more.</p>
      <p class="price">$499.00 <span class="fine">($514.00 at checkout)</span></p>
      ${buyButton(photonBuyUrl(p.name), "$514.00", owned)}
    </div>`;
  }).join("");

  const sparkCount = PRODUCTS.filter((p) => p.kind === "Spark").length;
  const plugCount = PRODUCTS.filter((p) => p.kind === "Plug").length;

  return `
  <section>
    <div class="store-head"><img src="/brand/starburst.jpg" alt=""><div><h1 class="page-title">Store</h1><p>Buy a Launch once and it is yours forever. Checkout shows the full total, including the standard 3% processing fee.</p></div></div>
    <div class="chrome-thin"></div>

    <div class="store-jump" aria-label="Jump to a section">
      <a href="#store-supernova">Supernova</a>
      <a href="#store-satellite">Satellite</a>
      <a href="#store-photons">Photons</a>
      <a href="#store-upkeep">Upkeep</a>
      <a href="#store-sparks-plugs">Sparks &amp; Plugs</a>
    </div>

    <h2 class="section-title">Launches</h2>
    <div class="poster-row" id="store-supernova"><img src="/brand/poster-supernova.jpg" alt="Supernova poster — $499 one-time, the whole front office"><div class="pr-txt"><b>Supernova</b><span class="desc">${esc(TIER_COPY.supernova.body)}</span><span class="desc">${esc(TIER_COPY.supernova.hours)}</span><span class="price">$499.00</span><span class="at">$514.00 at checkout</span>${buyButton(SUPERNOVA.url, "$514.00", allOwned || ownedProducts.includes("supernova"))}<p class="fine">Or pay monthly:</p><div class="row monthly-row">
        <a class="btn small" href="${esc(SUPERNOVA.monthly.url)}" target="_blank" rel="noopener">$49/mo</a>
        <a class="btn small" href="${esc(SUPERNOVA.twoYear.url)}" target="_blank" rel="noopener">$39/mo · 2-year</a>
        <a class="btn small" href="${esc(SUPERNOVA.annual.url)}" target="_blank" rel="noopener">$539/yr</a>
      </div></div></div>

    <div class="poster-row" id="store-satellite"><img src="/brand/poster-satellite.jpg" alt="Satellite poster — $99 one-time, one Brain, one Face, one job duty"><div class="pr-txt"><b>Satellite</b><span class="desc">${esc(TIER_COPY.satellite.body)}</span><span class="desc">${esc(TIER_COPY.satellite.hours)}</span><span class="price">$99.00</span><span class="at">$101.97 at checkout</span>${buyButton(SATELLITE.url, "$101.97", allOwned || ownedProducts.includes("satellite"))}<p class="fine">Or pay monthly:</p><div class="row monthly-row">
        <a class="btn small" href="${esc(SATELLITE.monthly.url)}" target="_blank" rel="noopener">$33/mo</a>
        <a class="btn small" href="${esc(SATELLITE.twoYear.url)}" target="_blank" rel="noopener">$26/mo · 2-year</a>
        <a class="btn small" href="${esc(SATELLITE.annual.url)}" target="_blank" rel="noopener">$363/yr</a>
      </div></div></div>

    <details class="store-group" id="store-photons" ${storeOpen.photons ? "open" : ""}>
      <summary><span class="summary-title">Meet the Photons</span><span class="fine">12 Supernovas · tap to hide</span></summary>
      <p class="page-lede">Each Photon is a Supernova on its own. Buy one and it drops into your app, ready to talk.</p>
      <div class="product-grid">${photonCards}</div>
    </details>

    <div class="card upkeep-card" id="store-upkeep"><img src="/brand/starburst.jpg" alt=""><div><h2>Upkeep</h2><p>${esc(UPKEEP_COPY.body)}</p><p class="price">$29.00/month <span class="fine">($29.87 at checkout)</span></p><div class="row">${buyButton(UPKEEP.url, "$29.87", state?.upkeep === true)}</div></div></div>

    <h2 class="section-title" id="store-sparks-plugs">Sparks &amp; Plugs</h2>
    <p class="page-lede">One job each. A Spark is a single button for one job, push it and it does the thing. A Plug is a Spark that runs on its own.</p>
    <div class="toggle" role="group" aria-label="Personal or Business">
      <button class="toggle-btn ${variant === "personal" ? "active" : ""}" data-action="variant" data-variant="personal">Personal</button>
      <button class="toggle-btn ${variant === "business" ? "active" : ""}" data-action="variant" data-variant="business">Business</button>
    </div>
    <details class="store-group" id="store-sparks" ${storeOpen.sparks ? "open" : ""}>
      <summary><span class="summary-title">Sparks</span><span class="fine">${sparkCount} · one button, one job · tap to browse</span></summary>
      <p class="page-lede">${esc(TIER_COPY.spark.body)} ${esc(TIER_COPY.spark.hours)}</p>
      <div class="addon-row featured"><div><b>Personality Builder</b><span>Spark · Personal $19 · Business $25</span><span class="pb-desc">The extra attribute that builds a personality for your interface — for a Spark or Plug that doesn't come with one.</span></div><div class="price">$19–$25</div></div>
      ${kindGroups("Spark")}
    </details>
    <details class="store-group" id="store-plugs" ${storeOpen.plugs ? "open" : ""}>
      <summary><span class="summary-title">Plugs</span><span class="fine">${plugCount} · runs on its own · tap to browse</span></summary>
      <p class="page-lede">${esc(TIER_COPY.plug.body)} ${esc(TIER_COPY.plug.hours)}</p>
      ${kindGroups("Plug")}
    </details>
    <div class="store-foot">Let us handle the noise so you can focus on what you want and need to do.<br>© 2026 Prism 5 Labs · Green Bay, Wisconsin</div>
  </section>`;
}

// ---------- Upkeep ----------
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
          : `<a class="btn primary" href="${esc(UPKEEP.url)}" target="_blank" rel="noopener">Buy Upkeep — $29.87</a>`
      }
      <p class="fine">Upkeep is never required to use what you bought.</p>
      </div>
    </div>
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

function render() {
  renderNav();
  const v = view();
  if (tab === "chat") v.innerHTML = customizePhoton ? renderCustomize() : activePhoton ? renderChatThread() : renderChatFront();
  else if (tab === "inboxes") v.innerHTML = renderInboxes();
  else if (tab === "store") v.innerHTML = renderStore();
  else v.innerHTML = renderUpkeep();
  // The chat input is never focused for the user: focusing it after
  // every render keeps the keyboard up and can scroll the messages
  // around. The owner taps it when they want to write.
}

async function refreshState() {
  const r = await api.state();
  if (r && r.ok) state = r;
}

async function loadInboxes() {
  const r = await api.inboxes();
  if (r && r.ok) {
    state.inboxAccounts = r.accounts;
    state.googleConfigured = r.googleConfigured;
  }
  const c = await api.contacts();
  if (c && c.ok) state.contacts = c.contacts || [];
}

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

document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!t) return;
  const action = t.dataset.action;
  if (action === "goto") {
    tab = t.dataset.tab as Tab;
    activePhoton = null;
    customizePhoton = null;
    if (tab === "inboxes") loadInboxes().then(render);
    render();
  } else if (action === "open-photon") {
    const name = t.dataset.photon || "";
    if (name) openPhoton(name);
  } else if (action === "back-to-front") {
    activePhoton = null;
    customizePhoton = null;
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
  } else if (form.classList.contains("draft-form")) {
    e.preventDefault();
    const fd = new FormData(form);
    const label = form.dataset.label || "";
    const to = String(fd.get("to") || "");
    const subject = String(fd.get("subject") || "");
    const body = String(fd.get("body") || "");
    const r = await api.saveDraft(label, to, subject, body);
    if (r && r.ok) {
      toast("Draft saved to Gmail drafts.");
      form.reset();
    } else {
      toast("That draft didn't save. Check the account is connected.", "err");
    }
  } else if (form.classList.contains("contact-form")) {
    e.preventDefault();
    const fd = new FormData(form);
    const name = String(fd.get("name") || "");
    const address = String(fd.get("address") || "");
    const photon = String(fd.get("photon") || "Prism");
    const r = await api.requestContact(photon, name, address);
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

// ---------- Keyboard-aware composer dock ----------
// When the on-screen keyboard opens, the visual viewport shrinks but the
// layout viewport does not (iOS Safari and older Android). Measure the gap
// and lift the fixed composer dock above the keyboard. Android Chrome with
// interactive-widget=resizes-content resizes the layout viewport instead,
// in which case the gap is ~0 and nothing changes.
function setupKeyboardDock(): void {
  const vv = window.visualViewport;
  if (vv) {
    const update = () => {
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty("--kb", kb + "px");
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
  }
  document.addEventListener("focusin", (e) => {
    if ((e.target as HTMLElement)?.id === "chat-input") {
      window.setTimeout(() => {
        document.getElementById("messages")?.scrollTo({ top: 999999, behavior: "smooth" });
      }, 350);
    }
  });
}

// ---------- Boot ----------
(async function init() {
  setupKeyboardDock();
  const params = new URLSearchParams(location.search);
  const t = params.get("tab");
  if (t === "inboxes" || t === "store" || t === "upkeep" || t === "chat") tab = t as Tab;
  await refreshState();
  if (tab === "inboxes") await loadInboxes();
  render();
  const gmail = params.get("gmail");
  if (gmail === "connected") toast("Gmail account connected.");
  if (gmail === "error") toast("Gmail sign-in didn't finish. Try again.", "err");
  if (state && !state.brain) {
    // The brain is off until a key is set; the app still works.
    console.info("Brain not connected: set ANTHROPIC_API_KEY to turn chat on.");
  }
})();
