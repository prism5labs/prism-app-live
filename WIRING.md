# Step 9 — Messenger (Facebook Pages only): WIRING

Module: `src/server/messenger.ts` (the only new module file for this step).
Status: **code ready, needs a real Meta developer app + Page access token
before any Page message can be read or sent.** With no env vars set the
server still starts and every status answer says so honestly.

## The honest limit

Meta offers a messaging API for Facebook Pages (business pages), not for
personal Messenger accounts. There is no supported way to connect a
personal Messenger account, and this design does not invent one. This step
builds the Page route for owners who run a business page, and keeps the
paste-in path for personal threads: the owner pastes the messages into chat
and the Photon reads them there.

## 1. Routes to mount in `src/server.ts`

Two edits, both in `src/server.ts` only:

**a) Import** (with the other `./server/*` imports at the top):

```ts
import { handleMessenger } from "./server/messenger";
```

**b) Dispatch** — add at the top of `handleApi()`, before any other route
(or anywhere before the final `return bad("not found", 404);`):

```ts
  // Step 9 — Messenger (Facebook Pages only). The module returns null for
  // paths it does not own, so this never swallows another route.
  if (path.startsWith("/api/messenger")) {
    const r = await handleMessenger(req, path);
    if (r) return r;
  }
```

No other `server.ts` edit is required. Optional, not required: expose the
status in `stateFor()` by importing `messengerStatus` from the same module
and adding `messenger: messengerStatus()` to the returned object, so the
client can read it from `/api/state` instead of calling
`/api/messenger/status`.

### Routes the module serves

| Method | Route | Account | What it does |
|---|---|---|---|
| GET | `/api/messenger/status` | no* | Page connected or not, which env vars are set, and a plain statement that personal Messenger has no supported API and is not connected by this module. |
| GET | `/api/messenger/threads` | yes | The Page's conversations via `GET /{page-id}/conversations`: id, participants, snippet, updated time, unread count. |
| GET | `/api/messenger/messages?conversationId=…` | yes | The messages in one Page thread via `GET /{conversation-id}/messages`: id, sender, text, created time. |
| GET | `/api/messenger/stored?conversationId=…` | yes | Messages received on the webhook and stored locally in `messenger_messages` (extra read path; the live read is `/messages`). |
| POST | `/api/messenger/send` | yes | Body `{ accountId, conversationId, text }`. Sends via `POST /me/messages` as a `RESPONSE` to the thread's other participant (looked up from the thread's participants — the conversation id alone is not a recipient). |
| GET | `/api/messenger/webhook` | no | Meta's `hub.mode=subscribe` verification: returns `hub.challenge` as plain text when `hub.verify_token` matches `META_WEBHOOK_VERIFY_TOKEN`; anything else is 403. |
| POST | `/api/messenger/webhook` | no | Incoming Page messages. Parses `entry[].messaging[]`, stores each real incoming text message in `messenger_messages` (conversation id = sender's Page-scoped id, sender id, text, timestamp, Meta message id), returns 200 quickly. Delivery/read receipts, echoes of the Page's own messages, and events with no text are skipped and counted, not stored. **No auto-reply: the Photon drafts and the owner taps send.** |

\* `status` does not require an account id; `threads`, `messages`,
`stored`, and `send` require a valid `accountId` (body, `x-account-id`
header, or query), like the Gmail routes. The webhook routes take no
account id — Meta calls them, not the app.

### The 24-hour messaging window, enforced honestly

Sends go out as `messaging_type: "RESPONSE"`, the standard reply inside
Meta's 24-hour window. If Meta rejects a send (most often because the
window has closed), the endpoint returns Meta's error plainly
(`error: "meta_error"` plus `metaError` with Meta's code and message).
It does **not** retry with a different message type and does not invent a
tag workaround.

### Storage

`messenger_messages` is created in the module itself with
`CREATE TABLE IF NOT EXISTS` at import (`id`, `conversation_id`,
`message_id` unique, `sender_id`, `text`, `timestamp`, `received_at`).
A webhook payload carries no conversation id, so the thread is identified
by the sender's Page-scoped id (PSID). Outbound sends are stored the same
way, with the sender id being the Page id, so the local history is whole.
Same free-tier caveat as the rest of the app: the SQLite file lives on
ephemeral disk, so stored webhook messages reset on redeploy until the
persistence step lands.

### Graph API

Base `https://graph.facebook.com/v26.0`, plain `fetch()` with a Bearer
token, no SDK, no new dependencies. v26.0 was the current version at
build time (Nov 2026); check Meta's changelog before changing it.

## 2. Env vars

Set in the Render dashboard (like the other keys in `config.ts`); the
coordinator consolidates these into `config.ts` at merge — the module
reads `process.env` directly for now. **Never write a token value into
the repo or any file.**

| Var | Purpose | Where it comes from |
|---|---|---|
| `META_PAGE_ID` | Which Facebook Page the app talks to. | The owner's business Page, via the Meta developer app (provided by Neil/Calyn). The Page id is shown on the Page / in the app dashboard. |
| `META_PAGE_ACCESS_TOKEN` | The credential that lets the server read the Page's conversations and send as the Page. | Generated in the Meta developer app (Messenger product, Page connected, `pages_messaging` permission) and provided by Neil/Calyn. Treat it like a password; it lives only in the Render env vars. |
| `META_WEBHOOK_VERIFY_TOKEN` | A shared secret the server checks when Meta verifies the webhook URL. | A value Neil/Calyn choose (any unguessable string) and enter both in the Meta developer app webhook settings and in the Render env vars. |

Setup on Meta's side (owner's job, in the Meta developer app):
create the app, add the Messenger product, connect the business Page,
generate the Page access token, set the webhook callback URL to
`https://<app-domain>/api/messenger/webhook` with the verify token above,
and subscribe the webhook to the `messages` messaging event. Meta's
dashboard wording may differ; the three env vars above are the whole
server side of it. When any of them is absent, `/api/messenger/status`
says the Page is not connected and the server still starts.

## 3. Persona truth lines (for `personas.ts`, when the coordinator wires it)

Use these verbatim, or trimmed but never softened:

> I can read and reply to messages on your business Facebook Page when
> it is connected. I cannot connect to your personal Messenger — Meta
> does not offer an API for personal Messenger accounts, so there is no
> supported way in. For personal chats, paste the messages here and I
> will read them. I never send a Page message on my own; I draft it and
> you tap send.

## 4. Client snippet — Messenger section in Inboxes

Do not edit `client/*` in this step; the snippet below is for the
coordinator. Anchor: `renderInboxes()` in `client/main.ts`, after the
`${renderSwitchboardContacts()}` line; state is loaded by `loadInboxes()`.

**`client/api.ts`** — add to `api`:

```ts
  messengerStatus: () =>
    req(`/api/messenger/status?accountId=${encodeURIComponent(getAccountId())}`),
  messengerThreads: () =>
    req(`/api/messenger/threads?accountId=${encodeURIComponent(getAccountId())}`),
  messengerMessages: (conversationId: string) =>
    req(`/api/messenger/messages?accountId=${encodeURIComponent(getAccountId())}&conversationId=${encodeURIComponent(conversationId)}`),
  messengerSend: (conversationId: string, text: string) =>
    req("/api/messenger/send", {
      method: "POST",
      body: JSON.stringify({ accountId: getAccountId(), conversationId, text }),
    }),
```

**`client/main.ts`** — add inside `renderInboxes()`, after
`${renderSwitchboardContacts()}`:

```ts
    ${renderMessenger()}
```

and add this function next to `renderSwitchboardContacts()` (it reads
`state?.messengerStatus` and `state?.messengerThreads`, both loaded by
`loadInboxes()` — extend that loader to call `api.messengerStatus()` and,
when connected, `api.messengerThreads()`):

```ts
// Messenger (Step 9): Facebook Page messaging only. Personal Messenger
// has no supported API, so the section says so instead of pretending.
function renderMessenger(): string {
  const s = state?.messengerStatus as any;
  const threads = (state?.messengerThreads || []) as any[];
  if (!s) return `<div class="card"><h3>Messenger</h3><p class="fine">Loading…</p></div>`;
  const personal = `<p class="fine">Personal Messenger can't be connected — Meta offers messaging for Facebook Pages only, not personal accounts. For a personal thread, paste the messages into chat and your Photon will read them there.</p>`;
  if (!s.configured) {
    return `<div class="card"><h3>Messenger</h3><p>Your business Facebook Page isn't connected yet.</p>${personal}</div>`;
  }
  const rows = threads.map((t: any) => `<div class="inbox-msg">
      <p class="inbox-subject">${esc((t.participants || []).map((p: any) => p.name).filter(Boolean).join(", ") || t.id)}</p>
      <p class="inbox-snippet">${esc(t.snippet || "")}</p>
      <p class="inbox-meta">${esc(t.updatedTime || "")}</p>
    </div>`).join("");
  return `<div class="card"><h3>Messenger — your Page</h3>
    <p class="fine">Page messaging is connected. Replies go out only when you tap send.</p>
    ${rows || `<p class="fine">No Page conversations yet.</p>`}
    ${personal}</div>`;
}
```

Thread-open and send UI (message list + reply box per thread) is a
follow-up once this section lands; the endpoints it needs already exist
(`messengerMessages` / `messengerSend` above).

## 5. How to verify live

Server on port 10107 with a scratch data dir (no real credentials):

```bash
cd <worktree>
DATA_DIR=/tmp/step9-messenger-data PORT=10107 bun src/server.ts
```

**(a) Env vars absent — honest not-configured, server starts:**

```bash
curl -s http://localhost:10107/api/messenger/status
# {"ok":true,"configured":false,"page":false,...,
#  "personalMessenger":{"connected":false,"note":"Personal Messenger has no supported API..."}}
curl -s http://localhost:10107/api/messenger/threads?accountId=acc_test1234
# {"ok":false,"error":"messenger_not_configured","message":"Facebook Page messaging is not connected yet — ..."}
```

**(b) Webhook verification — dummy token only, no real Meta call:**

```bash
DATA_DIR=/tmp/step9-messenger-data PORT=10107 META_WEBHOOK_VERIFY_TOKEN=dummy-verify-123 bun src/server.ts

curl -s "http://localhost:10107/api/messenger/webhook?hub.mode=subscribe&hub.verify_token=dummy-verify-123&hub.challenge=CHALLENGE123"
# CHALLENGE123  (plain text, 200)

curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:10107/api/messenger/webhook?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=CHALLENGE123"
# 403
```

**(c) Webhook POST stores the message, returns 200:**

```bash
curl -s -X POST http://localhost:10107/api/messenger/webhook \
  -H 'content-type: application/json' \
  -d '{"object":"page","entry":[{"id":"123456","time":1763330000000,"messaging":[{"sender":{"id":"PSID-USER-1"},"recipient":{"id":"123456"},"timestamp":1763330000000,"message":{"mid":"m_1","text":"Hi, is the farm open this weekend?"}}]}]}'
# {"ok":true,"stored":1,"skipped":0}

curl -s "http://localhost:10107/api/messenger/stored?accountId=acc_test1234&conversationId=PSID-USER-1"
# {"ok":true,"conversationId":"PSID-USER-1","messages":[{"conversationId":"PSID-USER-1","senderId":"PSID-USER-1","text":"Hi, is the farm open this weekend?", ...}]}
```

**With real credentials** (only after Neil/Calyn provide the Page id and
Page access token — never a dummy or invented one):

```bash
curl -s "http://localhost:10107/api/messenger/threads?accountId=acc_test1234"
curl -s "http://localhost:10107/api/messenger/messages?accountId=acc_test1234&conversationId=<thread-id>"
curl -s -X POST http://localhost:10107/api/messenger/send \
  -H 'content-type: application/json' \
  -d '{"accountId":"acc_test1234","conversationId":"<thread-id>","text":"Hello from Prism 5 Labs."}'
# If Meta refuses (e.g. the 24-hour window has closed), the response carries
# Meta's error plainly in metaError — that is the honest result, not a bug.
```

What is **not** verified here and must not be claimed: reading or sending
a real Page message (needs the real token), and the Meta webhook
subscription itself (needs the app registered in the Meta developer app).
