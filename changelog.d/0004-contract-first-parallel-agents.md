---
id: 0004
date: 2026-10-26
status: accepted
kind: decision
scope: docs
supersedes: []
---

# Contract-first development with a repository-native decision log

## Context

The project will be built by multiple agents working in parallel, often without
shared context. Tribal knowledge and chat history are not durable. We need a
bootstrap path that works from a fresh clone, clear interface boundaries, and a
record of why choices were made.

## Decision

Treat the repository as the system of record:

- `docs/contracts/` defines interfaces and invariants; `contracts/` holds
  machine-readable schemas and fixtures.
- Code and tests are authoritative for actual behavior; docs/code divergence is
  a defect.
- `changelog.d/` records decisions and contract changes (ADR-like fragments),
  append-only once accepted.
- `AGENTS.md` is the entry point; `docs/index.md` routes by role; scoped
  `AGENTS.md` files define workstream ownership.
- Parallel work uses separate git worktrees and stable seams (C-001…C-009).
- Every material decision or contract change gets a decision entry; every
  contract has test obligations.

## Consequences

### Positive

- A know-nothing agent can bootstrap from the repo.
- Parallel work has explicit ownership and interfaces.
- Future maintainers can see why, not just what.
- Contract changes force consumer/test updates.

### Negative / risks

- Documentation overhead; docs can drift if not checked.
- Contracts can become stale if code changes land without updates.
- Parallel agents may collide on shared docs without discipline.

### Follow-ups

- Add a docs link checker (`tools/check_docs.py`) and JSON validation to the
  baseline checks.
- Keep contract test names mapped to IDs.
- Review `AGENTS.md`/`docs/index.md` when workstreams change.

## Contracts affected

- All (process), especially C-001…C-009.

## Verification

- `find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty` passes.
- Every contract has an index entry and test obligations.
- Every accepted decision has a complete entry.
