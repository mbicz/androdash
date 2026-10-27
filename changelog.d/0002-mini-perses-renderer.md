---
id: 0002
date: 2026-10-26
status: accepted
kind: decision
scope: renderer
supersedes: []
---

# Implement a documented Perses subset instead of embedding the Perses UI

## Context

Perses's full UI expects a Perses backend/API and a large React/plugin runtime.
Bundling it would add significant size and complexity, require a compatibility
shim for dashboards/datasources, and make capability filtering harder to reason
about. The first goal is to render something useful on a phone with minimal
moving parts.

## Decision

Implement a small, dependency-free renderer that understands a **documented
subset** of Perses dashboards:

- panels: `TimeSeriesChart`, `StatChart`, `GaugeChart`, `Table`, `Markdown`;
- queries: `PrometheusTimeSeriesQuery`;
- datasources: `PrometheusDatasource` (direct URL);
- layouts: `Grid` (24 columns) with a phone stacking mode;
- static variable defaults (no picker);
- direct Prometheus HTTP API access.

The subset is versioned in C-002/C-005. Unsupported panels are filtered, never
approximated.

## Consequences

### Positive

- Small, auditable runtime; no npm/build step.
- Full control over capability filtering and diagnostics.
- Fast iteration in a browser and the emulator.
- Honest limits: the app says what it cannot render.

### Negative / risks

- Not full Perses parity; users may expect unsupported panels.
- We own charting, formatting, thresholds, and edge cases.
- Future plugin support requires renderer + contract work.

### Follow-ups

- Add panel kinds only with C-005 updates, fixtures, and tests.
- Revisit embedding Perses UI only if full parity becomes a hard requirement.

## Contracts affected

- C-002 (dashboard subset), C-003 (Prometheus), C-004 (capabilities),
  C-005 (panels).

## Verification

- Demo fixture covers supported and unsupported panels.
- Browser demo shows 6 rendered / 3 hidden.
- Contract tests per panel kind.
