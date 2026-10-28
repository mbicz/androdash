# AGENTS.md — start here

You are working on **AndroDash**, an Android kiosk dashboard that renders a
documented subset of [Perses](https://perses.dev/) dashboards in a WebView and
queries Prometheus directly from the phone.

This file is the entry point for every human and agent. It tells you what to
read, where you may work, how to verify, and how to leave the repository in a
state that the next stranger can use.

**Current milestone: M3 — hardening, real phone, and production-shaped data.**
M0, M1, and M2 are complete; the debug APK exists and the emulator demo is
verified. See `docs/roadmap.md` for the exact next tasks.

---

## 1. Read in this order

1. `CONSTITUTION.md` — non-negotiable principles.
2. `docs/index.md` — the documentation map.
3. `docs/architecture/overview.md` — components and data flow.
4. The contract(s) for your workstream (table below).
5. Your scoped `AGENTS.md`.
6. `docs/roadmap.md` — what is actually being built now.

Do not read the whole repository to start. The contracts and scoped guides are
designed to be enough for a know-nothing agent to make a correct change.

---

## 2. What exists (and what does not)

| Path | State | Purpose |
|---|---|---|
| `CONSTITUTION.md` | present | Project principles |
| `AGENTS.md` | present | This entry point |
| `docs/` | present | Architecture, contracts, development, roadmap |
| `contracts/` | present | Machine-readable schemas and fixtures |
| `changelog.d/` | present | Decision log and change fragments |
| `app/` | implemented (M2) | Android Kotlin shell, config parser, WebView security, kiosk/lock-screen |
| `web/` | implemented (M1) | Vanilla ES-module renderer plus contract tests |
| `tools/` | implemented | Docs checker, mock Prometheus, static demo server, mock tests |

Commands in `docs/development.md` are real unless explicitly marked **planned**.
Do not claim a command works without running it.

---

## 3. Source-of-truth hierarchy

1. **Executable behavior:** code and tests.
2. **Intended interfaces and invariants:** `docs/contracts/` and `contracts/`.
3. **Why:** accepted entries in `changelog.d/`.
4. **Narrative:** `docs/architecture/`, `README.md`, and this file.

If 1 and 2 disagree, stop and fix it. A mismatch is a defect, not a documentation
task. Never "fix" a doc to match a bug without deciding which behavior is right.

---

## 4. Workstreams and ownership

Parallel agents SHOULD work in separate git worktrees and MUST stay inside their
owned paths.

| ID | Workstream | Owns | Reads | Must not edit |
|---|---|---|---|---|
| W1 | Android shell | `app/`, root Gradle files, `gradle/` | C-001, C-007, C-008; `docs/architecture/android-shell.md` | `web/` runtime code, renderer contracts |
| W2 | Web renderer | `web/` | C-002–C-006, C-009; `docs/architecture/renderer.md` | `app/`, tools |
| W3 | Demo tooling | `tools/` | C-003; `docs/architecture/testing.md` | app, renderer |
| W4 | Contracts & docs | `docs/`, `contracts/`, `changelog.d/`, root Markdown | all | code unless explicitly asked |

Shared, coordination-required surfaces:

- `contracts/` and `docs/contracts/` — contract changes need a decision entry.
- `docs/roadmap.md` — update status only when a milestone or task state changes.
- Root Gradle files — W1 owns; W2/W3 consume.
- `web/app` — the Android build copies it as assets. W1 does not modify it; W2
  does not assume Android exists.

Integration seams are contracts, not conversations. If you need a new seam,
write it down first.

---

## 5. Contract-first workflow

Every workstream change follows this loop:

1. **Read** the relevant contract and its machine-readable fixtures.
2. **Decide** whether the change alters an interface. If yes:
   - Add `changelog.d/NNNN-<slug>.md` with `kind: contract` or `kind: decision`.
   - Update the contract document, schema/fixture, and every consumer.
   - Bump the contract or `schemaVersion` if the change is breaking.
3. **Implement** the smallest change that satisfies the contract.
4. **Test** the behavior, including error paths and limits.
5. **Verify** with the commands in section 7.
6. **Record** decisions and update status only when justified.
7. **Hand off** with exact commands and evidence.

Do not add an undocumented query parameter, error code, capability ID, panel
kind, or diagnostic field. Those are contracts.

### Contract IDs

| ID | Contract | Primary consumers |
|---|---|---|
| C-001 | Launch configuration | W1, W2 |
| C-002 | Dashboard source and normalization | W2 |
| C-003 | Prometheus access | W2, W3 |
| C-004 | Capability negotiation and filtering | W2 |
| C-005 | Panel rendering | W2 |
| C-006 | Refresh and time semantics | W2 |
| C-007 | Kiosk and lifecycle | W1 |
| C-008 | WebView security | W1, W2 |
| C-009 | Diagnostics and errors | W1, W2 |

---

## 6. Commands

### Available now

```sh
# Validate every JSON contract/fixture
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty

# Check local Markdown links (no dependencies)
python3 tools/check_docs.py

# Renderer unit/contract tests
mise exec -- node --test web/tests/

# Mock/tooling tests
python3 -m unittest discover -s tools -p 'test_*.py' -v

# Browser demo
python3 tools/mock_prometheus.py --port 9091
python3 tools/serve_demo.py --port 8099

# Android
mise exec -- ./gradlew :app:testDebugUnitTest
mise exec -- ./gradlew :app:assembleDebug
mise exec -- ./gradlew :app:installDebug
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_url "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json" \
  --es prometheus_url "http://10.0.2.2:9091" \
  --ez debug true
```

Canonical command details, host-loopback mapping, and emulator setup live in
`docs/development.md`.

---

## 7. Definition of done

A change is done only when all applicable items are true:

- [ ] It implements the contract, or the contract was deliberately changed.
- [ ] Pure logic has automated tests; UI behavior has a documented manual check.
- [ ] Error paths and limits are covered.
- [ ] `find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty` passes.
- [ ] The demo (`contracts/fixtures/demo-dashboard.json` or the Spark fixture)
      plus mock Prometheus still renders, or the reason it cannot is stated.
- [ ] `docs/` and `docs/contracts/` are not contradicted.
- [ ] A `changelog.d` entry exists for every decision or contract change.
- [ ] No secrets, real credentials, or private URLs are committed.
- [ ] The handoff names the commands run and the observed result.

Docs-only changes do not need code tests, but they do need valid links, valid
JSON, and a decision entry if they change intent.

---

## 8. Hard rules

- **Do not** move rendering into a server. The phone renders.
- **Do not** add remote scripts, styles, fonts, or runtime dependencies.
- **Do not** add a web build step without a decision entry. The v1 renderer is
  plain ES modules.
- **Do not** fake data or silently substitute a panel. Hide it and report why.
- **Do not** put dashboard/panel logic in Kotlin. The shell configures a WebView;
  the renderer explains itself.
- **Do not** add unsupported Perses features to the "supported" list in docs.
  Update C-002/C-005 and the capability registry together.
- **Do not** edit another workstream's files to make your check pass. Fix the
  contract or coordinate.
- **Do not** log full URLs with credentials, tokens, or query strings.
- **Do not** enable WebView debugging or cleartext in release without the
  documented decision.
- **Do not** commit generated build outputs, local SDK paths, or screenshots with
  private data.

---

## 9. Decision log

`changelog.d/` is the system of record for **why** the project looks like this.
It is not just a release changelog.

- One entry per material decision, contract change, or constitution amendment.
- Use `changelog.d/TEMPLATE.md`.
- Accepted entries are append-only history; supersede rather than rewrite.
- If you are about to make a choice that a future agent could reasonably undo,
  record it.

Read `changelog.d/README.md` for the exact format and status lifecycle.

---

## 10. Bootstrap checklist for a new agent

Copy this into your plan and check items off:

1. Read `AGENTS.md` (this file), `CONSTITUTION.md`, and `docs/index.md`.
2. Pick your workstream and read its scoped `AGENTS.md`.
3. Read the relevant contract(s) and open the linked fixtures.
4. Read `docs/roadmap.md` to confirm the task is in the current milestone.
5. Run the "available now" verification commands to confirm the baseline.
6. Make one small change; add or update tests.
7. Run the full verification for your workstream.
8. Add/update a `changelog.d` entry if you changed a decision or contract.
9. Report: files changed, commands run, results, remaining risks.

If any step is impossible using only this repository, fix the repository
(usually `AGENTS.md` or `docs/`) as part of your change.

---

## 11. Current milestone and next actions

- **M0 (complete):** constitution, contracts, architecture, decision log,
  fixtures, scoped guides.
- **M1 (complete):** web renderer, mock Prometheus, static demo server, browser
  demo, 80 renderer tests.
- **M2 (complete):** Android shell, emulator demo, kiosk/lock-screen modes,
   config tests, lint/build/install.
- **M3 (current):** soak test, physical AMOLED phone, accessibility, reconnect
  behavior. The Spark Exporter dashboard, real metric units, fit layout, and
  on-device dashboards (bundled + stored copy) are complete.

Start M3 work from `docs/roadmap.md`; keep the Spark integration honest when
adding metrics. Do not add unsupported capabilities or fake missing samples.
