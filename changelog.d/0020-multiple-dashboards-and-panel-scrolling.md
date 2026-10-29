---
id: 0020
date: 2026-10-29
status: accepted
kind: contract
scope: renderer, android
supersedes: []
---

# Multiple dashboards, panel scrolling, and gestures that never leave the app

## Context

On the Pixel the user wanted several dashboards on one unattended phone, also
in the fit-to-screen layout, and asked what vertical and horizontal swipes
should do. Fit tables cut long content to `+N more`, and Markdown was hidden in
fit. Swiping sometimes left the app: on return the shell recreated the WebView,
so the page reloaded and looked like "going back in history".

## Decision

1. **Gesture model.** Vertical drags only scroll content: inside a panel they
   scroll that panel; in fit the page never scrolls. A horizontal swipe pages
   between dashboards — anywhere in fit, on the header in the scroll layouts
   (strips own the page there) — unless the content under the finger can still
   scroll sideways. Arrow keys do the same.
2. **Panel scrolling.** `.panel-body` is each panel's one scroll container;
   panels keep their positions in fit. Tables show all rows, Markdown is shown
   in fit (bounded height), long legends and dense stat panels scroll instead
   of shrinking below 18 px numbers. Hidden edges fade; a refresh keeps the
   scroll position. `+N more` truncation is removed.
3. **Multiple dashboards.** C-001 `dashboard_urls` (1–8) with `dashboard_url`
   as the one shown; only it is loaded and queried. Header dots, swipe, and the
   settings "Dashboards" group (show, remove, add built-in dashboards from
   `/dashboards/index.json`, Rotate: Stay/30s/1m/5m). `rotate_seconds` advances
   on a timer and waits 2 minutes after any touch. Every switch persists with
   `setOption("dashboard_url")`.
4. **Shell (from the Android side):** `setOption` gains `dashboard_url` (must
   be listed), `dashboard_urls` (may reorder, shorten, or add built-in
   dashboards — never a new remote URL; remote URLs come only from launch
   extras), and `rotate_seconds`; value limit 2048 for the two URL names, 64
   for the rest. Stored copies become 8 slots by list position
   (`/stored/<i>/…`); reordering refetches rather than mislabels. The build
   lists bundled dashboards in `dashboards/index.json` by `metadata.name`.
5. **Back and relaunch.** On API 33+ an `OnBackInvokedCallback` (with
   `enableOnBackInvokedCallback`) consumes Back in kiosk, so the gesture never
   previews the launcher. A new intent without launch extras, or with the same
   renderer URL, keeps the running page and only re-applies kiosk, lock-screen,
   lock task, and collector state.

## Consequences

### Positive

- Several dashboards on one phone, browsable by swipe or rotating unattended,
  with no extra Prometheus load for the hidden ones.
- Nothing is cut off: every panel can show all its content.
- Returning to the app no longer reloads it; Back no longer leaves it.

### Negative / risks

- The bottom-edge home gesture still leaves the app unless screen pinning
  (lock task) is active; returning then keeps the page.
- Switching dashboards reloads the definition, probes, and variables
  (≈ 200–400 ms); hidden dashboards have no data until shown.
- Old single-slot stored copies are deleted; they are fetched again once.

## Contracts affected

- C-001 (`dashboard_urls`, `rotate_seconds`), C-002 (store slots), C-005 v7
  (Panel scrolling, Multiple dashboards, Markdown in fit), C-007 (`setOption`
  names, slots, Back callback, intent handling), C-008 (slot routes,
  `dashboard_urls` cannot add remote URLs); app-config schema and fixture.

## Verification

```sh
mise exec -- node --test web/tests/
mise exec -- ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Browser at 393×851 (fit, two dashboards): swipe left/right switches and wraps,
dots follow, a vertical drag scrolls only the panel under it (page stays at
0), a scrolled table fades its top edge.
