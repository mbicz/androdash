---
id: 0017
date: 2026-10-28
status: accepted
kind: contract
scope: renderer
supersedes: []
---

# Fit-to-screen layout, settings sheet, and lock-screen colour option

## Context

The phone runs unattended as a dashboard, often over the lock screen
(decision 0016). The scroll layouts (decision 0015) page and fold well when
someone holds the phone, but nobody scrolls an unattended screen: whatever is
below the first screen is never seen, and a fixed panel height leaves
whitespace in some panels while squeezing others. The wanted behavior is
everything on one screen, no wasted whitespace, and still legible — above all
on the lock screen. The locked view was always grayscale, which is less
readable than colour, so grayscale should be a choice, not a given.

The page toolbar (time range and refresh) took a row of the screen on every
page, and the lock-screen header icon was a second, separate control for a
related setting.

## Decision

Renderer (C-005, C-006, C-009):

1. **Fit layout** (`layout_mode=fit`, and always while locked). A pure planner,
   `web/app/src/fit.js` `planFit(items, { width, height })`, gives each panel a
   minimum legible height for a width from what it shows (stat tiles
   76 × 44 px, a single tile 34; gauge rings 70 × 74, a single ring 64; chart
   plot 56 + axis 14 + 140 px one-line legend entries; 18 px table rows, at
   least 3 plus `+N more`; 36 px panel chrome), a minimum width, and a growth
   weight (chart 3, gauge 2, stat 1, table 1 capped at all its rows). Dynamic
   programming over contiguous runs of panels (reading order kept) and column
   splits, for 1 … min(6, width / 158) columns, minimises the total minimum
   height; the fewest columns with at least 1.12× room win, else the roomiest
   plan. A shortfall scales type and minimums down to `--fit-scale` 0.72;
   below that the grid scrolls and `W_FIT_OVERFLOW` is recorded. Rows become
   CSS grid tracks `minmax(min px, weight fr)` (capped table rows
   `minmax(min, max)`), each row a `.fit-row` grid of `span fr` columns, so
   spare height goes to charts first. Markdown panels are not shown in fit;
   row headers, strips, and page dots are not used; the header is one compact
   line.
2. **Rebuild instead of waiting.** `renderDashboard()` rebuilds the page and
   repaints retained data and errors, so layout switches, rotation (re-planned
   after 120 ms), and lock/unlock never wait for a refresh. When a cycle
   changes a panel's series count, fit re-plans.
3. **Box-shaped content.** Stat tiles in fit fill the panel box (columns by box
   shape, one value size per panel from cell size and longest value, ≤ 44 px,
   56 px for a single tile). Gauges choose columns by box shape in every
   layout; a single gauge sits beside its readout only when the box is at
   least 1.5× as wide as tall, else the value goes inside the ring. Tables
   collapse a shared single label key into the column heading in every layout
   and in fit show the rows that fit plus `+N more`. Fit chart legends are a
   grid of one-line entries. Narrow plots (< 260 px) drop AM/PM from time
   ticks and keep at least two ticks; the value tick count follows plot height
   (about one per 22 px, at most 4).
4. **Settings sheet replaces the toolbar.** The header's settings button opens
   a sheet with segmented controls: Time range (5m … 7d), Refresh (Off, 5s,
   10s, 30s, 1m, 5m), Layout (Scroll | Fit to screen), and — only when the
   shell bridge exposes `lockScreenEnabled`/`setLockScreen` — "On the lock
   screen" (Off | Grayscale | Color). Choices apply immediately. The header
   lock-screen toggle is removed.
5. **`lock_style`** (`monochrome` default | `color`; C-001). Locked with
   `monochrome`, the renderer uses the grayscale palette; with `color`, the
   `amoled` palette (near-black cards, full state and series colour). Header
   actions stay hidden while locked.

Android (C-001, C-007):

`setView(timeRange, refreshSeconds)` is replaced outright by
`setOption(name, value)` with an allow-list (`time_range`, `refresh_seconds`,
`layout_mode`, `lock_style`), validated with the launch-extra rules; new
renderer-adjustable settings need only a new allowed name; the allow-list
keeps the bridge from being a generic config writer (C-008). `lock_style` is
additive (`schemaVersion` stays 1; missing → `monochrome`). Android unit tests
gain a test-scope `org.json:json` dependency because android.jar's `org.json`
is a stub on the JVM.

## Consequences

### Positive

- An unattended phone shows every reading on one screen, sized to what each
  panel needs, in dashboard order.
- The lock screen can be shown in colour, which reads better than grayscale;
  grayscale stays the default.
- One place for view settings; no toolbar row on the page.
- Rotation and lock/unlock repaint at once from retained data.
- The planner is pure and covered by `web/tests/contract/c005-fit.test.js`.

### Negative / risks

- Markdown panels are hidden in fit; dashboards that rely on Markdown for
  context lose it there (the scroll layouts still show it).
- The 0.72 scale floor is a judgement call; below it the fit grid scrolls,
  which an unattended screen will not do.
- Many panels on a small phone give small charts; the planner keeps them
  legible, not roomy.
- A change in a panel's series count after a cycle triggers a re-plan and a
  full rebuild of the page.
- The fit layout hides table header rows, so a collapsed shared label key
  (e.g. `collector`) is not visible there.

### Follow-ups

- Measure fit on the Pixel 10 over the lock screen with the Spark and macOS
  node dashboards in both orientations and both lock styles.

## Contracts affected

- C-001 (v3): `layout_mode` accepts `fit`; new `lock_style`.
- C-005 (v6): new "Fit layout" and "Header and settings sheet" sections;
  gauge, stat, table, legend, and axis rules; locked view always fit with the
  `lock_style` palette.
- C-006 (v3): controls move to the settings sheet; persistence through
  `setOption`.
- C-007 (v4): `setOption` replaces `setView`; locked colours follow
  `lock_style`.
- C-009: new warning `W_FIT_OVERFLOW`; header actions are refresh, view
  settings, and diagnostics.

## Verification

- `mise exec -- node --test web/tests/`: 73 renderer tests pass, including
  `web/tests/contract/c005-fit.test.js` and the fit-table and shared-key table
  tests in `c005-panels.test.js`.
- `mise exec -- ./gradlew :app:testDebugUnitTest`: `ConfigParserTest` covers
  `layout_mode=fit`, `lock_style` defaults and round-trip, and `setOption`
  validation.
- `python3 tools/check_docs.py` and `jq empty` on every `contracts/*.json`.
