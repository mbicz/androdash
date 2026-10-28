# C-002 — Dashboard source and normalization

- **Version:** 1 (AndroDash Perses subset v1)
- **Status:** Accepted, 2026-10-26; amended 2026-10-27 (variables in titles;
  decision 0015)
- **Consumers:** Web renderer (W2)
- **Fixtures:** [`demo-dashboard.json`](../../contracts/fixtures/demo-dashboard.json),
  [`spark-dashboard.json`](../../contracts/fixtures/spark-dashboard.json),
  [`macos-node-dashboard.json`](../../contracts/fixtures/macos-node-dashboard.json)
- **Related:** C-001 (URL), C-003 (datasources), C-004 (filtering), C-005 (panels)

## Purpose

Define which Perses dashboard documents AndroDash accepts, how they are fetched
and normalized, and which fields drive layout, time, variables, and data access.

This is **not** the Perses schema. It is the subset AndroDash promises to
understand. Unknown fields are ignored; unsupported panel/query kinds are
filtered through C-004.

## Fetch

- Method: `GET`.
- URL: `dashboard_url` from C-001; absolute `http(s)`.
- Headers: `Accept: application/json`.
- Cache: `no-store`.
- Timeout: 10 seconds.
- Redirects: follow at most 3; the final URL must still be `http(s)`.
- Response size limit: **5 MiB** (after decompression).
- Content handling: parse as UTF-8 JSON; do not require a specific
  `Content-Type`, but warn if it is not JSON-like.
- CORS: the response must allow the renderer origin
  (`http://androdash.local` in the app, or `*`) and `GET`. Static hosts and
  object stores must be configured accordingly; otherwise the browser blocks the
  fetch.
- No credentials/cookies in v1.

Fetch failures map to `E_DASHBOARD_FETCH` (C-009), with a short status/network
reason. A CORS failure must include a hint naming the renderer origin and the
need for `Access-Control-Allow-Origin`. Do not display the full URL with query
string.

## Accepted document shapes

1. A Perses dashboard object:

```json
{
  "kind": "Dashboard",
  "metadata": { "name": "…", "project": "…" },
  "spec": { "panels": {…}, "layouts": […], … }
}
```

2. An ephemeral dashboard object: same shape with `"kind": "EphemeralDashboard"`.

3. A JSON array of dashboard objects. Selection:
   - if `dashboard_name` is set, the first object whose `metadata.name` matches
     exactly;
   - otherwise the first object;
   - if the array has more than one object and `dashboard_name` is not set,
     select the first and record warning `W_DASHBOARD_MULTIPLE`.
   - If `dashboard_name` is set but no match: `E_DASHBOARD_PARSE`.

Anything else (Grafana dashboard, a list wrapper with `items`, a panel object) is
`E_DASHBOARD_PARSE`.

## Required and optional fields

| Field | Requirement |
|---|---|
| `kind` | `Dashboard` or `EphemeralDashboard` |
| `metadata.name` | Non-empty string |
| `spec` | Object |
| `spec.panels` | Object map of panel ID → Perses `Panel`; at least one panel required (`E_DASHBOARD_EMPTY` otherwise) |
| `spec.layouts` | Array; if missing/invalid, fallback stack in panel insertion order + warning |
| `spec.duration` | Duration string; default `1h` |
| `spec.refreshInterval` | Duration string or absent; `0s`/`0` = manual |
| `spec.datasources` | Object (preferred) or array; optional if `prometheus_url` is set |
| `spec.variables` | Array; optional |
| `spec.display` | Optional display metadata |

Unknown top-level/spec fields are ignored.

## Limits

Protect the phone:

| Limit | Value | On violation |
|---|---:|---|
| Response size | 5 MiB | `E_DASHBOARD_LIMIT` |
| Panels | 200 | `E_DASHBOARD_LIMIT` |
| Layout rows | 50 | `E_DASHBOARD_LIMIT` |
| Layout items | 2000 | `E_DASHBOARD_LIMIT` |
| Variables | 100 | `E_DASHBOARD_LIMIT` |
| Panels per row (rendered items) | 50 | Skip extras + `W_LAYOUT_TRUNCATED` |
| Panel/query counts per panel | 10 queries | `E_DASHBOARD_LIMIT` |

Limits are checked before building DOM or fetching data. A truncated layout row
is not fatal; exceeding global limits is.

## Duration grammar

Durations use a Go/Perses-style sequence:

```
duration := (<number><unit>)+
unit     := "ms" | "s" | "m" | "h" | "d" | "w"
```

Examples: `5m`, `1h`, `1h30m`, `7d`, `250ms`.

Rules:

- No spaces, signs, decimals, or empty units.
- `ms` is accepted for refresh parsing but a time range below `1s` is rejected.
- Time range must be `1s…30d`.
- Refresh must be `0`/`0s`/`0m` (manual) or `5s…1h`; `1–4s` clamps to `5s`
  with `W_REFRESH_CLAMPED`.
- A malformed dashboard duration falls back to the default with a warning, not a
  fatal error, except for an explicitly supplied `time_range`/`refresh_seconds`
  (C-001), which is `E_CONFIG`.

## Datasources

Accepted forms:

```json
"datasources": {
  "prom": {
    "default": true,
    "plugin": {
      "kind": "PrometheusDatasource",
      "spec": { "directUrl": "http://localhost:9090" }
    }
  }
}
```

or an older array:

```json
"datasources": [
  {
    "name": "prom",
    "default": true,
    "plugin": { "kind": "PrometheusDatasource", "spec": { "proxy": { "kind": "HTTPProxy", "spec": { "url": "http://localhost:9090" } } } }
  }
]
```

Normalization:

- Name from the map key or array `name`; missing/duplicate names are skipped with
  a warning.
- `plugin.kind` is required. v1 renders only `PrometheusDatasource`; other kinds
  are retained for filtering (C-004).
- URL extraction precedence:
  1. `plugin.spec.directUrl`;
  2. `plugin.spec.proxy.spec.url`;
  3. `plugin.spec.url` (legacy/simple form).
- The URL may be absolute `http(s)` or relative. A relative URL is resolved
  against the dashboard URL's origin. Non-http(s) or unresolvable URLs are
  retained with `url: null` and a warning; panels using them are ineligible.
- `default: true` marks the default for that plugin kind. If none is marked, the
  first datasource of the kind is the default.
- Secrets/basic auth references are ignored in v1; do not log them.
- If `prometheus_url` is set (C-001), it overrides all Prometheus datasource
  URLs for query execution. The dashboard datasource URLs are still used for
  capability probing only if no override exists.

There is no Perses proxy in the app: a `proxy.spec.url` is treated as a direct
base URL. If it points at a Perses server path, requests will fail; the error
must say the URL is used directly.

## Panels

`spec.panels` is a map:

```json
"panels": {
  "cpu": {
    "kind": "Panel",
    "spec": {
      "display": { "name": "CPU", "description": "…" },
      "plugin": { "kind": "TimeSeriesChart", "spec": {…} },
      "queries": [
        {
          "kind": "TimeSeriesQuery",
          "spec": {
            "plugin": {
              "kind": "PrometheusTimeSeriesQuery",
              "spec": { "query": "up", "datasource": "prom" }
            }
          }
        }
      ]
    }
  }
}
```

Normalization:

- Panel ID = map key; `title` = `spec.display.name`, else the key.
- `description` = `spec.display.description`, else empty.
- `panelKind` = `spec.plugin.kind`; `panelSpec` = `spec.plugin.spec` or `{}`.
- Queries = `spec.queries` array (default `[]`). Each query:
  - `queryKind` = `query.spec.plugin.kind`;
  - `querySpec` = `query.spec.plugin.spec` or `{}`;
  - `query` = `querySpec.query` if a string;
  - `datasource` = `querySpec.datasource` (string or object), optional.
- A panel with `kind != "Panel"` is invalid and skipped with a diagnostic.
- Missing `spec.plugin` → skipped; missing queries on a data panel →
  ineligible (`no_queries`); Markdown with no queries is valid.
- Duplicate panel IDs cannot occur in a map; duplicate layout references are
  allowed and render separate instances sharing one data fetch.

## Layouts

Only `Grid` layouts are rendered in v1.

```json
"layouts": [
  {
    "kind": "Grid",
    "spec": {
      "display": { "title": "Overview", "collapse": { "open": true } },
      "items": [
        {
          "x": 0, "y": 0, "width": 6, "height": 6,
          "content": { "$ref": "#/spec/panels/cpu" }
        }
      ]
    }
  }
]
```

Normalization:

- Row title = `spec.display.title`, else `""`.
- Collapsed default = `display.collapse.open === false`; missing → open.
- Item coordinates must be non-negative integers. `width` 1…24; `height` 1…50.
  Invalid items are skipped with `W_LAYOUT_ITEM_SKIPPED`.
- `content` forms:
  - `{ "$ref": "#/spec/panels/<id>" }` — JSON Pointer; unescape `~1` → `/`,
    `~0` → `~`, then URI-decode;
  - an inline Perses `Panel` object — normalize it with a synthetic ID
    `inline:<row>:<index>`.
- A `$ref` to a missing panel is skipped with a warning.
- A panel may appear in multiple items; each item is an instance.
- Unknown layout kinds are skipped with `W_LAYOUT_KIND_UNSUPPORTED`.
- If no valid rows exist, fallback: one synthetic row per panel in map insertion
  order, full width, height 6, with `W_LAYOUT_FALLBACK`.
- Rows with no eligible items are omitted after filtering (C-004/C-005).

The 24-column grid is a Perses convention. The renderer maps it to CSS; it does
not mutate the dashboard.

## Variables

Variables are resolved **once at boot** (and on reload). There is no variable
picker in v1. Values are used for query/datasource interpolation and for
display titles (see [Display and metadata](#display-and-metadata)).

| Kind | v1 resolution |
|---|---|
| `TextVariable` | `spec.value` if present, else `spec.defaultValue`, else `""`. |
| `ListVariable` + `StaticListVariable` | `spec.defaultValue` if present, else the first value. Values may be strings or `{label, value}`. Arrays: use the first element. |
| `ListVariable` + `PrometheusLabelValuesVariable` | `GET /api/v1/label/<labelName>/values` with `match[]` from `spec.matchers`; prefer `defaultValue` if it is in the result, else first; else `""`. Requires `prometheus` capability; failure → `W_VARIABLE_UNRESOLVED`, value `""`. |
| `ListVariable` + `DatasourceVariable` plugin | `spec.defaultValue` if it names a known datasource, else the default datasource of `spec.plugin.spec.datasourcePluginKind`, else the first datasource. |
| Unknown variable kind | `""` + `W_VARIABLE_UNKNOWN`. |

Interpolation:

- Supports `$name` and `${name}` for names matching
  `[A-Za-z_][A-Za-z0-9_]*`.
- Longest names are replaced first to avoid prefix collisions.
- `$$` becomes a literal `$`.
- Missing variables become `""` with `W_VARIABLE_MISSING`.
- Arrays resolve to a single value (default/first). There is **no** context-aware
  joining for regex/multi-value use in v1; dashboards relying on multi-select
  will show one value. Document this limitation in diagnostics.
- Variable values are strings; do not interpret them as PromQL fragments beyond
  substitution.

Variable resolution must not execute arbitrary code or interpolate into HTML.

## Display and metadata

- Dashboard title: `spec.display.name`, else `metadata.name`.
- Dashboard description: `spec.display.description`, else `""`.
- After variables resolve, `applyDisplayVariables()` interpolates `$var` and
  `${var}` (rules above) into the dashboard title, every row title, and every
  panel title. Titles are written with `textContent` only. If a title that
  contained `$` interpolates to an empty (whitespace-only) string, it falls back
  to the dashboard `metadata.name`, the panel ID, or `""` for a row (the row
  header then shows `Overview`, C-005), so an unresolved variable never leaves a
  blank or literal `$host` heading. Missing variables still warn
  `W_VARIABLE_MISSING`.
- Example: `macos-node-dashboard.json` sets `display.name: "$host"` with a
  `host` `PrometheusLabelValuesVariable` (`labelName: nodename`, matcher
  `node_uname_info`), so the header shows the machine name; if the variable
  does not resolve, it shows `macOS host`.
- Descriptions are not interpolated.
- Metadata `project`, timestamps, and version are kept for diagnostics only.
- No remote images/logos in v1.

## Errors and warnings

| Code | Condition |
|---|---|
| `E_DASHBOARD_FETCH` | Network/HTTP/timeout/redirect/size failure |
| `E_DASHBOARD_PARSE` | Not an accepted document shape, missing required fields, bad `dashboard_name` selection |
| `E_DASHBOARD_EMPTY` | No panels |
| `E_DASHBOARD_LIMIT` | Global size/panel/row/item/variable limit |
| `W_DASHBOARD_MULTIPLE` | Array had multiple dashboards; first selected |
| `W_DURATION_INVALID` | Dashboard duration malformed; default used |
| `W_REFRESH_INVALID` | Dashboard refresh malformed; default used |
| `W_DATASOURCE_INVALID` | Datasource missing name/kind/URL |
| `W_LAYOUT_KIND_UNSUPPORTED` | Non-Grid layout skipped |
| `W_LAYOUT_ITEM_SKIPPED` | Invalid item/ref skipped |
| `W_LAYOUT_TRUNCATED` | Row exceeded 50 items |
| `W_LAYOUT_FALLBACK` | No valid layouts; panels stacked |
| `W_VARIABLE_*` | Variable resolution warnings |

Warnings are collected in diagnostics and do not block rendering.

## Test obligations

`web/tests/contract/c002-dashboard.test.js`:

- accept Dashboard, EphemeralDashboard, and array selection;
- reject Grafana/wrapper/panel shapes;
- normalize object and array datasources, URL precedence, relative resolution;
- resolve `$ref`, escaped pointers, inline panels, duplicates;
- duration grammar and invalid fallbacks;
- variable defaults, interpolation, `$$`, missing vars;
- title interpolation into dashboard/row/panel titles, with the empty-result
  fallback;
- layout limits/fallbacks/collapse;
- panel/query normalization;
- size/limit errors;
- demo fixture → 9 panels, 4 rows, expected IDs.

## Out of scope

- Grafana import.
- Full Perses variable UI/context-aware interpolation.
- Panel/library references outside this spec.
- `AutoGrid` or non-Grid layouts.
- Remote assets in Markdown (C-005).
- Auth/secrets.
