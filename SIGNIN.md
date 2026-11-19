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
- **Sign-in recovery (Nov 19, 2026).** The session handoff above
  assumes the callback loads in the same browsing context that asked
  to sign in. On Android it does not: the installed app's navigation
  to Google is diverted to a browser tab (a Custom Tab, with its own
  bar and X), the callback loads there, and the one-time token is
  spent there — the installed app never learns the linked account id,
  and the token cannot be spent twice. Worse, when the Google identity
  was already linked (signed in once before from another context), the
  sign-in migrates the app's anonymous device id into the linked
  account and deletes it, so the app recreates itself as a fresh
  anonymous account on every open — the "must reconnect Google every
  time" loop, with Calendar/Drive tokens stranded under the linked
  account while the app asks under the orphaned id. The fix is
  server-side and does not depend on which context spent the token:
  the callback records device id -> account id (`signin_links`) at
  link time, and the client asks `POST /api/auth/recover` on boot (and
  when the app comes back from the browser) and adopts the linked id
  in its own context, finishing the migration — including any
  Calendar/Drive tokens connected while the app was orphaned. The
  device id is already the whole credential for the account, so this
  reveals nothing new.
- **Connection state, in plain words (Nov 19, 2026).** The header
  carries a glanceable pill — Google connected / not connected /
  checking / unreachable — and the Upkeep account card carries the
  same four states, so the two can never disagree. While the server is
  still answering the card says it is checking, never "not signed
  in"; when the server does not answer at all it says so and offers a
  retry. Boot can no longer sit on a loading line forever: every API
  call answers within a bounded time, the tab's data load cannot hold
  the first render past 8s, and the returning splash cover has a 6s
  backstop that fades it away on the slow fade.
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
  migration, the OAuth callback handler; sign-in links and recovery
  (`recordSigninLink`, `lookupSigninLink`, `recoverSignin`).
- `src/server.ts` — `stateFor` gains `auth`, `perk`, `backstories`;
  routes `start-signin`, `auth/session`, `auth/status`, `auth/recover`;
  the Gmail callback branches on `:signin` state.
- `src/server/stripe.ts` — webhook spends the welcome perk on a
  discounted checkout.
- `client/api.ts` — `setAccountId` / `clearAccountId`, `authStatus`,
  `authSession`, `authRecover`; every call bounded (30s, chat 120s).
- `client/main.ts` — sign-in return handling, sign in/out actions,
  account card in Upkeep, perk banner in the Store, prefilled promo
  code on Buy buttons, backstory under the empty-thread intro; boot
  and return-from-browser recovery, the header Google-state pill, the
  three-state account card, the 6s returning-splash backstop.
- `public/sw.js` — cache v33 for this change.
- `scripts/test-auth.ts` — 76 checks (see below).

## Tests

`bun scripts/test-auth.ts` — 76 checks, all passing (Nov 19, 2026).
Needs `OWNER_EMAILS` set (owner-grant checks read it):

```
DATA_DIR=/tmp/prism-auth-test GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x \
  GOOGLE_REDIRECT_URI=http://localhost:3111/api/oauth/google/callback \
  OWNER_EMAILS="prism5labscontact@gmail.com,aode1282@gmail.com" \
  bun scripts/test-auth.ts
```

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
- Recovery (Nov 19, 2026): the link is recorded for both devices at
  sign-in time and absent for a device that never signed in;
  `POST /api/auth/recover` returns the linked account for an orphaned
  device id, moves a Calendar/Drive token connected while orphaned
  onto the linked account, and says unlinked for an unknown device;
  state for the orphaned id reads not signed in, state for the
  recovered id reads signed in.
- Client (jsdom): signed-in Upkeep shows the account, the offer, and
  Prism's story; the Store shows the banner and Buy links carry
  `prefilled_promo_code=WELCOME15`; the header pill says Google
  connected when signed in; an orphaned device adopts its linked
  account on boot and shows signed in; an unreachable server shows
  "Prism didn't answer just now" with a retry, and the pill says
  Google unreachable — never "not signed in" before the answer.

One bug found by the tests and fixed: migration first deleted rows
whose primary key does not include `account_id` (messages, reminders,
day items, Stripe payments, Google identities) because the copy clashed
with the row itself. Those tables now move with a plain UPDATE; only
tables whose key includes `account_id` use copy-and-delete.

## Live verification (Nov 18, 2026, ~01:08 UTC, after deploy of 96f475a)

Confirmed against app.prism5labs.com:

- `/healthz` returns `{"ok":true,"brain":true,"provider":"anthropic"}`.
- `/api/auth/status` with an `X-Account-Id` header returns
  `{"ok":true,"signedIn":false}` for an unsigned account; without the
  header it returns 400 "accountId required".
- `/api/oauth/google/start-signin?accountId=<id>` returns 302 to
  `accounts.google.com` with the real Gmail OAuth client id, the
  registered callback
  `https://prism-app-live.onrender.com/api/oauth/google/callback`,
  scope `openid email profile`, `access_type=offline`,
  `prompt=consent`, and state `<id>:signin`.
- `/api/state` for an unsigned account carries `auth: {signedIn:
  false}`, `perk: null`, `backstories: []`, and all 12 Photons.
- Stripe (verified via the Stripe API): coupon `welcome15` live and
  valid; promotion code `WELCOME15` live, active, first-time-transaction
  only; all 74 Payment Links have `allow_promotion_codes: true`.
- Checkout page check (text fetch, no purchase): a live Payment Link
  renders "Pay Prism 5 Labs" with an "Add promotion code" field, which
  proves promotion codes are enabled on the link. The fetch snapshot is
  identical with and without `?prefilled_promo_code=WELCOME15`, so it
  cannot show whether the code is prefilled in a real browser, and the
  15% discount showing on the page was NOT confirmed by this check.

## Browser verification (Nov 17, 2026, ~21:19–21:23 CST, real browser)

Google sign-in verified end to end on the live app:

- Tapped "Sign in with Google" in Upkeep, chose aode1282@gmail.com,
  continued past Google's unverified-app warning, granted consent twice
  (sign-in, then access sharing name and email). Google redirected back
  to `/?tab=upkeep&signin=ok`. No one-time code step was required.
- After one reload, Upkeep showed "Signed in as neil saindon
  (aode1282@gmail.com). Account since Nov 17, 2026." with a Sign out
  button. The welcome offer shows in Upkeep (15% off first order, code
  WELCOME15, good until Nov 27, 2026, already filled in at checkout,
  one order only) and the "How Prism began" backstory shows. The Store
  tab shows the same welcome banner at the top.
- Quirk: right after the Google redirect the page briefly showed "You
  are not signed in" alongside an "Account created — welcome to Prism
  5, neil saindon" banner; one reload resolved it and the signed-in
  state then persisted.
- No purchase was made and no payment was entered.

## Still to verify live (needs a browser + a Google login)

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
