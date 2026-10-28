# C-005 — Panel rendering

- **Version:** 4
- **Status:** Accepted, 2026-10-27
- **Consumers:** Web renderer (W2)
- **Fixtures:** [`demo-dashboard.json`](../../contracts/fixtures/demo-dashboard.json),
  [`spark-dashboard.json`](../../contracts/fixtures/spark-dashboard.json)
- **Related:** C-002 (panel model), C-003 (data), C-004 (eligibility), C-006 (refresh)

## Purpose

Define which Perses panels v1 renders, how they behave, how they behave on a
phone-sized viewport, and what DOM/status surface tests can rely on.

This is a **subset**. Unknown panel kinds are filtered by C-004; they are not
rendered as generic charts.

## Supported panels

| Kind | Data | v1 rendering |
|---|---|---|
| `Markdown` | none | Sanitized subset; scrolls inside the panel |
| `TimeSeriesChart` | range queries | SVG multi-series line chart + legend |
| `StatChart` | range queries | One or more stat tiles; calculation + thresholds |
| `GaugeChart` | range queries | Arc gauge(s); calculation + thresholds |
| `Table` | instant queries | Series/value table |

Not supported in v1: `BarChart`, `ScatterChart`, `TraceTable`, `LogsTable`,
`TracingGanttChart`, `PieChart`, `Heatmap`, and any unknown kind.

No tooltips, zoom, pan, annotations, exemplars, or chart interaction in v1.
Rows can be collapsed/expanded; that is the only persistent interaction.

## Layout and responsive behavior

Input: normalized rows/items from C-002.

### Modes

- `layout_mode=auto` (default):
  - viewport CSS width **≥ 900 px** → 24-column grid;
  - otherwise → single-column stack.
- `grid`: always 24 columns.
- `stack`: always single column.

### Grid

- 24 columns; 8 px gap; 30 px row unit.
- Item `x` is 0-based; CSS column = `x + 1`, span = `width`.
- Item height = `max(140px, height * 30px + (height - 1) * 8px)`.
- Row container height is driven by its items; no absolute positioning outside
  the row.
- Items are ordered by `y`, then `x` for assistive reading order.

### Stack

- Items are ordered by row order, then item `y`, then `x`.
- Each item is full width; height = `max(160px, height * 24px)`.
- Exception: `StatChart` items are content-sized (`height: auto`,
  `min-height: 92px`) because a stat panel is a few text rows and the
  height-derived slot left more than half of it empty. Every other kind keeps
  the slot so long content scrolls inside the panel instead of growing the page.
- Stat/gauge tiles may use an internal 2-column grid on widths ≥ 420 px; charts
  remain full width.
- Collapsed rows show only their header and can be expanded by tapping.

### Rows

- Row title is rendered as a section heading; empty titles are allowed but the
  header still provides a collapse target if the row is collapsible.
- A row with zero eligible items is omitted. With `show_unsupported=true`, a row
  containing only placeholders remains.
- Collapse state is per page load, not persisted.

### Panel chrome

- Header: title (left), optional description as a muted line or accessible
  description, state indicator (right). On narrow viewports the header is a
  single 34 px row: the description moves into the panel's `aria-label` and is
  not painted, because a dozen panels × 14 px of description is a whole screen of
  scrolling for text the accessible name already carries.
- Body: renderer-specific.
- Error/stale badges do not resize the panel unexpectedly.

## Common data semantics

- Range panels use a shared time window per refresh cycle (C-006).
- A panel with multiple queries merges all normalized series; series identity is
  `labels` (canonicalized) plus a query index if labels collide.
- Series color is stable per panel: hash of the canonical label string into a
  fixed accessible palette. Duplicate labels get distinct palette entries.
- Empty result → `data-panel-state="empty"`, visible "No data" message.
- Query error → `data-panel-state="error"`, error code/message, last good data
  retained with a stale badge if available.
- Loading → skeleton/placeholder, `data-panel-state="loading"`.
- Hidden panels do not create DOM nodes unless `show_unsupported=true`.
- Unsupported placeholders use `data-panel-state="unsupported"`.

### Calculations (`StatChart`, `GaugeChart`)

`calculation` defaults to `last-number`. Supported values:

| Calculation | Meaning |
|---|---|
| `last-number` | Last non-null value in the series |
| `first-number` | First non-null value |
| `mean` | Arithmetic mean of non-null values |
| `sum` | Sum of non-null values |
| `min` | Minimum non-null value |
| `max` | Maximum non-null value |
| `count` | Count of non-null values |

Unknown calculation → `last-number` + `W_CALCULATION_UNKNOWN`.

Calculations are applied **per series**. If a panel has multiple series, render
multiple tiles/gauges and label each with its series name. Do not aggregate
across series unless the calculation itself is applied per series; there is no
implicit "total" across series in v1.

- Stat: max 12 tiles; extra series → `W_VALUES_TRUNCATED`.
- Gauge: max 4 gauges; extra series → `W_GAUGES_TRUNCATED`.
- If all values are null → `empty`.

### Thresholds

Perses threshold steps have `value` and optional `name`; v1 does not use
per-step colors.

- Sort steps ascending by `value`.
- A value below the first step (or no steps) uses the neutral/green state.
- For N steps, use: step 1 → warning (amber), step 2+ → critical (red). With a
  single step, values ≥ step → critical (red); below → green.
- Colors: `--state-ok` green, `--state-warn` amber, `--state-crit` red,
  `--state-muted` gray. Do not rely on color alone: include the threshold name or
  a textual state when available.
- Gauge arcs use the threshold zones; stat values use the state color and text.

### Value formatting

`spec.format` (panel or axis) may contain `unit` and `decimalPlaces` (0–4,
default 2 for non-integers). Supported units:

| Unit | Example |
|---|---|
| `none` / absent | `1234.5` |
| `percent` | `62.4%` |
| `bytes` | IEC: `1.5 MiB` |
| `decbytes` | SI: `1.5 MB` |
| `seconds` | `1.5 s` |
| `milliseconds` | `250 ms` |
| `short` | `1.2K`, `3.4M`, `5.6B` |
| `watts` | `61.5 W`, `1.5 kW` (SI scaling) |
| `celsius` | `52.4 °C` |
| `hertz` | `3.8 GHz` (SI scaling) |
| `bits` | `200 Gb/s`, `8.4 Gb/s` (bits, not bytes) |
| `tokens` | `980 tok/s`, `3.2K tok/s` |

Unknown unit → raw value + `W_UNIT_UNKNOWN` (once per panel). No unit conversion
is inferred from metric names. Unit suffixes act on the displayed value only;
the query result is never rescaled.

Number formatting must be locale-independent for tests (use `.` decimal
separator in assertions; UI may follow the browser locale later, but v1 uses
fixed formatting for stability).

### Series display names

`seriesDisplayName` favors a small set of labels that identify a series across
the supported dashboards: `mode`, `code`, `status`, `handler`, `path`,
`quantile`, `direction`, `engine`, `stage`, `state`, `device`, `counter`, `gpu`,
`reason`, and `collector`. When one or more are present, the display name is
their `key=value` list without the metric name. Otherwise it uses the metric
name plus the first two sorted labels other than `__name__`, `job`, and
`instance`. This is a presentation rule only; the canonical series key remains
the full sorted label set plus query index.

`reading` is a reserved synthetic label. A dashboard that groups same-unit
metrics in one panel adds it with `label_replace(...)` so each query's series
carries a short name (`gpu`, `hbm`, `zone`, `hwmon`, `sm`, `mem`, `cpu`, `draw`,
`limit`). When present, the display name is the `reading` value alone — a
`reading=` prefix would consume a third of a 168 px tile.

## Panel-specific rules

### Markdown

- `spec.text` string; missing → empty.
- Queries on a Markdown panel are ignored in v1 (no data fetch).
- Supported subset:
  - ATX headings `#`…`######`;
  - paragraphs;
  - **bold**, *italic*, `inline code`;
  - fenced code blocks (```), rendered monospace;
  - unordered/ordered lists (single level);
  - horizontal rules;
  - simple pipe tables (best effort).
- No raw HTML, no images, no iframes, no scripts, no clickable links. Link
  syntax is displayed as text (`label (url)`), never navigated.
- All text is escaped. Code blocks use `textContent`.
- Long content scrolls inside the panel; the dashboard does not grow unbounded.
- Empty text → `empty`.

### TimeSeriesChart

- Query kind must be `PrometheusTimeSeriesQuery` (C-003); other kinds make the
  panel ineligible (C-004).
- Range query only.
- SVG line chart:
  - plot area with padding for axes;
  - 4 y ticks, 3–5 x ticks (time labels in local time, `HH:mm` or `HH:mm:ss`
    depending on range);
  - auto y-domain across all visible series; include 0 if all values ≥ 0 and the
    max is small? Do not force zero by default; use a padded min/max. If all
    values are 0, show a flat line at 0.
  - null values break the path.
  - threshold lines (if any) dashed.
  - legend below (default) or right (`spec.legend.position`); cap 8 entries +
    "+N more"; show last value formatted.
  - `spec.legend.mode` is ignored; v1 always shows a list.
- Chart height fills the panel body; width is responsive.
- Geometry is CSS-pixel exact: the `viewBox` equals the measured rendered box,
  so text keeps its CSS size instead of being scaled with the drawing. Axis
  labels, threshold labels, and the legend are readable at 338 px-wide phone
  panels (previously a fixed 720×280 viewBox scaled 9.5 px text down to ~4.5 px).
  The renderer re-measures and redraws on `ResizeObserver` changes and re-renders
  on layout-mode changes.
- Padding adapts to the measured box: the left gutter is derived from the widest
  formatted tick label (capped at 72 px), and the x-axis label row is dropped to
  22 px in short panels.
- If there are no points → empty.
- If there are more series than the C-003 cap, the first 12 (stable sort) are
  rendered and a truncation note is recorded.
- `spec.yAxis.format.unit`/`spec.format.unit` drive formatting; axis labels may
  be abbreviated.
- `spec.visual` options (line width, area opacity, points) are best-effort:
  v1 honors `lineWidth` (1–4), `areaOpacity` (0–1), `showPoints` (boolean) if
  present; unknown options are ignored.

### StatChart

- Range query, per-series calculation (above).
- Tile: series label (truncated), value (large), unit, threshold state, and a
  3 px meter when `spec.thresholds.steps` is non-empty. The meter is a position
  on the threshold scale (`value / highest step`), so a panel without thresholds
  renders no meter — a bar pinned at 100% would claim "maximum" for any value.
  A single-series tile omits the label because the panel header names it; the
  tile fills its slot with `space-between` instead of centering content in a
  fixed-height box.
- Layout: flex/grid; one tile per series; max 12.
- `spec.format` controls value formatting; `spec.thresholds` controls color.
- No sparkline in v1.
- Panel title is the panel header; tile labels identify series.

### GaugeChart

- Range query, per-series calculation.
- Arc from -120° to +120° (240° sweep) with a value arc and threshold zones.
- One gauge: dial on the left, readout (value + state word) on the right, using
  the full panel width. The dial is sized from the measured body box rather than
  a fixed 180×170 viewBox, so nothing is scaled and the card is not half empty.
- Multiple gauges: value + unit centered in each arc, series label below; 2
  columns; max 4 gauges.
- No needle in v1; filled arc is sufficient.
- Threshold zones use the C-005 colors; no data → gray arc and "No data".

### Table

- Instant query at the cycle `end` time.
- Rows sorted by series label string, then value.
- Columns: `Series` and `Value` in v1. `Series` is a deterministic, compact
  label string: sorted labels excluding `__name__`, `job`, and `instance`, with
  `__name__` prefixed only when rows disagree on it
  (e.g. `code="200"`; full form `demo_requests_total{code="200"}` stays in the
  cell `title` and in diagnostics). `job`/`instance` identify the scrape target,
  not the series, and wrapping them cost 30–50 px per row on a phone.
- Max 100 rows; extra → `W_ROWS_TRUNCATED`.
- Numeric values formatted with `spec.format` if present; raw otherwise.
- No sorting/pagination/column settings in v1.
- Empty result → empty state.

## DOM and test hooks

Panel instance:

```html
<section class="panel" data-panel-id="cpu" data-panel-kind="TimeSeriesChart"
         data-panel-state="ready" aria-label="CPU usage">
  <header class="panel-header">…</header>
  <div class="panel-body">…</div>
</section>
```

Rows:

```html
<section class="row" data-row-title="Overview" data-row-collapsed="false">…</section>
```

Placeholders:

```html
<section class="panel panel-placeholder" data-panel-id="traces"
         data-panel-kind="TraceTable" data-panel-state="unsupported">
  …
</section>
```

Stable state values: `loading`, `ready`, `empty`, `error`, `unsupported`,
`hidden` (hidden nodes are not created; `hidden` may appear in diagnostics only).

Status line/overlay hooks live in C-009.

## Accessibility

- Each panel has an accessible name (title/description).
- Charts include a textual summary (`role="img"` + `aria-label` with series
  count, range, and last values) and a visible legend.
- Color is not the only indicator for thresholds/staleness; use text/icons.
- Touch targets (row headers) ≥ 44 px.
- Respect `prefers-reduced-motion`; no animations required in v1.

## Theme

Dark only in v1. `display_mode` (C-001) selects one of three presentations; all
modes share the same DOM, panel kinds, limits, status semantics, and data.

### `standard` (default)

The polished dark glass presentation. CSS variables:

```css
--bg: #0b0f14;
--panel: #111820;
--panel-border: #1f2a37;
--text: #e6edf3;
--muted: #8b949e;
--accent: #58a6ff;
--grid: #1f2a37;
--state-ok: #3fb950;
--state-warn: #d29922;
--state-crit: #f85149;
--state-muted: #6e7681;
```

### `amoled`

A true-black, flat presentation for OLED/AMOLED panels:

- page, panels, header, status bar, debug panel, fatal card, and boot screen use
  `#000000`;
- remove gradients, glows, shadows, backdrop blur, and all non-essential
  animations (including panel entrance, live-dot pulse, shimmer, and boot
  progress);
- keep the semantic state colors and the data series palette so thresholds and
  series remain distinguishable;
- use borders, not elevation, to separate surfaces.

### `monochrome`

The black-and-white, high-contrast, simplified presentation for lock-screen or
screensaver use. It is the `amoled` base plus:

- only white and gray for text, borders, accents, and states; no colored hues;
- a 12-entry grayscale series palette plus distinct dash patterns, so series are
  distinguishable without color;
- visible state words (`Nominal`, `Warn`, `Critical`, `Live`, `Degraded`,
  `Stale`, `Error`) remain the primary state indicator;
- the brand mark and header meta chips are hidden; the dashboard title,
  description, rows, panels, status bar, refresh action, and debug affordance
  remain;
- no gradients, shadows, blur, or animation.

Representative monochrome variables:

```css
--bg: #000000;
--panel: #000000;
--panel-border: #2e2e2e;
--text: #f5f5f5;
--muted: #a3a3a3;
--accent: #ffffff;
--state-ok: #f2f2f2;
--state-warn: #cfcfcf;
--state-crit: #ffffff;
--state-muted: #8a8a8a;
```

`monochrome` changes presentation only. It does not show the Activity over the
keyguard; C-007's `show_when_locked` controls that, and the two are intended to
be used together for a lock-screen dashboard.

No external fonts; system UI stack. No light theme in v1.

## Limits summary

| Limit | Value |
|---|---:|
| Series per panel | 12 |
| Points per series | 600 |
| Stat tiles | 12 |
| Gauges per panel | 4 |
| Table rows | 100 |
| Legend entries | 8 + "more" |
| Markdown render size | bounded by panel scroll, text capped at 100 KB |

## Test obligations

`web/tests/contract/c005-panels.test.js`:

- demo fixture: exact visible/hidden panel IDs and kinds;
- time series path generation with gaps/limits;
- stat/gauge calculations, thresholds, multiple series;
- table rows/sort/limit;
- Markdown escaping: `<script>`, raw HTML, links, code blocks;
- formatting units/decimals/unknown unit;
- monochrome charts use grayscale series and dash patterns;
- DOM hooks/states;
- stack vs grid ordering;
- empty/error/stale states;
- accessibility labels present.

Visual pixel tests are not required in v1; DOM/state assertions are.

## Out of scope

- Bar/scatter/pie/heatmap/gantt/trace/log panels.
- Tooltips, zoom, pan, annotations, exemplars.
- Variable pickers, links/actions, panel drilldowns.
- Light theme, custom fonts, remote images.
- Sparklines in stat panels.
- Context-aware threshold colors from Perses (v1 uses the documented mapping).
