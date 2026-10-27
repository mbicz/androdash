---
id: 0003
date: 2026-10-26
status: accepted
kind: decision
scope: architecture
supersedes: []
---

# Query Prometheus directly and filter panels by advertised capabilities

## Context

The app must render without a server, and the dashboard may be generated for a
client with a specific set of capabilities (Prometheus, Tempo, OTel, …). A
client that cannot service a panel should not show a broken or fake chart.

## Decision

The WebView queries Prometheus's HTTP API directly. There is no Perses proxy and
no server-side query execution. The client:

1. Advertises a capability set (`prometheus` in v1; others recognized).
2. Probes configured Prometheus URLs via `/api/v1/status/buildinfo`.
3. Computes panel eligibility from the panel plugin, query plugins, datasource
   URLs, and capabilities.
4. Hides ineligible panels (or shows explicit placeholders with
   `show_unsupported=true`) and records stable reasons.

A launch parameter can override the advertised set for testing. External
dashboard generators can target the same documented capability IDs.

## Consequences

### Positive

- Phone does all data access and rendering.
- No silent or fabricated panels.
- Generated dashboards can be tailored; the client still filters defensively.
- Diagnostics explain every hidden panel.

### Negative / risks

- Prometheus must be reachable from the device and allow CORS (`Origin: null`).
- Cleartext HTTP is common (decision 0006).
- No auth in v1.
- Capability advertisement is in-app only; no HTTP callback yet.

### Follow-ups

- Publish a capability document for generators in a later milestone.
- Add auth/HTTPS with a new contract if needed.
- Add Tempo/Loki/OTel only with real renderers.

## Contracts affected

- C-003 (Prometheus access), C-004 (capabilities/filtering), C-009 (reasons).

## Verification

- Demo: 6 panels render, 3 hidden with exact reasons.
- Stopping the mock yields visible errors, not fabricated data.
- Capability override tests.
