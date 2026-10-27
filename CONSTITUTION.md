# The AndroDash Constitution

**Version:** 1.0
**Ratified:** 2026-10-26
**Status:** Baseline for milestone M0
**Amendments:** require a `changelog.d` entry with `kind: constitution` and a version bump.

## Preamble

AndroDash turns an Android phone into a self-contained dashboard appliance. A
Perses dashboard definition describes what to show. The phone's WebView fetches
the data, lays out the panels, and draws the result. No application server is
required between the dashboard definition and the screen.

The project is built so that people and AI agents who have never seen it before
can understand it, change one part, and verify their work without reading the
whole repository. This document defines the rules that do not change casually.

## Article 1 — Render on the device

Dashboard rendering MUST run in the client (Android WebView) using the phone's
CPU, GPU, and RAM. The network is used for the dashboard definition and for
metrics. It MUST NOT be required for layout, charting, or page assembly.

A server MAY serve static files. A server MUST NOT be required to execute the
dashboard, proxy every query, or compose the screen.

## Article 2 — Kiosk is the primary mode

The default deployment is a full-screen, always-on, appliance-like view. Kiosk
mode MUST hide system chrome, keep the screen awake, and prevent accidental
navigation away.

Debug behavior MUST be explicit (`debug=true` or a debug build), MUST be
documented, and MUST be off by default in release. A kiosk that cannot be
serviced by its owner is a defect.

## Article 3 — Capability honesty

The client advertises what it can render. It MUST NOT silently fake, invent, or
approximate data. If a panel's panel plugin, query plugin, datasource, or
capability is unsupported, the panel is hidden or shown as explicitly
unsupported, and the reason is recorded in diagnostics.

A blank panel with an error code is acceptable. A convincing lie is not.

## Article 4 — Perses is a language, not a dependency

AndroDash reads a documented subset of Perses dashboard JSON. It is not a
reimplementation of the Perses server or the complete Perses UI. The supported
subset, its limits, and its known gaps are versioned in `docs/contracts/`.

Compatibility claims MUST be precise. "Renders Perses dashboards" means
"renders the subset in C-002/C-005", not "supports every Perses plugin".

## Article 5 — Contracts before code; code before prose

The intended interface is defined in `docs/contracts/` and, where practical, in
machine-readable form under `contracts/`. The actual behavior is defined by the
code and its tests.

When docs and code disagree, that is a defect. Fix the code, the contract, or
both. Do not let a contract rot into a wish list, and do not let code grow an
undocumented interface.

The source-of-truth hierarchy is:

1. Executable behavior: code plus tests.
2. Interfaces and invariants: `docs/contracts/` plus `contracts/`.
3. Rationale and history: accepted entries in `changelog.d/`.
4. Narrative explanation: `docs/architecture/`, `README.md`, and `AGENTS.md`.

## Article 6 — Self-contained, offline-capable runtime

The WebView application MUST NOT load remote JavaScript, remote CSS, remote
fonts, or third-party runtime code. Runtime assets ship inside the APK or are
served by this repository. No CDN is a dependency.

The app SHOULD render a previously loaded dashboard with a clear error state when
Prometheus is unreachable. It MUST NOT depend on a build step at runtime.

## Article 7 — Untrusted input, locked-down shell

Dashboard JSON, Markdown, labels, error strings, and Prometheus responses are
untrusted input. They MUST be escaped or handled as text, never injected as
HTML or script.

The WebView MUST be configured according to C-008: no remote code, no arbitrary
navigation, no mixed content, no file/content access beyond the bundled assets,
and no web debugging in release.

Cleartext HTTP is a deliberate, documented exception for metrics endpoints on a
trusted local network. It is not permission to weaken the rest of the shell.

## Article 8 — Observable in silence

A kiosk has no developer watching it. The screen MUST make the current state
legible: last successful update, next refresh, stale data, hidden panels, and
actionable errors. Diagnostics MUST be available without a debugger, gated by
`debug=true`.

Logs MUST NOT contain credentials, tokens, or secret query parameters. Error
messages MUST be specific enough to fix the configuration and short enough to
fit on a phone.

## Article 9 — Small steps, recorded decisions

Changes SHOULD be small enough to review and reverse. Every material decision or
contract change MUST leave an entry in `changelog.d/`. Accepted entries are
historical records: supersede them; do not rewrite them.

Speculative frameworks, build systems, and abstractions MUST NOT be introduced
without a decision entry and a concrete milestone need.

## Article 10 — Performance is part of the product

The target is a phone doing the rendering, often for hours. Work MUST be bounded:
bounded series per panel, bounded points per series, bounded panels per
dashboard, bounded refresh rate, no overlapping refresh cycles, and no unbounded
DOM growth.

Targets are documented in `docs/architecture/renderer.md`. A change that
measurably worsens boot time, refresh cost, or memory use needs justification in
the decision log.

## Article 11 — Parallel strangers must succeed

A new contributor or agent MUST be able to bootstrap from this repository
without tribal knowledge:

- `AGENTS.md` gives the route and the rules.
- `docs/index.md` gives the map.
- Each workstream has a scoped `AGENTS.md` and a contract.
- Every behavior has a runnable verification command or a documented manual
  check.
- Ownership boundaries are explicit, so parallel work does not collide.

If a smart stranger cannot get from clone to a verified change using the repo
alone, the repository is incomplete.

## Article 12 — No secrets, no surprises

Configuration, diagnostics, fixtures, screenshots, and decision entries MUST NOT
contain real credentials or private data. Test fixtures use synthetic values.
Launch URLs are validated. The default network posture is documented rather than
assumed.

## Amendment process

1. Add `changelog.d/NNNN-<slug>.md` with `kind: constitution`, status `proposed`.
2. Update this document and bump the version.
3. Update affected contracts, fixtures, and tests.
4. Mark the entry `accepted` when the change is merged.

A constitution article may be clarified without an amendment; changing its
meaning requires one.
