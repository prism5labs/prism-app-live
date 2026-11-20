// CDP probe for the email-reader overflow bug.
// Drives the REAL built client (public/main.js + styles.css) with a
// fetch stub returning the two inbox messages from Neil's screenshots
// (Talkiatry snippet carrying a literal &#39;, LiveWell proxy email
// with a long sender address, a [cid:...] line, and a long portal URL),
// dismisses the opening splash, opens the LiveWell message through
// the app's own reader flow, and measures overflow.
// Usage: CDP_PORT=9333 bun probe-email.ts [normal|large|xl] [width]
// Screenshots + measurements land in evidence/.
const PORT = process.env.CDP_PORT || "9333";
const SIZE = process.argv[2] || "normal";
const WIDTH = Number(process.argv[3] || "390");
const OUT = "/home/hatch/workspace/business/prism-app-worktrees/email-reader-fix/evidence";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LIVEWELL_BODY = [
  "[cid:image001.png@01DD783C.284BF3A0]",
  "Hello Neil,",
  "",
  "You have requested proxy access to your child. Your proxy access has been activated.",
  "",
  "If you do not already have a LiveWell account, you should have received an Enrollment email as well. If your computer\u2019s operating system (Windows or Mac) asks you to save your username and password, please choose \u201cno\u201d or \u201cnot right now\u201d, as this feature often causes problems when activated.",
  "",
  "LiveWell requires anyone who is given proxy access to complete a Proxy Confirmation before viewing another patient\u2019s record. Therefore, please complete the Proxy Confirmation in your LiveWell account at https://www.livewell.aah.org/mychart/Authentication/Login?returnUrl=%2Fmychart%2Fproxy-confirmation%3Fid%3D01DD783C284BF3A0.",
].join("\n");

const PRELOAD = `
try { localStorage.setItem("prism5.accountId", "acc_emailprobe01"); } catch (e) {}
(function () {
  var STATE = { ok: true, accountId: "acc_emailprobe01", displayName: "Prism 5", customName: "", ownedPhotons: ["Prism"], ownedProducts: [], meter: { used: 0, limit: 300, unlimited: false }, upkeep: false, freeCode: false, brain: false, googleConfigured: true, microsoftConfigured: false, auth: { email: "aode1282@gmail.com", name: "Neil" }, perk: null, backstories: {}, customizations: {}, photons: [{ name: "Prism", pronoun: "she/her", tagline: "For anyone who wants one assistant that does it all.", focus: "Your front desk.", owned: true }] };
  var INBOXES = { ok: true, googleConfigured: true, accounts: [{ label: "gmail-1", title: "Personal", connected: true, email: "aode1282@gmail.com", unreadCount: 2, error: null, messages: [
    { id: "talkiatry1", from: "Talkiatry <no-reply@talkiatry.com>", subject: "Your visit is confirmed", date: "Thu, 19 Nov 2026", snippet: "Your visit is confirmed You&#39;re all set for your next visit with us. See you then! VIRTUAL VISIT Thursday, December 17, 2026 @ 03:00 PM CST", unread: false },
    { id: "livewell1", from: "LiveWell Support <livewellsupport@advocatehealth.org>", subject: "Livewell Proxy Activation", date: "Thu, 19 Nov 2026 21:39:27 +0000", snippet: "You have requested proxy access to your child. Your proxy access has been activated.", unread: true }
  ] }] };
  var MSG = { ok: true, id: "livewell1", from: "LiveWell Support <livewellsupport@advocatehealth.org>", subject: "Livewell Proxy Activation", date: "Thu, 19 Nov 2026 21:39:27 +0000", body: ${JSON.stringify(LIVEWELL_BODY)} };
  var EMPTY = { ok: true, accounts: [], contacts: [], profile: null, imports: [], texts: [], calls: [], events: [], busy: [], files: [], pages: [] };
  var realFetch = window.fetch.bind(window);
  window.fetch = function (u2, opts) {
    var u = String(u2);
    if (u.indexOf("/api/state") !== -1) return Promise.resolve(new Response(JSON.stringify(STATE), { headers: { "content-type": "application/json" } }));
    if (u.indexOf("/api/inboxes") !== -1) return Promise.resolve(new Response(JSON.stringify(INBOXES), { headers: { "content-type": "application/json" } }));
    if (u.indexOf("/api/gmail/message") !== -1) return Promise.resolve(new Response(JSON.stringify(MSG), { headers: { "content-type": "application/json" } }));
    if (u.indexOf("/api/outlook/inboxes") !== -1) return Promise.resolve(new Response(JSON.stringify({ ok: true, microsoftConfigured: false, accounts: [] }), { headers: { "content-type": "application/json" } }));
    if (u.indexOf("/api/messenger/status") !== -1) return Promise.resolve(new Response(JSON.stringify({ ok: true, configured: false }), { headers: { "content-type": "application/json" } }));
    if (u.indexOf("/api/messenger/pages") !== -1) return Promise.resolve(new Response(JSON.stringify({ ok: true, pages: [] }), { headers: { "content-type": "application/json" } }));
    if (u.indexOf("/api/") !== -1) return Promise.resolve(new Response(JSON.stringify(EMPTY), { headers: { "content-type": "application/json" } }));
    return realFetch(u2, opts);
  };
})();
`;

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t: any) => t.type === "page");
  if (!page) throw new Error("no page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(e);
  });
  let id = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
  const consoleErrors: string[] = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    } else if (msg.method === "Runtime.exceptionThrown") {
      consoleErrors.push("exception: " + JSON.stringify(msg.params.exceptionDetails).slice(0, 300));
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      consoleErrors.push("console.error: " + JSON.stringify(msg.params.args).slice(0, 300));
    }
  };
  const send = (method: string, params: any = {}) =>
    new Promise<any>((res, rej) => {
      const mid = ++id;
      pending.set(mid, { res, rej });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const evalJs = async (expr: string) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result?.value;
  };
  const shot = async (name: string) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    await Bun.write(`${OUT}/${name}.png`, Buffer.from(r.data, "base64"));
    console.log("shot:", name);
  };

  await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PRELOAD });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: "http://prism-local.example.com:10101/?tab=connected" });
  let rows = 0;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    rows = await evalJs(`document.querySelectorAll(".email-row").length`);
    if (rows >= 2) break;
  }
  console.log("email rows:", rows);
  if (rows < 2) throw new Error("inbox rows did not render");
  // Dismiss the opening splash (tap-to-skip), then wait for it to go.
  await evalJs(`(() => { const s = document.getElementById("opening-splash"); if (s) s.click(); return !!s; })()`);
  await sleep(1400);
  const splashGone = await evalJs(`!document.getElementById("opening-splash")`);
  console.log("splash gone:", splashGone);

  const measure = async (label: string) => {
    const m = await evalJs(`(() => {
      const iw = window.innerWidth;
      const dw = document.documentElement.scrollWidth;
      const rect = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width), sw: el.scrollWidth, cw: el.clientWidth }; };
      const bad = [];
      document.querySelectorAll("body *").forEach((el) => {
        const b = el.getBoundingClientRect();
        if (b.right > iw + 1 || b.left < -1) bad.push({ tag: el.tagName, cls: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className).slice(0, 50), x: Math.round(b.x), right: Math.round(b.right), w: Math.round(b.width) });
      });
      return { iw, dw, sheet: rect(".card-sheet"), title: rect(".card-title"), kind: rect(".card-kind"), body: rect(".email-body"), overflowers: bad.slice(0, 10), overflowerCount: bad.length };
    })()`);
    console.log(label, JSON.stringify(m));
    return m;
  };

  // Entity check across every rendered snippet.
  const snippets = await evalJs(`Array.from(document.querySelectorAll(".inbox-snippet")).map((s) => s.textContent)`);
  console.log("snippets:", JSON.stringify(snippets));
  console.log("snippet shows literal &#39;:", snippets.some((s: string) => s.includes("&#39;")));

  if (SIZE !== "normal") {
    await evalJs(`document.documentElement.classList.remove("read-large", "read-xl"); document.documentElement.classList.add("read-${SIZE}");`);
    await sleep(300);
  }
  await measure(`LIST-${SIZE}-${WIDTH}`);
  await shot(`email-list-${SIZE}-${WIDTH}`);

  await evalJs(`(() => { const rows = document.querySelectorAll(".email-row"); for (const r of rows) { if ((r.textContent || "").includes("Livewell Proxy")) { r.click(); return "clicked"; } } return "not found"; })()`);
  await sleep(1200);
  const modalOpen = await evalJs(`!document.getElementById("card-modal").hidden`);
  console.log("modal open:", modalOpen);
  if (SIZE !== "normal") {
    await evalJs(`document.documentElement.classList.remove("read-large", "read-xl"); document.documentElement.classList.add("read-${SIZE}");`);
    await sleep(300);
  }
  await measure(`READER-${SIZE}-${WIDTH}`);
  await shot(`email-reader-${SIZE}-${WIDTH}`);
  console.log("console errors:", JSON.stringify(consoleErrors));
  process.exit(0);
}

main().catch((e) => {
  console.error("PROBE FAILED:", e.message);
  process.exit(1);
});
