---
id: 0009
date: 2026-10-26
status: accepted
kind: contract
scope: contracts
supersedes: []
---

# Normalize empty and duplicate launch configuration

## Context

C-001 requires the Android → query-string → renderer round trip to preserve the
configuration, but the first schema allowed two ambiguous cases:

- an empty `capabilities` array and an absent `capabilities` value were
  distinguishable in the canonical object but not on the wire, because C-001
  treats empty query values as unset;
- `dashboard_name` could be `""` in the canonical object even though an empty
  query value becomes `null`;
- duplicate capability IDs were deduplicated by C-004 while the schema marked
  the canonical list as unique.

The renderer needs one deterministic interpretation before M1 tests can assert
round-trip behavior.

## Decision

- A capability override is present only when the wire value is non-empty. The
  parser trims, lowercases, deduplicates, sorts, and rejects the result if it has
  more than 16 IDs. An empty wire value means `null` (probe), not an empty set.
- A canonical `capabilities` array must contain 1–16 unique IDs. To simulate a
  client with no supported capabilities, advertise an unknown inert ID instead
  of an empty list.
- `dashboard_name` is either `null` or a non-empty string. An empty wire value is
  unset.
- Round-trip preservation is canonical: capability IDs may be reordered,
  lowercased, and deduplicated by design.

The schema now enforces `minItems: 1` for `capabilities` and `minLength: 1` for
`dashboardName`; C-001 and C-004 document the normalization and test cases.

## Consequences

### Positive

- Absent, empty, and duplicate inputs have one documented result.
- Round-trip tests can compare canonical strings.
- Capability filtering and diagnostics get stable, sorted IDs.

### Negative / risks

- There is no way to request a truly empty advertised set; use an unknown ID.
  This is intentional to avoid adding another wire sentinel.
- A config source that builds an explicit empty capability list is invalid; an
  empty wire value is still unset (probe).

### Follow-ups

- Cover empty, duplicate, over-limit, and reordered capability inputs in
  `c001-config.test.js` and `c004-capabilities.test.js`.
- Keep the Android URL builder aligned with the canonical query form.

## Contracts affected

- C-001: capability count/normalization, empty optional values, test obligations.
- C-004: advertised override parsing and empty-override rule.
- `contracts/app-config.schema.json`: `minItems`/`minLength` constraints.

## Verification

`find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty` passes, the
example config still validates, and `python3 tools/check_docs.py` passes. Runtime
tests are deferred to M1.
