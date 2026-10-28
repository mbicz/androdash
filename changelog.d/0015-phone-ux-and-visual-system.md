---
id: 0015
date: 2026-10-27
status: accepted
kind: contract
scope: renderer
supersedes: []
---

# Phone UX pass: paging, folding, time controls, quiet status, flat visual system

## Context

User feedback from running the renderer on a phone:

- **Folding was broken.** Tapping a section header did nothing: the click
  handler threw a `ReferenceError`, and even with `hidden` set, the
  `.row-body` `display` rules overrode it.
- **Time controls were inert.** The header showed `Last 15m` and `Every 10s`
  chips that looked like controls but could not be changed on the device; the
  only way to change the range or interval was an `adb` relaunch.
- **Uneven axis times.** The x axis spanned the data extent, not the requested
  window, so ticks fell at uneven, data-dependent instants and charts in one
  cycle did not share a time axis.
- **Per-panel noise.** Every panel header carried a `LIVE`/`Static`/`Loading`
  badge and a painted description, repeating what one dashboard-wide status
  already says.
- **A per-second countdown wasted CPU.** A 1 s `setInterval` updated a
  next-refresh countdown in a fixed bottom status bar even while the dashboard
  was idle — on a device meant to run all day on a charger.
- **"Nominal" was weak.** Every healthy stat and gauge printed "Nominal", so the
  word that matters (`High`, `Critical`) did not stand out.
- **Vibe-styled chrome.** Gradients, glows, blur, bordered boxes inside cards,
  and a brand mark competed with the data; gauges used coloured threshold zones
  that read as decoration.
- On a phone, side-by-side dashboard panels were stacked into one long column,
  and in grid mode a fixed-height slot overflowed its row by up to 34 px.

## Decision

1. **Folding.** Row headers are buttons that toggle `hidden` on `.row-body` and
   `aria-expanded`/`data-row-collapsed` (`layout.js` `setCollapsed`). A global
   `[hidden] { display: none !important }` rule makes `hidden` win.
   `collapse.open === false` rows start folded.
2. **Pagination (stack mode).** `bandItems()` groups a row's items whose
   vertical extents overlap into a band. A band of two or more renders as a
   `.panel-strip`: horizontally swipeable, `scroll-snap-type: x mandatory`,
   pages `calc(100% - 26px)` wide so the next card peeks, with `.strip-dots`
   page dots (an `IntersectionObserver` marks the active dot; tapping a dot
   scrolls to its page). A band of one stays in the vertical stack. Items in a
   band are ordered by `x`, then `y`. Vertically, `html` uses
   `scroll-snap-type: y proximity` with snap points at the toolbar, each row,
   and each stacked band/slot, offset by `--header-h` (the sticky header height,
   measured with a `ResizeObserver`). In grid mode (≥ 900 px) the strip is
   `display: contents` and dots are hidden; grid tracks are `minmax(30px, auto)`
   and slots have `min-height: var(--panel-height-grid)`, so items never
   overflow their row.
3. **Time controls.** A toolbar under the header offers a time-range segmented
   control (`5m 15m 1h 6h 24h 7d`, plus the dashboard/launch value if it is not
   a preset) and a native refresh `<select>` (`Manual`, `5 s`, `10 s`, `30 s`,
   `1 min`, `5 min`, plus the current value if different). A choice applies
   immediately — a range starts a refresh now; an interval calls
   `Scheduler.setIntervalSeconds()`, which reschedules from now (`0` = manual) —
   updates the renderer config, and calls `AndroDash.setView(timeRange,
   refreshSeconds)` when the shell bridge is present (the shell persists it,
   decision 0016 / C-007). In a browser the choice is session-only. Effective
   precedence: last in-app choice (persisted into the launch config) > launch
   parameter > dashboard > default.
4. **Charts.** The x domain is the cycle's requested window (`startMs..endMs`,
   passed as `timeWindow`), not the data extent. Ticks are round:
   `panels/scale.js` `niceTicks` (1/2/2.5/5 × 10^k; byte axes step in powers of
   1024) and `timeTicks` (1 s…7 d steps aligned to local wall-clock boundaries,
   at most `min(8, plotWidth / 84)` ticks). Labels are `h:mm` (seconds when the
   step is under 60 s, weekday/day for ≥ 1 day). Value labels sit on the right
   in a gutter; no vertical grid lines; axis labels are 10 px. Series colour is
   assigned by position within the panel (`seriesColor(index)` →
   `var(--series-N)`, 8 slots), never by label hash, so series in a chart never
   share a colour. Threshold lines are dashed in the state colour.
5. **No countdown.** The 1 s status ticker and the bottom status bar are
   removed. One dashboard-wide status lives in the sticky header under the
   title: a dot (green live, amber degraded/stale, red error, gray loading) and
   text — the last successful update (`h:mm:ss`), `Stale since …`,
   `N of M failing · …`, `Offline [since …]`, or `Loading`. It updates only when
   a cycle settles or the scheduler state changes. Header actions: refresh now,
   a lock-screen toggle (only when the bridge exposes `lockScreenEnabled` and
   `setLockScreen`), and diagnostics (debug only). The `Last 15m`/`Every 10s`/
   `Live` chips and the brand mark are removed.
6. **Quiet panels.** `.panel-badge` is empty (hidden) unless the panel is
   `Stale`, `Error`, or `Hidden`; panels never say `Live`, `Static`, `Loading`,
   or `No data` in the header. Descriptions are not painted (they stay in the
   `aria-label`), except the stale explanation line.
7. **Stat tiles.** Label (multi-series only), number, a smaller unit
   (`splitUnit`), and a 3 px state edge on the tile's left (green ok, amber
   warn, red crit, neutral gray when the panel has no thresholds — state
   `none`). No "Nominal" text anywhere; a state word (the step's name, e.g.
   `High`, `Critical`) appears only for warn/crit. The meter still appears only
   with thresholds. A single-series tile has a 40 px number and no label.
8. **Gauges.** An open 240° arc with the gap at the bottom (screen angles
   150° → 390°), round caps, a neutral track, the value arc in the state colour
   (ok green, warn amber, crit red; blue accent without thresholds), and
   thresholds as notches cut into the track instead of coloured zones.
   Multi-gauge panels use a 2-column grid with value + unit inside the arc, the
   series label below, and a state word only for warn/crit. A single gauge puts
   the arc on the left and a large readout on the right. No bordered card per
   gauge.
9. **Visual system.** `web/app/styles.css` is rewritten: black canvas, flat
   `#1c1c1e` cards with a 20 px radius, no borders inside cards, no gradients,
   glows, blur, or animations except a 160–180 ms chevron/page-dot transition;
   system font; tabular numerals; every colour a CSS variable. Display modes
   are a pure stylesheet switch on `html[data-display-mode]`: `standard`,
   `amoled` (near-black cards), and `monochrome` (no hue: state by luminance
   plus the state word; series by gray level and dash pattern via
   `data-series` — eight distinct dash patterns; legend swatches become
   stroke samples; no area fill). This replaces the per-mode presentation
   described in decision 0010 (glass theme, true-black AMOLED with borders,
   hidden brand and meta chips); the C-001 `display_mode` field and its values
   are unchanged.
10. **Locked view.** `window.androdash.setLocked(bool)` (pushed by the Android
    shell, C-007 / decision 0016) sets `html[data-locked]` and forces
    `monochrome` without re-rendering; the toolbar, header actions, and page
    dots are hidden; refreshing continues.
11. **Titles.** After variables resolve, `applyDisplayVariables()` interpolates
    `$var`/`${var}` into the dashboard, row, and panel titles (written with
    `textContent` only). An empty result falls back to the dashboard
    `metadata.name` / panel ID. `macos-node-dashboard.json` uses
    `display.name: "$host"` with a `host` `PrometheusLabelValuesVariable`
    (`labelName: nodename`, matcher `node_uname_info`).

## Consequences

### Positive

- Sections fold; side-by-side panels page sideways, so a phone shows a
  dashboard's structure instead of one long column.
- Range and refresh can be changed on the device and survive reloads and
  relaunches in the app.
- Every chart in a cycle shares one time axis with round ticks and readable
  labels; a gap in data is visible as a gap in time.
- Nothing runs between refreshes: no per-second timer, no scroll handler, no
  animation loop.
- Colour and words appear only when something needs attention, so `High` and
  `Critical` stand out.
- Display modes and the locked view are CSS-only, so switching is instant and
  renderers do not branch on presentation.

### Negative / risks

- Without a countdown the operator cannot see when the next refresh is due on
  screen; it is in diagnostics (`nextRefreshAt`).
- The hidden-panel count is no longer on screen outside the debug overlay.
- Monochrome legend swatches are solid, dashed, or dotted only, so they match
  the chart's eight dash patterns approximately; the legend still names them.
- Series colours repeat after 8 series (the per-panel cap is 12).
- `scroll-snap-type: y proximity` depends on WebView snap heuristics; on some
  devices it may feel sticky or not snap at all.

### Follow-ups

- Measure snap and strip behavior on the Pixel 10 WebView and record results.

## Contracts affected

- C-002 (v1, amended): variables interpolate into dashboard/row/panel titles
  with fallback; `macos-node-dashboard.json` listed as a fixture.
- C-004 (v1, amended): the hidden count is reported in diagnostics and the
  debug overlay, not the header status.
- C-005 (v4 → v5): pagination (bands, strips, dots, vertical snap), working
  folding, grid tracks, quiet panel chrome, series colour by position, chart
  axes (window domain, nice/time ticks, right gutter), stat state edge, gauge
  arc and notches, visual system, CSS-variable display modes, locked view,
  `c005-layout.test.js`.
- C-006 (v1 → v2): in-app range/refresh presets, runtime interval change,
  `setView` persistence and precedence, status without a countdown.
- C-009 (v1, amended): header status (dot + text, no countdown, no bottom bar),
  header actions, `setLocked` in the `window.androdash` API.

## Verification

- `mise exec -- node --test web/tests/`: 66 tests pass, including
  `web/tests/contract/c005-layout.test.js` (bands, strip + dots, folding,
  nice/time ticks), C-002 title interpolation, C-006 runtime interval change,
  and the rewritten C-005 stat/gauge/series-colour/time-window tests.
- `python3 tools/check_docs.py` and
  `find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty`.
