# Step 10 — Wiring guide (research + automatic unlocks)

Code is ready; the routes are NOT live yet. This file tells the coordinator
exactly what to mount in `server.ts`, what the client must change, which env
vars to set, and how to verify. Nothing in this step edits `server.ts`,
`db.ts`, `personas.ts`, `config.ts`, `render.yaml`, `package.json`, or any
client file — those edits are the coordinator's, listed below.

New files in this step (only these):

- `src/server/research.ts` — Brave Search adapter + `POST /api/research`
- `src/server/stripe.ts` — Stripe webhook + `GET /api/stripe/status`

## 1. Routes to mount in server.ts

Add imports at the top of `src/server.ts`, next to the other `./server/*`
imports:

```ts
import { handleResearch } from "./server/research";
import { handleStripeWebhook, handleStripeStatus } from "./server/stripe";
```

Add these branches inside `handleApi(req, path)`, alongside the other
`/api/*` branches. Order matters only for the webhook (see the raw-body
rule below).

```ts
// POST /api/research — body: { accountId, query }.
// Returns { ok: true, query, provider: "brave",
//   results: [{ title, url, snippet, source }] }, always with sources.
// Without a Brave key: { ok: false, error: "research_not_connected" }
// with a plain-words message. Query capped at 500 chars.
if (path === "/api/research" && method === "POST") {
  return await handleResearch(req);
}

// POST /api/stripe/webhook — Stripe posts events here.
// ⚠️ RAW BODY RULE — read this before mounting. handleStripeWebhook(req)
// reads the request body itself with req.text(). server.ts MUST route this
// path straight to handleStripeWebhook(req) and MUST NOT call readBody(req)
// (req.json()) for it first. Parsing the body as JSON destroys the exact
// bytes Stripe signed, and every signature check would then fail with 400.
// No other route in handleApi reads the body before its branch, so routing
// this path to the handler first is all it takes — just do not add a
// readBody call above it for this path.
if (path === "/api/stripe/webhook" && method === "POST") {
  return await handleStripeWebhook(req);
}

// GET /api/stripe/status — { ok: true, configured: boolean,
// webhook: "/api/stripe/webhook" }. Never returns the secret.
if (path === "/api/stripe/status" && method === "GET") {
  return await handleStripeStatus(req);
}
```

No `config.ts` change is needed for this step: both modules read
`process.env` directly at call time (the coordinator consolidates env
handling into `config.ts` at merge, if wanted).

## 2. Env vars (Render dashboard — never commit a value)

| Var | Who provides it | Where it comes from |
| --- | --- | --- |
| `BRAVE_SEARCH_API_KEY` | Neil / Calyn | Brave Search API key from their Brave account (https://api.search.brave.com — a Brave Search API subscription). Without it, `/api/research` answers `research_not_connected` honestly and nothing breaks. |
| `STRIPE_WEBHOOK_SECRET` | Neil / Calyn | Stripe Dashboard → Developers → Webhooks → add endpoint `https://<app-domain>/api/stripe/webhook`, subscribe to `checkout.session.completed` only, then copy the endpoint's **Signing secret** (`whsec_…`) into Render. Without it, the webhook answers `webhook_not_configured` (400) and unlocks keep running through codes. |

No Stripe API key is needed: the webhook secret alone proves an event
came from Stripe. No money was spent in this step; the only keys used in
verification were throwaway test secrets (`whsec_test_step10_only` and a
fake Brave key), never real credentials.

## 3. Persona truth lines (for `src/server/personas.ts`)

Add these to the truth block in `personas.ts`, so a Photon only ever
describes what is real. They are honest when the pieces are unconnected:

> I can look things up live on the web, and when I do I show you where I
> found it, so you can check it yourself.
> If web search isn't connected on this server yet, I say so plainly
> instead of guessing — paste the page or the facts here and I'll work
> from that.
> When you buy something in the Store, it unlocks on its own once Stripe
> tells the server the payment landed.
> If a purchase doesn't show up after you paid, I never pretend it
> unlocked — it needs a code, or a person to check it.

## 4. Client change — buy flow must carry the account id (coordinator)

Today the buy buttons carry no account id at all: Photon links carry only
`?client_reference_id=Photon-<Name>` (`photonBuyUrl` in
`src/shared/catalog.ts`), product links carry `?client_reference_id=<slug>-<variant>`
(`client/main.ts` `productCard`, ~line 629), and the Supernova / Satellite /
Upkeep tier and monthly links carry no `client_reference_id` at all
(`client/main.ts` `renderStore`, ~lines 679–697). Without the account id in
the Stripe session, the webhook can record the payment but cannot unlock
anything on the buyer's account.

### Format

`client_reference_id` becomes `<accountId>:<hint>`, where `<accountId>` is
`getAccountId()` from `client/api.ts` and `<hint>` is the existing hint
(or a new one for the tier links). The server splits on the first `:` or
`|`, and only trusts an account part starting with `acc_` (the format
`client/api.ts` generates) — a bare hint such as `Photon-Prism` is never
mistaken for an account.

Hint vocabulary the server understands (`src/server/stripe.ts`,
`unlocksForHint`):

- `Photon-<Name>` → unlocks that Photon (Name must be one of the 12)
- `<catalog slug>` or `<catalog slug>-personal` / `-business` → that Spark/Plug
- `supernova`, `supernova-monthly`, `supernova-two-year`, `supernova-annual` → product `supernova`
- `satellite`, `satellite-monthly`, `satellite-two-year`, `satellite-annual` → product `satellite`
- `upkeep` → Upkeep on

### Exact snippet — anchor: `client/main.ts`, next to `buyButton` (~line 616)

```ts
// Step 10: every Stripe checkout carries the account id, so the webhook
// can unlock the purchase on the buyer's account. Format:
// "<accountId>:<hint>". The server only trusts an account part starting
// with "acc_"; a bare hint unlocks nothing.
function buyUrl(url: string, hint: string): string {
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}client_reference_id=${encodeURIComponent(getAccountId() + ":" + hint)}`;
}
```

Then change the call sites (same file):

```ts
// productCard (~line 629) — was:
//   buyButton(v.url + "?client_reference_id=" + p.slug + "-" + storeVariant, v.total, owned)
// becomes:
buyButton(buyUrl(v.url, p.slug + "-" + storeVariant), v.total, owned)

// Photon cards (~line 658) — photonBuyUrl() in src/shared/catalog.ts still
// appends "?client_reference_id=Photon-<Name>"; do not use it for the buy
// link any more. Use the bare Supernova URL with the Photon as the hint:
// becomes:
buyButton(buyUrl(SUPERNOVA.url, "Photon-" + p.name), "$514.00", owned)

// Supernova poster (~line 679) and its monthly links:
//   buyButton(buyUrl(SUPERNOVA.url, "supernova"), "$514.00", ...)
//   <a class="btn small" href="${esc(buyUrl(SUPERNOVA.monthly.url, "supernova-monthly"))}" ...>$49/mo</a>
//   <a class="btn small" href="${esc(buyUrl(SUPERNOVA.twoYear.url, "supernova-two-year"))}" ...>$39/mo · 2-year</a>
//   <a class="btn small" href="${esc(buyUrl(SUPERNOVA.annual.url, "supernova-annual"))}" ...>$539/yr</a>

// Satellite poster (~line 685) and its monthly links: same pattern with
// "satellite", "satellite-monthly", "satellite-two-year", "satellite-annual".

// Upkeep card (~line 697):
//   buyButton(buyUrl(UPKEEP.url, "upkeep"), "$29.87", state?.upkeep === true)
```

Open point, do not invent: a bare Supernova / Satellite tier buy names no
Photon, so the webhook unlocks only the tier product flag — the app has no
flow yet for a tier buyer to pick which Photon that unlocks. Neil /
coordinator to decide (e.g. first Photon opened after a Supernova buy
claims it, or a pick-a-Photon step at checkout). Until that is decided, a
Photon bought through its own card is the path that unlocks a Photon.

### Optional client snippet — research action (anchor: `client/api.ts`, inside `api`)

```ts
research: (query: string) =>
  req("/api/research", {
    method: "POST",
    body: JSON.stringify({ accountId: getAccountId(), query }),
  }),
```

Wire it to a "check this" action in the chat UI when the UI work lands.
Until then the endpoint is for pasted research: the owner pastes a page
or facts, and the Photon works from that.

### Brain tool-use is a follow-up, not this step

`src/server/anthropic.ts` was deliberately NOT touched: the brain cannot
call `/api/research` as a tool yet. That integration (a research tool the
brain can call mid-chat, with results cited in the reply) is follow-up
work. Until it lands, a Photon must not claim it can look things up live
on its own — the persona lines above say it can only when the search is
actually connected, and the check-this action / pasted research is the
honest path.

## 5. How the webhook maps a payment (so the coordinator can reason)

`src/server/stripe.ts`, `mapCheckoutSession` + `applyUnlocks`, using
`ownPhoton` / `ownProduct` / `setUpkeep` from `./db`:

1. Account id: `metadata.account_id` if present and `acc_`-prefixed,
   otherwise the account part of `client_reference_id`. No account id →
   payment recorded in `stripe_payments` with `account_id NULL`, 200,
   nothing unlocked.
2. Product: `metadata.product_slug` / `metadata.product` /
   `metadata.photon` first, then the `client_reference_id` hint, then —
   only when there is no usable hint — an amount fallback for totals that
   name exactly one thing ($514.00 Supernova, $101.97 Satellite, $29.87
   Upkeep, $50.47 / $555.17 Supernova monthly / annual, $33.99 / $26.78 /
   $373.89 Satellite monthly / 2-year / annual).
3. Deliberately NOT mapped from amount alone, because the amount cannot
   tell which one it is: $40.17 (Supernova 2-year AND Plug personal),
   $19.57 / $25.75 (every Spark), $60.77 (every Plug business). Those rely
   on the hint from the client snippet above. Unknown product → payment
   recorded, 200, nothing unlocked, and a `[stripe]` log line — never a
   guessed unlock.
4. Redelivery is safe: `stripe_payments.session_id` is the primary key
   (`INSERT OR IGNORE`) and `owned` rows are `INSERT OR IGNORE`, so
   Stripe retrying an event cannot double-unlock.
5. Every other event type is acknowledged with 200 and ignored.
6. `stripe_payments` table is created in `stripe.ts` itself
   (`CREATE TABLE IF NOT EXISTS` at import): `session_id, amount_total,
   currency, product, account_id, received_at`. `listStripePayments()`
   is exported for checking receipts.

## 6. How to verify live (after the coordinator mounts the routes)

Run the server on port 10108 with a scratch data dir:

```bash
cd <worktree>
PORT=10108 DATA_DIR=/tmp/step10-research-unlocks-data bun src/server.ts
```

### (a) Nothing configured — honest not-connected answers, server starts

```bash
curl -s http://localhost:10108/healthz
# {"ok":true,"brain":false,"provider":"none"}

curl -s http://localhost:10108/api/stripe/status
# {"ok":true,"configured":false,"webhook":"/api/stripe/webhook"}

curl -s -X POST http://localhost:10108/api/research \
  -H 'content-type: application/json' \
  -d '{"accountId":"acc_test1234567890abcdef","query":"Green Bay weather"}'
# {"ok":false,"error":"research_not_connected","message":"Web search isn't connected on this server yet. ..."}

curl -s -X POST http://localhost:10108/api/stripe/webhook \
  -H 'content-type: application/json' \
  -d '{"id":"evt_test","type":"checkout.session.completed","data":{"object":{"id":"cs_test"}}}'
# 400 {"ok":false,"error":"webhook_not_configured","message":"..."}
```

### (b) Webhook with a correctly signed test payload → 200 + unlock

Restart with the secret set (use the real `whsec_…` from Stripe, or a
test value for a dry run — never paste a real secret into a file):

```bash
PORT=10108 DATA_DIR=/tmp/step10-research-unlocks-data \
  STRIPE_WEBHOOK_SECRET=whsec_test_step10_only bun src/server.ts
```

Sign a payload exactly the way Stripe does — HMAC-SHA256 over
`"<unix timestamp>.<raw JSON body>"`, header
`Stripe-Signature: t=<timestamp>,v1=<hex>` (Bun one-liner; replace the
secret with the one the server is running with):

```bash
bun -e '
const secret = "whsec_test_step10_only";
const raw = JSON.stringify({ id: "evt_test_step10_001", type: "checkout.session.completed",
  data: { object: { id: "cs_test_step10_001", object: "checkout.session",
    mode: "payment", amount_total: 51400, currency: "usd",
    client_reference_id: "acc_test1234567890abcdef:Photon-Prism", metadata: {} } } });
const ts = Math.floor(Date.now() / 1000);
const h = new Bun.CryptoHasher("sha256", secret);
h.update(`${ts}.${raw}`);
const sig = `t=${ts},v1=${h.digest("hex")}`;
const res = await fetch("http://localhost:10108/api/stripe/webhook",
  { method: "POST", headers: { "content-type": "application/json", "Stripe-Signature": sig }, body: raw });
console.log(res.status, await res.text());
'
# 200 {"ok":true,"received":true,"session":"cs_test_step10_001",
#   "accountId":"acc_test1234567890abcdef","unlocked":["photon:Prism"],
#   "unmapped":false,"product":"Photon-Prism"}
```

Confirm the unlock stuck (same `DATA_DIR`):

```bash
bun -e '
import { Database } from "bun:sqlite";
const db = new Database("/tmp/step10-research-unlocks-data/app.db");
console.log(db.query("SELECT account_id, kind, ref FROM owned").all());
console.log(db.query("SELECT session_id, product, account_id FROM stripe_payments").all());
'
```

### (c) Same payload, bad signature → 400

Re-run the signing one-liner above with a wrong secret (e.g.
`"whsec_wrong_secret"`) while the server still runs with the right one:

```bash
# 400 {"ok":false,"error":"bad_signature"}
```

A stale timestamp (more than 5 minutes old) is also 400
(`stale_signature`); a missing header is 400 (`missing_signature`).

### (d) Live research (needs the real Brave key)

```bash
PORT=10108 DATA_DIR=/tmp/step10-research-unlocks-data \
  BRAVE_SEARCH_API_KEY=<real key> bun src/server.ts

curl -s -X POST http://localhost:10108/api/research \
  -H 'content-type: application/json' \
  -d '{"accountId":"acc_test1234567890abcdef","query":"Green Bay weather"}'
# {"ok":true,"query":"Green Bay weather","provider":"brave",
#  "results":[{"title":"...","url":"...","snippet":"...","source":"..."}]}
```

And the end-to-end Stripe check: in the Stripe Dashboard, send a test
event (`checkout.session.completed`) to the webhook endpoint, or make a
test-mode purchase through a Payment Link with
`?client_reference_id=<accountId>:Photon-Prism` appended, then check
`GET /api/state?accountId=<accountId>` shows the Photon owned.

## 7. What was verified in this step, and what was NOT

Verified Nov 15, 2026, in this worktree (branch
`step10-research-unlocks`, base `8b7df68`):

- `bun run typecheck` passes.
- Real server starts on port 10108 with
  `DATA_DIR=/tmp/step10-research-unlocks-data`; `/healthz` returns
  `{"ok":true,"brain":false,"provider":"none"}`. (Routes return 404 there
  until the coordinator mounts them — expected.)
- Via a throwaway harness in `/tmp` mounting the handlers exactly as
  §1 prescribes (the harness is not in the repo): with no env vars,
  status reports `configured:false`, research returns
  `research_not_connected`, webhook returns 400 `webhook_not_configured`,
  research rejects a missing account id (400) and a 501-char query (400).
- With `STRIPE_WEBHOOK_SECRET=whsec_test_step10_only`: a correctly
  HMAC-signed `checkout.session.completed` for
  `acc_test1234567890abcdef:Photon-Prism` returns 200 and unlocks
  `photon:Prism` (confirmed in SQLite: `owned` row present); redelivery
  of the same session id returns 200 without double-unlocking; the same
  payload with a wrong secret returns 400 `bad_signature`; a 10-minute-old
  timestamp returns 400 `stale_signature`; a missing header returns 400
  `missing_signature`; another event type returns 200 `ignored:true`.
- A legacy link (`Photon-Prism`, no account id) returns 200, is recorded
  in `stripe_payments` with `account_id NULL`, and unlocks nothing —
  this caught a real bug during verification (the loose account regex
  accepted `Photon-Prism` as an account id) and the fix is in
  `stripe.ts`: webhook parsing only trusts `acc_`-prefixed account ids.
- An unmappable product (`mystery-thing`) returns 200, is recorded, and
  unlocks nothing. A Spark hint unlocks its product slug; an `upkeep`
  hint turns Upkeep on (both confirmed in SQLite).
- With a fake Brave key, research returns `research_failed` with the
  plain-words message — the fetch path and error mapping work.

NOT verified (code ready, needs the real thing — say so plainly):

- Live Brave results with a real `BRAVE_SEARCH_API_KEY` (no real key
  exists in this step; §6(d) is the check to run once Neil/Calyn provide one).
- A real Stripe event from the Stripe Dashboard, or a real test-mode
  purchase through a Payment Link (§6 end-to-end check).
- Brain tool-use integration (follow-up, §4) and the client buy-flow
  snippet (§4) — both are coordinator / later work, not in this step.
