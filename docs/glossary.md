# Glossary

Terms as used in this repository. When a term has a broader meaning in Perses or
Prometheus, this page states the AndroDash-specific scope.

| Term | Meaning here |
|---|---|
| **AndroDash** | This project: an Android kiosk WebView that renders a Perses dashboard subset and queries Prometheus directly. |
| **AppConfig** | The canonical, validated launch-configuration object (C-001). Android Intent extras map to it; the renderer parses the same fields from query parameters. |
| **Advertised capabilities** | The capability IDs the client claims to support, e.g. `prometheus`. Exposed in diagnostics and used to filter panels. |
| **Capability** | A client feature/data source that panels can require. v1 implements `prometheus`; `tempo`, `loki`, and `opentelemetry` are recognized but unsupported. |
| **Capability filtering** | Hiding panels whose panel/query plugin, datasource, or capability is not available, instead of rendering a broken or fake panel. |
| **CORS** | Cross-Origin Resource Sharing. The WebView page (`http://androdash.local`) can fetch the dashboard/Prometheus only if the server allows it (`Access-Control-Allow-Origin: *` or that origin). |
| **Dashboard** | A Perses `Dashboard` (or `EphemeralDashboard`) JSON document describing panels, variables, datasources, layouts, duration, and refresh interval. |
| **Dashboard source** | The HTTP(S) URL the app fetches the dashboard JSON from. It may be static or generated. |
| **Dashboard subset** | The Perses features AndroDash actually supports, documented in C-002/C-005. Not full Perses. |
| **Datasource** | A named Perses datasource, e.g. a `PrometheusDatasource` with a direct/proxy URL. In v1 the URL is used directly; there is no Perses proxy. |
| **Debug overlay** | In-app diagnostics visible only with `debug=true`; config (redacted), capabilities, hidden panels, requests, errors, reload/exit actions. |
| **Eligibility** | The pure decision that a panel can be rendered given the panel kind, query kinds, datasource health, and capabilities. |
| **Error code** | A stable string such as `E_PROM_QUERY` defined in C-009. Messages are hints; codes are contract. |
| **EphemeralDashboard** | A Perses dashboard variant with the same spec shape. Accepted by C-002. |
| **Grid layout** | A Perses row with a 24-column grid; items have `x`, `y`, `width`, `height`, and a `$ref` to a panel. |
| **Hidden panel** | A panel removed from the layout because it is unsupported/unavailable. Counted and explained in diagnostics. |
| **Kiosk mode** | Fullscreen, immersive, keep-screen-on, back-disabled appliance mode. Optional lock task requires device-owner provisioning. |
| **Lock task** | Android's screen-pinning/device-owner mode. `lock_task=true` attempts `startLockTask()`; it is not guaranteed without provisioning. |
| **Matrix** | Prometheus range-query result type: a list of series, each with timestamp/value points. |
| **Panel** | A Perses panel: display metadata, a panel plugin (e.g. `TimeSeriesChart`), and queries. |
| **Panel plugin** | The renderer kind of a panel (`TimeSeriesChart`, `StatChart`, `GaugeChart`, `Table`, `Markdown`). |
| **PromQL** | Prometheus query language used in `PrometheusTimeSeriesQuery.query`. |
| **Prometheus** | The v1 metrics backend. Queried over its HTTP API from the WebView. |
| **Query plugin** | The query kind inside a panel query (`PrometheusTimeSeriesQuery`, `TempoTraceQuery`, …). Unsupported query plugins make the panel ineligible. |
| **Range query** | `GET /api/v1/query_range` with `start`, `end`, `step`; returns a matrix. Used by time series, stat, and gauge panels. |
| **Instant query** | `GET /api/v1/query` at a single `time`; returns a vector/scalar. Used by tables in v1. |
| **Refresh interval** | Seconds between refresh cycles, from `refresh_seconds` param, else dashboard `refreshInterval`, else 30. `0` means manual only. |
| **Renderer** | The vanilla ES-module web runtime in `web/app/` that parses, filters, lays out, queries, and draws. |
| **Row** | A Perses `Grid` layout entry with a display title and items; may be collapsible. |
| **Stale** | A panel or the dashboard showing last-good data after a failed refresh; visibly marked, never silently passed off as current. |
| **Step** | Prometheus range-query resolution in seconds. `step_seconds` overrides; otherwise derived from the range (≈240 points, min 15 s). |
| **SVG chart** | The v1 chart implementation: DOM/SVG paths, no canvas/chart library. |
| **Time range** | The dashboard window (`spec.duration` or `time_range`), e.g. `15m`; shared by all queries in one refresh cycle. |
| **Variable** | A Perses variable (text/list/datasource/label-values). v1 resolves defaults; there is no variable picker. |
| **WebView** | Android's Chromium-based browser component that runs the local renderer. |
| **`$ref`** | A JSON Pointer in a layout item referencing `#/spec/panels/<id>`. |
| **`10.0.2.2`** | The Android emulator's alias for the host machine's loopback interface. |
| **W1/W2/W3/W4** | Workstreams: Android shell, web renderer, demo tooling, contracts/docs. |
| **M0/M1/M2/M3/M4** | Milestones in `docs/roadmap.md`. |
| **C-001…C-009** | Contract IDs in `docs/contracts/`. |
