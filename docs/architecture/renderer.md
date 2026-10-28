# Web renderer architecture

**Status:** implemented for M1; contract tests live in `web/tests/contract/`.
**Workstream:** W2.
**Contracts:** C-001 … C-006, C-009.
**Scope:** `web/app/` runtime and `web/tests/`.

## 1. Constraints

- Vanilla ES modules, no bundler, no framework, no remote code, no CDN.
- Runs in the Android WebView from the virtual `http://androdash.local` origin
  (decision 0007) and in a normal browser over HTTP for development.
- No dependencies at runtime; tests use Node's built-in test runner.
- Rendering is client-side and bounded for a phone.
- All externally visible behavior follows the contracts.

## 2. Layout

```
web/
├── AGENTS.md
├── app/                      # served as Android assets; runtime only
│   ├── index.html
│   ├── styles.css            # visual system; display modes are CSS variables
│   └── src/
│       ├── main.js           # boot, header/toolbar, wiring, window.androdash
│       ├── config.js         # query → canonical AppConfig
│       ├── fetch-json.js     # timeout/redirect/error helpers
│       ├── dashboard/
│       │   ├── load.js       # fetch and select a dashboard
│       │   ├── normalize.js  # Perses subset → internal model, variables,
│       │   │                 # interpolation, title variables
│       │   └── duration.js   # duration parsing
│       ├── capabilities.js   # probe + capability set
│       ├── eligibility.js    # panel filtering and reasons
│       ├── prometheus.js     # HTTP client, response normalization, series names/colours
│       ├── scheduler.js      # refresh state machine
│       ├── diagnostics.js    # error codes, redaction, status model
│       ├── layout.js         # rows, bands/strips, folding, grid/stack placement
│       └── panels/
│           ├── index.js      # panel plugin registry
│           ├── time-series.js
│           ├── stat.js
│           ├── gauge.js
│           ├── table.js
│           ├── markdown.js
│           ├── format.js     # units, calculations, thresholds
│           ├── scale.js      # nice value ticks and wall-clock time ticks
│           └── svg.js        # small SVG helpers
└── tests/
    ├── helpers/
    │   └── mini-dom.js       # minimal DOM for Node tests
    └── contract/
        ├── c001-config.test.js
        ├── c002-dashboard.test.js
        ├── c003-prometheus.test.js
        ├── c004-capabilities.test.js
        ├── c005-layout.test.js
        ├── c005-panels.test.js
        ├── c006-refresh.test.js
        └── c009-diagnostics.test.js
```

Contract tests map to contract IDs and are named accordingly. C-007/C-008 are
Android-shell checks, not web tests.

## 3. Boot pipeline

`main.js` owns orchestration only; logic lives in testable modules.

1. **Config** — parse `location.search`, validate, apply defaults (C-001).
2. **Shell** — find the DOM roots and create diagnostics; show fatal card on
   config error.
3. **Dashboard** — fetch the URL, select a dashboard, normalize to the internal
   model (C-002).
4. **Capabilities** — collect datasource URLs, probe Prometheus, apply the
   advertised override (C-004).
5. **Variables** — resolve defaults; label variables may call Prometheus; then
   interpolate variables into dashboard/row/panel titles (C-002).
6. **Eligibility** — filter panels and rows, record reasons (C-004).
7. **Layout** — build the header, time toolbar, rows, and panels once (C-005).
8. **Data** — first refresh cycle (C-006), then schedule.
9. **Status** — update the header status and diagnostics when a cycle settles
   or the scheduler state changes.

The renderer should paint the dashboard shell and Markdown/unsupported states
before all data arrives, then fill panels progressively. A slow Prometheus must
not block the whole screen.

## 4. Internal model (summary)

The normalized model is an implementation detail, but these concepts are stable:

```js
DashboardModel = {
  name, description, duration, refreshInterval,
  datasources: Map<name, {kind, url, default}>,
  variables: Map<name, {kind, value, values}>,
  panels: Map<id, PanelModel>,
  rows: [{title, collapsed, items: [{x, y, width, height, panelId}]}]
}

PanelModel = {
  id, title, description,
  kind, spec,               // panel plugin kind + raw spec
  queries: [{kind, spec, datasource, query}]
}
```

Raw Perses fields are preserved where renderers need them. Unknown fields are
ignored, not copied into the DOM.

## 5. Rendering strategy

### DOM

- One root element (`#app`) with:
  - a sticky header: dashboard title (variables interpolated), one
    dashboard-wide status line (C-009), and icon actions (refresh now,
    lock-screen toggle when the shell bridge offers it, diagnostics in debug);
  - a time toolbar: range segmented control and refresh `<select>` (C-006);
  - one section per row with a folding header button;
  - one element per panel instance, either stacked or inside a horizontal
    strip with page dots (C-005).
- Structure is created once per dashboard load. A refresh updates panel bodies
  and the header status, not the entire tree. There is no per-second timer.
- Panels expose test hooks:
  - `data-panel-id`
  - `data-panel-kind`
  - `data-panel-state="loading|ready|empty|stale|error|unsupported|hidden"`
  - `[data-row-title]`, `[data-row-collapsed]`
- No `innerHTML` with untrusted strings. Use `textContent` and DOM builders.
  Markdown is rendered through a sanitizing subset renderer.

### Charts

SVG, built with small helper functions:

- line paths with `M/L` commands;
- optional area fill (`--area-opacity`);
- x domain = the cycle window (`timeWindow`), not the data extent;
- round ticks from `panels/scale.js`: `niceTicks` (1/2/2.5/5 × 10^k, powers of
  1024 for bytes; 4 intervals, 3 under 150 px) and `timeTicks` (wall-clock
  aligned, at most `min(8, plotWidth / 84)`);
- value labels on the right in a 22–64 px gutter; no vertical grid lines;
  10 px axis labels;
- dashed threshold lines in the state colour;
- series colour by position (`seriesColor(index)` → `var(--series-N)`, 8 slots);
- series legend with last values;
- null values break the line (gap), not connect across missing data;
- the `viewBox` equals the measured rendered box, so text keeps its CSS size.
  A `ResizeObserver` redraws on any box change.

No canvas in v1. No tooltips in v1 (documented in C-005). Tap targets are row
headers, page dots, the toolbar, and header actions.

### Layout

- `layout_mode=auto` (default):
  - viewport CSS width ≥ 900 px → 24-column grid with `minmax(30px, auto)` row
    tracks;
  - narrower → single-column stack.
- `grid` forces the 24-column grid; `stack` forces the single column.
- `bandItems()` groups a row's items whose vertical extents overlap into
  bands. In stack mode a band of two or more becomes a horizontally swipeable
  `.panel-strip` (scroll-snap `x mandatory`, pages `calc(100% - 26px)` wide,
  page dots driven by an `IntersectionObserver`); a band of one stays in the
  vertical stack. The page snaps vertically (`y proximity`) to the toolbar,
  rows, and stacked bands under the header (`--header-h`, measured with a
  `ResizeObserver`). In grid mode strips are `display: contents`.
- Row headers fold/unfold rows (`hidden` on `.row-body`, `aria-expanded`);
  dashboard-collapsed rows start folded.
- A row with no eligible items is omitted (unless `show_unsupported=true`
  produces placeholders).
- Duplicate `$ref` items render separate instances; data for the same panel ID is
  fetched once per refresh and shared.
- `display_mode` (`standard`, `amoled`, `monochrome`) is a pure stylesheet
  switch: it is applied as `data-display-mode` on the document root and every
  colour is a CSS variable, so renderers never receive it and switching never
  re-renders. `window.androdash.setLocked(true)` (from the shell, C-007) sets
  `data-locked` and forces `monochrome`; the locked view hides the toolbar,
  header actions, and page dots while refreshing continues.

## 6. Panel registry

v1 renderers:

| Kind | Data | Notes |
|---|---|---|
| `TimeSeriesChart` | conditional range queries | SVG multi-series on the cycle window |
| `StatChart` | range queries + calculation | tiles per series, state edge |
| `GaugeChart` | range queries + calculation | 240° open arc, threshold notches |
| `Table` | instant queries | series + value rows |
| `Markdown` | none | sanitized subset |

Everything else is unsupported and filtered. Adding a panel kind requires:
renderer, eligibility registry entry, C-005, demo fixture, tests, changelog.

## 7. Prometheus client

- Thin wrapper around `fetch` with `AbortController`.
- No credentials in v1; URLs with userinfo are rejected by config validation.
- `cache: "no-store"`, `Accept: application/json`.
- One request per query; no batching (v1).
- Normalizes matrix/vector/scalar results into series with numeric/null points.
- Maps errors to `E_PROM_*` codes (C-003, C-009).
- Truncates diagnostics, never logs full URLs with query strings.

Prometheus requests are made directly from the WebView. CORS and cleartext are
network prerequisites, not renderer bugs. Error messages must say so.

## 8. Scheduler

- Captures `end = Date.now()` per cycle; all queries share `start`/`end`.
- No overlapping cycles; if a cycle is running, a manual refresh request is
  coalesced into "run once after".
- `refreshSeconds = 0` means manual only.
- `setIntervalSeconds()` changes the interval at runtime (in-app refresh
  control) and reschedules from now.
- Pauses while `document.visibilityState === "hidden"`; refreshes immediately on
  visibility if stale.
- Keeps last good data on errors; marks stale; continues other panels.
- Dashboard JSON is fetched at boot/reload, not each tick.
- Exposes `window.androdash.refresh()` and `reloadDashboard()` for the header
  refresh action, the debug overlay, and tests.
- In-app range/refresh choices are passed to `AndroDash.setView()` when the
  shell is present, which persists them (C-006, C-007).

## 9. Diagnostics and status

- One dashboard-wide status in the sticky header (release and debug): a state
  dot and the last successful update time, `Stale since …`,
  `N of M failing · …`, `Offline [since …]`, or `Loading` (C-009). No
  countdown; it updates only when a cycle settles or the scheduler state
  changes.
- Panel badges appear only for `Stale`, `Error`, and `Hidden` (C-005).
- `debug=true` enables an overlay with config (redacted), capabilities, probe
  results, hidden panels and reasons, request timings, and errors.
- `window.androdash.getDiagnostics()` returns the C-009 object.
- Error codes are stable contract values; messages are human hints.

## 10. Performance and memory bounds

- Max 200 panels per dashboard, 2000 layout items.
- Max 12 series per panel, 600 points per series, 100 table rows, 4 gauges per
  panel.
- Downsample series that exceed the point cap; report a diagnostic.
- No unbounded timers, DOM nodes, or caches. Requests are not cached across
  cycles.
- Avoid layout thrash: batch DOM updates per panel; charts are built as strings
  or DOM fragments and replaced once.
- Target: demo first paint < 2 s on the emulator; typical refresh < 1 s with the
  mock; stable memory over a 30-minute soak.

## 11. Browser development harness

- Serve the repository root with `tools/serve_demo.py` (M1).
- Open
  `http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/demo-dashboard.json&prometheus_url=http://localhost:9091&debug=true`.
- Android serves the same `web/app` files at `http://androdash.local/`.
- The runtime must not depend on Android APIs; `window.AndroDash` is optional.
- Node tests import modules directly; modules must not touch `window` at import
  time except in `main.js`.

## 12. Testing seams

Export pure functions for:

- config parsing/validation;
- duration parsing;
- dashboard selection/normalization;
- variable resolution/interpolation;
- capability/eligibility decisions;
- Prometheus URL building and response normalization;
- calculations and value formatting;
- Markdown escaping;
- layout ordering and banding (`bandItems`);
- value and time tick selection (`niceTicks`, `timeTicks`).

`main.js` should be a thin composition layer with little untested logic.

See [`testing.md`](testing.md) for the test matrix and commands.
