# AndroDash

An Android kiosk dashboard that renders a **documented subset of Perses
dashboards** in a WebView and talks to **Prometheus directly from the phone**.

The phone does the rendering. There is no dashboard server, no screenshot
service, and no proxy requirement. Point the app at a Perses dashboard JSON URL
and a Prometheus URL; the app lays out the panels, queries the metrics, and
draws the screen.

> **Status: M2 complete, M3 hardening next.** The renderer, mock tooling, and
> Android shell are implemented and verified on the emulator. The demo and a
> production-shaped Spark Exporter dashboard render from the same code. See
> [`docs/roadmap.md`](docs/roadmap.md).

---

## Highlights

- Plain ES2022 renderer with hand-built SVG charts; no web build step and no
  runtime dependencies.
- Direct Prometheus queries from the phone, including dashboard variables and
  capability-first panel filtering.
- Kiosk shell with `standard`, true-black `amoled`, and black-and-white
  `monochrome` presentations for AMOLED lock-screen use.
- Deterministic mock Prometheus and a Spark Exporter dashboard fixture covering
  GPU, unified-memory pressure, token throughput, latency, RDMA fabric, and
  collector health.
- Honest absence semantics: missing driver fields stay missing; unsupported
  panels are hidden with stable reasons.

---

## Why

- Reuse an old Android phone as a wall dashboard.
- Keep the dashboard definition in Perses JSON, generated or stored anywhere.
- Use the phone's RAM/CPU for rendering instead of a remote browser or server.
- Filter panels by what the client can actually serve (Prometheus first; other
  capabilities can be added later).
- Run full-screen in kiosk mode with periodic refresh and honest status.

## Architecture in one picture

```
                 HTTP(S)                         HTTP(S)
┌──────────────────────┐   dashboard JSON   ┌─────────────────────┐
│ dashboard generator  │ ─────────────────► │  Android WebView    │
│ or static file       │                    │  renderer (phone)   │
└──────────────────────┘                    │                     │
                                            │  layout → panels    │
┌──────────────────────┐   PromQL/HTTP      │  SVG charts         │
│ Prometheus           │ ◄────────────────► │  refresh scheduler  │
└──────────────────────┘                    └─────────┬───────────┘
                                                      │
                                              ┌───────▼────────┐
                                              │ Android shell  │
                                              │ kiosk + config │
                                              └────────────────┘
```

The Android shell only parses launch configuration, configures a locked-down
WebView, and applies kiosk behavior. Rendering and data access live in the web
runtime.

## Documentation map

Start with [`AGENTS.md`](AGENTS.md) if you are an agent or a new contributor.

- [`CONSTITUTION.md`](CONSTITUTION.md) — non-negotiable principles.
- [`docs/index.md`](docs/index.md) — full documentation map.
- [`docs/architecture/overview.md`](docs/architecture/overview.md) — components
  and data flow.
- [`docs/contracts/README.md`](docs/contracts/README.md) — the interface
  contracts.
- [`contracts/`](contracts/) — JSON Schemas and fixtures.
- [`changelog.d/`](changelog.d/) — decision log.
- [`docs/roadmap.md`](docs/roadmap.md) — milestones and workstreams.

## Quickstart

```sh
# terminal 1 — deterministic synthetic metrics
python3 tools/mock_prometheus.py --port 9091

# terminal 2 — serve the repo (dashboard fixtures + web runtime)
python3 tools/serve_demo.py --port 8099

# terminal 3 — build, install, launch on the emulator
mise exec -- ./gradlew :app:installDebug
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_url "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json" \
  --es prometheus_url "http://10.0.2.2:9091" \
  --es display_mode amoled \
  --ez debug true
```

`10.0.2.2` is the Android emulator's alias for the host loopback. A physical
phone uses the host's LAN address instead.

For the Spark Exporter dashboard, point `dashboard_url` at
`http://10.0.2.2:8099/contracts/fixtures/spark-dashboard.json`. The queries,
units, and absence semantics are documented in
[`docs/integrations/spark-exporter.md`](docs/integrations/spark-exporter.md).

Browser demo:

```text
http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/spark-dashboard.json&prometheus_url=http://localhost:9091&debug=true
```

## Repository layout

```
AGENTS.md              agent entry point and rules
CONSTITUTION.md        project principles
README.md              this file
app/                   Android Kotlin shell: config, WebView, kiosk
web/                   vanilla ES-module renderer and contract tests
tools/                 docs checker, mock Prometheus, static demo server
docs/                  architecture, contracts, development, integrations, roadmap
contracts/             machine-readable schemas and fixtures
changelog.d/           decision log / change fragments
```

## Non-goals for v1

- A full Perses replacement or a general-purpose dashboard editor.
- Server-side rendering or a required dashboard backend.
- Grafana dashboard import.
- Tempo/Loki/OpenTelemetry panels beyond explicit capability filtering.
- Multi-dashboard rotation, authentication, and alerting.

These may become milestones later, but they are not hidden assumptions.

## Contributing

Read [`AGENTS.md`](AGENTS.md), then the contract for your workstream. Every
material decision or contract change needs an entry in [`changelog.d/`](changelog.d/).
Keep the demo working and the docs honest.
