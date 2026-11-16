# Step 3 — Proactive checks, reminders, and push: WIRING

Step 3 of the Prism 5 app capability design (proactive checks, reminders,
and push). One new module, `src/server/proactive.ts`, plus this file. No
other file was touched.

## What it does

- A scheduler wakes every 5 minutes and checks Gmail for anything new,
  diffing against a persistent `seen_state` table so an item is only ever
  brought once.
- Reminders: create one with a time, list them, mark done. A reminder that
  comes due is surfaced by the next check cycle.
- Web Push (VAPID, RFC 8291 aes128gcm + RFC 8292) so the owner gets a tap
  on their phone when a check finds something new. Push goes only to the
  owner's own subscribed devices, never to anyone else.
- The Photon-facing rule, from the design: checks only ever bring what
  needs a decision. Nothing is sent anywhere without the owner's tap.

## Routes to mount in server.ts

Import at the top of `src/server.ts`:

```ts
import {
  handleProactiveApi,
  startProactiveScheduler,
} from "./server/proactive";
```

Inside `handleApi`, before the final `return bad("not found", 404)`:

```ts
// Step 3: proactive checks, reminders, push.
const proactive = await handleProactiveApi(req, path);
if (proactive) return proactive;
```

Start the scheduler once, next to `Bun.serve` (after the server is up):

```ts
startProactiveScheduler();
```

`handleProactiveApi` returns `null` for paths it does not own, so it is
safe to mount before the 404. The scheduler does NOT auto-start on import;
the coordinator wires the start, as above.

Routes (all under `/api/`, accountId from body, `x-account-id` header, or
`?accountId=` query, same as the rest of the server):

| Route | Method | What it does |
|---|---|---|
| `/api/proactive/status` | GET | Scheduler running or not, last check time, counts of new items found, push configured or not, which channels exist yet. |
| `/api/proactive/check` | POST | One manual check cycle for the caller's account; returns what is new (gmail / texts / calendar / reminders due) and what push did. |
| `/api/reminders` | GET | List the caller's reminders. |
| `/api/reminders` | POST | Create one. Body: `{ "text": "...", "remind_at": "<ISO date>" }`. Returns 201 with the reminder. |
| `/api/reminders/:id/done` | POST | Mark a reminder done. |
| `/api/push/subscribe` | POST | Store the browser's push subscription. Body: the `PushSubscription` JSON from `registration.pushManager.subscribe()` (or `{ subscription: {...} }`). |
| `/api/push/status` | GET | Push configured? This device subscribed? Returns the VAPID public key when configured. |

## Env vars

| Name | Purpose | Required? |
|---|---|---|
| `VAPID_PUBLIC_KEY` | Base64url uncompressed P-256 point (65 bytes) for Web Push. Generate with any VAPID key generator; never commit a key. | Only for push. Without it, status honestly says push is not configured and checks/reminders still run. |
| `VAPID_PRIVATE_KEY` | Base64url P-256 scalar (32 bytes), the matching private half. Server-side only, never in the client, never committed. | Only for push. |
| `VAPID_SUBJECT` | Contact for the push service, e.g. `mailto:contact@prism5labs.com`. Required by the VAPID spec. | Only for push. |

No other env vars. The module reads these directly from `process.env`
at call time (the coordinator consolidates `config.ts` at merge).

## Persona truth lines (for personas.ts)

Add these when the coordinator updates the truth blocks. They are honest
about what is live and what is not:

- "I check your Gmail every few minutes and only bring you what needs a decision — I never send anything without your tap."
- "You can set a reminder and I'll surface it when it's due, but I can't tap you on the phone until push notifications are set up on the server."
- "Texts and calendar checks aren't built yet, so right now I can only watch your Gmail. I'll say so plainly rather than pretend otherwise."
- "On the free tier the app sleeps when nobody's using it, so checks only run while it's awake."

## Client snippet for push subscription

The service worker is already registered in `public/index.html`
(`navigator.serviceWorker.register("/sw.js")`). Two client pieces are
still needed (coordinator's job — do not edit client files from this step):

### 1. Service worker: show the push (add to `public/sw.js`)

```js
self.addEventListener("push", (event) => {
  let data = { title: "Prism 5", body: "Something needs you." };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon.png",
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
```

### 2. Subscribe on the phone (anchor: next to the service-worker registration in `public/index.html`, or in the Upkeep/settings view in `client/main.ts`)

```js
async function subscribePush(accountId) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  const status = await fetch(`/api/push/status?accountId=${encodeURIComponent(accountId)}`).then((r) => r.json());
  if (!status.configured || !status.publicKey) return; // push not set up yet; say so in the UI
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) return; // already subscribed
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(status.publicKey),
  });
  await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accountId, subscription: sub }),
  });
}
// urlBase64ToUint8Array: the standard base64url -> Uint8Array helper
// (decode the VAPID public key before passing it as applicationServerKey).
```

## How to verify live

Start the server (from this worktree):

```bash
PORT=10103 DATA_DIR=/tmp/step3-proactive-data bun src/server.ts
```

With VAPID keys absent, the server starts and the status endpoints answer
honestly:

```bash
# Proactive status: scheduler running, push not configured
curl "http://localhost:10103/api/proactive/status?accountId=test-account-1"

# Push status: configured false, subscribed false
curl "http://localhost:10103/api/push/status?accountId=test-account-1"

# Reminders round-trip (remind_at in the past so it is due on the next check)
curl -X POST http://localhost:10103/api/reminders \
  -H "content-type: application/json" \
  -d '{"accountId":"test-account-1","text":"Call the farm back","remind_at":"2026-11-15T18:00:00.000Z"}'
curl "http://localhost:10103/api/reminders?accountId=test-account-1"
curl -X POST http://localhost:10103/api/reminders/<id-from-above>/done \
  -H "content-type: application/json" -d '{"accountId":"test-account-1"}'

# Manual check cycle (no Gmail connected: returns gmail checked=false,
# texts/calendar available=false, reminders due listed if any are due)
curl -X POST http://localhost:10103/api/proactive/check \
  -H "content-type: application/json" -d '{"accountId":"test-account-1"}'
```

With VAPID keys set (generate a pair first; never commit them):

```bash
VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:contact@prism5labs.com \
  PORT=10103 DATA_DIR=/tmp/step3-proactive-data bun src/server.ts
```

Then `/api/push/status` reports `configured: true` with the public key,
and a browser that subscribes via the snippet above will receive a push
when a check cycle finds something new.

## Honest limits (do not let a Photon claim otherwise)

- **Free tier sleeps.** On the free tier the process sleeps when idle, so
  the scheduler only runs while the server is awake. A 5-minute check is
  really "every 5 minutes while awake". Staying awake needs the paid
  instance (step 2).
- **Seen-state needs the paid disk (step 2) to survive redeploys.** The
  `seen_state` table lives in the same SQLite file as everything else, on
  the free tier's ephemeral disk. A redeploy wipes it, so the first check
  after a redeploy may re-surface recent Gmail as "new" once.
- **Texts and calendar checks are not built yet** (steps 1 and 4). The
  scheduler looks for `./texts` and `./calendar` modules lazily and
  reports them as unavailable until they land. The contract for those
  modules is documented in `src/server/proactive.ts`: export
  `checkChannelItems(accountId)` returning recent items with `{ id,
  summary, detail? }`; the scheduler diffs them against `seen_state`
  itself.
- **Push is code-ready, not live, until VAPID keys exist.** The
  encryption (RFC 8291 aes128gcm, WebCrypto only) and the send path are
  implemented, but without `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` /
  `VAPID_SUBJECT` in the environment, no push is sent and the status
  endpoints say so. The service-worker `push` handler and the client
  subscribe call (above) are also still to be added by the coordinator.
- **No delivery channel is invented for due reminders.** A due reminder
  is surfaced in the next check result (and pushed to the owner's own
  devices if push is configured). It is not emailed, texted, or otherwise
  sent anywhere.
