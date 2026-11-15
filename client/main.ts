// Prism 5 — standalone client. Four tabs: Chat, Inboxes, Store, Upkeep.
// No provider or model names appear anywhere in the visible copy.

import { api, getAccountId } from "./api";
import { logoHtml, portraitHtml } from "./ui";
import { SUPERNOVA, SATELLITE, UPKEEP, PRODUCTS, CATEGORIES, photonBuyUrl } from "../src/shared/catalog";
import { TIER_COPY, UPKEEP_COPY } from "../src/shared/tiers";
import { PHOTONS } from "../src/shared/photons";

type Tab = "chat" | "inboxes" | "store" | "upkeep";

let state: any = null;
let tab: Tab = "chat";
let activePhoton: string | null = null;
let storeVariant: "personal" | "business" = "personal";
let threadMessages: any[] = [];
let threadLoading = false;
let toastTimer: number | null = null;

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

function photonCard(p: any, size = 72): string {
  const owned = p.owned;
  return `<button class="photon-card" data-action="open-photon" data-photon="${esc(p.name)}" ${
    owned ? "" : "disabled"
  }>
    ${portraitHtml(p.name, size)}
    <span class="photon-name">${esc(p.name)}</span>
    <span class="photon-tag">${esc(p.tagline)}</span>
  </button>`;
}

// ---------- Chat front page ----------
function renderChatFront(): string {
  const owned = (state?.photons || []).filter((p: any) => p.owned);
  const displayName = state?.displayName || "Prism 5";
  const customName = state?.customName || "";
  const ownedHtml =
    owned.length > 0
      ? `<div class="photon-grid">${owned.map((p: any) => photonCard(p)).join("")}</div>`
      : `<div class="empty-panel">
          <p class="empty-title">Your counter's empty.</p>
          <p>You don't own any Photons yet. Buy one in the Store, or redeem a code below.</p>
          <div class="row">
            <button class="btn primary" data-action="goto" data-tab="store">Visit the Store</button>
            <button class="btn" data-action="goto" data-tab="upkeep">Redeem a code</button>
          </div>
        </div>`;
  return `
  <section class="front">
    <div class="logo-plate">${logoHtml(84)}</div>
    <h1 class="app-name">${esc(displayName)}</h1>
    <p class="app-sub">Prism 5 Labs</p>
    <p class="greeting">Howdy, neighbor!</p>
    <p class="front-lede">One assistant that does it all, and becomes a second you. Pick a Photon and start talking.</p>
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
    <p class="fine">${esc(meterLine())}. Upkeep is $29 a month for unlimited chat, updates, priority support, and live voice calls.</p>
  </section>`;
}

// ---------- Chat thread ----------
function renderChatThread(): string {
  const p = PHOTONS.find((x) => x.name === activePhoton);
  if (!p) return renderChatFront();
  const msgs = threadMessages.length
    ? threadMessages
        .map(
          (m: any) =>
            `<div class="bubble ${m.role === "user" ? "mine" : "theirs"}"><p>${esc(m.content)}</p></div>`,
        )
        .join("")
    : `<div class="bubble theirs"><p>Howdy, neighbor! ${esc(p.name)} is on the line. Ask a real question, or start with what you need.</p></div>`;
  return `
  <section class="thread">
    <div class="thread-head">
      <button class="btn small" data-action="back-to-front">← All Photons</button>
      ${portraitHtml(p.name, 56)}
      <div class="thread-title">
        <h2>${esc(p.name)}</h2>
        <p>${esc(p.focus)}</p>
      </div>
      <button class="btn small call" data-action="call" data-photon="${esc(p.name)}">Call · Upkeep</button>
    </div>
    <div class="messages" id="messages">${msgs}</div>
    <div id="chat-error" class="chat-error" hidden></div>
    <form id="chat-form" class="composer">
      <input id="chat-input" type="text" placeholder="Ask ${esc(p.name)} anything…" autocomplete="off" aria-label="Message">
      <button class="btn primary" type="submit">Send</button>
    </form>
    <p class="fine">${esc(meterLine())}</p>
  </section>`;
}

async function openPhoton(name: string) {
  activePhoton = name;
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

async function sendChat(text: string) {
  const input = document.getElementById("chat-input") as HTMLInputElement | null;
  if (input) input.value = "";
  const err = document.getElementById("chat-error") as HTMLElement | null;
  if (err) err.hidden = true;
  // Optimistic: show the user's message right away.
  threadMessages = [...threadMessages, { role: "user", content: text }];
  render();
  scrollMessages();
  const r = await api.chat(activePhoton || "", text);
  if (r && r.ok) {
    threadMessages = [...threadMessages, { role: "assistant", content: r.reply }];
    if (r.meter && state) state.meter = r.meter;
    render();
    scrollMessages();
  } else {
    // The message was not saved and the meter was not touched. Show why.
    threadMessages = threadMessages.slice(0, -1);
    render();
    showChatError(r?.message || "Something went wrong. Try that again in a moment.");
  }
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
    ${state?.inboxError ? `<p class="chat-error">${esc(state.inboxError)}</p>` : ""}
    <div class="inbox-grid">${cards}</div>
  </section>`;
}

// ---------- Store ----------
function buyButton(url: string, label: string, owned: boolean): string {
  if (owned) return `<span class="owned-badge">Owned — yours already</span>`;
  return `<a class="btn primary" href="${esc(url)}" target="_blank" rel="noopener">Buy — ${esc(label)}</a>`;
}

function renderStore(): string {
  const ownedProducts: string[] = state?.ownedProducts || [];
  const ownedPhotons: string[] = state?.ownedPhotons || [];
  const allOwned = state?.freeCode === true;
  const variant = storeVariant;
  const photonCards = PHOTONS.map((p) => {
    const owned = allOwned || ownedPhotons.includes(p.name);
    return `<div class="card product-card photon-store">
      ${portraitHtml(p.name, 64)}
      <h3>${esc(p.name)}</h3>
      <p>${esc(p.tagline)}</p>
      <p class="fine">${esc(p.focus)} And so much more.</p>
      <p class="price">$499.00 <span class="fine">($514.00 at checkout)</span></p>
      ${buyButton(photonBuyUrl(p.name), "$514.00", owned)}
    </div>`;
  }).join("");

  const groups = CATEGORIES.map(
    (cat) => `<h2 class="section-title">${esc(cat)}</h2><div class="product-grid">${PRODUCTS.filter(
      (p) => p.category === cat,
    )
      .map((p) => {
        const v = variant === "personal" ? p.personal : p.business;
        const owned = allOwned || ownedProducts.includes(p.slug);
        return `<div class="card product-card">
          <h3>${esc(p.name)}</h3>
          <p class="kind">${esc(p.kind)}</p>
          <p>${esc(p.description)}</p>
          <p class="price">${esc(v.price)} <span class="fine">(${esc(v.total)} at checkout)</span></p>
          ${buyButton(v.url + "?client_reference_id=" + p.slug + "-" + variant, v.total, owned)}
        </div>`;
      })
      .join("")}</div>`,
  ).join("");

  return `
  <section>
    <h1 class="page-title">Store</h1>
    <p class="page-lede">Buy a Launch once and it is yours forever. Checkout shows the full total, including the standard 3% processing fee.</p>

    <div class="card tier-card">
      <h2>Supernova</h2>
      <p>${esc(TIER_COPY.supernova.body)}</p>
      <p class="fine">${esc(TIER_COPY.supernova.hours)}</p>
      <p class="price">$499.00 <span class="fine">($514.00 at checkout)</span></p>
      <div class="row">${buyButton(SUPERNOVA.url, "$514.00", allOwned || ownedProducts.includes("supernova"))}</div>
      <p class="fine">Or pay monthly:</p>
      <div class="row">
        <a class="btn" href="${esc(SUPERNOVA.monthly.url)}" target="_blank" rel="noopener">$49/mo</a>
        <a class="btn" href="${esc(SUPERNOVA.twoYear.url)}" target="_blank" rel="noopener">$39/mo · 2-year</a>
        <a class="btn" href="${esc(SUPERNOVA.annual.url)}" target="_blank" rel="noopener">$539/yr</a>
      </div>
    </div>

    <div class="card tier-card">
      <h2>Satellite</h2>
      <p>${esc(TIER_COPY.satellite.body)}</p>
      <p class="fine">${esc(TIER_COPY.satellite.hours)}</p>
      <p class="price">$99.00 <span class="fine">($101.97 at checkout)</span></p>
      <div class="row">${buyButton(SATELLITE.url, "$101.97", allOwned || ownedProducts.includes("satellite"))}</div>
      <p class="fine">Or pay monthly:</p>
      <div class="row">
        <a class="btn" href="${esc(SATELLITE.monthly.url)}" target="_blank" rel="noopener">$33/mo</a>
        <a class="btn" href="${esc(SATELLITE.twoYear.url)}" target="_blank" rel="noopener">$26/mo · 2-year</a>
        <a class="btn" href="${esc(SATELLITE.annual.url)}" target="_blank" rel="noopener">$363/yr</a>
      </div>
    </div>

    <h2 class="section-title">Meet the Photons</h2>
    <p class="page-lede">Each Photon is a Supernova on its own. Buy one and it drops into your app, ready to talk.</p>
    <div class="product-grid">${photonCards}</div>

    <div class="card tier-card">
      <h2>Upkeep</h2>
      <p>${esc(UPKEEP_COPY.body)}</p>
      <p class="price">$29.00/month <span class="fine">($29.87 at checkout)</span></p>
      <div class="row">${buyButton(UPKEEP.url, "$29.87", state?.upkeep === true)}</div>
    </div>

    <h2 class="section-title">Sparks &amp; Plugs</h2>
    <p class="page-lede">One job each. A Spark is a single button for one job, push it and it does the thing. A Plug is a Spark that runs on its own. ${esc(TIER_COPY.spark.body)} ${esc(TIER_COPY.plug.body)}</p>
    <div class="toggle" role="group" aria-label="Personal or Business">
      <button class="toggle-btn ${variant === "personal" ? "active" : ""}" data-action="variant" data-variant="personal">Personal</button>
      <button class="toggle-btn ${variant === "business" ? "active" : ""}" data-action="variant" data-variant="business">Business</button>
    </div>
    ${groups}
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

    <div class="card">
      <h2>Upkeep — $29 a month</h2>
      <ul class="included-list">${UPKEEP_COPY.included.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
      ${
        state?.upkeep
          ? `<p><span class="owned-badge">Upkeep is on</span></p>`
          : `<a class="btn primary" href="${esc(UPKEEP.url)}" target="_blank" rel="noopener">Buy Upkeep — $29.87</a>`
      }
      <p class="fine">Upkeep is never required to use what you bought.</p>
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
        `<button class="nav-btn ${tab === t.id ? "active" : ""}" data-action="goto" data-tab="${t.id}">${t.label}</button>`,
    )
    .join("");
}

function render() {
  renderNav();
  const v = view();
  if (tab === "chat") v.innerHTML = activePhoton ? renderChatThread() : renderChatFront();
  else if (tab === "inboxes") v.innerHTML = renderInboxes();
  else if (tab === "store") v.innerHTML = renderStore();
  else v.innerHTML = renderUpkeep();
  const input = document.getElementById("chat-input") as HTMLInputElement | null;
  if (input) input.focus();
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
}

// ---------- Events (delegation) ----------
document.addEventListener("click", (e) => {
  const t = (e.target as HTMLElement).closest("[data-action]") as HTMLElement | null;
  if (!t) return;
  const action = t.dataset.action;
  if (action === "goto") {
    tab = t.dataset.tab as Tab;
    activePhoton = null;
    if (tab === "inboxes") loadInboxes().then(render);
    render();
  } else if (action === "open-photon") {
    const name = t.dataset.photon || "";
    if (name) openPhoton(name);
  } else if (action === "back-to-front") {
    activePhoton = null;
    render();
  } else if (action === "call") {
    callPhoton(t.dataset.photon || "");
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
  }
});

// ---------- Boot ----------
(async function init() {
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
