# C-004 — Capability negotiation and filtering

- **Version:** 1
- **Status:** Accepted, 2026-10-26; amended 2026-10-27 (hidden count leaves
  the header status; decision 0015)
- **Consumers:** Web renderer (W2); dashboard generators (external)
- **Fixtures:** [`demo-dashboard.json`](../../contracts/fixtures/demo-dashboard.json),
  [`spark-dashboard.json`](../../contracts/fixtures/spark-dashboard.json)
- **Related:** C-002 (normalization), C-003 (datasources), C-005 (rendering), C-009 (diagnostics)

## Purpose

Define what the client advertises, how it decides whether a panel is renderable,
and what happens to panels it cannot serve. This is the seam that lets a
dashboard generator target a client's capabilities while the client still filters
defensively.

## Capability model

A capability is a stable lowercase ID. v1:

| ID | Status | Required for |
|---|---|---|
| `prometheus` | implemented | `PrometheusTimeSeriesQuery`, `PrometheusDatasource` |
| `tempo` | recognized, unsupported | `TempoTraceQuery`, Tempo panels |
| `loki` | recognized, unsupported | `LokiLogQuery`, Loki panels |
| `opentelemetry` | reserved | future OTLP-backed queries/panels |

Unknown IDs are allowed in configuration but are inert. They are reported as
`unknown` in diagnostics; they never make a panel eligible.

### Advertised capability document

The renderer exposes this via `window.androdash.getCapabilities()` and in
diagnostics:

```json
{
  "renderer": "androdash/0.1.0",
  "dashboardContract": 1,
  "capabilities": ["prometheus"],
  "panels": ["TimeSeriesChart", "StatChart", "GaugeChart", "Table", "Markdown"],
  "queries": ["PrometheusTimeSeriesQuery"],
  "datasources": ["PrometheusDatasource"],
  "features": ["refresh", "kiosk", "capability-filter", "diagnostics"],
  "limits": {
    "panels": 200,
    "seriesPerPanel": 12,
    "pointsPerSeries": 600,
    "tableRows": 100,
    "gaugesPerPanel": 4
  }
}
```

- `capabilities` is sorted and deduplicated.
- `panels`/`queries`/`datasources` are the implemented registries, not a promise
  of full Perses support.
- v1 does not expose an HTTP endpoint for this document. A generator can be
  configured with the same IDs by its operator, or use the `capabilities` launch
  parameter for testing. A future milestone may publish it; that needs a
  contract change.

### Advertised override

If `capabilities` is provided (C-001), it is authoritative for filtering:

- parse comma-separated IDs, trim, lowercase, deduplicate, sort, max 16;
- an empty canonical list is invalid (`E_CONFIG`); an empty wire value is unset
  (C-001). To simulate a client with no supported capabilities, advertise an
  unknown inert ID instead;
- the resulting set is advertised even if a probe later succeeds;
- if `prometheus` is advertised, still probe Prometheus for **health**; an
  unreachable endpoint makes panels ineligible with `probe_failed`, but does not
  remove `prometheus` from the advertised set;
- if `prometheus` is not advertised, do not probe for eligibility; Prometheus
  panels are `capability_unavailable`;
- unknown IDs are retained, marked inert, and never satisfy a requirement.

This override exists for testing and for deployments that want to simulate a
different client profile. It is not a security boundary.

## Plugin and datasource registry

### Panel plugins

| Panel kind | Implementation | Data required |
|---|---|---|
| `TimeSeriesChart` | yes | ≥1 supported query |
| `StatChart` | yes | ≥1 supported query |
| `GaugeChart` | yes | ≥1 supported query |
| `Table` | yes | ≥1 supported query |
| `Markdown` | yes | none |
| anything else | no | — |

### Query plugins

| Query kind | Capability | Implementation |
|---|---|---|
| `PrometheusTimeSeriesQuery` | `prometheus` | yes |
| `TempoTraceQuery` | `tempo` | no |
| `LokiLogQuery` | `loki` | no |
| anything else | `unsupported:<kind>` | no |

Query kind names are case-sensitive. Unknown types are unsupported.

### Datasources

| Datasource plugin | Capability | Implementation |
|---|---|---|
| `PrometheusDatasource` | `prometheus` | yes (direct URL) |
| anything else | derived from query | no |

## Eligibility algorithm

A panel is **eligible** only if all of these are true:

1. `panel.kind === "Panel"` and the panel plugin is in the registry.
2. For every query:
   - the query plugin is in the registry;
   - its required capability is advertised;
   - its datasource resolves to a usable URL;
   - for Prometheus, the relevant base URL is healthy (probe or override).
3. A data panel has at least one query.
4. A Markdown panel ignores any queries and never fetches data; it does not
   become a data panel.
5. The panel's plugin spec is an object (or absent → `{}`). A malformed spec is
   `invalid_panel` and ineligible.

If any requirement fails, the **entire panel** is ineligible. Partial rendering
is not allowed: a TimeSeriesChart with one Prometheus query and one Tempo query
would be misleading, so it is hidden.

Eligibility is computed **before** layout/DOM creation. Hidden panels are removed
from rows; empty rows are removed.

### Health and probe timing

- Probing happens once at boot (and on reload), not on every refresh.
- Probe all unique Prometheus base URLs in parallel, max 4, 5 s timeout each.
- A URL is healthy if `/api/v1/status/buildinfo` succeeds (C-003).
- If a URL becomes unhealthy during a refresh, panels show data errors (C-003)
  but remain eligible; do not re-run capability filtering mid-cycle.
- If a URL is unhealthy at boot, its panels are hidden with `probe_failed`.
  Markdown remains.

## Hidden reasons

Stable reason IDs (C-009 enum):

| Reason | Meaning |
|---|---|
| `unsupported_panel` | Panel plugin not implemented |
| `unsupported_query` | At least one query plugin not implemented (detail = kind) |
| `missing_datasource` | No usable URL for the query/panel |
| `capability_unavailable` | Required capability not advertised |
| `probe_failed` | Advertised capability, but datasource probe failed |
| `no_queries` | Data panel has no queries |
| `invalid_panel` | Malformed panel/query/spec |

Reason precedence (first match wins, independent of evaluation order):

1. `invalid_panel`
2. `unsupported_query`
3. `capability_unavailable`
4. `missing_datasource`
5. `probe_failed`
6. `no_queries`
7. `unsupported_panel`

This makes a panel with an unsupported query report the most actionable missing
capability (e.g. Tempo), while a panel whose kind is unsupported but whose
queries are supported reports `unsupported_panel`. Additional reasons may be
listed in `detail`; the reason ID is stable.

## Display behavior

- Default: hidden panels are removed; the hidden count is reported in
  diagnostics (`panels.hidden`) and the debug overlay, which lists every hidden
  panel and reason. The header status (C-009) does not show it.
- `show_unsupported=true`: hidden panels are replaced by a placeholder card in
  the same layout position, with title, reason, and a short hint. Placeholders
  are **not** data panels, are not refreshable, and are clearly marked
  `data-panel-state="unsupported"`.
- Rows with only placeholders remain visible when `show_unsupported=true`; with
  the default they are omitted.
- Hidden counts include both removed and placeholder panels; diagnostics
  distinguish them.
- Never show a blank panel without a state; never fabricate sample data.

## Capability-driven dashboard generation

External generators SHOULD:

- target the IDs in the advertised document;
- emit only supported panel/query/datasource kinds;
- still expect the client to filter (defense in depth);
- avoid relying on `capabilities` being reflected in the request URL (v1 does
  not append it).

A future "capability endpoint" or signed capability query is out of scope. If
needed, add a contract and decision.

## Diagnostics

The C-009 snapshot includes:

- `capabilities.advertised`: sorted IDs;
- `capabilities.probed`: per-URL `{baseUrl, ok, version, latencyMs, error}`;
- `capabilities.unknown`: IDs not in the registry;
- `panels.total/rendered/hidden/errors`;
- `panels.hiddenReasons`: `{panelId, panelKind, reason, detail}`.

Redact URLs (scheme + host + path).

## Test obligations

`web/tests/contract/c004-capabilities.test.js`:

- advertised override with/without `prometheus`;
- probe success/failure and health effect;
- panel registry matrix (supported/unsupported);
- query plugin matrix;
- datasource resolution/health;
- no-query and mixed-query panels;
- first-reason determinism;
- hidden counts and `show_unsupported` placeholders;
- demo fixture: 9 total, 6 eligible, 3 hidden with exact reasons
  (`traces` → `unsupported_query` Tempo, `logs` → `unsupported_query` Loki,
  `unknown` → `unsupported_panel`).

## Out of scope

- Tempo/Loki/OTel rendering.
- Capability advertisement over HTTP.
- Per-panel capability declarations beyond plugin kinds.
- Automatic dashboard regeneration.
- Fallback/demo data in production.
