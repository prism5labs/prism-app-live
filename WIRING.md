# WIRING — Step 4 (Calendar) + Step 6 (Drive and Docs)

Module: `src/server/google.ts` (new, the only code file in this step).
It owns its own OAuth flow and its own `google_tokens` table, separate
from `gmail.ts`. `gmail.ts`, `server.ts`, `db.ts`, `config.ts`,
`personas.ts`, `render.yaml`, `package.json`, and `client/*` are
untouched. The coordinator mounts the routes below in `server.ts`.

## What this step does (and does not do)

- Calendar: read events and free/busy times, book an event, cancel an
  event — through the same Google sign-in the app already uses for
  Gmail, with calendar scopes added. The owner signs in once and
  grants both. Owners already connected for Gmail will be asked to
  sign in again once for the new permission.
- Drive and Docs: search and read files — plain text, Google Docs
  exported as text, Sheets as CSV. Reading first; writing and
  sharing come later.
- Nothing here books, cancels, or sends anything on its own. The
  Photon drafts; the owner taps. `POST /api/calendar/book` creates
  the event only when called.
- Nothing is invented. If a file type cannot be read as text, the
  endpoint says so in plain words and returns the metadata only.
  If Google says a scope was not granted, endpoints return
  `{ok:false, error:"google_reauth", message:"..."}` pointing at
  re-sign-in.

## NEED (for Neil, not code — do not attempt browser work)

- The **Calendar API** and the **Drive API** must be enabled in the
  same Google Cloud project as the Gmail OAuth client. Until they
  are, Google answers these calls with an error and the endpoints
  report it honestly instead of working. Enable both APIs in the
  Google Cloud console for that project, then re-sign-in once.

## Routes to mount in server.ts

Import at the top of `server.ts` (alongside the gmail import):

```ts
import {
  authUrlExtra,
  handleExtraOAuthCallback,
  calendarStatus,
  listCalendarEvents,
  bookCalendarEvent,
  cancelCalendarEvent,
  freeBusy,
  driveStatus,
  searchDrive,
  readDriveFile,
  googleExtraConfigured,
  EXTRA_CALLBACK_PATH,
} from "./server/google";
```

`accountIdFrom` and `isValidAccountId` already exist in `server.ts`;
reuse them exactly as the Gmail routes do. Every handler below
returns a plain object; wrap it with the existing `json()` helper,
and use `bad()` for missing/invalid inputs the same way the Gmail
routes do.

### OAuth (Calendar + Drive)

| Method | Path | Handler |
|---|---|---|
| GET | `/api/oauth/google/start-extra?accountId=...` | `authUrlExtra(accountId)` — redirect 302 to the URL it returns; if it returns `null`, reply `{ok:false, error:"google_not_configured", message:"Calendar and Drive sign-in isn't set up on this server yet. It needs a Google OAuth client (client ID, secret, and redirect)."}` |
| GET | `/api/oauth/google/callback-extra?code=...&state=...` | `handleExtraOAuthCallback(code, state)` — on success redirect to `` `${config.appUrl}/?tab=inboxes&google=connected` ``; on failure to `` `${config.appUrl}/?tab=inboxes&google=error` ``. This path is different from Gmail's `/api/oauth/google/callback` on purpose. **The Google Cloud console redirect URI list must include the matching callback URL for this path** (same base as the Gmail one, with `/api/oauth/google/callback-extra`); otherwise Google refuses the sign-in. |

### Calendar

| Method | Path | Handler |
|---|---|---|
| GET | `/api/calendar/status?accountId=...` | `calendarStatus(accountId)` → `{ok, connected, email?, scopes?, googleConfigured?, message?}` |
| GET | `/api/calendar/events?accountId=...&timeMin=...&timeMax=...` | `listCalendarEvents(accountId, timeMin, timeMax)` — `timeMin`/`timeMax` optional ISO dates; defaults to now through 7 days out. Returns `{ok, connected, email, events:[{id, summary, start, end, attendees[], location?, description?}]}` |
| POST | `/api/calendar/book` | Body `{accountId, title, start, end, description?, attendees?[]}` → `bookCalendarEvent(accountId, body)`. Validates title/start/end are present, parseable, and end is after start. Creates the event only when called. |
| POST | `/api/calendar/cancel` | Body `{accountId, eventId}` → `cancelCalendarEvent(accountId, eventId)` |
| GET | `/api/calendar/freebusy?accountId=...&timeMin=...&timeMax=...` | `freeBusy(accountId, timeMin, timeMax)` — same optional window as events. Returns `{ok, connected, email, busy:[{start, end}]}` |

### Drive

| Method | Path | Handler |
|---|---|---|
| GET | `/api/drive/status?accountId=...` | `driveStatus(accountId)` → `{ok, connected, email?, scopes?, googleConfigured?, message?}` |
| GET | `/api/drive/search?accountId=...&q=...` | `searchDrive(accountId, q)` — `q` optional; with no `q` it lists the most recently modified files. Returns `{ok, connected, email, files:[{id, name, mimeType, modifiedTime}]}` |
| GET | `/api/drive/file?accountId=...&id=...` | `readDriveFile(accountId, id)` — plain text, Google Docs as text, Sheets as CSV. Returns `{ok, readable:true, file, content, truncated}` or `{ok, readable:false, file, message:"This file type cannot be read as text."}`. Content is capped at 100,000 characters (`truncated:true` when cut). |

Error shape (all handlers): `{ok:false, error:"not_connected"|"google_reauth"|"token_failed"|"google_failed"|"missing_fields"|"bad_time", message:"..."}` in plain words. `google_reauth` means: sign in with Google again and allow the calendar and Drive permission.

## Env vars

No new secrets. Same three Google OAuth client vars Gmail already
uses, read directly in `src/server/google.ts` (`process.env`):

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

The coordinator consolidates these into `config.ts` at merge. The
redirect URI registered in the Google Cloud console must cover both
callback paths: `/api/oauth/google/callback` (Gmail, existing) and
`/api/oauth/google/callback-extra` (this step, new).

## Persona truth lines (for personas.ts — coordinator adds)

Add only when the routes above are mounted and live; until then the
Photon must say these are not connected, not claim them.

- "I can see your Google Calendar once you connect it — I can check what's on, find a free time, and draft an invite, but nothing gets booked until you tap it."
- "If Calendar or Drive isn't connected yet, I'll say so and point you at the sign-in — I won't guess what's on your calendar or in your files."
- "I can look up a file in your Google Drive and read it — a resume, a letter, a document — and quote from what's actually there. If a file can't be read as text, I'll tell you that instead of making something up."
- "Calendar and Drive use the same Google sign-in as your email. If you already connected Gmail, you'll sign in once more to add the calendar and Drive permission."

## Client UI snippet (do NOT edit client files — coordinator wires this in)

A Calendar view and a Drive section inside the Inboxes tab. Anchor:
`client/ui.ts`, `renderInboxes()` (the tab that already shows the
three Gmail accounts). Suggested placement: a "Calendar" block
above the inboxes list, and a "Drive" block below it. Exact snippet
for the coordinator:

```ts
// Calendar block (inside renderInboxes, above the Gmail accounts):
// - GET /api/calendar/status?accountId=... → if !connected, show:
//   "Calendar isn't connected yet." + button "Connect Calendar & Drive"
//   → GET /api/oauth/google/start-extra?accountId=...
// - if connected, show the account email + "Next 7 days" list from
//   GET /api/calendar/events?accountId=... (summary, start–end).
//   A "Book" button per proposed time calls POST /api/calendar/book
//   with {accountId, title, start, end} only after the owner taps it.
//   A "Cancel" button per event calls POST /api/calendar/cancel
//   with {accountId, eventId}.

// Drive block (inside renderInboxes, below the Gmail accounts):
// - GET /api/drive/status?accountId=... → if !connected, same
//   "Connect Calendar & Drive" button as above (one sign-in covers both).
// - if connected, a search box → GET /api/drive/search?accountId=...&q=...
//   listing name + modified date; tapping a file calls
//   GET /api/drive/file?accountId=...&id=... and shows the text,
//   or the plain-words "This file type cannot be read as text." line.
```

No new tab is needed; both live inside Inboxes, where the Google
connection already lives.

## How to verify live

Server must be started with the Google env vars set (same values as
the Gmail OAuth client). With no tokens stored, the status endpoints
answer honestly instead of failing:

```bash
# Start (from this worktree):
DATA_DIR=/tmp/step4-google-data PORT=10104 bun src/server.ts

# Not connected yet — honest answers, no crash:
curl "http://localhost:10104/api/calendar/status?accountId=test-account-1"
# → {"ok":true,"connected":false,...}
curl "http://localhost:10104/api/drive/status?accountId=test-account-1"
# → {"ok":true,"connected":false,...}
curl "http://localhost:10104/api/calendar/events?accountId=test-account-1"
# → {"ok":false,"error":"not_connected","message":"Calendar and Drive aren't connected yet..."}
curl "http://localhost:10104/api/drive/search?accountId=test-account-1&q=resume"
# → {"ok":false,"error":"not_connected",...}
curl -X POST http://localhost:10104/api/calendar/book \
  -H 'content-type: application/json' \
  -d '{"accountId":"test-account-1","title":"Test","start":"2026-11-20T14:00:00-06:00","end":"2026-11-20T15:00:00-06:00"}'
# → {"ok":false,"error":"not_connected",...} (nothing is booked)

# Auth URL (needs GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI set; no real
# sign-in — check the URL string only, do not complete it):
# GET /api/oauth/google/start-extra?accountId=test-account-1
# → 302 to https://accounts.google.com/o/oauth2/v2/auth?... with
#   scope=...calendar.readonly ...calendar.events ...drive.readonly,
#   access_type=offline, prompt=consent,
#   state=test-account-1:calendar-drive

# After a real sign-in (needs the Calendar + Drive APIs enabled in the
# Google Cloud project, and the callback-extra redirect URI registered):
curl "http://localhost:10104/api/calendar/events?accountId=<id>&timeMin=2026-11-16T00:00:00-06:00&timeMax=2026-11-23T00:00:00-06:00"
curl "http://localhost:10104/api/calendar/freebusy?accountId=<id>&timeMin=2026-11-16T00:00:00-06:00&timeMax=2026-11-23T00:00:00-06:00"
curl "http://localhost:10104/api/drive/search?accountId=<id>&q=resume"
curl "http://localhost:10104/api/drive/file?accountId=<id>&id=<file-id>"
```

## Status

Code ready, not live. The module typechecks and the server starts;
with no Google tokens the endpoints answer honestly. Live Calendar
and Drive need: (1) the Calendar API and Drive API enabled in the
Google Cloud project, (2) the `/api/oauth/google/callback-extra`
redirect URI registered there, (3) the routes above mounted in
`server.ts` by the coordinator, (4) a real owner sign-in. Until
then, Photons must not claim Calendar or Drive work.
