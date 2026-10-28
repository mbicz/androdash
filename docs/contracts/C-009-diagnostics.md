# C-009 — Diagnostics and errors

- **Version:** 1
- **Status:** Accepted, 2026-10-26
- **Consumers:** Web renderer (W2), Android shell (W1)
- **Machine-readable:** [`contracts/diagnostics.schema.json`](../../contracts/diagnostics.schema.json)
- **Fixture:** [`diagnostics.example.json`](../../contracts/fixtures/diagnostics.example.json)
- **Related:** all contracts

## Purpose

Define the stable error/warning codes, the diagnostics snapshot, the on-screen
status, and redaction rules. A kiosk has no developer watching; the screen and
the snapshot must explain what is happening without leaking secrets.

## Error and warning codes

### Fatal (no dashboard render)

| Code | Meaning |
|---|---|
| `E_CONFIG` | Invalid/missing launch configuration (C-001) |
| `E_ASSET_LOAD` | The local renderer asset failed to load (native) |
| `E_DASHBOARD_FETCH` | Dashboard request failed (C-002) |
| `E_DASHBOARD_PARSE` | Response is not an accepted Perses dashboard shape |
| `E_DASHBOARD_EMPTY` | Dashboard has no panels |
| `E_DASHBOARD_LIMIT` | Dashboard exceeds a global limit |

### Non-fatal (panel/cycle/dashboard reload)

| Code | Meaning |
|---|---|
| `E_DATASOURCE` | No usable datasource URL for a query/panel |
| `E_CAPABILITY` | Required capability unavailable or probe failed |
| `E_PROM_NETWORK` | Network/CORS/timeout/cleartext/TLS failure |
| `E_PROM_HTTP` | Prometheus returned a non-2xx status |
| `E_PROM_QUERY` | Prometheus returned `status: "error"` |
| `E_PROM_RESPONSE` | Malformed/unsupported Prometheus response |
| `E_RENDER` | A panel renderer threw an unexpected error |
| `E_INTERNAL` | Unexpected internal error |

### Warnings

Warnings are non-fatal and recorded in diagnostics:

| Code | Meaning |
|---|---|
| `W_REFRESH_CLAMPED` | Refresh interval was raised to the 5 s floor (C-001/C-006) |
| `W_DASHBOARD_MULTIPLE` | URL returned multiple dashboards; first selected (C-002) |
| `W_DURATION_INVALID` | Dashboard duration malformed; default used |
| `W_REFRESH_INVALID` | Dashboard refresh malformed; default used |
| `W_DATASOURCE_INVALID` | Datasource missing name/kind/URL |
| `W_LAYOUT_KIND_UNSUPPORTED` | Non-Grid layout skipped |
| `W_LAYOUT_ITEM_SKIPPED` | Invalid layout item/ref skipped |
| `W_LAYOUT_TRUNCATED` | Row exceeded item limit |
| `W_LAYOUT_FALLBACK` | No valid layouts; panels stacked |
| `W_VARIABLE_UNKNOWN` | Unknown variable kind |
| `W_VARIABLE_UNRESOLVED` | Label/datasource variable could not resolve |
| `W_VARIABLE_MISSING` | Interpolation referenced a missing variable |
| `W_CAPABILITY_UNKNOWN` | Advertised capability ID is not in the registry |
| `W_SERIES_TRUNCATED` | Panel kept only the first N series (C-003) |
| `W_POINTS_TRUNCATED` | Series was downsampled (C-003) |
| `W_ROWS_TRUNCATED` | Table kept only the first N rows |
| `W_VALUES_TRUNCATED` | Stat kept only the first N tiles |
| `W_GAUGES_TRUNCATED` | Gauge kept only the first N gauges |
| `W_CALCULATION_UNKNOWN` | Unknown stat/gauge calculation; last-number used |
| `W_UNIT_UNKNOWN` | Unknown formatting unit; raw value used |

Do not invent ad-hoc codes. Add a contract update for a new code.

## Diagnostics snapshot

Canonical shape (see the schema for exact types):

```json
{
  "schemaVersion": 1,
  "renderer": "androdash/0.1.0",
  "generatedAt": "2026-10-26T12:00:05.000Z",
  "startedAt": "2026-10-26T12:00:00.000Z",
  "config": {
    "schemaVersion": 1,
    "dashboardUrl": "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json",
    "prometheusUrl": "http://10.0.2.2:9091",
    "refreshSeconds": 10,
    "timeRange": "15m",
    "stepSeconds": null,
    "kiosk": true,
    "debug": true,
    "layoutMode": "auto",
    "displayMode": "standard",
    "dashboardName": null,
    "capabilities": null,
    "showUnsupported": false
  },
  "capabilities": {
    "advertised": ["prometheus"],
    "unknown": [],
    "probed": [
      {
        "baseUrl": "http://10.0.2.2:9091",
        "ok": true,
        "version": "2.53.0-androdash-mock",
        "latencyMs": 12,
        "error": null
      }
    ]
  },
  "dashboard": {
    "url": "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json",
    "name": "AndroDash Demo",
    "duration": "15m",
    "refreshInterval": "10s",
    "panelsTotal": 9,
    "rowsTotal": 4
  },
  "panels": {
    "total": 9,
    "rendered": 6,
    "hidden": 3,
    "errors": 0,
    "hiddenReasons": [
      {
        "panelId": "traces",
        "panelKind": "TraceTable",
        "reason": "unsupported_query",
        "detail": "TempoTraceQuery"
      }
    ]
  },
  "lastRefresh": {
    "startedAt": "2026-10-26T12:00:00.000Z",
    "endedAt": "2026-10-26T12:00:00.120Z",
    "ok": true,
    "durationMs": 120,
    "succeeded": 6,
    "failed": 0
  },
  "nextRefreshAt": "2026-10-26T12:00:10.120Z",
  "requests": [
    {
      "at": "2026-10-26T12:00:00.020Z",
      "method": "GET",
      "url": "http://10.0.2.2:9091/api/v1/query_range",
      "status": 200,
      "durationMs": 12
    }
  ],
  "errors": [],
  "warnings": []
}
```

Rules:

- `config` is the canonical object (C-001) with URLs **redacted**: scheme + host
  + path only; no userinfo/query/fragment. The schema still validates.
- `capabilities.advertised` is sorted/deduplicated.
- `capabilities.unknown` lists advertised IDs not in the registry.
- `capabilities.probed` has at most 4 entries, one per probed base URL.
- `dashboard` is `null` if no dashboard loaded; otherwise redacted URL + metadata.
- `panels.total/rendered/hidden/errors` are counts for the current model.
  `hiddenReasons` has one entry per hidden panel instance's distinct panel ID
  (max 200), sorted by `panelId`.
- `lastRefresh` may be `null` before the first cycle. `ok` is true only if every
  eligible data panel succeeded; `succeeded + failed` equals the data-panel
  count (0 for Markdown-only).
- `nextRefreshAt` is `null` in manual mode or while no cycle is scheduled.
- `requests` keeps the most recent 50 entries, oldest first. `url` is redacted
  (no query string). Never include headers/bodies/credentials.
- `errors` keeps the most recent 50 `E_*` events (oldest first); `warnings` keeps
  the most recent 50 `W_*` events with the same object shape. `panels.errors` is
  the current panel-error count, not the history length.
- Both arrays are bounded and redacted; `message` ≤ 300 chars, `detail` ≤ 500.

Add:
```json
"warnings": [
  {"at":"...","code":"W_LAYOUT_FALLBACK","message":"...","panelId":null,"detail":null}
]
```
Both `errors` and `warnings` bounded 50. `panels.errors` counts current panel
errors (not historical).

- `generatedAt` is the snapshot time; `startedAt` boot.
- `renderer` is `androdash/<semver>`.

Reason enum: `unsupported_panel`, `unsupported_query`, `missing_datasource`,
`capability_unavailable`, `probe_failed`, `no_queries`, `invalid_panel`.

Error object:
```json
{ "at": "...", "code": "E_PROM_NETWORK", "message": "…", "panelId": "cpu", "detail": null }
```
`message` ≤ 300 chars, no secrets. `detail` ≤ 500, optional.

Warnings object same shape with W_* code.

## On-screen status

Always visible (compact in release, fuller in debug):

- state: `live` | `degraded` | `stale` | `error` | `loading`;
- last successful update (local time);
- next refresh (local time or countdown) or "manual";
- hidden panel count;
- error count (if > 0).

Rules:

- `live`: all eligible data panels succeeded in the last cycle (or no data
  panels, e.g. Markdown-only).
- `degraded`: some succeeded, some failed.
- `stale`: last-good data retained and no current success? If all failed but
  last-good exists → `stale`; if no data at all → `error`.
- `error`: fatal/startup failure or no successful data and no last-good.
- `loading`: before the first cycle settles.
- Never show a perpetually spinning indicator.
- Errors include the stable code and a short actionable hint. Full details in
  the debug overlay.

## Debug overlay

Enabled only with `debug=true` (C-001):

- config (redacted) and capabilities;
- probe results and health;
- hidden panels + reasons;
- last refresh timing, next refresh, request log, errors/warnings;
- actions: refresh, reload dashboard, reload page, exit kiosk (bridge if
  available);
- a "copy diagnostics" action is optional; do not copy secrets.

Overlay is rendered with the same escaping rules; no raw JSON `innerHTML`.

## API

`window.androdash` exposes:

| Method | Returns |
|---|---|
| `getConfig()` | frozen canonical AppConfig (redacted? No: the renderer needs real URLs internally; expose a redacted copy to UI) |
| `getCapabilities()` | advertised capability document (C-004) |
| `getDiagnostics()` | C-009 snapshot |
| `refresh()` | void; starts/coalesces a cycle |
| `reloadDashboard()` | Promise; re-fetch/reprobe/rebuild |

Rules:

- `getConfig()` returns a redacted copy for display; internal modules use the
  frozen config. Alternatively expose `getConfig({redact:true})`; v1 default is
  redacted. Document in code.
- Methods never throw to callers; return an error snapshot instead where
  applicable.
- The native bridge (`window.AndroDash`) is separate (C-007/C-008).

## Redaction

- URLs: `scheme://host/path` only. Strip userinfo, query, fragment.
- Prometheus error bodies/expressions: truncate (200/300 chars) and escape.
- Labels: truncate to 100 chars in diagnostics.
- No cookies, headers, tokens, or credentials exist in v1; still never log them
  if added.
- Request metrics log only redacted URL, method, status, duration, timestamp.

## Test obligations

`web/tests/contract/c009-diagnostics.test.js`:

- snapshot validates against `contracts/diagnostics.schema.json` (programmatic
  check or `jsonschema` if available);
- required fields/types;
- counts and hidden reasons from the demo fixture;
- error/warning code stability;
- redaction of userinfo/query strings;
- bounded request/error/warning arrays;
- status transitions live/degraded/stale/error/loading;
- no secret strings in serialized diagnostics.

## Out of scope

- Remote telemetry/export.
- Crash reporting SDKs.
- Log persistence across launches.
- User-configurable log levels.
- Metrics about the app itself beyond the snapshot.
