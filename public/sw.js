// Prism 5 service worker. Cache-first for the app shell and static assets,
// network-first for the API (chat, state, and inboxes must always be fresh).
// CACHE v6: bumped Nov 16, 2026 for the chat redesign (Photon-specific
// poster backgrounds + new main.js/index.html/styles.css). The Photon
// intro shipped without a cache bump once before, and existing installs
// kept serving the cached pre-intro shell; bumping the cache makes them
// fetch the new shell instead. The background art is precached too, so
// the chat room shows its poster on first open after the update.
const CACHE = "prism5-v6";
const SHELL = ["/", "/index.html", "/styles.css", "/main.js", "/manifest.json", "/opening-animation-v3.mp4", "/chat-bg/bg-rocket.jpg", "/chat-bg/bg-helmets.jpg", "/chat-bg/bg-starburst.jpg"];

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
