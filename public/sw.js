// Prism 5 service worker. Cache-first for the app shell and static assets,
// network-first for the API (chat, state, and inboxes must always be fresh).
// CACHE v37: bumped Nov 19, 2026 for the Calendar + Drive connect fix —
// the Gmail OAuth callback now routes a ":calendar-drive" state to the
// extra handler instead of rejecting it as bad_state, so "Connect
// Calendar & Drive" finishes instead of showing "Gmail sign-in didn't
// finish. Try again." The cache bump makes existing installs fetch the
// new main.js, index.html and styles.css instead of serving the cached
// ones, and clears any older cache entries on activate.
// CACHE v36: bumped Nov 19, 2026 for Nova at $79 (one-time $79.00 / $81.37
// at checkout, $10 a month, Personal Upkeep $9 a month), the twelve Atoms
// in the Store and You, and the first-open Business/Personal chooser that
// replaces the first-run landing. The cache bump makes existing installs
// fetch the new main.js, index.html and styles.css instead of serving the
// cached ones, and clears any older cache entries on activate.
// CACHE v35: bumped Nov 19, 2026 for Nova — the personal helper in the
// Store (one-time $79 / $10 a month, Personal Upkeep $9 a month), the
// personal/business feature gate, Nova's gentler default (check-ins and
// getting-started nudges on), and the Nova card in You with the business
// set shown locked. The cache bump makes existing installs fetch the new
// main.js instead of serving the cached one, and clears any older cache
// entries on activate.
// CACHE v34: bumped Nov 19, 2026 for the Prism redesign — four places
// (Chat, Connected, Store, You) instead of Chat / Inboxes / Store /
// Upkeep; one Google sign-in for Gmail + Calendar + Drive; Connections
// card with a plain state per service; settings behind the account with
// nothing for sale; redeem-a-code only in the Store; slow fades on every
// transition (700ms in, 350ms out). NOTE: the nightly need-a-moment
// branch also used v33 off a different base — the merge must keep one
// v34, not two. The cache bump makes existing installs fetch the new
// main.js, index.html and styles.css instead of serving the cached
// ones, and clears any older cache entries on activate.
// CACHE v33: bumped Nov 19, 2026 for the humor synthesis — the shared HUMOR
// const in src/server/personas.ts (Leacock / Wodehouse / Wilde mechanics,
// Jeeves diction NOT adopted) appended to every Photon system prompt, plus
// the staged Jeeves Face draft in src/shared/voices.ts (not a live Face).
// The cache bump makes existing installs fetch the new main.js and sw.js
// instead of serving the cached ones, and clears any older cache entries
// on activate.
// CACHE v33: bumped Nov 19, 2026 for the Google sign-in fix — sign-in
// recovery (POST /api/auth/recover, so a sign-in completed in the
// browser tab lands in the installed app), the header Google-state pill
// and the three-state account card, the 6s backstop on the returning
// splash cover, and bounded API calls so boot can never sit on a
// loading line forever. The cache bump makes existing installs fetch
// the new main.js, index.html and styles.css instead of serving the
// cached ones, and clears any older cache entries on activate.
// CACHE v32: bumped Nov 18, 2026 for the interface sounds — tiny
// synthesized click / toggle / swoosh (Web Audio, no files), wired to
// every tap, switch, and screen change, with an on/off switch in
// Upkeep saved per device in localStorage. The cache bump makes
// existing installs fetch the new main.js and sw.js instead of serving
// the cached ones, and clears any older cache entries on activate.
// CACHE v31: bumped Nov 18, 2026 for the opening-animation switch —
// the film can now be turned off for good (Upkeep, or "Don't play
// the opening again" on the opening itself), saved per device in
// localStorage, and an off device never flashes the splash on the
// way in. The cache bump makes existing installs fetch the new
// main.js, index.html and styles.css instead of serving the cached
// ones, and clears any older cache entries on activate.
// CACHE v30: bumped Nov 18, 2026 for the phone-taps fix — the toggle
// could not turn off, because the off path only dropped the local
// subscription while the server kept the stored row and status kept
// reporting subscribed, and there was no server unsubscribe route at
// all. POST /api/push/unsubscribe now deletes the stored row(s), and
// the off path calls it before re-reading status. The cache bump makes
// existing installs fetch the new main.js and sw.js instead of serving
// the cached ones, and clears any older cache entries on activate.
// CACHE v29: bumped Nov 18, 2026 for the freeze diagnosis — the opening
// film stalled and the sign-in page read as frozen on Neil's phone. The
// v5 film is now precached at install (best effort, so a slow video
// fetch cannot fail the whole install) and video Range requests are
// served as 206 slices out of the cache when the whole file is cached,
// so the film plays from the installed copy on reopen even on a slow
// connection instead of stalling on the network. The cache bump makes
// existing installs fetch the new sw.js and main.js instead of serving
// the cached ones, and clears any older cache entries on activate.
// CACHE v28: bumped Nov 18, 2026 for the v5 opening film — the crystalline
// teal prism figure in place of Prism herself, fading into the golden dust
// and ending on the gold pyramid mark — plus the no-video hardening: Range
// requests now bypass the worker entirely (the Cache API cannot store a
// 206 partial response, so intercepting one only adds failure modes), the
// splash carries a poster frame so it never sits black while the film
// loads, and the splash code watches for a stall and falls back to the
// v3 film. The cache bump makes existing installs fetch the new main.js,
// the new sw.js, the v5 film and its poster instead of serving the cached
// ones, and clears any older cache entries on activate.
// CACHE v26: bumped Nov 18, 2026 for the wizard-standard first slice —
// the Reading card (text size + high contrast, saved per device) and the
// Google sign-in/connect smoothing (no "not signed in" flash on the way
// back from Google, pending states on the sign-in and connect buttons,
// the connect chooser reopens after a failed sign-in). The cache bump
// makes existing installs fetch the new main.js and styles.css instead
// of serving the cached ones.
// CACHE v25: bumped Nov 18, 2026 for the memory import fix — the app
// stored the self-export but only ever showed the brain its first 1,500
// characters (the table of contents), and the 100,000-character cap cut
// the file's tail. Imports are now stored whole, split into sections,
// the owner's identity rides in every prompt, the matching sections
// answer each message, and Prism is seeded from the export's SOUL and
// IDENTITY. Old whole-file imports are split in place on boot. The
// cache bump makes existing installs fetch the new main.js and server
// code instead of serving the cached ones.
// CACHE v24: bumped Nov 18, 2026 for the owner Upkeep grant, the free-code
// voice fix, and the first-run landing screen (code held back until after
// sign-up, newsletter line added). The cache bump makes existing installs
// fetch the new main.js instead of serving the cached one.
// CACHE v20: bumped Nov 18, 2026 for the new Prism portrait — Prism's
// face is now Prism 5 herself (the approved Jeeves avatar: Florence
// Pugh face, spiky blue-black faux hawk, vibrant blue eyes, red
// lipstick), same still, same teal crystalline bodysuit, red cape, and
// light beam. The cache bump makes existing installs fetch the new
// Prism.png instead of serving the cached one.
// CACHE v19: bumped Nov 18, 2026 for the chat composer fix — the
// thread header's nowrap tagline forced Chrome to expand the layout
// viewport past the screen (menu and send button off the right edge,
// keyboard math corrupted), and the body height subtracted the
// keyboard gap from 100dvh, which already shrinks with the keyboard,
// collapsing the thread to a sliver. The cache bump makes existing
// installs fetch the new styles.css instead of serving the cached one.
// CACHE v18: bumped Nov 17, 2026 for the Sputnik hero image fix (the
// source sputnik.jpg had a 20px white strip down its right edge — and
// 21px on the left — so the hero showed a white sliver; the image is
// cropped to the emblem, 659px wide, no white edge) on top of the v17
// Start My Day Stripe links. The cache bump makes existing installs
// fetch the new main.js and the new sputnik.jpg instead of serving the
// cached ones.
const CACHE = "prism5-v40";
const SHELL = ["/", "/index.html", "/styles.css", "/main.js", "/manifest.json", "/opening-animation-v3.mp4", "/opening-v5-poster.jpg", "/chat-bg/bg-rocket.jpg", "/chat-bg/bg-helmets.jpg", "/chat-bg/bg-starburst.jpg", "/chat-bg/bg-robot.jpg", "/chat-bg/bg-saucer.jpg", "/chat-bg/bg-raygun.jpg", "/chat-bg/bg-car.jpg", "/chat-bg/bg-pilot.jpg", "/chat-bg/bg-moonbase.jpg", "/chat-bg/bg-diner.jpg", "/chat-bg/bg-launchpad.jpg", "/chat-bg/bg-spacestation.jpg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) =>
        // The shell first; the film after it, best effort — a slow or
        // failed film fetch must not fail the whole install and leave
        // the old worker in place. The film is fetched plain (no
        // Range), so it stores as a whole 200 the Range handler below
        // can slice from.
        c.addAll(SHELL).then(() => c.add("/opening-v5.mp4").catch(() => {})),
      )
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz") return;
  // Range requests (video streaming and seeking): serve a 206 slice
  // out of the cache when the whole file is cached, so the opening
  // film plays from the installed copy on reopen even on a slow
  // connection. Before this the Range requests bypassed the worker
  // entirely, so every reopen streamed the 3.7 MB film off the
  // network — on a slow connection it stalled and the splash sat
  // black. When the file is not cached yet, fall through to the
  // network untouched. (The Cache API cannot store a 206 partial
  // response, so only whole 200s are ever cached and sliced here.)
  if (event.request.headers.has("Range")) {
    event.respondWith(
      caches.match(event.request).then(async (cached) => {
        const range = event.request.headers.get("Range") || "";
        if (cached && cached.status === 200) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (m) {
            const buf = await cached.arrayBuffer();
            const total = buf.byteLength;
            let start;
            let end;
            if (m[1] === "" && m[2] !== "") {
              // Suffix range: the last N bytes.
              start = Math.max(0, total - parseInt(m[2], 10));
              end = total - 1;
            } else {
              start = parseInt(m[1] || "0", 10);
              end = m[2] !== "" ? parseInt(m[2], 10) : total - 1;
            }
            if (!Number.isNaN(start) && !Number.isNaN(end) && start <= end && start < total) {
              start = Math.max(0, start);
              end = Math.min(end, total - 1);
              return new Response(buf.slice(start, end + 1), {
                status: 206,
                headers: {
                  "content-type": cached.headers.get("content-type") || "video/mp4",
                  "content-range": `bytes ${start}-${end}/${total}`,
                  "content-length": String(end - start + 1),
                  "accept-ranges": "bytes",
                },
              });
            }
          }
        }
        return fetch(event.request);
      }),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

// Web Push (Step 3): show the tap when a proactive check finds something
// new. The payload is a title and a body from the owner's own server, for
// the owner's own account — plus an image when the server sends one, so the
// picture and the message arrive as one notification.
self.addEventListener("push", (event) => {
  let data = { title: "Prism 5", body: "Something needs you." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}
  const options = {
    body: data.body,
    icon: "/icons/icon-192.png",
    tag: "prism5-proactive",
  };
  // The picture that goes with the message: shown big in the notification
  // when the server sends one; the app icon stays when it does not.
  if (typeof data.image === "string" && data.image) options.image = data.image;
  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      return self.clients.openWindow("/");
    }),
  );
});
