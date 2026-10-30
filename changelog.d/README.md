# Decision log and change fragments (`changelog.d`)

This directory is the **system of record for why** AndroDash looks the way it
does. It is not a conventional release-only changelog.

Every material decision, contract change, or constitution amendment gets one
entry. A future agent should be able to read `changelog.d/` and understand which
choices are deliberate, which are provisional, and what superseded what.

## Decision index

One line per entry, oldest first. The newest entries describe the current
shape; older ones remain binding unless marked superseded.

| ID | Decision | Status |
|---|---|---|
| [0001](0001-on-device-webview-kiosk.md) | Render dashboards on-device in an Android WebView kiosk | accepted |
| [0002](0002-mini-perses-renderer.md) | Implement a documented Perses subset instead of embedding the Perses UI | accepted |
| [0003](0003-direct-prometheus-capabilities.md) | Query Prometheus directly and filter panels by advertised capabilities | accepted |
| [0004](0004-contract-first-parallel-agents.md) | Contract-first development with a repository-native decision log | accepted |
| [0005](0005-vanilla-es-modules.md) | Use vanilla ES modules and SVG charts with no web build step | accepted |
| [0006](0006-cleartext-lan-http.md) | Allow cleartext HTTP for LAN dashboards and Prometheus | accepted |
| [0007](0007-virtual-http-origin.md) | Serve the bundled renderer from a virtual local HTTP origin | accepted |
| [0008](0008-dashboard-cors.md) | Require CORS for dashboard JSON fetches | accepted |
| [0009](0009-config-edge-cases.md) | Normalize empty and duplicate launch configuration | accepted |
| [0010](0010-amoled-monochrome-display-modes.md) | Add AMOLED and monochrome display modes | accepted |
| [0011](0011-show-when-locked.md) | Allow the kiosk dashboard to show above the keyguard | accepted |
| [0012](0012-spark-exporter-units.md) | Consume Spark Exporter metrics and add physical units | accepted |
| [0013](0013-application-id-rename.md) | Rename the Android application ID to `com.mbicz.androdash` | accepted |
| [0014](0014-css-pixel-geometry-and-grouped-metrics.md) | Render at CSS-pixel geometry and group same-unit metrics | accepted |
| [0015](0015-phone-ux-and-visual-system.md) | Phone UX pass: paging, folding, time controls, quiet status, flat visual system | accepted |
| [0016](0016-lock-screen-grayscale.md) | Lock-screen grayscale view, power-button re-light, and view/lock bridge methods | accepted |
| [0017](0017-fit-layout-and-lock-style.md) | Fit-to-screen layout, settings sheet, and lock-screen colour option | accepted |
| [0018](0018-on-device-dashboards.md) | On-device dashboards: bundled, stored copy, or live from the URL | accepted |
| [0019](0019-on-phone-collector.md) | Prometheus on the phone: bundled collector service | accepted |
| [0020](0020-multiple-dashboards-and-panel-scrolling.md) | Multiple dashboards, panel scrolling, and gestures that never leave the app | accepted |
| [0021](0021-phone-exporter-zoom-and-stable-header.md) | Phone exporter in the app, panel zoom, and a stable header | accepted |
| [0022](0022-status-dot-only.md) | Header status: the dot only | accepted |

## File naming

```
NNNN-short-kebab-title.md
```

- `NNNN` is a zero-padded, monotonically increasing number.
- One entry per change/decision. Do not bundle unrelated decisions.
- Use `TEMPLATE.md` as the starting point.

## Status lifecycle

| Status | Meaning |
|---|---|
| `proposed` | Under discussion; not yet binding. Code may exist behind a flag, but do not ship a breaking contract on it. |
| `accepted` | Binding. Code, contracts, and docs must agree. |
| `superseded` | Replaced by a later entry. Keep the original text; add `superseded-by`. |
| `rejected` | Considered and not adopted. Keep for context. |

Accepted entries are **append-only history**. Do not rewrite them to match new
code; add a new entry and mark the old one superseded.

## Kinds

| Kind | Use |
|---|---|
| `decision` | Architecture/product choice (e.g. WebView, no bundler) |
| `contract` | Interface/behavior change (schema, error code, capability ID) |
| `change` | Notable implementation change that is not a contract decision |
| `constitution` | Amendment to `CONSTITUTION.md` |

## When an entry is required

- A new/removed query parameter, error code, capability ID, panel kind, warning,
  diagnostic field, or schema field.
- A change to filtering, refresh, timeout, limit, or redaction semantics.
- A new dependency, build step, network endpoint, or platform permission.
- A security posture change (cleartext, bridge, WebView setting).
- A milestone scope change or a deliberate deferral.
- A constitution amendment.

Not required for typo fixes, link fixes, or tests that only cover existing
contracts.

## Entry format

```markdown
---
id: NNNN
date: YYYY-MM-DD
status: accepted
kind: decision
scope: architecture
supersedes: []
---

# Title

## Context
## Decision
## Consequences
## Contracts affected
## Verification
```

- `scope`: `architecture`, `renderer`, `android`, `tooling`, `contracts`,
  `security`, `docs`, `milestone`.
- `supersedes`: list of entry IDs, or `[]`.
- Keep it short enough to read before a change.

## Relationship to contracts and code

- Contracts define the interface; this log explains the choice.
- Code/tests define actual behavior.
- If an accepted entry conflicts with a contract, the contract wins until a new
  entry + contract update is accepted. Resolve the conflict; don't ignore it.

## Release notes

A future release changelog can be generated from `kind: change` entries. The
decision log is intentionally richer than release notes.
