# C-010 — Car projection

- **Version:** 1
- **Status:** Proposed, 2026-11-06
- **Consumers:** Android shell (W1)
- **Fixtures:** [`inference-fleet-dashboard.json`](../../contracts/fixtures/inference-fleet-dashboard.json),
  [`demo-dashboard.json`](../../contracts/fixtures/demo-dashboard.json)
- **Related:** C-002 (dashboard model), C-003 (Prometheus), C-005 (panel
  rendering), C-006 (refresh), C-009 (diagnostics)

## Purpose

Define how a dashboard is shown on an Android Auto head unit through the
Android for Cars App Library (CAL), and what is deliberately **not** shown.

The car screen is a second rendering target for the same dashboard. It is not
the phone view at a different size: CAL templates are lists, panes, and grids,
there is no chart template, and no drawing surface is available to an
IoT-category app. So this contract exists to make the omission explicit rather
than accidental — Article 3 of the constitution forbids silently dropping a
panel.

## Category and why

The app registers `androidx.car.app.category.IOT` in its
`CarAppService` intent filter and `<uses name="template"/>` in
`res/xml/automotive_app_desc.xml`.

`IOT` is the only category that fits: guideline `IT-1` permits *viewing the
current state of devices* while driving, which is what this dashboard does.
`NAVIGATION`, `POI`, and `WEATHER` would grant a drawing surface, but declaring
one is a misrepresentation and fails the manual Play review (`NF-1`, `NF-2`,
`NF-6`, `NF-7`, `PF-1`, `WE-1`). See decision 0033.

## Projection rules

Input: the same normalized dashboard model the phone renderer uses (C-002).
Output: a car view model — plain data, no CAL types — which the CAL layer turns
into templates.

### Panel kinds

| Panel kind | Car projection | Why |
|---|---|---|
| `StatChart` | One row per series: `label · value unit`, state word when a threshold applies | A number and a state word are glanceable |
| `GaugeChart` | One row per series: `label · value%`, state word | Same; the arc is not reproducible |
| `Table` | Up to [MAX_TABLE_ROWS] rows: `label` + formatted value | Already row-shaped |
| `TimeSeriesChart` | One row per series: a fixed-width **block sparkline** ([SPARK_WIDTH] cells) plus the last value and a state word | No chart template, but the shape is the glanceable part; blocks are text, so `IU-1`/`SA-1` still hold. A series with no range data is counted as an omitted chart |
| `Markdown` | **Omitted.** Reported as "text omitted" | Not glanceable; `AC-1` caps a task at five screens |

Every omitted panel is counted and reported, so the driver knows the view is a
summary, not the whole dashboard.

### Row geometry

A car row is laid out by the host, not by us. That has one consequence the
whole design follows: **the car font is proportional**, so a column cannot be
aligned by padding text with spaces.

Measured on AAOS (1024x768, density 160), from the host's own rendering:

| Text | Glyphs | Width | Per glyph |
|---|---|---|---|
| `Inference hosts` | 15 | 188 px | 12.53 px |
| `Temperatures` | 12 | 170 px | 14.17 px |
| `KV cache` | 8 | 115 px | 14.38 px |

Per-glyph advance varies by ~20%, so `"KV cache".padEnd(15)` would be 40 px too
wide. Fixed-width glyphs are the exception, and they are the only text we can
align with:

| Alphabet | Fixed | Advance |
|---|---|---|
| Block elements `▁▂▃▄▅▆▇█` | **yes** | 17.00 px |
| Shade `░` | **yes** | 17.00 px |
| Space | yes | **8.00 px** |
| Emoji | **no** | 30 / 33 / 40 px |

The host **clips a row text line at x=880** with the body starting at x=204, so
at most 39 cells (663 px) render uncut. Exceeding that is not harmless: the host
cuts at a fixed pixel width, so a longer run loses its tail and the *visible*
proportion stops matching the value. Verified: at 44 and 51 cells the run still
ended at x=880, and a 27% bar read as 35% of the visible width. [SPARK_WIDTH] and
[BAR_WIDTH] are therefore both 39.

The row therefore uses three structural devices, in order of preference:

1. **A host-laid-out leading column.** `Row.setImage` puts a tinted dot in a
   column the host sizes and positions, so every state indicator lands on the
   same x regardless of label or value length. This is the only *guaranteed*
   alignment in CAL, and it is what makes the green/red column read as a column.
2. **Fixed-width block runs** for shape. A sparkline or meter bar is a run of
   block glyphs, so its right edge is constant by construction.
3. **Color as a second channel.** The state word is tinted with
   `ForegroundCarColorSpan`, so a breach reads without parsing the word. The
   word stays: color is never the only cue (`AC-1`).

A row spends at most two text lines (the CAL limit): one for the shape when it
has one, one for the value and state. A row carries a sparkline **or** a meter,
never both.

### Sparklines

A `TimeSeriesChart` cannot be drawn (no chart template), but its *shape* is the
glanceable part. Each series becomes a row carrying a **block sparkline** of
[SPARK_WIDTH] cells.

Rules:

- Every cell is a block glyph — never a space. A space advances 8.00 px while a
  block advances 17.00 px, so a single blank shifts every following cell left
  and the row visibly drifts. (This was a real defect: empty cells were written
  as `' '` against filled cells of a different width.)
- Blocks fill their whole cell, so the row tiles into a continuous filled area.
- The range is bucketed per cell and averaged, so a long range keeps its shape.
- A flat series renders mid-height (`▅`) rather than collapsing to the baseline,
  which would read as zero.
- An empty range yields no row and counts as an omitted chart.

**Braille was tried and rejected.** It is fixed-width and packs a 2x4 dot grid,
so it promises finer resolution — but its dots are sparse by design. On screen
they render as isolated clusters separated by gaps, and two text lines carry a
line gap between them, so a two-line braille raster reads as broken and
vertically offset rather than as an area. Blocks are the honest choice.

### Meter bars

A value with a known `0..100` scale gets a **meter bar**: [BAR_WIDTH] cells of
`█` (the measured part) and `░` (the remaining capacity). Both are block
elements, so the run has a constant width and right edge.

The scale must be real. Only a `percent` unit gets a bar, because percent is the
only unit in the dashboard model with a defined maximum. `celsius`, `watts`,
`bytes`, and `hertz` have no maximum in the panel spec, so drawing a bar for
them would invent a scale — forbidden by `IU-1`. Such rows show the value and
state word only.

A missing sample yields no bar (not a zero-length one, which would read as 0%).

### State

Severity comes from **which threshold the value crossed**, never from the
threshold's name:

| Severity | Meaning | Dot tint | Value-line color |
|---|---|---|---|
| 0 | below every threshold | green | green |
| 1 | no data | secondary | secondary |
| 2 | crossed a lower threshold | yellow | yellow |
| 3 | crossed the highest threshold | red | red |

This is not cosmetic. A dashboard names its thresholds freely — the fleet
fixture uses `Busy`, `Tight`, `Hot` — so a name-keyed colour map matched none of
them and painted a **breached** row green. That defect shipped in an earlier
build and was caught by rendering a warning-state dashboard on the host.

The state *word* shown to the driver is still the dashboard's own name (`Busy`),
which is why the word and the severity are separate fields: [Row.state] is what
is displayed, [Row.severity] is what is colored. The dot is a row image tinted
via `CarIcon.setTint`; the word is tinted via `ForegroundCarColorSpan`. Both key
off [Row.severity], so they cannot disagree.

### Tabs

The car view is a `TabTemplate` with 2–4 tabs (CAL limit; fewer than 2 is
invalid). Tabs are filled in reading order (row, then band, then `x`, then `y`),
which preserves the phone's reading order:

| Tab | Content | Source |
|---|---|---|
| Fleet | Rows from the first group of stat/gauge panels | Panels 1–n |
| Inference | Rows from the next group | Panels n+1–m |
| Models | Table rows | `Table` panels |
| Summary | Omitted counts, host reachability | Derived |

A tab holds at most [MAX_ROWS_PER_TAB] rows. Overflow spills into the next tab
rather than truncating silently; if all tabs are full, the remainder is counted
in the Summary tab. This is the "one dashboard across swipeable surfaces" rule:
paging is by content, not free-form geometry.

### Values

Formatting matches C-005 exactly (`formatValue`, thresholds, `calculations`),
so a number reads the same on the phone and in the car. `calculations` defaults
to `last-number`.

A series with no data is rendered as `—` with the state word `No data`. It is
never omitted silently and never shown as `0`.

## Geometry

The car's screen is **not** the phone's. The CAL host reports:

- `ConstraintManager.getContentLimit(CONTENT_LIMIT_TYPE_LIST | _GRID)` — the
  maximum number of rows/items the host will render; the app cannot change it.
- `CarContext.getConfiguration()` — `screenWidthDp` / `screenHeightDp` of the
  head unit.

Both are read at screen construction and re-read on configuration change. The
phone's `Activity` display metrics are never used for car layout.

The row budget is `min(MAX_ROWS_PER_TAB, contentLimit)`. Rows beyond the limit
are reported, not dropped.

## Refresh

Polling uses the same collector/`prometheusUrl` and C-006 semantics as the
phone. The screen refreshes by `invalidate()`, at most once per
[CAR_REFRESH_FLOOR_SECONDS]. CAL hosts throttle; the app must not spin.

Stale data is marked: if the last successful fetch is older than
`2 × refreshSeconds`, the affected rows carry a `stale` marker rather than
presenting old numbers as current.

## Errors

| Code | When | Car surface |
|---|---|---|
| `E_CAR_NO_CONFIG` | The app has no stored `AppConfig` | MessageTemplate: "Open AndroDash on the phone to configure" |
| `E_CAR_NO_PROMETHEUS` | No `prometheus_url` and no reachable collector | MessageTemplate naming the missing prerequisite |
| `E_CAR_DASHBOARD` | Dashboard fetch/normalize failed | MessageTemplate with the C-009 code |
| `E_CAR_QUERY` | A Prometheus query failed | Row shows `—`; Summary counts failures |

Errors never fall back to fabricated numbers (Article 3).

## Limits

- Tabs: 2–4 (CAL).
- Rows per tab: [MAX_ROWS_PER_TAB] = 10.
- Table rows per panel: [MAX_TABLE_ROWS] = 8.
- Series per panel: [MAX_SERIES] = 12 (matches C-003).
- Dashboard fetch: 5 MiB (C-002).
- Refresh floor: [CAR_REFRESH_FLOOR_SECONDS] = 10 s, matching the CarPlay
  driving-task guidance and keeping CAL hosts from throttling.

## Compatibility

v1 is new. Additive changes (a new projected kind, a new tab) are allowed with a
`changelog.d` entry. Changing which kinds are omitted is breaking.

## Test obligations

- Pure projector tests over fixtures: which panels project, which are omitted,
  the omission counts, and tab assignment/overflow.
- Formatting parity: a value formats identically through C-005 and the car
  projector.
- Geometry: `contentLimit` and configuration are honoured; a host limit of 4
  rows produces 4 rows and a reported remainder.
- No fabricated data: an absent series renders `—` / `No data`.
