# docs/AGENTS.md — Contracts and documentation (W4)

Read the root [`AGENTS.md`](../AGENTS.md), [`CONSTITUTION.md`](../CONSTITUTION.md),
[`docs/index.md`](index.md), and
[`changelog.d/README.md`](../changelog.d/README.md).

## Scope

You own the narrative and interface documentation:

```
docs/
contracts/
changelog.d/
README.md
AGENTS.md
CONSTITUTION.md
```

You do **not** own `app/`, `web/`, or `tools/` code. If behavior needs to change,
write the contract/decision first; the owning workstream implements it.

## Documentation rules

- Docs are source of truth for intent, not for actual behavior. Code + tests win
  for behavior; fix divergence rather than papering over it.
- Mark planned behavior as **planned**. Do not claim an APK, server, or command
  works before it does.
- Use relative links; run `python3 tools/check_docs.py` when available.
- One contract per file, stable ID, explicit version, machine-readable artifacts
  and test obligations.
- Keep machine-readable schemas/fixtures in sync with prose.
- Update `docs/index.md` and `docs/contracts/README.md` when adding/removing docs.
- Do not duplicate code-level details across documents; link.
- Every material decision/contract change gets a `changelog.d` entry.
- Accepted decision entries are append-only; supersede, don't rewrite.
- No secrets, private hosts, personal data, or generated build artifacts.

## Contract change checklist

1. Add `changelog.d/NNNN-<slug>.md` (`kind: contract` or `decision`).
2. Update the contract doc + schema/fixture + index table.
3. Notify/coordinate with every consumer (W1/W2/W3).
4. Add/update the contract test named `c00X-...`.
5. If breaking: bump version, document migration.
6. Run JSON/link checks.

## Current state

M0–M2 are complete; M3 is current. Docs describe implemented behavior plus
explicit M3 gaps. The Spark Exporter integration, AMOLED/monochrome modes, and
lock-screen behavior are documented and tested.

## Commands

```sh
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
python3 tools/check_docs.py
find docs contracts changelog.d -type f | sort
```

## Definition of done

- Local links resolve; JSON parses.
- No contradiction with `CONSTITUTION.md` or implemented code.
- Every new interface/error/capability is in a contract and a fixture/test plan.
- Decision entry exists for intent changes.
- `docs/index.md` routes the new material.

## Don't

- Don't edit code to make a doc claim true without the owning workstream.
- Don't invent unsupported Perses features or hidden capabilities.
- Don't delete accepted decision entries.
- Don't add absolute local paths or private URLs.
