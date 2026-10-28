---
id: 0014
date: 2026-10-27
status: accepted
kind: contract
scope: renderer
supersedes: []
---

# Render at CSS-pixel geometry and group same-unit metrics

## Context

Measured on the emulator (393×851 CSS px, dpr 2.75, 1080×2340 @ 440 dpi) with
the Spark fixture, the renderer was both wasting vertical space and producing
illegible output:

| Element | Measured | Problem |
|---|---|---|
| Chart axis labels | `viewBox` 720×280 in a 338 px box → 0.469 scale | 9.5 px text rendered at **4.45 px** |
| Stat tile | 338×130 card holding 51 px of content | 61 % vertical slack |
| Gauge card | 154 px dial centered in a 338 px card | 55 % horizontal waste |
| Panel chrome | 51 px header on a 200 px panel | 34 % overhead |
| Table row | 62–76 px | full `spark_collector_success{collector=…, instance=…, job=…}` wrapped |
| Whole page | `scrollHeight` 4234 px = 4.97 screens | 15 panels, no grouping |

The fixture also queried the same TTFT expression twice (a `StatChart` and the
first query of `token-latency`), costing a panel, a header, and an HTTP request
for identical data.

## Decision

1. **Exact SVG geometry.** `TimeSeriesChart` and `GaugeChart` derive their
   `viewBox` from the measured rendered box instead of a fixed drawing space, so
   SVG text keeps its CSS font size. `main.js` passes the panel body's
   content-box size; a `ResizeObserver` redraws on any box change.
2. **Compact chrome.** Panel header `min-height` 46 → 34 px, body padding
   `4px 13px 13px` → `2px 10px 8px`. On viewports ≤ 760 px the panel description
   is not painted (it stays in `aria-label`) and the header is one row: brand
   mark without the wordmark, title, and three chips.
3. **Content-sized stat panels.** `StatChart` stack slots use `height: auto`
   with `min-height: 92px`; every other kind keeps the C-005 slot so long
   content scrolls inside the panel.
4. **Compact stat tile.** `space-between` instead of centering; a single-series
   tile omits the redundant label (the header names it).
5. **Meter only with a scale.** A stat tile draws its 3 px meter only when
   `thresholds.steps` is non-empty; the bar is `value / highest step`. Grouped
   panels (`power`, `clocks`, `requests`) have no thresholds, so their bars used
   to sit at 100% for every value, which reads as "maximum".
6. **Inline single gauge.** One gauge renders as dial-left / readout-right at
   full card width; multiple gauges keep the 2-column arc layout.
7. **Compact table labels.** `job` and `instance` are dropped, `__name__` is
   prefixed only when rows disagree on it, and the full label string stays in the
   cell `title`.
8. **Stack formula matches C-005.** `panelHeight(item, "stack")` is
   `max(160, height * 24)`, as documented; the code had drifted to `max(200,
   height * 34)`.
9. **`reading` synthetic label.** Grouped panels use
   `label_replace(..., "reading", "<name>", "", "")`; `seriesDisplayName`
   returns that value alone.
10. **Spark fixture v2:** 14 panels / 23 queries (was 15 / 18). Same-unit
   metrics share a panel: `thermal` (gpu, hbm, zone, hwmon °C), `power` (draw,
   limit W), `clocks` (sm, mem, cpu Hz). The duplicate TTFT panel is removed;
   `token-latency` keeps TTFT + inter-token. Rows are regrouped to match.

## Consequences

### Positive

- Axis labels, threshold labels, and legends are readable at phone widths
  (measured 9.5 px CSS, scale 1.00) instead of 4.45 px.
- `scrollHeight` 4234 → 2834 px on the same fixture: 4.97 → 3.33 screens.
- One fewer panel, one fewer HTTP request per cycle, and no duplicated data.
- Grouping is a dashboard-spec change; no new panel kinds, no renderer special
  cases per metric.

### Negative / risks

- Descriptions are not painted on narrow viewports. They remain in
  `aria-label`; a stale panel still shows its description line.
- `ResizeObserver` redraws replace the SVG node. Legend and series colors are
  recomputed from the same deterministic hash, so colors do not shift.
- The `reading` label is a fixture convention, not a Perses feature; a dashboard
  that does not add it falls back to the documented display-name rules.

### Follow-ups

- Grid-mode tile heights still follow the item height; a tall `StatChart` item
  keeps its slot.

## Contracts affected

- C-005: stack sizing exception for `StatChart`, exact-geometry charts,
  inline single gauge, compact table labels, compact header, `reading` display
  name. Version 3 → 4.

## Verification

```sh
mise exec -- node --test web/tests/          # 55 pass
python3 -m unittest discover -s tools -p 'test_*.py' -v   # 6 pass
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
python3 tools/check_docs.py
```

Browser measurement at 393×851: `scrollHeight` 2834, chart `viewBox` equals the
rendered box (scale 1.00), `.axis-label` computed `font-size: 9.5px`, stat tiles
51 px of content in a 60–75 px tile with zero overflow, gauge dial 104×104 in a
343×114 inline card, table rows 20–21 px.
