# Google sign-in for the Prism app (Nov 17, 2026)

Accounts used to be a device-generated id in localStorage, sent as
`X-Account-Id`. The server created the account on first sight, and
everything hung off that device id. Clearing browser data, losing the
phone, or switching devices lost the account, with no way back in.

Now the owner signs in with Google and the account follows the person.
Same OAuth client as Gmail, no new service, no new cost.

## How it works

- **Sign-in button** in Upkeep ("Your account" card). It goes to
  `GET /api/oauth/google/start-signin?accountId=<device id>`, which
  redirects to Google with scopes `openid email profile` only
  (identity, nothing else).
- **Same redirect URI as Gmail** (`/api/oauth/google/callback`), so
  nothing had to be registered in the Google Cloud console. The state
  tells the flows apart: `<deviceAccountId>:signin` is an app sign-in,
  anything else is a Gmail label.
- **Linking.** The callback exchanges the code, reads the Google
  profile (sub, email, name), and links it:
  - New Google identity: the device account id becomes the permanent
    account id. Nothing moves, nothing is lost.
  - Known Google identity on a different device id: the device's data
    migrates into the Google-linked account (owned Photons/products,
    threads, messages, Gmail/Outlook connections, profile, imported
    memory, customizations, contacts, reminders, texts, calls, Stripe
    payments, perks, backstories). Where the account already has a row
    for the same thing, the account's row wins. The old device account
    row is deleted. The accounts row merges: earlier creation date,
    union of upkeep/free-code flags, custom name when the account has
    none, this month's meter summed.
- **Session handoff.** The callback does not put the account id in the
  URL. It mints a one-time session token (10 minutes), redirects to
  `/?tab=upkeep&signin=ok&session=<token>`, and the client spends it
  once via `POST /api/auth/session` for the account id, stores it in
  localStorage, and strips the token from the address bar.
- **Sign-out** is local only: the browser drops the account id and
  starts a fresh anonymous device id. Everything stays on the server;
  signing back in with the same Google account recovers it.
- **Staying signed in.** The account id lives in localStorage, same as
  before. Clearing browser data wipes the local copy, and the account
  itself is untouched on the server — sign in again and it comes back.
- **What Google sees.** Only the standard OAuth consent for name,
  email, and profile picture scope. The app reads no mailbox, calendar,
  or Drive content through the sign-in itself; Gmail/Calendar/Drive
  remain their own separate connections on the Inboxes tab.

## Account-creation perks

Created once, when a Google identity is first linked:

1. **Backstories.** One fictional backstory per Photon
   (`src/shared/backstories.ts`), rendered with the owner's name and
   the day the account was created. Shown in the Upkeep account card
   (Prism's story) and under a Photon's introduction when its thread
   is empty. Display only — never read into a chat system prompt.
   Fixed text, not generated: same every time, costs nothing, never
   fails.
2. **Welcome offer: 15% off the first order, code WELCOME15, 10 days
   from account creation.**
   - Stripe: coupon `welcome15` (15% off, duration once) and promotion
     code `WELCOME15` (first-time-transaction restriction, no expiry —
     the 10-day window is per account, enforced by the app).
   - All 74 live Payment Links have `allow_promotion_codes: true`, so
     the code works at checkout (Stripe's own docs: a prefilled promo
     code has no effect unless promotion codes are enabled on the link).
     Verified by re-listing the account after the update: 74/74 true
     (69 active, 5 inactive).
   - The app records the perk per account (`account_perks`: code,
     created_at, expires_at = created_at + 10 days, used_at). While
     active, the Store shows the banner and every Buy button prefills
     the code (`prefilled_promo_code=WELCOME15`), so the discount is
     already there when the checkout page opens. After 10 days or one
     use, the banner disappears and the code stops prefilling.
   - The Stripe webhook marks the perk used when a discounted checkout
     lands (`total_details.amount_discount > 0` on the session).

## Files

- `src/shared/backstories.ts` — the 12 backstories + rendering.
- `src/server/auth.ts` — identities, sessions, perks, backstories,
  migration, the OAuth callback handler.
- `src/server.ts` — `stateFor` gains `auth`, `perk`, `backstories`;
  routes `start-signin`, `auth/session`, `auth/status`; the Gmail
  callback branches on `:signin` state.
- `src/server/stripe.ts` — webhook spends the welcome perk on a
  discounted checkout.
- `client/api.ts` — `setAccountId` / `clearAccountId`, `authStatus`,
  `authSession`.
- `client/main.ts` — sign-in return handling, sign in/out actions,
  account card in Upkeep, perk banner in the Store, prefilled promo
  code on Buy buttons, backstory under the empty-thread intro.
- `scripts/test-auth.ts` — 40 checks (see below).

## Tests

`bun scripts/test-auth.ts` — 40 checks, all passing (Nov 17, 2026):

- HTTP: unsigned account reads not signed in; start-signin 302s to
  Google with the Gmail redirect URI, identity-only scopes, offline
  access, and `<device>:signin` state; a fake authorization code
  redirects to the error page (checked against real Google); a bad
  session token is refused.
- Link: first link keeps the device id, perk created (WELCOME15, 10
  days, active), 12 backstories, name and date personalised.
- Migration: second device with the same Google identity lands on the
  same account; Photon ownership, thread, Gmail connection, and custom
  name move; the old device account row is gone.
- Sessions: spend once, second spend refused, expired refused.
- Perks: spend once, second spend refused, expired reads inactive.
- State: carries auth, perk, and 12 backstories.
- Client (jsdom): signed-in Upkeep shows the account, the offer, and
  Prism's story; the Store shows the banner and Buy links carry
  `prefilled_promo_code=WELCOME15`.

One bug found by the tests and fixed: migration first deleted rows
whose primary key does not include `account_id` (messages, reminders,
day items, Stripe payments, Google identities) because the copy clashed
with the row itself. Those tables now move with a plain UPDATE; only
tables whose key includes `account_id` use copy-and-delete.

## Still to verify live (needs a browser + a Google login)

- Tap "Sign in with Google" in Upkeep on the live app, pick a Google
  account, allow: lands back signed in, with the welcome offer and
  Prism's story in Upkeep.
- Sign in on a second browser/device with the same Google account:
  same account, same Photons and chats.
- Sign out, sign back in: the account comes back.
- Checkout page with the prefilled code: the 15% discount shows before
  paying (no purchase needed to look — do not complete one for a test).

## Stripe records (live account: Prism 5 Labs, acct_1Ub1xPCcvbCluCuO)

- Coupon `welcome15`: 15% off, duration once, valid.
- Promotion code `WELCOME15` (promo_1UcxE7CcvbCluCuOto8v8IsU): active,
  first-time-transaction only, coupon `welcome15`, no expiry.
- All live Payment Links updated to `allow_promotion_codes: true`
  (74 links: 69 active, 5 inactive; verified by re-listing).
