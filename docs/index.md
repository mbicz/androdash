# Documentation map

This directory is the narrative source of truth for **intent**. Executable
behavior is defined by code and tests; interface details are defined by
[`docs/contracts/`](contracts/README.md) and the machine-readable artifacts in
[`contracts/`](../contracts/).

If you are new, read [`AGENTS.md`](../AGENTS.md) first.

## Start by role

| You are… | Read, in order |
|---|---|
| A new agent | [`AGENTS.md`](../AGENTS.md) → [`CONSTITUTION.md`](../CONSTITUTION.md) → this page → your scoped `AGENTS.md` → your contract |
| Doing Android shell work (W1) | C-001, C-007, C-008 → [`architecture/android-shell.md`](architecture/android-shell.md) → [`app/AGENTS.md`](../app/AGENTS.md) |
| Doing renderer work (W2) | C-001–C-006, C-009 → [`architecture/renderer.md`](architecture/renderer.md) → [`web/AGENTS.md`](../web/AGENTS.md) |
| Doing demo/tooling work (W3) | C-003 → [`architecture/testing.md`](architecture/testing.md) → [`tools/AGENTS.md`](../tools/AGENTS.md) |
| Changing contracts/docs (W4) | [`contracts/README.md`](contracts/README.md) → [`changelog.d/README.md`](../changelog.d/README.md) → [`docs/AGENTS.md`](AGENTS.md) |
| Trying to run the demo | [`development.md`](development.md) → [`roadmap.md`](roadmap.md) (current milestone) |
| Looking for why | [`changelog.d/`](../changelog.d/) |

## Architecture

| Document | What it answers |
|---|---|
| [`architecture/overview.md`](architecture/overview.md) | What are the components? How does a refresh flow end to end? What is out of scope? |
| [`architecture/android-shell.md`](architecture/android-shell.md) | How does the Kotlin shell configure the WebView, parse config, and apply kiosk behavior? |
| [`architecture/renderer.md`](architecture/renderer.md) | How is the web runtime structured? How are panels, layout, and refresh implemented? |
| [`architecture/security.md`](architecture/security.md) | What is the threat model? What must never be weakened? |
| [`architecture/testing.md`](architecture/testing.md) | What is tested at which layer? What is the emulator demo recipe? |
| [`integrations/spark-exporter.md`](integrations/spark-exporter.md) | How are Spark Exporter metrics queried, formatted, and demonstrated? |

## Contracts

The index is [`contracts/README.md`](contracts/README.md).

| ID | Title |
|---|---|
| C-001 | [Launch configuration](contracts/C-001-launch-config.md) |
| C-002 | [Dashboard source and normalization](contracts/C-002-dashboard-source.md) |
| C-003 | [Prometheus access](contracts/C-003-prometheus-access.md) |
| C-004 | [Capability negotiation and filtering](contracts/C-004-capability-negotiation.md) |
| C-005 | [Panel rendering](contracts/C-005-panel-rendering.md) |
| C-006 | [Refresh and time semantics](contracts/C-006-refresh-and-time.md) |
| C-007 | [Kiosk and lifecycle](contracts/C-007-kiosk-lifecycle.md) |
| C-008 | [WebView security](contracts/C-008-webview-security.md) |
| C-009 | [Diagnostics and errors](contracts/C-009-diagnostics.md) |

## Process

| Document | What it answers |
|---|---|
| [`development.md`](development.md) | How do I set up, run, test, and debug? What commands are real today? |
| [`roadmap.md`](roadmap.md) | What is the current milestone? What is next? What are the workstreams? |
| [`glossary.md`](glossary.md) | What do Perses/Prometheus/Android terms mean here? |
| [`../changelog.d/README.md`](../changelog.d/README.md) | How do I record a decision or contract change? |

## Machine-readable artifacts

| Path | Purpose |
|---|---|
| [`../contracts/app-config.schema.json`](../contracts/app-config.schema.json) | Canonical launch configuration object |
| [`../contracts/diagnostics.schema.json`](../contracts/diagnostics.schema.json) | Diagnostics snapshot shape |
| [`../contracts/fixtures/demo-dashboard.json`](../contracts/fixtures/demo-dashboard.json) | Small Perses dashboard used by the demo and tests |
| [`../contracts/fixtures/spark-dashboard.json`](../contracts/fixtures/spark-dashboard.json) | Spark Exporter host, inference, fabric, and health dashboard |
| [`../contracts/fixtures/macos-node-dashboard.json`](../contracts/fixtures/macos-node-dashboard.json) | Live macOS host dashboard (node_exporter + real Prometheus) |
| [`integrations/agenticmac-exporter.md`](integrations/agenticmac-exporter.md) | AI coding harnesses and macOS health on the Mac (agenticmac-exporter) |
| [`../contracts/fixtures/app-config.example.json`](../contracts/fixtures/app-config.example.json) | Example canonical config |
| [`../contracts/fixtures/prometheus/`](../contracts/fixtures/prometheus/) | Deterministic Prometheus API responses |

Fixtures are normative. If a fixture and a contract disagree, treat it as a
defect and fix both.

## Documentation rules

- Use relative links; keep them valid.
- Prefer tables and short sections over long prose.
- Mark **planned** behavior clearly. Do not describe unimplemented behavior as
  if it exists.
- Every material decision or contract change gets a `changelog.d` entry.
- Do not duplicate code-level details in multiple documents; link instead.
- Keep line length reasonable for review; no generated tables by hand if a
  script can check them.
