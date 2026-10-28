# C-005 — Panel rendering

- **Version:** 5
- **Status:** Accepted, 2026-10-27 (v5: phone pagination, working folding,
  round axes on the cycle window, series colour by position, flat visual system
  and locked view; decision 0015)
- **Consumers:** Web renderer (W2)
- **Fixtures:** [`demo-dashboard.json`](../../contracts/fixtures/demo-dashboard.json),
  [`spark-dashboard.json`](../../contracts/fixtures/spark-dashboard.json)
- **Related:** C-002 (panel model), C-003 (data), C-004 (eligibility), C-006 (refresh), C-007 (locked view), C-009 (status)

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
The only interactions are folding rows, paging horizontal strips (swipe or page
dots), and the header time controls (C-006). Folding and paging are per page
load, not persisted.

## Layout and responsive behavior

Input: normalized rows/items from C-002.

### Modes

- `layout_mode=auto` (default):
  - viewport CSS width **≥ 900 px** → 24-column grid;
  - otherwise → single-column stack.
- `grid`: always 24 columns.
- `stack`: always single column.

### Grid

- 24 columns; 8 px gap; row tracks `minmax(30px, auto)`.
- Item `x` is 0-based; CSS column = `x + 1`, span = `width`; CSS row = `y + 1`,
  span = `height`.
- Slot minimum height (`--panel-height-grid`) =
  `max(140px, height * 30px + (height - 1) * 8px)`. Tracks grow to fit, so an
  item never overflows into the next row (the earlier fixed-height slot
  overflowed by up to 34 px).
- Row container height is driven by its items; no absolute positioning outside
  the row.
- Horizontal strips (below) are `display: contents` and page dots are hidden,
  so strip slots are ordinary grid children.
- DOM order follows bands (below), which is reading order for assistive tech.

### Stack

- Items are ordered by row, then band, then within a band by `x`, then `y`.
- A band of one item is a full-width slot in the vertical stack; height
  (`--panel-height-stack`) = `max(160px, height * 24px)`.
- Exception: `StatChart` slots are content-sized (`height: auto`,
  `min-height: 92px`) because a stat panel is a few text rows and the
  height-derived slot left more than half of it empty. Every other kind keeps
  the slot so long content scrolls inside the panel instead of growing the page.
- Stat tiles flow in an internal `repeat(auto-fit, minmax(120px, 1fr))` grid;
  multi-gauge panels use 2 columns; charts remain full width.

### Pagination (stack mode)

A phone shows one panel width at a time, so side-by-side dashboard panels page
horizontally instead of being stacked into one long column.

- **Bands.** `bandItems(items)` walks a row's items in `y`, then `x` order. An
  item whose `y` is above the current band's bottom (`max(y + height)` of its
  items) joins that band; otherwise it starts a new band. Items whose vertical
  extents overlap therefore share a band. Inside a band, items are ordered by
  `x`, then `y` (the order of a swipe).
- **Strip.** A band with two or more rendered items becomes a `.panel-strip`
  (`role="group"`, `aria-roledescription="carousel"`,
  `aria-label="<row>: N pages, swipe sideways"`): a horizontal flex row with
  `scroll-snap-type: x mandatory`, a hidden scrollbar, and pages
  `calc(100% - 26px)` wide so the next card peeks in. `StatChart` pages are
  content-height.
- **Page dots.** A `.strip-dots` element follows each strip with one
  `<button class="strip-dot">` per page (`aria-label="Show <panel title>"`).
  An `IntersectionObserver` (root = strip, threshold 0.6) sets
  `data-active="true"` on the dot of the visible page; tapping a dot scrolls
  smoothly to its page. No timer or scroll handler runs while a strip is still.
- **Vertical snap.** In stack mode the document uses
  `scroll-snap-type: y proximity` with `scroll-snap-align: start` on the time
  toolbar, each row section, and each stacked slot or strip. The snap offset is
  `scroll-padding-top: var(--header-h)`; `--header-h` is the sticky header
  height, kept current by a `ResizeObserver`, so snapped content lands just
  below the header. Proximity (not mandatory) keeps free scrolling.
- Grid mode does not page (see Grid).

### Rows

- Every row has a full-width `<button class="row-header">` with the row title
  (`Overview` when the title is empty) and a chevron, and
  `aria-expanded="true|false"`.
- Tapping the header folds/unfolds the row: it toggles `data-row-collapsed` on
  the row section and the `hidden` attribute on `.row-body`. A global
  `[hidden] { display: none !important }` rule makes `hidden` win over the
  layout's `display` rules. A row with `collapse.open === false` (C-002) starts
  folded.
- A row with zero eligible items is omitted. With `show_unsupported=true`, a row
  containing only placeholders remains.
- Collapse state is per page load, not persisted.

### Panel chrome

- Header: one line, title (left) and badge (right). The panel description is
  never painted; it is part of the panel's `aria-label` (`title: description`).
  The only painted subtitle is the stale explanation
  (`<code> · showing last good data`, in the warning colour).
- The `.panel-badge` is empty — and hidden — unless the panel is `Stale`,
  `Error`, or `Hidden` (placeholder). Healthy, loading, and empty panels say
  nothing in the header: no `Live`, `Static`, `Loading`, or `No data` badge.
  Dashboard freshness is reported once, in the header status (C-009).
- Body: renderer-specific.
- Error/stale badges do not resize the panel unexpectedly.

## Common data semantics

- Range panels use a shared time window per refresh cycle (C-006).
- A panel with multiple queries merges all normalized series; series identity is
  `labels` (canonicalized) plus a query index if labels collide.
- Series colour is assigned by position within the panel: series index `i`
  uses `seriesColor(i)` = `var(--series-<i mod 8>)`. It is never derived from a
  label hash, so the first 8 series of a chart never share a colour; the line,
  area, and legend swatch carry the same slot (`data-series`).
- Empty result → `data-panel-state="empty"`, "No data" in the panel body (not
  in the header).
- Query error → `data-panel-state="error"`, error code/message, last good data
  retained as `stale` if available.
- Loading → `data-panel-state="loading"`, `aria-busy="true"`, no badge.
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
- No steps → state `none`: the panel makes no judgement (neutral stat edge, blue
  gauge arc, no meter, no state word).
- A value below the first step → `ok`.
- For N ≥ 2 steps: step 1 → `warn`, step 2+ → `crit`. With a single step,
  values ≥ step → `crit`; below → `ok`.
- Colours are CSS variables: `--ok` green, `--warn` amber, `--crit` red,
  `--none` blue accent (gauge arc), `--edge-none` neutral gray (stat edge).
- Colour is not the only signal: `warn`/`crit` values show a state word — the
  step's `name`, else `Warning`/`Critical`. `ok` and `none` show no word; no
  "Nominal" text is painted anywhere.
- Stat tiles carry the state on a left edge, gauges on the value arc (thresholds
  as notches), charts as dashed threshold lines in the state colour.

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
  - **X domain** = the cycle's requested window `[start, end]` (C-006), passed
    to the renderer as `timeWindow` — not the data extent. Every chart in a
    cycle shares the same time axis, and a series that starts late or stops
    leaves visible empty space. Without a window (tests) the data extent is
    used.
  - **Time ticks** (`timeTicks`): the smallest step from 1 s, 2 s, 5 s, 10 s,
    15 s, 30 s, 1 m, 2 m, 5 m, 10 m, 15 m, 30 m, 1 h, 2 h, 3 h, 6 h, 12 h, 1 d,
    2 d, 7 d that yields at most `min(8, floor(plotWidth / 84))` ticks (at
    least 2), aligned to local wall-clock boundaries (a 5 m step falls on
    :00, :05; a 6 h step on 00:00, 06:00). Labels are local `h:mm`, with
    seconds when the step is below 60 s, the weekday for steps ≥ 1 day (month
    and day when the span exceeds 7 days), and the weekday at midnight ticks on
    multi-day spans.
  - **Value ticks** (`niceTicks`): steps of 1, 2, 2.5, or 5 × 10^k; the domain
    extends to the enclosing ticks; 4 intervals (3 when the body is under
    150 px tall). `bytes` axes step in powers of 1024 (512 MiB, 1 GiB, 1.5 GiB).
    Threshold values are included in the domain. A constant series is padded
    (±50%, or 0…1 for all-zero) without going below 0 for non-negative data;
    positive-only data never gets a negative axis.
  - Value labels sit on the **right**, in a gutter sized from the widest tick
    label (5.6 px per character + 8, clamped to 22–64 px); the plot starts at
    the left edge. Time labels sit in an 18 px bottom row, edge labels anchored
    inward. Axis labels are 10 px with tabular numerals.
  - Horizontal hairlines at value ticks; no vertical grid lines.
  - null values break the path; the last point is marked with a dot.
  - Threshold lines are dashed in the state colour (step 1 amber, step 2+ red).
  - Area fill under each line at `--area-opacity` (0.12; 0 in monochrome)
    unless `spec.visual.areaOpacity` is set.
  - Legend always below the plot (`spec.legend.position` and `spec.legend.mode`
    are ignored); cap 8 entries + "+N more"; each entry shows its series
    swatch, name, and last value formatted.
- Chart height fills the panel body; width is responsive.
- Geometry is CSS-pixel exact: the `viewBox` equals the measured rendered box,
  so text keeps its CSS size instead of being scaled with the drawing (a fixed
  720×280 viewBox once scaled 9.5 px text down to ~4.5 px on a 338 px panel).
  The renderer re-measures and redraws on `ResizeObserver` changes and
  re-renders on layout-mode changes.
- `spec.visual` options (line width, area opacity, points) are best-effort:
  v1 honors `lineWidth` (1–4), `areaOpacity` (0–1), `showPoints` (boolean) if
  present; unknown options are ignored.

### StatChart

- Range query, per-series calculation (above).
- Tile: series label (multi-series only, truncated), number, unit set smaller
  (`splitUnit`: `62.4` + `%`), a state word only for `warn`/`crit`, and a 3 px
  state edge on the tile's left: green `ok`, amber `warn`, red `crit`, neutral
  gray `none` when the panel has no thresholds.
- A 3 px meter appears only when `spec.thresholds.steps` is non-empty. The meter
  is a position on the threshold scale (`value / highest step`), so a panel
  without thresholds renders no meter — a bar pinned at 100% would claim
  "maximum" for any value.
- A single-series tile omits the label because the panel header names it and
  uses a 40 px number; the tile fills its slot with `space-between` instead of
  centering content in a fixed-height box.
- Layout: flex/grid; one tile per series; max 12.
- `spec.format` controls value formatting; `spec.thresholds` controls color.
- No sparkline in v1.
- Panel title is the panel header; tile labels identify series.

### GaugeChart

- Range query, per-series calculation.
- Open 240° arc with the gap at the bottom: screen angles 150° → 390° (0° =
  right, clockwise), round caps. The track is a neutral fill (`--fill`); the
  value arc is in the state colour (`ok` green, `warn` amber, `crit` red;
  `--none` blue when the panel has no thresholds). Each threshold step is a
  notch cut into the track; there are no coloured zones.
- Scale maximum: 100 for `percent`; otherwise
  `max(1, every step value, the value) × 1.12`.
- One gauge: arc on the left, large readout on the right (44 px value, smaller
  unit, state word only for `warn`/`crit`), using the full panel width. The
  arc is sized from the measured body box rather than a fixed viewBox.
- Multiple gauges: 2-column grid, value + unit inside each arc, series label
  below with the state word only for `warn`/`crit`; max 4 gauges.
- No bordered card per gauge; no needle.
- No values → the panel's empty state ("No data").

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

Rows and pagination:

```html
<section class="row" data-row-title="Overview" data-row-collapsed="false">
  <button class="row-header" aria-expanded="true">…</button>
  <div class="row-body">
    <div class="panel-slot">…</div>                 <!-- band of one -->
    <div class="panel-strip" role="group" aria-roledescription="carousel">
      <div class="panel-slot">…</div>
      <div class="panel-slot">…</div>
    </div>
    <div class="strip-dots">
      <button class="strip-dot" data-active="true" aria-label="Show CPU"></button>
      <button class="strip-dot" data-active="false" aria-label="Show Load"></button>
    </div>
  </div>
</section>
```

Placeholders:

```html
<section class="panel panel-placeholder" data-panel-id="traces"
         data-panel-kind="TraceTable" data-panel-state="unsupported">
  …
</section>
```

Stable state values: `loading`, `ready`, `empty`, `stale`, `error`,
`unsupported`, `hidden` (hidden nodes are not created; `hidden` may appear in
diagnostics only). The panel badge text is `Stale`, `Error`, `Hidden`, or empty.

Header status and overlay hooks live in C-009.

## Accessibility

- Each panel has an accessible name (title/description).
- Charts include a textual summary (`role="img"` + `aria-label` with series
  count, range, and last values) and a visible legend.
- Color is not the only indicator for thresholds/staleness: state words for
  `warn`/`crit`, `Stale`/`Error` badges, and the stale explanation line.
- Row headers are full-width buttons at least 44 px tall with `aria-expanded`;
  page dots are labelled 24 px buttons.
- Respect `prefers-reduced-motion`: the only transitions (chevron and page dot,
  160–180 ms) are disabled.

## Visual system and display modes

Dark only. `web/app/styles.css` defines one flat presentation:

- black canvas (`--bg: #000`); flat cards (`--card: #1c1c1e`) with a 20 px
  radius and no borders inside cards (unsupported placeholders use a hairline
  outline instead of a fill);
- no gradients, glows, shadows, blur, or animations; the only motion is the
  160–180 ms chevron and page-dot transition;
- system UI font stack, no external fonts; tabular numerals;
- colour only where it means something — the state of a measurement and the
  identity of a series — and every colour is a CSS variable.

Standard tokens (abridged):

```css
--bg: #000;
--card: #1c1c1e;
--fill: rgba(120, 120, 128, 0.24);
--hairline: rgba(84, 84, 88, 0.5);
--label: #fff;
--label-2: rgba(235, 235, 245, 0.6);
--label-3: rgba(235, 235, 245, 0.3);
--ok: #30d158;
--warn: #ffd60a;
--crit: #ff453a;
--none: #0a84ff;
--edge-none: rgba(235, 235, 245, 0.16);
--series-0 … --series-7: #0a84ff #bf5af2 #64d2ff #ff9f0a #ff375f #5e5ce6 #66d4cf #ac8e68;
--area-opacity: 0.12;
```

`display_mode` (C-001) is a pure stylesheet switch on
`html[data-display-mode]`; all modes share the same DOM, panel kinds, limits,
status semantics, and data, and switching never re-renders.

### `standard` (default)

The tokens above.

### `amoled`

Near-black cards (`--card: #0c0c0d`) and a slightly dimmer fill on the black
canvas, so unlit pixels stay off. State and series colours are unchanged.

### `monochrome`

No hue at all:

- cards are black; text, fills, and hairlines are white/gray;
- state moves to luminance (`--ok` dim white, `--warn` brighter, `--crit`
  white, `--none` light gray) plus the state word for `warn`/`crit`;
- series move to gray levels and dash patterns by slot (`data-series`): eight
  distinct strokes (0 solid; 1–7 each a different dash), so no two series in a
  panel share a stroke; legend swatches become solid, dashed, or dotted stroke
  samples;
- no area fill (`--area-opacity: 0`).

### Locked view

`window.androdash.setLocked(bool)` — pushed by the Android shell while the
phone is locked with `show_when_locked` (C-007) — sets `html[data-locked]` and
forces `data-display-mode="monochrome"` without re-rendering; `setLocked(false)`
restores the configured mode. While locked the time toolbar, header actions,
and page dots are hidden and panel padding tightens; refreshing continues. The
header status stays visible.

`monochrome` and the locked view change presentation only; showing the Activity
over the keyguard is C-007's `show_when_locked`.

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

`web/tests/contract/c005-panels.test.js` and
`web/tests/contract/c005-layout.test.js`:

- demo fixture: exact visible/hidden panel IDs and kinds;
- time series path generation with gaps/limits;
- series colour by position: series in one chart never share a colour or dash
  slot;
- time axis spans the cycle window and ticks on round minutes; positive-only
  charts get no negative axis;
- `niceTicks` round values and 1024-step byte axes; `timeTicks` wall-clock
  alignment;
- stat/gauge calculations, thresholds, state word only on crossing, meter only
  with thresholds, multiple series;
- table rows/sort/limit;
- Markdown escaping: `<script>`, raw HTML, links, code blocks;
- formatting units/decimals/unknown unit;
- bands: side-by-side items form one band, full-width items stay vertical, tall
  items keep their stacked neighbours in the band (column first);
- a band renders as a strip with one page dot per panel;
- tapping a row header folds and unfolds it; a dashboard-collapsed row starts
  folded;
- DOM hooks/states;
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
