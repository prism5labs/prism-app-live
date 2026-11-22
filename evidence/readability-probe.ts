// Readability pass evidence probe (Nov 21, 2026).
// Drives the REAL built client (public/main.js + styles.css) in headless
// Chrome via CDP, with fetch stubs for state/thread/inbox/message, and
// captures: home, a Photon thread with a long reply, the email reader,
// and the Store — at 390x844 and 360x800 — plus a DOM audit of computed
// font sizes and the prose measure.
// Usage: CDP_PORT=9334 bun evidence/readability-probe.ts <before|after> <baseUrl> <outDir>
const PORT = process.env.CDP_PORT || "9334";
const PHASE = process.argv[2] || "before";
const BASE = process.argv[3] || "http://127.0.0.1:10102/";
const OUT = process.argv[4] || `/home/hatch/workspace/business/prism-app-worktrees/readability/evidence/readability-2026-11-21/${PHASE}`;
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LONG_REPLY = [
  "Here is the long version, the way I would lay it out if we had the whole counter to ourselves and nowhere else to be this afternoon.",
  "First, the inbox: three messages need a decision from you, and the rest is routine paper that can be filed without another thought. The Talkiatry confirmation is the one with a date attached, so it goes first. The LiveWell note is a proxy confirmation — it wants a tap inside their portal, and nothing about it is urgent tonight.",
  "Second, the calendar: tomorrow is clear until the afternoon, which means the morning is yours for the deep work, the kind that never survives contact with a ringing phone. I have kept it empty on purpose.",
  "Third, the store paperwork: the receipt from Tuesday is filed, the invoice is drafted in your words, and the only thing waiting is your say-so. Nothing has been sent. Nothing will be sent until you say the word, in so many words, naming what goes and who it goes to.",
  "That is the whole of it. One decision at a time, in the order I have laid them out, and when you are ready for the next one, it will be sitting right here waiting for you.",
].join("\n\n");
const LONG_BODY = [
  "Hello Neil,",
  "",
  "You have requested proxy access to your child. Your proxy access has been activated.",
  "",
  "If you do not already have a LiveWell account, you should have received an Enrollment email as well. If your computer's operating system (Windows or Mac) asks you to save your username and password, please choose “no” or “not right now”, as this feature often causes problems when activated.",
  "",
  "LiveWell requires anyone who is given proxy access to complete a Proxy Confirmation before viewing another patient's record. Therefore, please complete the Proxy Confirmation in your LiveWell account at https://www.livewell.aah.org/mychart/Authentication/Login?returnUrl=%2Fmychart%2Fproxy-confirmation%3Fid%3D01DD783C284BF3A0.",
  "",
  "Thank you for using LiveWell.",
].join("\n");

const PRELOAD = `
try { localStorage.setItem("prism5.accountId", "acc_readprobe01"); localStorage.setItem("prism5.opening.v1", "off"); localStorage.setItem("prism.side.v1", "business"); } catch (e) {}
(function () {
  var LONG_REPLY = ${JSON.stringify(LONG_REPLY)};
  var LONG_BODY = ${JSON.stringify(LONG_BODY)};
  var STATE = { ok: true, accountId: "acc_readprobe01", displayName: "Prism 5", customName: "", ownedPhotons: ["Prism"], ownedProducts: [], ownedAtoms: [], meter: { used: 3, limit: 300, unlimited: false }, upkeep: false, freeCode: false, brain: true, googleConfigured: true, microsoftConfigured: false, auth: { email: "aode1282@gmail.com", name: "Neil", signedIn: true }, perk: null, backstories: {}, customizations: { Prism: { faceName: null, voice: "house", tuning: null, lookSet: null, portrait: null, step: 3, done: true } }, photons: [{ name: "Prism", pronoun: "she/her", tagline: "For anyone who wants one assistant that does it all.", focus: "Your front desk.", owned: true }] };
  var THREAD = { ok: true, messages: [ { role: "user", content: "Give me the long version of where everything stands." }, { role: "assistant", content: LONG_REPLY } ] };
  var INBOXES = { ok: true, googleConfigured: true, accounts: [{ label: "gmail-1", title: "Personal", connected: true, email: "aode1282@gmail.com", unreadCount: 1, error: null, messages: [ { id: "livewell1", from: "LiveWell Support <livewellsupport@advocatehealth.org>", subject: "Livewell Proxy Activation", date: "Thu, 19 Nov 2026 21:39:27 +0000", snippet: "You have requested proxy access to your child. Your proxy access has been activated.", unread: true } ] }] };
  var MSG = { ok: true, id: "livewell1", from: "LiveWell Support <livewellsupport@advocatehealth.org>", subject: "Livewell Proxy Activation", date: "Thu, 19 Nov 2026 21:39:27 +0000", body: LONG_BODY };
  var EMPTY = { ok: true, accounts: [], contacts: [], profile: null, imports: [], texts: [], calls: [], events: [], busy: [], files: [], pages: [], reminders: [], threads: [] };
  var realFetch = window.fetch.bind(window);
  window.fetch = function (u2, opts) {
    var u = String(u2);
    var J = function (o) { return Promise.resolve(new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } })); };
    if (u.indexOf("/api/state") !== -1) return J(STATE);
    if (u.indexOf("/api/threads/") !== -1) return J(THREAD);
    if (u.indexOf("/api/inboxes") !== -1) return J(INBOXES);
    if (u.indexOf("/api/gmail/message") !== -1) return J(MSG);
    if (u.indexOf("/api/outlook/inboxes") !== -1) return J({ ok: true, microsoftConfigured: false, accounts: [] });
    if (u.indexOf("/api/drive/status") !== -1) return J({ ok: true, connected: true, email: "aode1282@gmail.com" });
    if (u.indexOf("/api/drive/search") !== -1) return J({ ok: true, files: [{ id: "doc1", name: "Family notes.txt", mimeType: "text/plain", modifiedTime: "2026-11-19T12:00:00Z" }] });
    if (u.indexOf("/api/drive/file") !== -1) return J({ ok: true, readable: true, truncated: false, file: { name: "Family notes.txt", mimeType: "text/plain" }, content: LONG_BODY });
    if (u.indexOf("/api/messenger/status") !== -1) return J({ ok: true, configured: false });
    if (u.indexOf("/api/stripe/status") !== -1) return J({ ok: true, configured: true });
    if (u.indexOf("/api/") !== -1) return J(EMPTY);
    return realFetch(u2, opts);
  };
})();
`;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t: any) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(e); });
  let id = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
  const errors: string[] = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id)!; pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
    else if (msg.method === "Runtime.exceptionThrown") errors.push("exception: " + JSON.stringify(msg.params.exceptionDetails).slice(0, 200));
  };
  const send = (method: string, params: any = {}) => new Promise<any>((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evalJs = async (expr: string) => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result?.value; };
  const shot = async (name: string) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`${OUT}/${name}.png`, Buffer.from(r.data, "base64")); console.log("shot", name); };

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PRELOAD });

  const audit: any = { phase: PHASE, base: BASE, viewports: {} };
  for (const [w, h] of [[390, 844], [360, 800]] as const) {
    const tag = `${w}x${h}`;
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 2, mobile: true });
    await send("Page.navigate", { url: BASE });
    await sleep(2500);
    // Dismiss splash / chooser if present.
    await evalJs(`(() => { const s = document.getElementById("opening-splash"); if (s) s.click(); const skip = document.querySelector(".chooser-skip"); if (skip) skip.click(); return true; })()`);
    await sleep(1200);
    await shot(`home-${tag}`);
    // Thread: tap the owned Photon card.
    const opened = await evalJs(`(() => { const b = document.querySelector('[data-action="open-photon"]'); if (b) { b.click(); return true; } return false; })()`);
    await sleep(1800);
    const inThread = await evalJs(`document.body.classList.contains("is-thread")`);
    if (opened && inThread) await shot(`thread-${tag}`);
    else console.log("THREAD NOT REACHED", tag, opened, inThread);
    const threadAudit = await evalJs(`(() => {
      const msg = document.querySelector(".msg.bot p");
      const box = document.querySelector(".messages");
      if (!msg) return null;
      const cs = getComputedStyle(msg);
      const r = msg.getBoundingClientRect();
      const fs = parseFloat(cs.fontSize);
      return { msgFontPx: fs, msgLineHeightPx: parseFloat(cs.lineHeight), msgWidthPx: Math.round(r.width), approxCharsPerLine: Math.round(r.width / (fs * 0.48)), messagesWidthPx: box ? Math.round(box.getBoundingClientRect().width) : null };
    })()`);
    // Back out, then Connected -> email reader.
    await evalJs(`(() => { const b = document.querySelector('[data-action="back-to-front"]'); if (b) b.click(); return true; })()`);
    await sleep(900);
    await evalJs(`(() => { const b = [...document.querySelectorAll("#nav .nav-btn")].find(x => x.textContent.includes("Connected")); if (b) b.click(); return true; })()`);
    await sleep(1800);
    const rows = await evalJs(`document.querySelectorAll(".email-row").length`);
    if (rows > 0) {
      await evalJs(`document.querySelector(".email-row").click()`);
      await sleep(1500);
      await shot(`email-reader-${tag}`);
    } else console.log("NO EMAIL ROWS", tag);
    const emailAudit = await evalJs(`(() => { const b = document.querySelector(".email-body"); if (!b) return null; const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); const fs = parseFloat(cs.fontSize); return { fontPx: fs, lineHeightPx: parseFloat(cs.lineHeight), widthPx: Math.round(r.width), approxCharsPerLine: Math.round(r.width / (fs * 0.48)), maxHeight: cs.maxHeight, overflowY: cs.overflowY, borderRadius: cs.borderTopLeftRadius }; })()`);
    await evalJs(`(() => { const x = document.querySelector("[data-action='card-close']"); if (x) x.click(); return true; })()`);
    await sleep(700);
    // Drive document: open the stubbed file from the Drive section.
    const driveOpened = await evalJs(`(() => { const b = document.querySelector('[data-action="drive-open"]'); if (b) { b.scrollIntoView(); b.click(); return true; } return false; })()`);
    await sleep(1500);
    if (driveOpened) await shot(`drive-reader-${tag}`);
    else console.log("NO DRIVE FILE", tag);
    const driveAudit = await evalJs(`(() => { const b = document.querySelector(".drive-content"); if (!b) return null; const cs = getComputedStyle(b); const r = b.getBoundingClientRect(); const fs = parseFloat(cs.fontSize); return { fontPx: fs, lineHeightPx: parseFloat(cs.lineHeight), widthPx: Math.round(r.width), approxCharsPerLine: Math.round(r.width / (fs * 0.48)), maxHeight: cs.maxHeight, overflowY: cs.overflowY }; })()`);
    await evalJs(`(() => { const x = document.querySelector("[data-action='card-close']"); if (x) x.click(); return true; })()`);
    await sleep(700);
    // Store.
    await evalJs(`(() => { const b = [...document.querySelectorAll("#nav .nav-btn")].find(x => x.textContent.includes("Store")); if (b) b.click(); return true; })()`);
    await sleep(1500);
    await shot(`store-${tag}`);
    // Font-size audit on the store surface + nav (visible text-bearing elements).
    const fontAudit = await evalJs(`(() => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll("body *").forEach((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return;
        const direct = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
        if (!direct) return;
        const key = el.tagName + "." + String(el.className).slice(0, 40) + "@" + cs.fontSize;
        if (seen.has(key)) return; seen.add(key);
        out.push({ sel: el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").join(".") : ""), fontPx: parseFloat(cs.fontSize), text: (el.textContent || "").trim().slice(0, 30) });
      });
      return out.sort((a, b) => a.fontPx - b.fontPx);
    })()`);
    audit.viewports[tag] = { thread: threadAudit, email: emailAudit, drive: driveAudit, smallestText: (fontAudit || []).slice(0, 12), below12_5: (fontAudit || []).filter((f: any) => f.fontPx < 12.5), below12: (fontAudit || []).filter((f: any) => f.fontPx < 12) };
    // Return to Chat for the next viewport.
    await evalJs(`(() => { const b = [...document.querySelectorAll("#nav .nav-btn")].find(x => x.textContent.includes("Chat")); if (b) b.click(); return true; })()`);
    await sleep(800);
  }
  audit.consoleErrors = errors;
  writeFileSync(`${OUT}/audit.json`, JSON.stringify(audit, null, 2));
  console.log(JSON.stringify(audit, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
