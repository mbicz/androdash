# C-005 — Panel rendering

- **Version:** 6
- **Status:** Accepted, 2026-10-27 (v5: phone pagination, working folding,
  round axes on the cycle window, series colour by position, flat visual system
  and locked view; decision 0015); amended 2026-10-28 (v6: fit-to-screen
  layout, settings sheet, box-shaped gauges and stat tiles, shared table label
  heading, height-aware axes, `lock_style` palette for the locked view;
  decision 0017)
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

The only interactions are folding rows, paging horizontal strips (swipe or page
dots), and the header actions — refresh now and the view settings sheet (see
[Header and settings sheet](#header-and-settings-sheet)). Folding and paging
are per page load, not persisted.

## Layout and responsive behavior

Input: normalized rows/items from C-002.

### Modes

- `layout_mode=auto` (default):
  - viewport CSS width **≥ 900 px** → 24-column grid;
  - otherwise → single-column stack.
- `grid`: always 24 columns.
- `stack`: always single column.
- `fit`: fit-to-screen layout (see [Fit layout](#fit-layout)). The locked view
  always uses it, whatever `layout_mode` says.

`auto`, `grid`, and `stack` are the scroll layouts; the settings sheet offers
them as one "Scroll" choice next to "Fit to screen".

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
  multi-gauge panels choose their column count from the box shape (see
  GaugeChart); charts remain full width.

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
  `scroll-snap-type: y proximity` with `scroll-snap-align: start` on each row
  section and each stacked slot or strip. The snap offset is
  `scroll-padding-top: var(--header-h)`; `--header-h` is the sticky header
  height, kept current by a `ResizeObserver`, so snapped content lands just
  below the header. Proximity (not mandatory) keeps free scrolling.
- Grid mode does not page (see Grid).

### Fit layout

`layout_mode=fit`, and always while locked. The screen dictates the layout:
every panel on one screen, in dashboard reading order, at a size that keeps its
content legible, with no scrolling and no padding with empty space. The planner
is `web/app/src/fit.js` (pure functions, no DOM); `main.js` builds the DOM.

- **Items.** Rows in order; inside a row, items by `y`, then `x`. Unsupported
  placeholders and `Markdown` panels (`FIT_EXCLUDED_KINDS`: documentation, not
  readings) are **not shown** in fit. Row headers, folding, strips, and page
  dots are not used; panels of folded rows are shown. Each item carries its
  kind and a display count: after data, its series count (gauges capped at 4);
  before the first data, 6 for a `Table`, otherwise its query count (≥ 1).
- **Demand** (`panelDemand(kind, count, width)`): the minimum legible height of
  a panel `width` px wide, its minimum width, and its growth weight. Panel
  chrome (title + padding) is 36 px; the inner width is `width − 20`.

  | Kind | Minimum height after the 36 px chrome | Min width | Weight |
  |---|---|---:|---:|
  | `StatChart` | one tile: 34; else tile rows × 44 + 6 px gaps, tiles ≥ 76 px wide | 96 | 1 |
  | `GaugeChart` | one ring: 64; else ring rows × 74 + 6 px gaps, rings ≥ 70 px wide (≤ 4) | 90 | 2 |
  | `TimeSeriesChart` | plot 56 + time axis 14 + legend `lines × 15 + 4`; legend entries are 140 px one-liners, `lines = ceil(min(n, 8) / floor(inner / 140))` | 150 | 3 |
  | `Table` | `min(n, 3)` rows × 18, + 14 for `+N more` when `n > 3`; capped at all `n` rows × 18 | 140 | 1 |
  | other | 40 | 120 | 1 |

- **Plan** (`planFit(items, { width, height })`, 8 px gap):
  - column counts `C = 1 … min(6, floor((width + 8) / 158))` (columns ≥
    150 px);
  - for each `C`, dynamic programming over contiguous runs of up to `C` panels
    (reading order is kept, like breaking a paragraph into lines) and every
    split of the `C` columns among a run's panels; a split is valid only when
    each panel gets at least its minimum width. A row's minimum height is its
    tallest member's, its weight the largest member weight; a row of only
    tables is capped at its tallest table's full height. The plan minimises
    the total minimum height (gaps included); ties prefer fewer rows;
  - `room = height / total minimum height`. The fewest columns with
    `room ≥ 1.12` wins (wider panels read better); otherwise the plan with the
    most room;
  - `scale = min(1, room)`, floored at **0.72**. Below the floor the plan
    overflows: the grid scrolls vertically and `W_FIT_OVERFLOW` (C-009) is
    recorded. Panels are never dropped to make room.
- **DOM.** `<main class="fit-grid">` is as tall as the visual viewport below
  the header (minus the bottom safe-area margin), with `--fit-scale` set to the
  scale and one `grid-template-rows` track per planned row:
  `minmax(<min × scale>px, <weight>fr)`, or `minmax(<min × scale>px,
  <max × scale>px)` for a capped row. Left-over height therefore goes to charts
  first, then gauges, never past a table's rows. Each row is a `.fit-row` grid
  with one `minmax(0, <span>fr)` column per panel, each panel in a
  `.panel-slot`. Panel titles, tile and gauge labels, state words, legends,
  axis labels, and table cells scale with `--fit-scale`. `html[data-layout="fit"]`
  and the body do not scroll; `.fit-grid.overflow` does.
- **Header.** One compact line: title (20 px), the status beside it, and 30 px
  icon buttons; it is not sticky.
- **Rebuild instead of waiting.** `renderDashboard()` rebuilds the page and
  repaints every panel's retained data or error, so a layout switch, rotation,
  and lock/unlock never wait for the next refresh. In fit, a window resize
  (including rotation) re-plans after a 120 ms debounce; after each cycle, if
  any panel's display count differs from the planned count, it re-plans the
  same way.
- **Content.** Renderers receive `fit: true` and the measured body box and fill
  it: stat tiles size to the box (StatChart), gauges choose columns by box
  shape (GaugeChart, all layouts), chart legends become a grid of one-line
  entries, and tables show the rows that fit plus `+N more` (Table).

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

## Header and settings sheet

The header (`.app-header`) holds the dashboard title, the one dashboard status
(C-009), and icon actions: **Refresh now**, **View settings** (sliders icon),
and diagnostics (only with `debug=true`). The page carries no toolbar or other
controls.

View settings opens a bottom sheet (`.sheet-overlay` > `.sheet`,
`role="dialog"`, `aria-modal="true"`, `aria-label="View settings"`) titled
"View" with a Done button; Done, Escape, or a tap outside the sheet closes it.
Each group is a segmented control (`role="radiogroup"`, segments
`role="radio"` with `aria-checked`). A choice applies at once and, when the
shell bridge is present, is persisted with C-007
`AndroDash.setOption(name, value)`; in a plain browser it lasts for the
session.

| Group | Choices | Effect |
|---|---|---|
| Time range | `5m` `15m` `1h` `6h` `24h` `7d` (+ the effective range) | `time_range`; refresh now (C-006) |
| Refresh | `Off` `5s` `10s` `30s` `1m` `5m` (+ the effective interval) | `refresh_seconds`; reschedule (C-006) |
| Layout | Scroll \| Fit to screen | `layout_mode`: `fit`, or back to the scroll mode used before (`auto` if none); the page is rebuilt at once |
| Dashboard | Saved on phone \| Live from URL; "Update from URL" | Only when the bridge exposes `storeDashboard` (C-002 "Dashboard sources"). `dashboard_source` `stored`/`url`, then reload; the update re-fetches `dashboard_url` and replaces the stored copy only if it normalizes. A bundled dashboard shows "Built into the app". |
| Collector | read-only | Only when C-007 `collectorStatus()` reports `enabled`. Shows whether the on-phone Prometheus runs (and restart count or last exit), and one row per scrape target coloured by its `up` value from an instant query to the collector (`unknown` until it answers). |
| On the lock screen | Off \| Grayscale \| Color | Only when the bridge exposes `lockScreenEnabled` and `setLockScreen` (C-007). Off → `setLockScreen(false)`; Grayscale/Color → `lock_style` `monochrome`/`color`, then `setLockScreen(true)`. Shows Off while `lockScreenEnabled()` is false, else the current `lock_style`. |

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
    2 d, 7 d that yields at most `max(2, min(8, floor(plotWidth / w)))` ticks,
    with `w` = 46 px for a compact plot (under 260 px wide) and 84 px
    otherwise. If that round step lands only once in the window, the next
    finer step is used (when it gives at most one tick more than the limit),
    so the axis does not show a single time. Ticks align to local wall-clock
    boundaries (a 5 m step falls on :00, :05; a 6 h step on 00:00, 06:00).
    Labels are local `h:mm` (compact plots drop the AM/PM marker), with
    seconds when the step is below 60 s, the weekday for steps ≥ 1 day (month
    and day when the span exceeds 7 days), and the weekday at midnight ticks on
    multi-day spans.
  - **Value ticks** (`niceTicks`): steps of 1, 2, 2.5, or 5 × 10^k; the domain
    extends to the enclosing ticks; the target interval count follows the
    chart height, about one label per 22 px:
    `max(1, min(4, floor((height − 25) / 22)))`, so labels never touch on short
    charts. `bytes` axes step in powers of 1024 (512 MiB, 1 GiB, 1.5 GiB).
    Threshold values are included in the domain. A constant series is padded
    (±50%, or 0…1 for all-zero) without going below 0 for non-negative data;
    positive-only data never gets a negative axis.
  - Value labels sit on the **right**, in a gutter sized from the widest tick
    label (5.6 px per character + 8, clamped to 22–64 px); the plot starts at
    the left edge. Time labels sit in an 18 px bottom row, edge labels anchored
    inward. Axis labels are 10 px with tabular numerals (9.5 px × fit scale in
    the fit layout).
  - Horizontal hairlines at value ticks; no vertical grid lines.
  - null values break the path; the last point is marked with a dot.
  - Threshold lines are dashed in the state colour (step 1 amber, step 2+ red).
  - Area fill under each line at `--area-opacity` (0.12; 0 in monochrome)
    unless `spec.visual.areaOpacity` is set.
  - Legend always below the plot (`spec.legend.position` and `spec.legend.mode`
    are ignored); cap 8 entries + "+N more"; each entry shows its series
    swatch, name, and last value formatted. In the fit layout the legend is a
    grid of one-line entries (columns ≥ 140 px; the name is ellipsised, the
    value kept whole).
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
- In the fit layout tiles fill the panel box (`fitTiles`, re-run on
  `ResizeObserver` changes): columns and rows from `bestCellGrid` with a tile
  aspect of 2.2 (one cell for a single tile), and one number size for the
  whole panel, `--value-size` = the smallest of `0.78 × (cell height − 15)`
  (no label allowance for a single tile) and
  `(cell width − 14) / max(3, 0.58 × L)`, where `L` is the longest number's
  length plus 0.55 × its unit's length, clamped to 14…44 px (14…56 px for a
  single tile).
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
- Arrangement follows the measured body box, in every layout, and is redone on
  `ResizeObserver` changes:
  - **One gauge:** when the box is at least 1.5× as wide as tall, the arc
    (side `min(height, 0.42 × width)`) sits left of a large readout (44 px
    value, 34 px in fit; smaller unit; state word only for `warn`/`crit`).
    Otherwise the ring alone takes `min(width, height)` with value + unit
    inside the arc and the readout hidden.
  - **Multiple gauges:** columns from `bestCellGrid(count, width, height,
    { aspect: 1.05, gap: 12 })` — the split that makes the rings largest for
    the box shape — with value + unit inside each arc and the series label
    below (state word only for `warn`/`crit`); max 4 gauges.
  - The value inside a ring is `0.56 × radius`, clamped to 13–40 px.
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
- Shared label key: when rows agree on `__name__` and every row is identified
  by the same single label (after excluding `__name__`, `job`, `instance`),
  that key becomes the first column heading and cells show only its value
  (heading `collector`, cells `cpu`, `disk`; heading `code`, cell `200`). This
  applies in every layout, but the fit layout hides the header row, so there
  the cells show the bare values.
- Fit layout: rows are 18 px and the header row is hidden. The body box holds
  `capacity = floor(height / 18)` rows; when there are more, the first
  `max(1, capacity − 1)` rows are shown followed by a `.table-more` line
  `+N more` counting the rest.
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

Fit layout:

```html
<main class="fit-grid" style="--fit-scale: 1.000; grid-template-rows: minmax(118px, 1fr) minmax(144px, 3fr)">
  <div class="fit-row" style="grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)">
    <div class="panel-slot">…</div>
    <div class="panel-slot">…</div>
  </div>
  <div class="fit-row" style="grid-template-columns: minmax(0, 1fr)">
    <div class="panel-slot">…</div>
  </div>
</main>
```

`html[data-layout]` is `fit` or `scroll`; the app shell's `data-layout-mode`
is `fit`, `grid`, or `stack`. An overflowing fit plan adds `.overflow` to
`.fit-grid`.

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
switches the palette by C-001 `lock_style`: `monochrome` (default) →
`data-display-mode="monochrome"`; `color` → `data-display-mode="amoled"`
(near-black cards, full state and series colour), whatever `display_mode` is
configured. `setLocked(false)` restores the configured mode. The locked view
always uses the [fit layout](#fit-layout): when the layout in use is not fit,
locking and unlocking rebuild the page and repaint retained data at once.
While locked the header actions are hidden; the header status stays visible
and refreshing continues.

`monochrome` changes presentation only; the locked view changes presentation
and layout. Showing the Activity over the keyguard is C-007's
`show_when_locked`.

## Limits summary

| Limit | Value |
|---|---:|
| Series per panel | 12 |
| Points per series | 600 |
| Stat tiles | 12 |
| Gauges per panel | 4 |
| Table rows | 100 |
| Legend entries | 8 + "more" |
| Fit columns | 6 |
| Fit minimum type scale | 0.72 (then scroll + `W_FIT_OVERFLOW`) |
| Markdown render size | bounded by panel scroll, text capped at 100 KB |

## Test obligations

`web/tests/contract/c005-panels.test.js`,
`web/tests/contract/c005-layout.test.js`, and
`web/tests/contract/c005-fit.test.js`:

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
- table rows/sort/limit; a shared single label key becomes the column heading;
  fit tables show the rows their box holds and count the rest (`+N more`);
- Markdown escaping: `<script>`, raw HTML, links, code blocks;
- formatting units/decimals/unknown unit;
- bands: side-by-side items form one band, full-width items stay vertical, tall
  items keep their stacked neighbours in the band (column first);
- a band renders as a strip with one page dot per panel;
- tapping a row header folds and unfolds it; a dashboard-collapsed row starts
  folded;
- fit: every panel stays on one phone screen in reading order; one full-width
  column when the screen allows it; no panel narrower than its minimum width;
  type shrinks to the 0.72 floor, then the plan reports overflow instead of
  hiding panels; charts take the growth while a table never grows past its
  rows; cell grids follow the box shape;
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
