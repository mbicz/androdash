---
id: 0006
date: 2026-10-26
status: accepted
kind: decision
scope: security
supersedes: []
---

# Allow cleartext HTTP for LAN dashboards and Prometheus

## Context

A typical home-lab Prometheus listens on `http://host:9090`; dashboard JSON may
be served by a NAS or a simple static server over HTTP. Android 9+ blocks
cleartext by default. Requiring HTTPS for v1 would add certificate/proxy setup
and break the "just Prometheus + a dashboard + the phone" goal.

## Decision

Allow cleartext HTTP for `dashboard_url` and `prometheus_url` in v1, while
keeping the rest of the WebView locked down. Document the risk and recommend a
trusted LAN/VPN or an HTTPS reverse proxy for anything exposed.

This is not a general permission to weaken TLS: SSL errors remain fatal, mixed
content remains disabled, and no credentials are sent in v1.

## Consequences

### Positive

- Works with standard home-lab Prometheus and simple static hosting.
- No certificate provisioning for the first demo.
- The phone can talk to LAN addresses directly.

### Negative / risks

- Metrics/dashboard traffic is readable and tamperable on untrusted Wi-Fi.
- No confidentiality/integrity against a network attacker.
- A future HTTPS deployment may make HTTP Prometheus mixed content; needs a
  decision.

### Follow-ups

- Add optional HTTPS/basic-auth support with a new contract.
- Provide deployment guidance for a trusted VLAN/VPN.
- Revisit `usesCleartextTraffic` when auth/HTTPS lands.

## Contracts affected

- C-001 (URL schemes), C-003 (CORS/cleartext errors), C-008 (network posture).

## Verification

- Emulator demo uses `http://10.0.2.2:9091` and works.
- Diagnostics warn when a URL is HTTP? (v1: document, no noisy banner.)
- Security checklist confirms no TLS bypass, no credentials, no mixed content.
