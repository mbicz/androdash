---
id: 0034
date: 2026-11-06
status: accepted
kind: decision
scope: app, docs, contracts
supersedes: []
---

# Text sparklines on the car screen

## Context

C-010 originally omitted `TimeSeriesChart` panels entirely and counted them.
That was correct about the *mechanism* — CAL has no chart template — but wrong
about the *value*: the fleet dashboard's three most useful panels are charts
(output tokens per second, time to first token, GPU power), and dropping them
left the car view with six numbers and a "3 charts hidden" note.

A chart cannot be drawn. A template gives a `Row` a title and text lines, and
nothing else. But the *shape* of a time series is the glanceable part, and block
glyphs are text.

## Decision

Project each `TimeSeriesChart` series into a row carrying a fixed-width **text
sparkline**:

- `SPARK_WIDTH` = 24 characters, from `▁▂▃▄▅▆▇█`.
- The range is bucketed into 24 equal slices and averaged, so a long range keeps
  its shape instead of aliasing.
- A flat series renders mid-height (`▅`) rather than collapsing to the baseline,
  which would read as zero.
- A series with no samples produces no row and still counts as an omitted chart.

The row is `label`, `last value · state`, then the sparkline on a second line.

## Consequences

### Positive

- The three chart panels now appear, so `omittedCharts` is 0 on the fleet
  dashboard. The car view is no longer a numbers-only summary.
- No new dependency, no drawing, no image: block glyphs are text, so `SA-1` (no
  animation) and `IU-1` (no images) still hold, and the IoT category is
  unchanged.
- Formatting still matches C-005, so a value reads the same on both screens.

### Negative / risks

- A sparkline has no axis, no scale, and no legend. It shows *shape*, not
  magnitude — the number beside it carries magnitude. This must not be described
  as a chart anywhere.
- 24 characters is a width guess. On a narrow head unit the row may wrap; on a
  wide one it is short. It is a constant, not a measured fit.
- Bucket averaging smooths spikes: a one-sample spike can disappear. Acceptable
  for glanceability, wrong for diagnosis.

### Follow-ups

- Measure the row width from `ConstraintManager`/configuration instead of using
  a fixed 24, if a head unit wraps it.
- Consider a per-row marker for threshold breaches inside the sparkline.

## Contracts affected

- **C-010 amended**: `TimeSeriesChart` now projects to sparkline rows; the
  omission count applies only to charts with no range data.

## Verification

- `CarProjectorTest`: rising `▁▃▅█` at width 4, flat `▅▅▅▅`, 100 samples keep
  their shape at width 24, charts with range data are no longer counted as
  omitted, block-glyph alphabet enforced. 12 projector tests pass.
- On the AAOS emulator the fleet dashboard projected 10 panels / 9 series with
  `omittedCharts=0`, tabs `[Fleet:10, Inference:1]`.
- `tools/check_docs.py` passes; `jq empty` over `contracts/` passes.
