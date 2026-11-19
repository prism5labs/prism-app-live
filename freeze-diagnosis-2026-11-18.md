# Prism app freeze diagnosis — opening v5 black screen + sign-in freeze

Date: Nov 18, 2026 (evening, CST). Retry: a previous diagnosis attempt
the same day ended with no diagnosis and its processes killed, leaving
the repo clean at d5f6725 (SW v28). This pass started from the repo and
the live app, not from that attempt's work.

## Symptoms (Neil's own phone, Nov 18 ~16:40 CST)

1. After a full close and reopen of the installed Prism app: a BLACK
   screen with "tap to skip" and NO opening video at all.
2. The sign-in page keeps FREEZING — he never got past it.

## Timeline correction (matters for the diagnosis)

Neil's 16:40 test ran against the **v27** deploy (commit 928de80,
22:25 UTC / 16:25 CST), not v28. The v5 hardening commit d5f6725
landed 23:02 UTC / 17:02 CST — after his report — and Render needed
minutes more to deploy it. So the black screen he saw was the v4 film
under v27: no poster frame, no stall watchdog, and Range requests
intercepted by the worker. The v28 hardening was built in response to
that report; it was never verified on his phone.

Two more timeline facts: 6a3fc3a (Neon Counter) pushed 22:09 UTC and
928de80 22:25 UTC, so the live service restarted twice in the hour
before his test. A restart makes /api/state hang until the new
process is up — the exact window in which symptom 2 appeared.

## What was verified (all by direct check, Nov 18–19)

- **Live SW before the fix: v28.** Fetched live /sw.js: `prism5-v28`,
  matching the local file. The live deploy was d5f6725.
- **Live root fetch fails in the text fetcher** ("no extractable
  content", HTTP 200) — an artifact of fetching a JS app shell as
  text, not a site outage; live /sw.js fetched fine minutes apart.
- **Server video serving is correct.** Ran the server locally
  (temp DATA_DIR, port 18231): full GET /opening-v5.mp4 → 200,
  `video/mp4`, Content-Length 3710071. Range `bytes=0-1023` and
  `bytes=1000000-1001023` → **206 Partial Content** with correct
  Content-Range and `accept-ranges: bytes`. Bun.serve handles Range
  automatically for Bun.file responses. The server is NOT the problem.
- **The films are well formed.** ffprobe: v5 is H.264 High, 720x1280,
  24fps, 10.0s; moov atom at offset 36, before mdat at 3378 —
  faststart, so playback can start before the whole file downloads.
  v4 and v3 are faststart too.
- **The first frame is NOT black.** Extracted frames at t=0, 0.5, 1,
  2, 5s: the film opens on a bright diner scene (prism on the
  counter). The poster (opening-v5-poster.jpg, 67 KB) is the same
  frame. If poster or video had loaded, the screen would not be black.
- **"Tap to skip" is not a string in the app.** Grepped the whole
  repo: no such text anywhere. It is Neil's description of the
  splash's tap-to-dismiss, not a literal label.
- **Boot fetches had NO timeout.** client/api.ts `req()` calls fetch
  with no AbortSignal. init awaits `api.authSession()` (OAuth return)
  and `refreshState()` (/api/state) before the first render. If either
  hangs, the app never renders: the header and an empty view and nav,
  no sign-in button anywhere. The 13s splash backstop still fires, so
  the user lands on an empty shell that does nothing — it reads as a
  frozen sign-in page.
- **Nothing else hangs the server.** /api/state is synchronous SQLite
  reads (WAL mode); migrations run at server boot, not per request;
  the sign-in session exchange is a DB lookup plus stateFor. No loop
  or blocking call found in the boot path.
- **The splash was black before JS ran.** `.opening-splash` fell back
  to `background: #000` until main.js set the scheme, and the splash
  is only ever removed by JS — if main.js failed to load, it would sit
  black forever.
- **The v28 watchdog had a hole.** At 5s it fell back only if
  `currentTime < 0.5 && readyState < 3`. A film can sit buffered at
  currentTime 0 with readyState 3 and never show a frame — no
  fallback fires. There was also no second watch after the v3
  fallback; a stalled v3 waited out the 13s backstop.
- **The film still depended on the network on every reopen.** v28
  made Range requests bypass the worker, so the video element
  streamed the 3.7 MB film off the network on every launch — the
  precached v3 fallback included, since its Range requests bypassed
  too. On the slow connection Neil was on, that is the stall.

## Root causes

1. **Black screen (v27, what Neil saw):** slow/flaky connection +
   a 2.9 MB film with no poster and no stall watchdog. Any stall
   meant a black splash until the 13s backstop (or his tap).
2. **Sign-in freeze:** boot fetches with no timeout. During the
   deploy restarts that evening, /api/state (or the session exchange
   on an OAuth return) hung, init never reached render, and the app
   sat as an empty shell with no sign-in button. Not a UI freeze —
   boot never finished.
3. **Remaining v28 holes (why a retry was still needed):** the
   watchdog's readyState qualifier, no second watch after the v3
   fallback, the splash black before JS and immortal if main.js never
   ran, and the film still network-bound on every reopen.

## The fix (SW v29)

- `public/sw.js` — CACHE `prism5-v29`. The v5 film is precached at
  install (best effort, chained after the shell so a slow film fetch
  cannot fail the whole install). Video Range requests are now served
  as 206 slices out of the cache when the whole file is cached, with
  a network fall-through when it is not. Non-Range behavior and the
  API pass-through are unchanged.
- `client/api.ts` — new `reqTimeout()` (10s, answers
  `{ ok: false, error: "timeout" }` instead of hanging). `state()` and
  `authSession()` use it; every other call is untouched.
- `client/main.ts` — `window.__prismMainLoaded` set the moment the
  bundle runs; the inline splash backstop is cleared in init; the 5s
  watchdog now fires whenever the film has not advanced past 0.5s
  (readyState qualifier dropped); a second watch dismisses the splash
  at 9s if the v3 fallback stalls too; if boot reaches render with no
  state, the app says so with a toast and retries state once after 5s
  instead of leaving an empty shell.
- `public/index.html` — a tiny inline script removes the splash after
  15s if main.js never ran.
- `public/styles.css` — the splash falls back to diner teal
  (#0f5257) instead of black before JS sets the scheme.

## Verification (before deploy)

- `bun run typecheck`: clean. `bun run build`: main.js 143,234
  bytes, sha256
  `33ec9da9b1549bbad66e5b76428ce2f61e826d74e9b80034bbccea40ad1ff881`
  (built by the Dockerfile at deploy; main.js is gitignored).
- `bash scripts/ironclad-check.sh`: PASSED.
- `bun scripts/test-auth.ts` (fresh DATA_DIR, both owner emails):
  **55 passed, 0 failed.** (An earlier 54/55 run failed only on
  "second owner email grants Upkeep" because OWNER_EMAILS held one
  email; a repeat run against a reused DATA_DIR failed on stale
  state — both are harness-invocation artifacts, not the change.)
- Service-worker harness (`/tmp/prism-sw-test.ts`, throwaway):
  **12/12 passed** — install precaches shell + film as a whole 200;
  Range 1000–1999 returns 206 with the exact bytes at that offset;
  open-ended and suffix ranges correct to EOF; uncached Range falls
  through to network 206; plain requests still cache-first; /api/
  untouched.
- Local server test: Range 206s confirmed (see above).

## Deployment

- Commit: `7097a9c` — "Freeze fix: opening plays from the service-worker
  cache; boot can no longer hang (SW v29)", pushed to origin/main
  (Render auto-deploys on push). 6 files: client/api.ts,
  client/main.ts, public/index.html, public/styles.css, public/sw.js,
  freeze-diagnosis-2026-11-18.md.
- Live verification (fresh fetches, Nov 19 ~01:44–01:46 UTC):
  live /main.js contains the v29 code — the retry toast ("Couldn't
  reach the server just now — checking again in a moment."), the 5s
  watchdog WITHOUT the readyState qualifier, and the new 9s second
  watchdog. Live /sw.js reads `prism5-v29` with the best-effort film
  precache and the Range-slicing handler. The local build hash is
  `33ec9da9…`; the Dockerfile rebuilds main.js at deploy from the
  same source. Live index.html was not fetchable as text (JS app
  shell — the text fetcher returns nothing for it), but it ships in
  the same container as the verified sw.js and main.js.

## Still required: Neil's phone test

Even after live verification, this is NOT done until Neil re-tests
on his phone: full close/reopen of the installed app (the opening
should play from the installed copy, no black screen), then a
sign-in attempt. If the installed copy still serves the old worker,
a second reopen picks up v29 — the worker updates on launch.

Note: no live-browser check was possible from this session (a
subagent cannot operate the live browser). The live checks above are
text fetches of the deployed files plus local harnesses. An
installed-PWA check on a real device, or Neil's own re-test, is the
remaining verification.
