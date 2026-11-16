# Step 2 — paid upgrade runbook (Render)

For Neil, to do in the Render dashboard. Nothing here has been done yet:
**code ready, needs paid upgrade.** Do not start until you are ready to
pay for the plan change and to re-enter the app's data afterwards,
because the upgrade starts with an empty database (see "What happens to
existing data").

Design doc: `~/workspace/business/prism-app-capability-design.md`,
section 4, "Memory that survives, and staying awake". The exact file to
apply is `render-paid-patch.md` in this same worktree.

## Before you start

You need:

- Your Render login (the account that owns the `prism-app-live` service).
- Access to push to the app repo (`prism5labs/prism-app-live`), or
  someone who can push for you — the deploy file lives in the repo, and
  Render reads it from there (Blueprint-managed).
- About 15 minutes, plus time afterwards to re-enter unlocks and
  reconnect Gmail (below).

## What it costs

Render shows the price in the dashboard when you change the plan.
**Confirm the price shown in the dashboard before confirming.** No
price is written here — Render sets it, and anything written down here
could be out of date by the time you read it. What you are paying for:
the smallest paid instance (Starter) plus a 1 GB persistent disk.

## Steps, in order

### 1. Apply the render.yaml patch

1. Open `render-paid-patch.md` and copy the complete replacement
   `render.yaml` from its code block.
2. In the app repo, replace the whole contents of `render.yaml` with
   that block. Nothing else in the repo changes.
3. Commit and push to the branch Render deploys from. Render picks the
   change up by Blueprint sync; if it does not start on its own, go to
   the service in the dashboard and use **Manual Deploy → Deploy latest
   commit**.

Do not edit `render.yaml` in the Render dashboard's YAML editor as a
substitute for the repo file — the repo file is the source of truth and
the dashboard copy would be overwritten on the next sync.

### 2. Confirm the plan change in the dashboard

1. In the Render dashboard, open the `prism-app-live` service.
2. Go to **Settings → Instance Type**. It should now show the paid
   instance (Starter) from the patched file.
3. Read the price Render shows. **Confirm the price shown in the
   dashboard before confirming.** If the price is not what you expect,
   stop here — do not confirm, and ask before going on.
4. Confirm the change. Render restarts the service on the new instance
   with the new disk attached.

### 3. Check the disk and the environment variable

1. Still in the service, open **Settings** (or **Disks**, if shown) and
   confirm a disk named `prism-app-data`, mounted at `/data`, size
   1 GB, is listed and attached.
2. Open **Environment** and confirm `DATA_DIR` is set to `/data`, and
   that the existing variables are untouched: `NODE_ENV=production`,
   plus `ANTHROPIC_API_KEY`, `FREE_CODE`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, and `APP_URL` as
   they were. If any secret is missing after the change, re-enter it
   in the dashboard — never put a secret in the repo or in a file.
3. Check the deploy log for the latest deploy: it should finish
   without errors.

### 4. Re-enter the data (the database starts empty)

The new disk starts empty — this is expected, and it is the last time
it happens. Do these in the app at `https://app.prism5labs.com`:

1. **Unlocks:** re-enter the free code (or redeem code) on each device
   that had one. Unlocks live in the database, and the old database
   does not carry over.
2. **Gmail:** reconnect each Gmail account on the Inboxes tab. Each
   account needs a fresh Google sign-in; the old connections (including
   their refresh tokens) are gone with the old database.
3. **Contacts:** re-add Switchboard contacts and send fresh connection
   requests. Contacts start pending again and need the recipient to
   approve, same as the first time.
4. **Customization:** name, voice, and look picks were stored per
   account — redo any that matter. (Chat history is gone; see below.)

## What happens to existing data on upgrade

Plainly: **everything the app currently remembers is lost at the
upgrade, and there is no migrate button.**

- The old database lives on the free tier's temporary disk. Render
  does not copy it onto the new persistent disk.
- Unlocks must be re-entered, Gmail accounts reconnected, contacts
  re-approved (see step 4 above).
- Chat history is lost. There is no way to carry it over from the
  free tier.
- The backup script in this step (`scripts/export-db.ts`) backs up a
  local database file. It cannot reach the live free-tier database, so
  it cannot save the live data before the upgrade. It exists so that,
  from now on, a local copy of the database can be backed up before
  any future risky change.

After the upgrade, this loss does not repeat: redeploys and restarts
keep the data on the persistent disk.

## How to verify after the upgrade

Do these in order, and do not call the step done until all four pass:

1. **App loads:** open `https://app.prism5labs.com` on your phone.
   The app shell loads, the four tabs (Chat, Inboxes, Store, Upkeep)
   show, and no error page appears.
2. **A redeem works:** enter the free code (or a redeem code) on a
   device and confirm the Photons unlock. Close the app fully, reopen
   it, and confirm it is still unlocked.
3. **A Gmail connect works:** on the Inboxes tab, connect one Gmail
   account through Google sign-in and confirm the inbox lists. Close
   and reopen the app and confirm it is still connected.
4. **A redeploy no longer wipes data:** in the Render dashboard, run
   **Manual Deploy → Deploy latest commit** (no code change needed).
   Wait for it to finish, then reopen the app and confirm the unlock,
   the Gmail connection, and the chat history from checks 2–3 are all
   still there. This is the check that proves the disk works — if data
   is gone after this redeploy, stop and report it before using the
   app further.

Also confirm the website is unaffected: open `https://prism5labs.com`
and confirm it still loads as the website, not the app. (The patch
removes the bare and www domains from the app service because the
website lives on its own static site.)

## If something goes wrong

- **Deploy fails:** read the deploy log first. A failure here is
  almost always the YAML (a typo in the copied block) — compare the
  repo's `render.yaml` against `render-paid-patch.md` line by line.
- **App loads but data vanishes on redeploy:** the database is not on
  the disk. Check `DATA_DIR` is `/data` in Environment and the disk
  is mounted at `/data` — the two must match exactly.
- **Wrong site on a domain:** if `prism5labs.com` or `www` shows the
  app (or vice versa), check the domains list on the app service is
  `app.prism5labs.com` only, and check the website's own static site
  still holds the bare and www domains.
- **Going back:** downgrading to free removes the disk and the data on
  it. Before any downgrade, back up anything that matters — and note
  the backup script only covers a local database file, not the live
  one. Do not downgrade casually.

## Local verification already done (Nov 15, 2026)

Before this runbook was written, in the `step2-persistence` worktree:

- `DATA_DIR` was confirmed honoured: the server was started with
  `DATA_DIR=/tmp/step2-persistence-data` on port 10102 and `app.db`
  landed in that directory, not in `./data`.
- `scripts/export-db.ts` was run against a scratch database and
  produced a timestamped JSON backup with all seven tables
  (`accounts`, `owned`, `threads`, `messages`, `gmail_accounts`,
  `customizations`, `contacts`).
- `bun run typecheck` passes.
