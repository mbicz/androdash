# Contracts

**Version:** 1.x (2026-10-28)
**Status:** accepted and implemented through M2; M3 hardening is ongoing.
**Normative companions:** [`contracts/`](../../contracts/) (schemas + fixtures).

Contracts define the interfaces between workstreams and the guarantees the
renderer/shell make to each other and to operators. They are intentionally
smaller than a full Perses specification. If code needs behavior not described
here, add a contract change and a `changelog.d` entry first.

## Index

| ID | Contract | Version | Consumers | Machine-readable / fixtures |
|---|---|---|---|---|
| C-001 | [Launch configuration](C-001-launch-config.md) | 3 | W1, W2 | `contracts/app-config.schema.json`, `fixtures/app-config.example.json` |
| C-002 | [Dashboard source and normalization](C-002-dashboard-source.md) | 1 | W2 | `fixtures/demo-dashboard.json`, `fixtures/spark-dashboard.json`, `fixtures/macos-node-dashboard.json` |
| C-003 | [Prometheus access](C-003-prometheus-access.md) | 1 | W2, W3 | `fixtures/prometheus/*.json` |
| C-004 | [Capability negotiation and filtering](C-004-capability-negotiation.md) | 1 | W2 | `fixtures/demo-dashboard.json`, `fixtures/spark-dashboard.json` |
| C-005 | [Panel rendering](C-005-panel-rendering.md) | 6 | W2 | `fixtures/demo-dashboard.json`, `fixtures/spark-dashboard.json` |
| C-006 | [Refresh and time semantics](C-006-refresh-and-time.md) | 3 | W2 | — |
| C-007 | [Kiosk and lifecycle](C-007-kiosk-lifecycle.md) | 4 | W1 | — |
| C-008 | [WebView security](C-008-webview-security.md) | 1 | W1, W2 | — |
| C-009 | [Diagnostics and errors](C-009-diagnostics.md) | 1 | W1, W2 | `contracts/diagnostics.schema.json`, `fixtures/diagnostics.example.json` |

## How to read a contract

Each contract has:

- **Purpose** — the problem and boundary.
- **Interface** — inputs, outputs, invariants.
- **Behavior** — ordered rules and edge cases.
- **Errors** — stable codes (see C-009).
- **Limits** — bounded resource use.
- **Compatibility** — versioning and what counts as breaking.
- **Test obligations** — the minimum tests that make it executable.

## Versioning

- `schemaVersion` is an integer for machine-readable artifacts. Bump it for
  breaking changes; add migration notes/decisions.
- Contract docs carry a major version in their header (`v1`). A breaking change
  becomes `v2`; old consumers must be migrated or explicitly dropped.
- Additive fields are allowed within a major version if:
  - they have defaults;
  - consumers tolerate unknown fields;
  - docs, fixtures, and tests are updated;
  - a `changelog.d` entry records the change.
- Removing/renaming a field, changing a default, changing an error code, or
  changing filtering semantics is breaking.

## Change process

1. Add `changelog.d/NNNN-<slug>.md` (`kind: contract` or `kind: decision`).
2. Update the contract, schema/fixture, and every consumer in the same change.
3. Add/update the contract test named after the contract ID.
4. Update the index table and any architecture doc that describes the behavior.
5. If breaking: bump the version and state the migration.

Accepted entries are history; do not rewrite them. Supersede with a new entry.

## Cross-cutting invariants

- The app renders on the device; no server-side rendering contract exists.
- Unsupported capability → hide/placeholder + diagnostic; never fake data.
- All timestamps in machine artifacts are UTC ISO-8601; Prometheus query times
  are Unix seconds (fractional allowed).
- All HTTP inputs are untrusted; strings are escaped before display.
- Limits are enforced before allocating unbounded DOM/arrays.
- Diagnostics never include credentials or full query strings.
- The demo fixtures (`demo-dashboard.json` and `spark-dashboard.json`) must keep
  working across contract changes, or the change must update them and the
  expected counts.

## Contract test naming

```
web/tests/contract/c001-config.test.js
web/tests/contract/c002-dashboard.test.js
web/tests/contract/c003-prometheus.test.js
web/tests/contract/c004-capabilities.test.js
web/tests/contract/c005-panels.test.js
web/tests/contract/c005-layout.test.js
web/tests/contract/c005-fit.test.js
web/tests/contract/c006-refresh.test.js
web/tests/contract/c009-diagnostics.test.js
```

C-007/C-008 are verified by Android unit tests and the emulator manual checklist
(see `docs/architecture/testing.md`).

## Out of scope for v1

- Full Perses plugin coverage.
- Authentication/secrets.
- Multi-dashboard/playlists.
- Grafana import.
- Server-side rendering/proxying.
- Native chart widgets.

Anything here that becomes necessary needs a new contract or an explicit
amendment, not an implicit code path.
