# Step 8 — Job plug: wiring guide for the coordinator

Module: `src/server/jobs.ts` (the only code file this step adds).
This file is the whole handoff. Nothing else in the repo was touched.

## What it is, honestly

A small worker that wakes once a day, fetches job listings from a
connected feed, filters them by the owner's rules, and **files** what
fits so the owner can review it. **It does not apply to any job.**
There is no apply adapter yet, and nothing in this module applies,
signs, or sends anything. Every response and every log line says so.

## Open question (undecided, unpriced)

**The job source is undecided.** Indeed's public API is restricted,
so the choice is a job-board partnership, a licensed feed, or a hosted
browser worker. Do not pick one until the options are priced. Until
that decision is made, this module ships a provider-agnostic adapter
interface plus one concrete adapter that reads a JSON or RSS/Atom feed
URL from `JOBS_FEED_URL`. With no feed URL set, the run endpoint
returns `job_source_not_connected` in plain words instead of
pretending to search. The module never scrapes Indeed or any job
board, and never invents listings.

## Env vars

| Var | What it is | Who provides it |
| --- | --- | --- |
| `JOBS_FEED_URL` | URL of a JSON or RSS/Atom job feed. JSON: an array of jobs, or an object with a `jobs` / `listings` / `results` / `data` array; each job has `title`, `company`, `location`, `url` (or `link`), `pay` (or `salary`), `description` (optional). RSS/Atom: `<item>` / `<entry>` blocks with title, link, description, author (company). | **Open decision.** Nobody provides it yet. It is whatever the chosen job source turns out to be: a partner feed, a licensed feed, or a hosted browser worker that publishes a feed. No URL is set anywhere in this repo, and no credential or key is involved. |

No other env vars. No new npm dependencies (fetch only, zero runtime
dependencies, same as the rest of the server). The module reads
`process.env.JOBS_FEED_URL` directly at call time; consolidate into
`config.ts` at merge if that is the house pattern.

## Tables (created by the module itself, at import)

- `job_rules (account_id, rule_key, rule_value)` — owner-set rules.
- `job_runs (id, account_id, started_at, found, kept, skipped, log)` —
  one row per run; `log` is JSON of the per-listing decisions with
  reasons.
- `job_listings (id, account_id, source, title, company, location, url,
  pay, status, created_at)` — `status` is `filed` or `skipped`.
  Unique on `(account_id, url)`, so a re-run files nothing twice.

## Routes to mount in server.ts

Import at the top of `src/server.ts`:

```ts
import { handleJobsApi, startJobPlugScheduler } from "./server/jobs";
```

Inside `handleApi`, before the final `return bad("not found", 404);`:

```ts
// Step 8 — the job plug. handleJobsApi returns null for non-jobs paths.
if (path.startsWith("/api/jobs")) {
  const jobsResponse = await handleJobsApi(req, path);
  if (jobsResponse) return jobsResponse;
}
```

Routes (all take `accountId` the same way as the rest of the API:
JSON body, `x-account-id` header, or `?accountId=` query):

| Route | What it does |
| --- | --- |
| `GET /api/jobs/status` | Source connected? Rules set? Last run? Always includes `autoApply: false`. |
| `GET /api/jobs/rules` | Merged rules (Neil's defaults + owner changes) and the defaults. |
| `POST /api/jobs/rules` | Owner sets rules. Body `{ rules: { key: value } }` or the rules flat in the body. Unknown keys and bad values are rejected with 400. |
| `GET /api/jobs/listings?status=filed\|skipped&limit=50` | Stored listings, newest first. |
| `POST /api/jobs/run` | One manual run for the caller's account. With no feed URL: `503 { ok:false, error:"job_source_not_connected" }` with a plain-words message. |

## Scheduler wiring (does NOT auto-start)

The module deliberately does not start its scheduler on import. To
start the daily run, the coordinator adds one call after the server
starts in `src/server.ts`:

```ts
startJobPlugScheduler(); // Daily job-plug run, all accounts. Returns a stop function.
```

It runs once every 24 hours (`JOB_PLUG_INTERVAL_MS`) for every
account in the `accounts` table. It does not run immediately on
start; a manual `POST /api/jobs/run` covers that.

## Rules engine (defaults = Neil's standing rules)

Defaults when the owner has set nothing; every one is changeable
through `POST /api/jobs/rules`:

- Remote preferred; onsite in the Green Bay area OK (Green Bay, De
  Pere, Ashwaubenon, Allouez, Bellevue, Howard, Suamico, Pulaski,
  Luxemburg, Denmark, Wrightstown).
- Pay floor $3,000/month (`pay_floor_monthly`). Hourly pay assumes
  160 hours/month; a pay range is judged on its low end; a bare
  number of 20,000+ with no unit is read as yearly. Pay not listed
  means the floor cannot be checked: the listing is still filed, with
  a note in the run log.
- Hard no, skipped with the reason logged: outbound sales, cold
  calling, phone-heavy call centers, commission-only outbound, FedEx
  in any role, any posting that requires a drug test or a DOT physical
  (unless the owner approved that specific role), employers that test
  THC. Background-check consent is fine and never blocks a listing;
  drug-screen consent is never signed by the plug.
- Soft fail, filed as `skipped` with the reason, never applied: pay
  below the floor, onsite work outside the Green Bay area.
- `approved_roles` is a JSON array of listing URLs (exact match) or
  titles that are exempt from the drug-test / DOT-physical hard
  rules. An approved role is still only filed for review, never
  applied to.
- Negations are respected: "no outbound calls", "no drug test", and
  "no cold calling" do not trip the matching hard-no rule.
- A listing already filed on an earlier run is skipped as
  `already_filed`.

Rule keys (anything else is rejected): `prefer_remote`,
`onsite_allowed`, `onsite_area`, `pay_floor_monthly`,
`hard_no_outbound_sales`, `hard_no_cold_calling`,
`hard_no_call_center`, `hard_no_commission_only`, `hard_no_fedex`,
`hard_no_drug_test`, `hard_no_dot_physical`, `hard_no_thc_testing`,
`allow_background_check`, `approved_roles`.

## Persona truth lines (for personas.ts at merge time)

Add these to the truth block so no Photon ever claims the job plug
does what it does not. Plain sentences, no promises beyond what is
live:

> The job plug files jobs that fit your rules so you can review them.
> It does not apply to any job on its own.
> It only works once a job source is connected, and right now no job
> source is connected, so it cannot search yet.
> It never signs a drug-test consent or a background-check consent,
> and it skips anything from FedEx, anything outbound or cold-calling,
> any phone-heavy call center, and any posting that needs a drug test
> or a DOT physical unless you approved that exact role.

The same three lines are exported from the module as
`JOB_TRUTH_LINES`.

## Client snippet (not wired; paste when the tab exists)

No client file was edited. When a Jobs view is added (suggested
anchor: a Jobs card in the Upkeep tab render in `client/main.ts`,
after the upkeep status block), this is the snippet:

```js
async function loadJobs() {
  const r = await fetch(`/api/jobs/status?accountId=${accountId}`);
  const s = await r.json();
  if (!s.ok) return;
  // s.sourceConnected, s.rulesSet, s.autoApply (always false),
  // s.lastRun { found, kept, skipped, log }, s.message (plain words).
  // If !s.sourceConnected, show s.message and nothing else.
  // Otherwise show kept/skipped from s.lastRun and link to
  // `/api/jobs/listings?accountId=${accountId}&status=filed`.
}
```

## How to verify live

```bash
# 1. No feed URL: honest not-connected errors, server starts.
DATA_DIR=/tmp/step8-jobs-data PORT=10106 bun src/server.ts
curl -s "http://localhost:10106/api/jobs/status?accountId=test-acct-1234"
# -> { ok:true, sourceConnected:false, autoApply:false, lastRun:null,
#      message:"No job source is connected yet..." }
curl -s -X POST http://localhost:10106/api/jobs/run \
  -H 'content-type: application/json' -d '{"accountId":"test-acct-1234"}'
# -> { ok:false, error:"job_source_not_connected", ... } (HTTP 503)

# 2. Rules round-trip.
curl -s -X POST http://localhost:10106/api/jobs/rules \
  -H 'content-type: application/json' \
  -d '{"accountId":"test-acct-1234","rules":{"pay_floor_monthly":3500}}'
curl -s "http://localhost:10106/api/jobs/rules?accountId=test-acct-1234"
# -> pay_floor_monthly "3500", customized true.

# 3. With a feed: JOBS_FEED_URL=http://127.0.0.1:10117/jobs.json
#    (a small local JSON feed) then POST /api/jobs/run.
#    Verified Nov 15, 2026 against a 12-listing fixture: found 12,
#    kept 2 (remote chat support $3,500/mo; Green Bay inbound support
#    $22/hr), skipped 10 with reasons (FedEx, outbound, call center,
#    pay below floor, DOT physical, drug test, location outside area,
#    commission-only outbound, cold calling, THC testing). A second
#    run files nothing twice: kept 0, skipped 12, all already_filed.
#    An RSS feed with 2 items verified the same way (1 filed, 1 FedEx
#    skipped). Approving one drug-test role via approved_roles files
#    that role and only that role.
curl -s "http://localhost:10106/api/jobs/listings?accountId=test-acct-1234&status=filed"
```

## What this step does NOT do (say it plainly)

- It does not apply to jobs. There is no apply adapter yet.
- It does not search any real job board. The only source is the feed
  URL, and none is connected.
- It does not decide the job source or price it. Partnership,
  licensed feed, or hosted browser worker is still open.
- It does not sign any consent, run any background check, or contact
  any employer.
- `bun run typecheck` passes in this worktree (verified Nov 15, 2026).
