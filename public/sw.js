// Prism 5 service worker. Cache-first for the app shell and static assets,
// network-first for the API (chat, state, and inboxes must always be fresh).
// CACHE v3: bumped Nov 15, 2026 for the client-B voice/proactive/jobs/
// Messenger/research UI and the push handler below, so existing installs
// fetch the new look instead of the old cached shell.
const CACHE = "prism5-v3";
const SHELL = ["/", "/index.html", "/styles.css", "/main.js", "/manifest.json"];

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
// new. The payload is only ever a title and a body from the owner's own
// server, for the owner's own account.
self.addEventListener("push", (event) => {
  let data = { title: "Prism 5", body: "Something needs you." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      tag: "prism5-proactive",
    }),
  );
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
