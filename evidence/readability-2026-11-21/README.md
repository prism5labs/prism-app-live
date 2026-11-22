# Readability & elegance pass — Prism evidence (Nov 21, 2026)

Screenshots at 390×844 and 360×800, headless Chrome via CDP, real built
client with stubbed API data (same long reply / same email body in
before and after, so the comparison is typesetting, not content).

- `before/` — the unmodified local build (origin/main 8f0875d).
- `before/live/` — the current live app (app.prism5labs.com, fresh
  profile, live code + the same stubbed data; no owned account exists
  for a live capture, so data is stubbed, code and CSS are live's).
- `after/` — the local build with this pass applied, plus
  `drive-reader-*.png` for the new Drive document page (the before
  build rendered Drive inline as a 13px boxed pane; no before shot of
  that surface was captured after the fact).

Each folder's `audit.json` holds the DOM audit: computed font sizes on
the Store surface, the chat prose measure, and the email/Drive reader
metrics at both widths.

## Headline numbers (390×844)

| Surface | Before | After |
|---|---|---|
| Chat reply (`.msg`) | 14.4px / 1.45 (lh 20.9px), ~40 chars/line at 280px | 16.96px / 1.65 (lh 28.0px), ~39 chars/line at 319px |
| Email body | 14px / 1.55, 8px-radius box, max-height 55vh, inner scrollbar | 16.96px / 1.65, no box, max-height none, page scrolls |
| Drive body | 13px / 1.5, 8px-radius box, max-height 50vh, inner scrollbar | 16.96px / 1.65, no box, max-height none, page scrolls |
| Smallest rendered text (Store audit) | 10.56px (`.poster-row .at`), nav labels 10.88px | Nothing below 12px; label-role (uppercase) at exactly 12px, captions at 12.48px (= the spec's 0.78rem ≈ 12.5px) |

360×800 shows the same pattern (chat 16.96px/1.65 at 289px ≈ 36
chars/line; email/Drive 16.96px/1.65, no inner scroll).

Probe: `evidence/readability-probe.ts` (CDP; relay proxy on 18082,
static server for `public/` on 10102).
