# Decision log and change fragments (`changelog.d`)

This directory is the **system of record for why** AndroDash looks the way it
does. It is not a conventional release-only changelog.

Every material decision, contract change, or constitution amendment gets one
entry. A future agent should be able to read `changelog.d/` and understand which
choices are deliberate, which are provisional, and what superseded what.

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
