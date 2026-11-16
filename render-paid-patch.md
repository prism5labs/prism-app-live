# Step 2 — render.yaml patch for the paid upgrade

Status: **code ready, needs paid upgrade.** Nothing in this file has been
applied. Do not apply it until Neil approves and pays for the Render plan
change. Applying it is a dashboard + git action (see
`paid-upgrade-runbook.md`), not a code deploy on its own.

## Why

Today the app runs on Render's free tier: the disk is ephemeral, so every
redeploy wipes unlocks, Gmail connections, contacts, and chat history, and
the service sleeps when idle, so the first reply is slow. This patch moves
the database onto a persistent disk and the service onto a paid instance
that does not sleep. Design doc:
`~/workspace/business/prism-app-capability-design.md`, section 4,
"Memory that survives, and staying awake".

## Complete replacement render.yaml

Replace the whole of `render.yaml` with this. Do not edit `render.yaml` in
the repo until Neil says go — this file is the patch, the repo file stays
on the free tier until then.

```yaml
services:
  - type: web
    name: prism-app-live
    runtime: docker
    dockerfilePath: ./Dockerfile
    plan: starter
    domains:
      - app.prism5labs.com
    disks:
      - name: prism-app-data
        mountPath: /data
        sizeGB: 1
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATA_DIR
        value: /data
      # ANTHROPIC_API_KEY: set in the Render dashboard (never in this file).
      # Enables live chat replies. Without it the app serves the shell and
      # chat history, and new replies answer "brain not connected".
      # ANTHROPIC_MODEL: optional, default claude-sonnet-4-5.
      # FREE_CODE: the friends-and-family redeem code. No default; when
      # unset, no free code works. Set in the Render dashboard, never here.
      # GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI:
      # optional, enable Gmail sign-in on the Inboxes tab. Without them the
      # tab reports honestly that no accounts are connected.
      # APP_URL: optional, public base URL of this deployment (used for the
      # OAuth redirect). Defaults to the request host when unset.
```

## What changed, line by line

```diff
 services:
   - type: web
     name: prism-app-live
     runtime: docker
     dockerfilePath: ./Dockerfile
-    plan: free
+    plan: starter
     domains:
-      - prism5labs.com
-      - www.prism5labs.com
+      - app.prism5labs.com
+    disks:
+      - name: prism-app-data
+        mountPath: /data
+        sizeGB: 1
     envVars:
       - key: NODE_ENV
         value: production
+      - key: DATA_DIR
+        value: /data
       # (all secret / optional env comments unchanged)
```

## Notes on each change

- `plan: free` → `plan: starter`. Starter is the smallest paid instance
  type. A persistent disk cannot be attached to a free instance, so the
  plan change and the disk go together — one without the other does not
  work. **Confirm the price shown in the Render dashboard before
  confirming.** No price is stated here because Render sets it.
- `disks:` — one persistent disk, `prism-app-data`, mounted at `/data`,
  `sizeGB: 1` (the minimum size; raise it later if the database ever
  outgrows it — chat history and Gmail tokens are small, 1 GB is ample
  to start). Once the disk exists, redeploys and restarts keep whatever
  is on it. Deleting the disk deletes the data; never delete it to
  "clean up".
- `DATA_DIR: /data` — the server reads its database from
  `process.env.DATA_DIR || "./data"` (`src/server/config.ts`) and opens
  `<DATA_DIR>/app.db` (`src/server/db.ts`). Setting `DATA_DIR` to the
  disk mount path is what actually puts the database on the persistent
  disk. The value must match `mountPath` exactly.
- `domains:` — now `app.prism5labs.com` only. `prism5labs.com` and
  `www.prism5labs.com` are removed because the website now lives on its
  own static site; listing them here would point the bare and www
  domains at the app service. After the upgrade, check the website
  still loads on its own domain — this change must not touch it.

## What this does NOT change

- No secrets are added to the file. `ANTHROPIC_API_KEY`, `FREE_CODE`,
  and the Google OAuth values stay dashboard-only, exactly as before.
  The free unlock code lives only in the Render `FREE_CODE` env var;
  it is not written anywhere in this patch.
- No code changes. `src/server/config.ts` and `src/server/db.ts`
  already honour `DATA_DIR` (verified locally — see runbook); the patch
  only points that variable at durable storage.
- No data is migrated. The new disk starts empty: unlocks must be
  re-entered, Gmail accounts reconnected, contacts re-approved, and
  chat history is lost. That is the cost of the upgrade, and it is the
  last time it happens — after this, redeploys keep the data.

## How it gets applied

Render is Blueprint-managed: the file in the repo is the source of
truth. The exact click-by-click order is in `paid-upgrade-runbook.md` —
in short: replace `render.yaml` with the block above, commit and push,
let the Blueprint sync pick it up, and confirm the plan price in the
dashboard before confirming.
