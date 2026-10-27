---
id: 0005
date: 2026-10-26
status: accepted
kind: decision
scope: renderer
supersedes: []
---

# Use vanilla ES modules and SVG charts with no web build step

## Context

The renderer must ship inside the APK, run from a local app origin, be
auditable, and be easy for parallel agents to change. A bundler/framework adds dependency and
build complexity for a UI with five panel kinds and one data source. Charting
libraries add weight and their own rendering/escape semantics.

## Decision

- Runtime: plain ES2022 modules, loaded directly by the WebView.
- No framework, bundler, transpiler, CDN, or runtime npm dependency.
- Charts: hand-built SVG (line, arc, table) with small helpers.
- Tests: Node's built-in test runner (`node --test`), importing modules directly.
- CSS: one local stylesheet with CSS variables; dark theme only in v1.
- Python standard library for the mock/static demo tooling.

## Consequences

### Positive

- Zero build step; edit and reload.
- Small, inspectable surface; no supply-chain runtime risk.
- Tests run with no `npm install`.
- Easy asset packaging (`web/app` → APK assets).

### Negative / risks

- We own chart layout/accessibility/performance details.
- No JSX/type system; discipline and tests are required.
- Browser/WebView feature differences must be handled manually.
- Large future dashboards may need a chart library or build step; that needs a
  decision entry.

### Follow-ups

- Keep pure logic exported and tested.
- Measure performance/memory on the emulator.
- If a build step is ever added, record why and update `AGENTS.md`/C-008.

## Contracts affected

- C-005 (rendering), C-008 (no remote code), architecture/renderer.

## Verification

- `node --test web/tests/` (M1) with no dependencies.
- App loads `index.html` from assets without a build.
- Security audit: no remote scripts/styles/fonts.
