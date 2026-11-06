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
| `TimeSeriesChart` | One row per series: `label · last value`, plus a fixed-width **text sparkline** of the range | No chart template, but the shape is the glanceable part; block glyphs are text, so `IU-1`/`SA-1` still hold. A series with no range data is counted as an omitted chart |
| `Markdown` | **Omitted.** Reported as "text omitted" | Not glanceable; `AC-1` caps a task at five screens |

Every omitted panel is counted and reported, so the driver knows the view is a
summary, not the whole dashboard.

### Sparklines

A `TimeSeriesChart` cannot be drawn (no chart template), but its *shape* is the
glanceable part. Each series becomes a row with a fixed-width text sparkline
(`SPARK_WIDTH` = 24 characters) built from block glyphs `▁▂▃▄▅▆▇█`:

- The range is bucketed into `SPARK_WIDTH` equal slices and averaged, so a long
  range keeps its shape.
- A flat series renders mid-height (`▅`) rather than collapsing to the baseline,
  which would read as zero.
- An empty range yields no row and counts as an omitted chart.

Block glyphs are text, so `SA-1` (no animation) and `IU-1` (no images) still
hold.

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
