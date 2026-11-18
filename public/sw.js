// Prism 5 service worker. Cache-first for the app shell and static assets,
// network-first for the API (chat, state, and inboxes must always be fresh).
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
const CACHE = "prism5-v26";
const SHELL = ["/", "/index.html", "/styles.css", "/main.js", "/manifest.json", "/opening-animation-v3.mp4", "/chat-bg/bg-rocket.jpg", "/chat-bg/bg-helmets.jpg", "/chat-bg/bg-starburst.jpg", "/chat-bg/bg-robot.jpg", "/chat-bg/bg-saucer.jpg", "/chat-bg/bg-raygun.jpg", "/chat-bg/bg-car.jpg", "/chat-bg/bg-pilot.jpg", "/chat-bg/bg-moonbase.jpg", "/chat-bg/bg-diner.jpg", "/chat-bg/bg-launchpad.jpg", "/chat-bg/bg-spacestation.jpg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
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
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
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
