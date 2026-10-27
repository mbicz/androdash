# C-005 — Panel rendering

- **Version:** 1
- **Status:** Accepted, 2026-10-26
- **Consumers:** Web renderer (W2)
- **Fixtures:** [`demo-dashboard.json`](../../contracts/fixtures/demo-dashboard.json)
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
  description, state indicator (right).
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

Unknown unit → raw value + `W_UNIT_UNKNOWN` (once per panel). No unit conversion
is inferred from metric names.

Number formatting must be locale-independent for tests (use `.` decimal
separator in assertions; UI may follow the browser locale later, but v1 uses
fixed formatting for stability).

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
- Tile: series label (truncated), value (large), unit, threshold state.
- Layout: flex/grid; one tile per series; max 12.
- `spec.format` controls value formatting; `spec.thresholds` controls color.
- No sparkline in v1.
- Panel title is the panel header; tile labels identify series.

### GaugeChart

- Range query, per-series calculation.
- Arc from -120° to +120° (240° sweep) with a value arc and threshold zones.
- Center: value + unit; series label below/above if multiple.
- Max 4 gauges; layout responsive (1 column on narrow, 2 columns if space).
- No needle in v1; filled arc is sufficient.
- Threshold zones use the C-005 colors; no data → gray arc and "No data".

### Table

- Instant query at the cycle `end` time.
- Rows sorted by series label string, then value.
- Columns: `Series` and `Value` in v1. `Series` is a deterministic label string
  from `__name__` and sorted labels (e.g. `demo_requests_total{code="200"}`).
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

Dark only in v1. CSS variables:

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
