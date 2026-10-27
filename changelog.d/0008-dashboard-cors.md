---
id: 0008
date: 2026-10-26
status: accepted
kind: contract
scope: security
supersedes: []
---

# Require CORS for dashboard JSON fetches

## Context

The renderer runs from the intercepted `http://androdash.local` origin
(decision 0007), not from the dashboard server's origin. Fetching
`dashboard_url` is therefore a cross-origin request. Without an
`Access-Control-Allow-Origin` response header, the browser blocks the response
even when the URL is reachable, and the shell would otherwise report a generic
network failure.

## Decision

C-002 now requires the dashboard source to permit `GET` from the renderer origin
(`http://androdash.local` or `*`). CORS failures map to `E_DASHBOARD_FETCH` with
a hint naming the renderer origin and the missing header. C-008 records this as a
deployment prerequisite alongside Prometheus CORS. The M1 demo server
(`tools/serve_demo.py`) must send `Access-Control-Allow-Origin: *` and handle
`OPTIONS`.

Prometheus already had the same requirement in C-003; this entry makes the
dashboard side symmetric.

## Consequences

### Positive

- The failure mode is diagnosed instead of looking like an unreachable host.
- Browser development and the Android shell use the same source rules.
- The demo server can be tested from both origins.

### Negative / risks

- Static dashboard hosting (object stores, NAS web servers) must be configured
  for CORS; some default hosting setups will not work unchanged.
- `*` is acceptable for public/synthetic dashboards but should be narrowed where
  the host supports an origin allowlist.

### Follow-ups

- Implement the CORS headers and `OPTIONS` handling in `tools/serve_demo.py`
  (M1).
- Add the demo-server CORS check to the M1/M2 manual test list.

## Contracts affected

- C-002: CORS requirement and CORS-specific error hint.
- C-008: CORS deployment prerequisite for the virtual origin.
- C-003: unchanged Prometheus CORS requirement; cross-referenced.
- `tools/AGENTS.md`: demo static server must send CORS.
- `docs/architecture/*`: failure and troubleshooting wording.

## Verification

Docs-only for now. `python3 tools/check_docs.py` and the JSON checks pass. The
M1 implementation must demonstrate a successful dashboard fetch from
`http://androdash.local` and a visible CORS hint when the header is removed.
