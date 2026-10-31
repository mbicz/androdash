---
id: 0025
date: 2026-10-30
status: accepted
kind: contract
scope: web, docs
supersedes: []
---

# Fit: a chart keeps its plot; the legend gives way first

## Context

Fit is meant to show every panel on one screen. To get there it used to shrink
any row, then halve the row minimum and clip what did not fit. On the Spark
dashboard at 393 × 851 that pushed chart panels to 70 px, below the plot plus
its axis, so the plotted lines were cut off — the one thing a line chart exists
to show. Text (titles, legend labels) can be given up; a truncated plot cannot.

## Decision

1. **Two heights per panel.** `panelDemand` now returns `rigidH` beside `minH`:
   the part of the minimum that must never shrink. For `TimeSeriesChart` it is
   chrome + plot floor (44 px) + axis (14 px); for every other kind it is the
   full minimum. A row's `rigidHeight` is the tallest member's `rigidH`.
2. **The plot is rigid, the legend is not.** A short screen drops legend lines
   first (`overflow: hidden` on the fit legend), then shrinks the plot from
   56 px to a 44 px floor. Below that, the grid scrolls rather than clip.
3. **Plan selection uses the rigid height.** The fewest columns with
   `height − Σ rigidHeight ≥ 0` wins (wider panels read better); only when no
   column count fits at the rigid height does the plan fall back to the most
   `room` and report overflow. Row minimums are floored, not rounded, so
   per-row rounding cannot add a pixel of scroll.
4. **Fit chrome is 30 px** (6 px padding, 15 px header, 3 px gap), down from
   36 px. It is the smallest chrome that still fits the title, and it buys back
   the height the plot needs. Other layouts keep 36 px.

## Consequences

### Positive

- Spark fit at 393 × 851 renders every panel with no scroll: four charts at a
  56 px plot, `bodyScroll: 0`, no `overflow` class.
- The macos-node and demo dashboards also fit at scale 1 with full legends.

### Negative / risks

- Legend labels disappear on a tight screen before any line is shortened; a
  chart can be shown with an empty legend, which is deliberate (the header
  still names the panel, the values are in the tooltip-free plot).
- Small screens still overflow: Spark at 360 × 640 needs 278 px of scroll and
  at 320 × 568 needs 842 px. The overflow is now honest — every rigid panel is
  whole and only the grid scrolls.
- `agenticmac` at 393 × 851 still overflows by 13 px because its stat/gauge
  rows are rigid at their minimum.

## Contracts affected

- C-005 "Fit layout": demand table gains `rigidH`, chrome is 30 px in fit, plan
  selection is rigid-height first, the plot floor and legend sacrifice are
  stated.

## Verification

- `c005-fit.test.js`: new case asserts a chart row's `rigidHeight` is
  `30 + 44 + 14`, its minimum never drops below it, and a stat row is rigid at
  its own minimum. 93 web tests pass.
- Headless Chromium at 393 × 851 (mock Prometheus, Spark fixture): no overflow,
  `bodyScroll: 0`, chart SVGs 56 px, legends clipped as designed.
