---
id: 0039
date: 2026-11-20
status: accepted
kind: decision
scope: docs, contracts, tooling
supersedes: []
---

# The repository is host-agnostic

## Context

Integration docs, decision evidence, fixtures, generators, and tests had
accumulated the maintainer's own environment: LAN and tailnet addresses,
machine hostnames, an adb serial, a hardware MAC address, the composition and
day-to-day state of a private inference fleet, and narrative about one
workstation and one phone. None of that is needed to understand or verify a
decision, and it ties a public project to a private network.

## Decision

- Docs, decisions, fixtures, generators, tests, and comments describe **roles**,
  not the maintainer's machines: "a macOS host", "GB10 hosts", "the
  workstation", "a Prometheus on the LAN".
- Example addresses use `192.168.1.0/24` for LAN hosts and `100.64.0.0/24` for
  tailnet hosts; example hostnames are `spark-a`, `spark-b`, `workstation`;
  example adb serial is `0123456789ABCDEF`; example MAC addresses are
  locally administered (`02:…`).
- Generic technology stays: product and hardware classes (DGX Spark, GB10,
  macOS), exporters and their repositories, Tailscale as a supported discovery
  source, device models named as test-device evidence.
- Existing decision entries were **redacted in place** to apply this. That is
  the one exception to append-only history: identifying data may be removed
  from an accepted entry; its decision, rationale, and measurements may not be
  changed.

## Consequences

### Positive

- Anyone can follow a doc or reproduce a decision's evidence without decoding
  someone else's network.
- No private addresses or device identifiers ship in the APK's bundled
  dashboards or in the docs.

### Negative / risks

- Git history before this entry held the original values. On 2026-11-20 the
  full history was rewritten with `git filter-repo` (every blob, commit message,
  and path; author identity unchanged) and force-pushed. Clones and forks made
  before the rewrite, and GitHub's cached views until purged, still hold the
  old objects.
- Verification evidence now names roles, so it cannot be traced to a specific
  physical machine from the repo alone.

### Follow-ups

- Purge GitHub's cached views of the pre-rewrite objects with GitHub support if
  they must not be reachable by SHA.

## Contracts affected

- none. Fixture descriptions and the `metadata.name` of two dashboards changed
  wording only (`macOS agents`, `Model speed on macOS`); no query, panel kind,
  capability, or schema changed.

## Verification

- A case-insensitive search of tracked files for the removed hostnames,
  addresses, serial, and MAC address returns nothing.
- A search of every commit message, blob, and path in the rewritten history
  returns nothing.
- `node --test web/tests/`, tooling unit tests, `:app:testDebugUnitTest`,
  `check_docs.py`, and `jq empty` over `contracts/` pass.
