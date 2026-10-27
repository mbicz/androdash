# C-003 — Prometheus access

- **Version:** 1
- **Status:** Accepted, 2026-10-26
- **Consumers:** Web renderer (W2), mock tooling (W3)
- **Fixtures:** [`contracts/fixtures/prometheus/`](../../contracts/fixtures/prometheus/)
- **Related:** C-002 (datasources), C-004 (capabilities), C-006 (time)

## Purpose

Define how the WebView resolves a Prometheus base URL, calls the HTTP API
directly, and normalizes responses for rendering. There is no Perses proxy and
no server-side query execution.

## Base URL resolution

For each Prometheus query, resolve a base URL in this order:

1. `prometheus_url` from C-001, if set (overrides every dashboard datasource).
2. The query's explicit datasource reference:
   - `datasource` string: a variable (`$ds`) or a datasource name;
   - `datasource` object: `{kind, name}` (name required).
   Resolve variables first (C-002). The referenced datasource must be
   `PrometheusDatasource` and have a usable URL.
3. The dashboard default `PrometheusDatasource` (`default: true`), else the first
   `PrometheusDatasource` with a usable URL.
4. No URL → `E_DATASOURCE`, panel ineligible (`missing_datasource`).

Base URL rules:

- Absolute `http://` or `https://`, no userinfo in v1.
- Trailing slashes are removed; paths are preserved (e.g.
  `https://host/prometheus`).
- A datasource URL from the dashboard may be relative; resolve it against the
  dashboard URL origin (C-002).
- A `proxy.spec.url` is treated as a direct Prometheus base URL; do not append
  Perses proxy paths.
- Do not follow redirects to a different scheme in v1? Redirects are allowed up
  to 2 for GETs, final URL must be http(s). (Fetch follows by default; record the
  final URL for diagnostics.)

## Probe

Capability detection uses:

```
GET {base}/api/v1/status/buildinfo
Accept: application/json
timeout: 5 s
cache: no-store
```

Success requires HTTP 2xx and a JSON body with `status === "success"` and a
`data` object. Record the `data.version` string (truncated) for diagnostics.

A CORS/network/HTTP/parse failure means the endpoint is not healthy; record the
error code and do not pretend Prometheus is available. Probe results are inputs
to C-004, not panel errors.

Do not probe `/api/v1/status/config` or `/api/v1/targets`; they may expose
sensitive configuration and are unnecessary.

## Requests

All requests:

- `GET`, `Accept: application/json`, `cache: "no-store"`, credentials omitted.
- Timeout: 10 seconds via `AbortController`.
- No auth headers/tokens in v1.
- URL-encode query strings with `URLSearchParams`; do not hand-concatenate.
- Prometheus times are Unix seconds; use milliseconds precision where useful
  (`(ms / 1000).toFixed(3)`), step as integer seconds.
- Add `timeout=10s` to Prometheus queries where supported; the client timeout is
  authoritative.

### Range query

Used by `TimeSeriesChart`, `StatChart`, `GaugeChart`.

```
GET {base}/api/v1/query_range
  ?query=<promql>
  &start=<unix seconds>
  &end=<unix seconds>
  &step=<seconds>
  &timeout=10s
```

- `start`/`end` come from the C-006 cycle window.
- `step`:
  - `step_seconds` if configured;
  - else `max(15, ceil(rangeSeconds / 240))`, integer seconds;
  - range ≤ 0 or invalid → `E_CONFIG` (should have been caught by C-001/C-006).
- One request per panel query. No batching in v1.
- Do not add `dedup`, `partial_response`, or exemplars.

### Instant query

Used by `Table` in v1.

```
GET {base}/api/v1/query?query=<promql>&time=<unix seconds>&timeout=10s
```

### Label values (variables)

Used by `PrometheusLabelValuesVariable` (C-002).

```
GET {base}/api/v1/label/<labelName>/values?match[]=<matcher>&match[]=…
```

- `labelName` and matchers are URL-encoded.
- Send each configured matcher as a repeated `match[]`.
- If no matchers, send no `match[]`.
- Limit to 20 matchers; extra ignored with a warning.
- Response is `{status:"success", data:["v1","v2",…]}`.

## Response normalization

Prometheus API envelope:

```json
{ "status": "success", "data": { "resultType": "matrix", "result": […] } }
```

Normalized series:

```js
{
  labels: { "__name__": "…", "job": "…", … }, // strings
  points: [ { t: 1700000000.000, v: 12.5 }, … ] // v may be null for NaN/±Inf
}
```

Rules:

- `resultType: "matrix"`: `result[]` entries have `metric` and
  `values: [[ts, "value"], …]`. Sort points by time. Parse the value string:
  numeric → number; `NaN`/`+Inf`/`-Inf`/invalid → `null` (a gap).
- `resultType: "vector"`: `result[]` entries have `metric` and
  `value: [ts, "value"]`; normalize to one point per series. For tables, keep the
  timestamp.
- `resultType: "scalar"`: `result: [ts, "value"]`; synthesize one series with
  `labels: {}` and one point.
- `resultType: "string"`: unsupported → `E_PROM_RESPONSE`.
- Missing/extra fields: ignore unknown fields; missing `metric` → `{}`; missing
  values → skip that series with a warning.
- Do not evaluate/interpret label values as HTML.
- Preserve `__name__` (or add it if Prometheus returned it).

Limits:

| Limit | Value | Behavior |
|---|---:|---|
| Series per panel | 12 | Keep first 12 after stable sort; `W_SERIES_TRUNCATED` |
| Points per series | 600 | Downsample evenly (keep first/last); `W_POINTS_TRUNCATED` |
| Table rows | 100 | Keep first 100 after sort; `W_ROWS_TRUNCATED` |
| Stat values | 12 | Keep first 12; `W_VALUES_TRUNCATED` |
| Gauges per panel | 4 | Keep first 4; `W_GAUGES_TRUNCATED` |
| Error body shown | 200 chars | Truncate and escape |

Stable sort for truncation: series by `__name__`, then sorted label key/value
pairs; points by time; table rows by series string.

## Errors

| Code | Condition | UI |
|---|---|---|
| `E_PROM_NETWORK` | fetch/abort/CORS/DNS/TLS/cleartext failure | panel error, hint about reachability/CORS/HTTP |
| `E_PROM_HTTP` | non-2xx HTTP status | panel error with status and short body |
| `E_PROM_QUERY` | `status: "error"` envelope, `errorType`/`error` | panel error with Prometheus message |
| `E_PROM_RESPONSE` | malformed JSON/envelope, unsupported result type | panel error |
| `E_DATASOURCE` | no usable datasource URL | panel hidden (C-004) |

Error objects (C-009) include `code`, `message`, optional `detail`, and the
panel/query ID. Do not include credentials or full URLs. Prometheus error text is
untrusted; escape it before display.

Partial success is not a Prometheus concept in v1; a response is success or an
error.

## CORS, cleartext, and network prerequisites

- The WebView page origin is `http://androdash.local` (decision 0007). Prometheus
  must return `Access-Control-Allow-Origin: *` or that origin (and allow `GET`).
  Prometheus's default `--web.cors.origin` often permits this; the mock always
  sends `*`.
- The app origin is HTTP, so requests to `http://` Prometheus are not mixed
  content. If the renderer is later served over HTTPS, HTTP Prometheus requests
  would become mixed content and be blocked; record a decision before changing
  the scheme.
- Android allows cleartext HTTP in v1 (decision 0006). On a physical device, the
  phone must be able to reach the Prometheus host; `localhost` means the phone,
  not the developer machine.
- Errors must name the probable cause: "Prometheus unreachable from the device",
  "CORS blocked (origin http://androdash.local)", "HTTP cleartext blocked", or
  "Prometheus returned an error".

## Security

- No credentials in URLs or headers in v1. If `userinfo` is present, C-001
  rejects the config.
- Do not log full PromQL? PromQL may contain identifiers but not secrets; still
  truncate request URLs in diagnostics and never log response bodies wholesale.
- Escape all Prometheus-supplied strings before display.
- Treat `error` strings as untrusted text.
- Do not follow arbitrary redirects from a response; use fetch's default with a
  short timeout.

## Test obligations

`web/tests/contract/c003-prometheus.test.js`:

- base URL precedence (override, query datasource, default, none);
- range/instant/label-values URL construction and encoding;
- step formula and edges;
- matrix/vector/scalar normalization, NaN/Inf gaps, sorting;
- error mapping for network/HTTP/envelope/malformed;
- limits/truncation warnings;
- redaction;
- fixture parity: `contracts/fixtures/prometheus/*.json` normalize as expected.

W3's mock must return envelopes matching the fixtures and support CORS.

## Out of scope

- Prometheus auth (basic/bearer/mTLS).
- Recording rules/admin APIs.
- Streaming/websockets.
- Query batching/caching across cycles.
- Timestamps other than wall clock (C-006).
