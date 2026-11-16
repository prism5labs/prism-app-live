# WIRING — Step 1 (texts) + Step 7 (calls and caller ID)

Module: `src/server/telephony.ts` (only new file in this step, plus this
doc). It creates its own tables at import, reads its env vars directly,
and exports one handler per route. Nothing in `server.ts`, `db.ts`,
`config.ts`, `personas.ts`, `render.yaml`, `package.json`, or `client/`
was touched — the coordinator mounts the routes below and consolidates
the env vars into `config.ts` at merge time.

Status: **code ready, needs a Twilio account and number to go live.**
With no Twilio env vars the server starts fine and every JSON endpoint
answers `not_connected` in plain words. Nothing is sent, dialed, or
claimed until the owner connects a number.

## 1. Routes to mount in server.ts

Add the import at the top of `server.ts` (next to the gmail import):

```ts
import {
  getTextsStatus,
  listTexts,
  sendText,
  incomingText,
  listCalls,
  dialCall,
  voiceWebhook,
  voicemailCallback,
} from "./server/telephony";
```

Add these blocks inside `handleApi`, following the existing route
pattern. JSON endpoints use the existing `accountIdFrom(req, body)` and
`isValidAccountId` checks; webhooks take the account id from the query
string (`?accountId=...`) because Twilio calls them, not the app.

```ts
// GET /api/texts/status — configured or not, number masked.
if (path === "/api/texts/status" && method === "GET") {
  const accountId = accountIdFrom(req, {});
  if (!isValidAccountId(accountId)) return bad("accountId required", 400);
  return getTextsStatus(req, accountId);
}

// GET /api/texts — stored inbound/outbound texts (?limit=, default 50, max 100).
if (path === "/api/texts" && method === "GET") {
  const accountId = accountIdFrom(req, {});
  if (!isValidAccountId(accountId)) return bad("accountId required", 400);
  return listTexts(req, accountId);
}

// POST /api/texts/send — owner-tap send. Body: { accountId, to, body }.
// `to` is a phone number, or an email address (the contact's phone column
// is used). Only approved contacts; otherwise contact_not_approved.
if (path === "/api/texts/send" && method === "POST") {
  const body = await readBody(req);
  const accountId = accountIdFrom(req, body);
  if (!isValidAccountId(accountId)) return bad("accountId required", 400);
  return sendText(req, accountId, body);
}

// POST /api/texts/incoming — Twilio webhook (form-encoded). No accountId
// check in server.ts: the handler reads ?accountId= from the URL and
// validates the Twilio signature itself.
if (path === "/api/texts/incoming" && method === "POST") {
  return incomingText(req);
}

// GET /api/calls — the call log (?limit=, default 50, max 100).
if (path === "/api/calls" && method === "GET") {
  const accountId = accountIdFrom(req, {});
  if (!isValidAccountId(accountId)) return bad("accountId required", 400);
  return listCalls(req, accountId);
}

// POST /api/calls/dial — owner-tap outbound call. Body: { accountId, to }.
// Only approved contacts; otherwise contact_not_approved. Needs APP_URL
// set (Twilio fetches the call instructions from it).
if (path === "/api/calls/dial" && method === "POST") {
  const body = await readBody(req);
  const accountId = accountIdFrom(req, body);
  if (!isValidAccountId(accountId)) return bad("accountId required", 400);
  return dialCall(req, accountId, body);
}

// POST /api/calls/voice — TwiML webhook for inbound calls (and the Url
// Twilio fetches for outbound dials). Greets, records a voicemail with
// transcription on.
if (path === "/api/calls/voice" && method === "POST") {
  return voiceWebhook(req);
}

// POST /api/calls/voicemail — Twilio transcription callback. Signature
// validated; transcript stored on the call row and as a message the
// Photon can read (see §5).
if (path === "/api/calls/voicemail" && method === "POST") {
  return voicemailCallback(req);
}
```

Also add the telephony status to `/api/state` if wanted (optional,
not required): `telephony: twilioConfigured()` — import
`twilioConfigured` from `./server/telephony`.

Note: `sendText` and `dialCall` take the already-parsed `body` as a
third argument because `server.ts`'s `readBody(req)` consumes the
request — a handler that re-read it would get nothing. Passing the
body through is the same pattern the chat routes use with `prepareChat`.

## 2. Env vars (set in the Render dashboard; never in the repo)

| Name | Purpose | Where the owner gets it |
|---|---|---|
| `TWILIO_ACCOUNT_SID` | Twilio account id; used in the API URL and Basic auth | Twilio Console dashboard (Account SID on the home page) |
| `TWILIO_AUTH_TOKEN` | Twilio auth token; Basic auth password, and the key for webhook signature validation | Twilio Console dashboard (Auth Token on the home page; can be rotated there) |
| `TWILIO_PHONE_NUMBER` | The provider number texts and calls go out from, in E.164 (e.g. `+15551234567`) | Twilio Console → Phone Numbers → Buy a Number (a US number is on the order of a dollar or two a month; confirm with Twilio at build time) |
| `APP_URL` | Already exists in `config.ts`. The public base URL of the app; Twilio fetches call instructions from it, so outbound dials fail with `no_public_url` until it is set | Render dashboard (the deployed service URL, e.g. `https://app.prism5labs.com`) |

No other env vars. The free unlock code is untouched and lives only
in the Render `FREE_CODE` env var, as before.

### Twilio console setup (owner step, after deploy)

1. Buy a number in Twilio Console → Phone Numbers.
2. On that number, set the webhooks (replace `<APP_URL>` with the real
   public URL and `<ACCOUNT_ID>` with the owner's account id from the
   app — the id is in the app's local storage / state):
   - Messaging webhook (incoming text):
     `https://<APP_URL>/api/texts/incoming?accountId=<ACCOUNT_ID>`
   - Voice webhook (incoming call):
     `https://<APP_URL>/api/calls/voice?accountId=<ACCOUNT_ID>`
   - The voicemail transcription callback is set by the app itself on
     each call (`transcribeCallback` in the TwiML), so nothing to set
     by hand.
3. Set the three env vars above in Render and redeploy.

Costs are Twilio's, not ours: a number and per-text / per-minute
charges apply. Confirm current prices in the Twilio Console at build
time; this doc states no prices as fact.

## 3. Persona truth lines (what the Photon may say)

Use these verbatim-ish in `personas.ts` when telephony is wired in.
When unconnected, the Photon must say so plainly and never claim texts
or calls work:

- "I can read and send texts from your Twilio number, but only to contacts you've approved — nothing goes out without your tap."
- "Calls come in on the same number. I don't answer them live; they go to voicemail, I read the transcript, and I can draft you a reply or a callback."
- "If I don't recognise a number, I just call it an unknown number. I never guess a name."
- When unconnected: "Texts and calls aren't connected yet — there's no phone number set up on the server, so I can't send a text or place a call."

## 4. Client UI snippet

No client files were edited. Two anchors in `client/main.ts`:

### (a) Texts & Calls card in Inboxes — anchor: `renderInboxes()` (~line 565)

Add a card above the Gmail cards (after the `.switchboard-strip`
div), fed by `GET /api/texts/status`, `GET /api/texts`, and
`GET /api/calls`:

```html
<div class="card inbox-card">
  <h3>Texts &amp; calls</h3>
  <!-- when configured: -->
  <p class="fine">Your number: (***) ***-4567</p>
  <!-- each text: -->
  <div class="inbox-msg">
    <p class="inbox-subject">Test Friend · inbound</p>
    <p class="inbox-snippet">Hello back</p>
    <p class="inbox-meta">+15557654321 · 2026-11-16</p>
  </div>
  <!-- each call: -->
  <div class="inbox-msg">
    <p class="inbox-subject">Voicemail from Test Friend</p>
    <p class="inbox-snippet">Hi, this is a test voicemail.</p>
    <p class="inbox-meta">+15557654321 · voicemail</p>
  </div>
  <!-- when not configured: -->
  <p>Texts and calls aren't connected yet. Add your Twilio number in the server settings to turn them on.</p>
</div>
```

Sending and dialing stay owner-tap from chat for now: the Photon
drafts the reply, the owner taps send, the client calls
`POST /api/texts/send` with `{ accountId, to, body }` (or
`POST /api/calls/dial` with `{ accountId, to }`). A dedicated compose
box in this card is a follow-up, not part of this step.

### (b) Phone column on contacts — anchor: `renderSwitchboardContacts()` (~line 532)

The contacts table now has a `phone TEXT` column (added by the module
at import with `ALTER TABLE ... ADD COLUMN`, wrapped so it no-ops if
the column already exists). The row renderer should show the phone
next to the email when present, and the "Request a connection" form
should gain an optional phone field:

```html
<input name="phone" type="tel" placeholder="Phone (optional)">
```

The `GET /api/contacts` response does not yet include `phone` — the
coordinator adds it to that route's mapping when wiring this step
(`phone: c.phone` needs a `phone` field on the db `Contact` type, which
is a `db.ts` edit and therefore out of scope here). Until then, the
phone is stored and used server-side for vetting and caller ID, and
the client cannot display or edit it. Approval still flows through
the existing email friend-request: once a contact approves by email,
texts and calls to their phone are allowed.

## 5. How voicemails surface (for the Photon and the Inboxes UI)

- `calls` table row: the source of truth — `GET /api/calls` returns
  each call with `fromLabel` (contact name or `"unknown number"`),
  `status` (`in_progress` → `voicemail` / `voicemail_failed`),
  `transcript`, and `recordingUrl`.
- Chat thread: the transcription callback also appends a user message
  to the **Prism** thread via `addMessage`:
  `Voicemail from <label> (<number>): <transcript>`. That is how the
  Photon reads it in chat history and can answer it like any other
  message. If transcription failed, no thread message is added — the
  call row still records `voicemail_failed`.
- Inboxes tab: surface voicemails from `GET /api/calls` using the card
  in §4(a). Do not surface them from the chat thread.

Caller ID: `callerIdFor(accountId, phone)` is exported from the
module. It matches the number against the contacts table by the phone
column (last-10-digits match, so formatting differences don't matter).
Known → the contact's name. Unknown → `{ name: null, label: "unknown
number", known: false }`. Never a guessed name.

## 6. What is NOT live yet (honest limits)

- No real Twilio account or number is connected; nothing can be sent
  or dialled until §2 is done. The code degrades to `not_connected`
  until then.
- No live-voice answering: inbound calls go to voicemail with a
  transcript. The Susan protocol (answering unknown callers as the
  owner's assistant) rides on this later, not now.
- No device pairing: texts and calls use the provider number, not the
  owner's own phone number or history. Pairing is the later step from
  the design doc.
- No scheduled / proactive text checks: inbound texts are filed when
  Twilio delivers them; nothing polls for them.
- One number routes by `?accountId=` in the webhook URL. A shared Labs
  number that routes by owner is a build-time decision for later.

## 7. How to verify live

Prereqs: server running with the module mounted (§1) and the env vars
in §2 set. `<ACCT>` is the owner's account id.

```bash
# 1. Status: configured, number masked.
curl -s "https://<APP_URL>/api/texts/status?accountId=<ACCT>"
# -> {"ok":true,"configured":true,"phoneNumber":"(***) ***-4567"}

# 2. Unconnected behaviour (unset the Twilio vars and restart): every
# JSON endpoint answers not_connected and the server still starts.
curl -s "https://<APP_URL>/api/texts?accountId=<ACCT>"
# -> {"ok":false,"error":"not_connected",...}

# 3. Send to a number that is not an approved contact: refused, nothing sent.
curl -s -X POST "https://<APP_URL>/api/texts/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"<ACCT>","to":"+15559998888","body":"hi"}'
# -> {"ok":false,"error":"contact_not_approved",...}

# 4. Send to an approved contact (phone on their contact row): real Twilio send.
curl -s -X POST "https://<APP_URL>/api/texts/send" \
  -H 'content-type: application/json' \
  -d '{"accountId":"<ACCT>","to":"+15557654321","body":"hi from Prism"}'
# -> {"ok":true,"sent":true,"messageSid":"SM...","contactName":"..."}

# 5. Lists show the stored text with the caller-ID label.
curl -s "https://<APP_URL>/api/texts?accountId=<ACCT>"
curl -s "https://<APP_URL>/api/calls?accountId=<ACCT>"

# 6. Dial an approved contact (needs APP_URL set).
curl -s -X POST "https://<APP_URL>/api/calls/dial" \
  -H 'content-type: application/json' \
  -d '{"accountId":"<ACCT>","to":"+15557654321"}'
# -> {"ok":true,"placed":true,"callSid":"CA...","contactName":"..."}

# 7. Inbound path: text the Twilio number from a phone, then check
# GET /api/texts — the row appears with fromLabel set. Call the number,
# leave a voicemail, then check GET /api/calls for the transcript and
# the Prism chat thread for the "Voicemail from ..." message.
```

### Verification done in this worktree (Nov 16, 2026)

`bun run typecheck` passes. Verified over HTTP on port 10101 with a
throwaway harness in `/tmp` (the real `server.ts` does not mount these
routes yet — that is the coordinator's §1 job — so the harness mounted
the handlers identically to prove them; harness and seed scripts are in
`/tmp/step1-test-server.ts` and `/tmp/step1-seed.ts`, not in the repo):

- No Twilio env: server starts; `/api/texts/status`, `/api/texts`,
  `/api/calls`, `/api/texts/send`, `/api/calls/dial` all return
  `{ok:false,error:"not_connected"}`; the incoming webhook returns an
  empty TwiML response.
- Dummy Twilio env (`ACaaa…`, dummy token, `+15551234567`):
  status returns `{ok:true,configured:true,phoneNumber:"(***) ***-4567"}`;
  send to an unapproved number returns `contact_not_approved` with no
  provider call; send to the approved seeded contact attempts Twilio
  and fails cleanly with `provider_auth_failed` (Twilio 401 — one
  attempt only, proving the call path reaches auth); dial with no
  `APP_URL` returns `no_public_url` before any provider call; the
  voice webhook returns TwiML with `<Say>`, `<Record transcribe="true"
  transcribeCallback=".../api/calls/voicemail?accountId=...">`, and
  `<Hangup/>`.
- Signed webhooks (real HMAC-SHA1 signatures computed over the URL +
  sorted params): a forged signature is rejected with 403 and stores
  nothing; a valid inbound text is stored and listed with
  `fromLabel: "Test Friend"`; a valid voicemail callback updates the
  call row to `voicemail` with transcript + recording URL and appends
  `Voicemail from Test Friend (+15557654321): Hi, this is a test
  voicemail.` to the Prism thread.
- No real credentials, numbers, or money were used: all Twilio values
  in testing were dummies, and no real message or call was placed.
