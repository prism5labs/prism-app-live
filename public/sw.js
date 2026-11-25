// Prism 5 service worker.
// CACHE v50: bumped Nov 21, 2026 — the opening film slimmed again to
// ~550 kbps (713 KB) so it plays in real time on a slow connection.
// CACHE v49: bumped Nov 21, 2026 for the opening film re-encode — the
// v5 film was 6.1 MB at ~4.9 Mbps and never started on a slow phone
// connection; it is now ~1 MB capped near 750 kbps, same film. The
// cache bump makes installs fetch the new film instead of serving
// the cached heavy copy. Cache-first for the app shell and static assets,
// network-first for the API (chat, state, and inboxes must always be fresh).
// CACHE v37: bumped Nov 19, 2026 for the Calendar + Drive connect fix —
// the Gmail OAuth callback now routes a ":calendar-drive" state to the
// extra handler instead of rejecting it as bad_state, so "Connect
// Calendar & Drive" finishes instead of showing "Gmail sign-in didn't
// finish. Try again." The cache bump makes existing installs fetch the
// new main.js, index.html and styles.css instead of serving the cached
// ones, and clears any older cache entries on activate.
// CACHE v36: bumped Nov 19, 2026 for Nova at $79 (one-time $79.00 / $81.37
// at checkout, $10 a month, Personal Upkeep $9 a month), the twelve Novas
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
// Jeeves diction NOT adopted) appended to every Supernova system prompt, plus
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
// CACHE v41: bumped Nov 21, 2026 for the opening film vanish-beat fix —
// the v5 film is re-cut with a 0.75s cross-dissolve centred on the 6.17s
// cut (5.42–6.17s) so the crystalline figure dissolves into the falling
// gold dust instead of vanishing in one frame. The cache bump makes
// existing installs fetch the new opening-v5.mp4 instead of serving the
// cached one.
// CACHE v42: bumped Nov 21, 2026 for Nova chat — owned Novas open a
// chat thread in the same view Supernovas use. The cache bump makes
// existing installs fetch the new main.js instead of serving the
// cached one.
// CACHE v43: bumped Nov 21, 2026 for Supernova + Nova tool use (read +
// draft only) on the Anthropic chat path. The cache bump makes
// existing installs fetch the new main.js instead of serving the
// cached one.
// CACHE v44: bumped Nov 21, 2026 for the proactive loop — texts and
// calendar channel checks, check findings delivered into the owner's
// Supernova thread, and the Nova (Ruby/Jude) check-in and nudge sender.
// The cache bump makes existing installs fetch the new main.js
// instead of serving the cached one.
// CACHE v45: bumped Nov 21, 2026 for the readability & elegance pass —
// the §2 token layer (type scale, spacing, four radii, five timings),
// chat as reading at 17px/1.65, one conversation geometry, email and
// Drive as document pages, calmer look sets, and the motion sweep.
// The cache bump makes existing installs fetch the new styles.css and
// main.js instead of serving the cached ones.
// CACHE v52: bumped Nov 22, 2026 for the speed + declutter pass —
// portrait thumbnails (480px WebP, ~50 KB) replace the full 1600px
// PNGs (~3.5 MB) everywhere in the client, the chat backgrounds are
// recompressed (~5 MB total instead of ~11 MB), images live in a
// separate asset cache that survives shell bumps (below), and the
// Chat front and first-run chooser are picture-led with the wordy
// paragraphs cut. The cache bump makes existing installs fetch the
// new main.js, index.html and styles.css instead of serving the
// cached ones, and clears any older shell cache entries on activate.
// CACHE v54: bumped Nov 22, 2026 for the Nova renames — June is now
// Jude, Cleo is now Clive, Pearl is now Pierce (the portraits are men;
// the names were the mismatch). The roster, backstories, nudge sender,
// portrait filenames and thumbnails all carry the new names, and a
// server migration carries existing threads and ownership rows over,
// so no customer's conversation is orphaned. The cache bump makes
// existing installs fetch the new main.js instead of serving the
// cached one.
// v55: pronoun pass on the Nova backstories — Jude's story now reads
// they/them and Pierce's he/him throughout, matching the declared
// pronouns in src/shared/atoms.ts. Text-only change; the cache bump
// makes existing installs fetch the corrected bundle.
// v56: stored-row companion to v55 — a boot migration rewrites the
// Jude and Pierce rows already sitting in accounts' atom_backstories
// tables (seeded at linking with the old wording), and carries any
// rows still keyed June/Pearl over with the corrected text. Server-only
// change; the cache bump keeps the shell version honest.
// v57: final sweep of the same migration — a stored atom_backstories
// row still keyed Cleo (the v56 pass did not cover that table for the
// third rename) is carried to Clive with the current template text, or
// removed when the account already holds a Clive row. Server-only
// change; the cache bump keeps the shell version honest.
// v59: the portrait carousels are retired — the Supernovas and Novas
// now ride two rotating-drum vending machines (Chat front and Store),
// built natively in the client. The cache bump makes existing
// installs fetch the new main.js and styles.css instead of serving
// the cached ones.
// v60: the opening's finale is replaced (Neil, Nov 22, 2026) — the
// v5 film keeps its first beat (the crystal Prism forming), and at
// 5.15s the Novaic poster takes over: all 24 Faces form up like a
// Marvel ensemble poster, hold alive for about a second (breathing
// sway, drifting sparkle, one band of wind-light), then fly away in
// different directions before the curtain handover. The film files
// are untouched; the v3 fallback keeps its own ending. The cache
// bump makes existing installs fetch the new main.js and styles.css
// instead of serving the cached ones.
// CACHE v61: bumped Nov 23, 2026 for the hero opening — the Novaic
// poster finale is replaced by the 23 Novas and Supernovas as
// full-figure heroes (painted full-body art in public/heroes/),
// assembling asymmetrically and flashing out as light. Prism is
// out of the opening entirely. The bump makes installs fetch the
// new main.js and styles.css instead of serving the v60 copies.
// CACHE v62: open-time version check (Neil, Nov 23, 2026) — the new
// update-gate.js registers this worker at launch, checks for a newer
// build before the opening plays, and reloads once behind a veil when
// one lands, so no install settles into a stale copy.
// CACHE v63: the lightweight pass (Nov 23, 2026) — the 24 full
// portraits are 800px WebPs (~120 KB) instead of 1600px PNGs
// (~3.5 MB each; the fallback path and the push image point at the
// WebPs now), and the shell's text assets travel gzipped. The asset
// cache name is unchanged on purpose: thumbnail URLs did not move,
// and the old PNG entries in it are simply never requested again.
// CACHE v64: the opening re-choreographed to the owner's second
// word (Nov 23, 2026) — the v5 film now hands off at 1.8s, while
// it is still only a shaft of light on the crystal, so Prism
// herself never appears; on the stage her light gathers at the
// heart and SPLITS, one ray per hero, and the 23 Faces condense
// out of the light where they stand instead of travelling in as
// cutouts. The flash-out, tap-to-skip, opening setting, and
// sounds are unchanged. Animated per-Face clips are wired
// (HERO_CLIPS in main.js) but ship empty — the image-to-video
// pipeline was down at build time; see public/heroes/manifest.json.
const CACHE = "prism5-v70";
// Images (portraits, thumbnails, brand art, chat backgrounds, icons)
// live in their own cache whose name does NOT change with the shell
// version. Before v52 every shell bump deleted the one cache on
// activate, so each deploy made every install re-download every
// portrait it touched. This cache survives bumps; its entries are
// refreshed in the background by the fetch handler below, and the
// name is only ever changed if the asset strategy itself changes.
const ASSETS = "prism5-assets-v1";
// The shell is the app itself plus the opening films (the splash is
// untouchable, and its films must be local or it stalls). The twelve
// chat backgrounds are NOT precached any more (v52): they were ~11 MB
// of the ~12 MB install, and the fetch handler now caches each one in
// the asset cache the first time the rotation reaches it.
const SHELL = ["/", "/index.html", "/styles.css", "/main.js", "/update-gate.js", "/manifest.json", "/opening-animation-v3.mp4", "/opening-v5-poster.jpg"];

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

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== ASSETS).map((k) => caches.delete(k))))
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
  // Images go to the asset cache (see ASSETS above): cache-first with
  // a background refresh, in the cache that survives shell bumps, so a
  // deploy never makes an install re-download its portraits.
  if (
    url.pathname.startsWith("/supernovas/") ||
    url.pathname.startsWith("/novas/") ||
    url.pathname.startsWith("/brand/") ||
    url.pathname.startsWith("/chat-bg/") ||
    url.pathname.startsWith("/icons/")
  ) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const cached = await cache.match(event.request);
        const network = fetch(event.request)
          .then((res) => {
            if (res.ok) cache.put(event.request, res.clone()).catch(() => {});
            return res;
          })
          .catch(() => cached);
        return cached || network;
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
