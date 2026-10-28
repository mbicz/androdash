# Roadmap and workstreams

**Last updated:** 2026-10-26
**Current milestone:** M3 — hardening, real phone, and production-shaped data
(M0, M1, and M2 complete).
**Rule:** do not start a later milestone's code before its dependencies have
contract tests. M1 and M2 may overlap only on the shell skeleton.

## Milestones

### M0 — Foundation (complete, 2026-10-26)

- [x] Constitution, source-of-truth hierarchy, agent entry point.
- [x] Contracts C-001 … C-009.
- [x] Machine-readable app config and diagnostics schemas.
- [x] Demo dashboard fixture and Prometheus fixtures.
- [x] Architecture, security, testing, development docs.
- [x] Decision log entries 0001 … 0009.
- [x] Scoped agent guides.
- [x] `tools/check_docs.py` local-link checker.

**Acceptance evidence:** JSON fixtures parse; local doc links resolve; all
contract docs exist; no renderer/Android code is claimed to work.

### M1 — Renderer core + browser demo (complete, 2026-10-26)

Goal: open the demo in a browser, see 6 supported panels with data and 3 hidden
panels with reasons, refresh every 10 s, and pass contract tests.

Ordered tasks:

| ID | Task | Owner | Depends on | Done when |
|---|---|---|---|---|
| M1-1 | `tools/mock_prometheus.py`: deterministic buildinfo/query/query_range/label values + CORS | W3 | C-003 | curl fixtures match; demo metrics work |
| M1-2 | `tools/serve_demo.py`: repo-root static server, correct MIME, CORS `*`, no cache | W3 | — | browser loads web app + fixture; cross-origin dashboard fetch works |
| M1-3 | `web/app` skeleton: index.html, CSS, boot, error card, config parser | W2 | M1-2, C-001 | bad config shows `E_CONFIG` |
| M1-4 | Dashboard fetch/normalize/duration/variables | W2 | C-002 | demo model has 9 panels, 4 rows, 6 eligible |
| M1-5 | Capability probe + eligibility filter | W2 | C-003, C-004 | 3 hidden with exact reasons |
| M1-6 | Layout (grid/stack), rows, panel DOM hooks | W2 | C-005 | portrait stack + desktop grid |
| M1-7 | TimeSeriesChart + SVG helpers + formatting | W2 | M1-4, M1-5 | CPU/load charts render |
| M1-8 | StatChart, GaugeChart, Table, Markdown | W2 | C-005 | demo panels render; Markdown escaped |
| M1-9 | Scheduler + status/diagnostics + debug overlay | W2 | C-006, C-009 | refresh, stale, hidden reasons visible |
| M1-10 | Renderer unit/contract tests | W2/W4 | all above | `node --test web/tests/` passes |

**M1 acceptance:**

- Browser demo against the mock shows: header, 6 visible panels, 3 hidden,
  status line, refresh, debug overlay.
- Stop the mock → stale/error with last data; restart → recovery.
- `node --test web/tests/` passes.
- `contracts/fixtures/demo-dashboard.json` is the minimal smoke dashboard;
  production-shaped fixtures are added in M3.
- No runtime dependencies, no remote assets.
- Contract tests named `c001…c006`, `c009` exist for implemented clauses.

**M1 evidence:** 53 Node tests pass; the browser demo renders 6 panels, hides 3
with exact reasons, refreshes, and recovers after a mock outage. The static
server and mock are implemented in `tools/`.

### M2 — Android shell + emulator demo (complete, 2026-10-26)

Goal: APK installs and renders the same demo on the emulator/phone in kiosk mode.

| ID | Task | Owner | Depends on | Done when |
|---|---|---|---|---|
| M2-1 | Gradle wrapper + `:app` module + manifest/theme | W1 | M1-3 | `assembleDebug` produces APK |
| M2-2 | `AppConfig`/`ConfigParser` + unit tests | W1 | C-001 | Intent → URL matches web parser |
| M2-3 | WebView factory + security settings + navigation blocking | W1 | C-008 | local page loads; no navigation |
| M2-4 | Kiosk controller (immersive, keep awake, back) | W1 | C-007 | demo fullscreen; back no-op |
| M2-5 | Bridge (`platform`, `exitKiosk`, `reload`, `log`) | W1 | C-007/C-008 | debug overlay can exit/reload |
| M2-6 | Persisted config + relaunch behavior | W1 | C-001 | launcher restores demo |
| M2-7 | Fatal screen for invalid config/local asset | W1 | C-009 | `E_CONFIG` visible, no blank WebView |
| M2-8 | Map `web/app` as assets; package smoke test | W1 | M1-3 | runtime assets present, no tests |
| M2-9 | Emulator E2E: install, launch, refresh, screenshot | W1/W4 | all | evidence in handoff |

**M2 acceptance:**

- `./gradlew :app:assembleDebug` and `:app:installDebug` pass.
- Demo launches from `adb` with `10.0.2.2` URLs.
- 6 panels render, 3 hidden, refresh works.
- Kiosk true: immersive, back no-op, screen awake; kiosk false: back exits.
- `display_mode` applies `standard`, `amoled`, and `monochrome`; monochrome is
  true black with no gradients, shadows, blur, or non-essential animation.
- `show_when_locked` is applied only with `kiosk=true`, marks the activity as
  the turn-screen-on activity, and is cleared by a relaunch without the extra.
- Invalid config shows `E_CONFIG`; no uncaught crash in logcat.
- Persisted config restores after force-stop/relaunch.
- No secrets in logs; WebView debugging off in release.

**M2 evidence:** debug APK builds and installs on `emulator-5554`; the demo and
Spark dashboards render, refresh, hide unsupported panels, retain last-good data
during a Prometheus outage, and apply display/lock-screen modes. Screenshots live
in the local `screenshots/` evidence directory (git-ignored). `ConfigParserTest`
passes; `:app:lintDebug` is part of the verification pass.

### M3 — Hardening, real phone, and production-shaped data (current)

- [x] Spark Exporter dashboard fixture (`spark-dashboard.json`), deterministic
  mock coverage, physical units (`W`, `°C`, `Hz`, `Gb/s`, `tok/s`), query
  cookbook, and tests.
- [x] Phone-space pass: exact CSS-pixel SVG geometry (axis text was rendering at
  4.45 px), compact chrome, content-sized stat panels, grouped same-unit metrics
  (decision 0014). Spark fixture page height 4234 → 2834 px at 393×851.
- [ ] Soak test (30+ min), memory/DOM bounds, reconnect behavior.
- [ ] Physical-phone test on AMOLED hardware with the real Spark host.
- [ ] Device-owner/lock-task provisioning notes (optional).
- [ ] Orientation/theme/layout refinements from phone feedback.
- [ ] Accessibility pass (contrast, text size, chart summaries).
- [x] On-device dashboards: bundled in the APK and a stored copy of a remote
  dashboard; live fetch is an option (decision 0018).
- [ ] On-phone Prometheus collector (decision 0019): shell, packaging, and
  contracts implemented with unit tests; on-device acceptance (C-007 item 12)
  and soak pending.

### M4 — Capability-driven generation + auth

- Publish the capability document for external generators.
- Optional HTTPS/basic auth for Prometheus (new contract).
- Multiple dashboards/rotation/playlists if still desired.
- Additional datasource kinds (Tempo/Loki/OTel) only with real renderers.

## Workstreams and parallelization

| Workstream | Can start | Needs | Produces |
|---|---|---|---|
| W1 Android shell | M3 hardening and physical-device feedback | device, SDK 35, M1 assets path | shell fixes, kiosk/lock-screen behavior |
| W2 Web renderer | M3 now | contracts, fixtures, mock for integration | renderer fixes, new units/panels within C-005 |
| W3 Demo tooling | M3 now | C-003 fixture expectations | mock coverage, static serving, deterministic tests |
| W4 Contracts/docs | now, ongoing | changes from W1–W3 | docs, schemas, decisions, link checks |

Parallel rules:

- Worktrees per workstream; no shared working tree.
- W2 does not edit `app/` or root Gradle; W1 does not edit `web/app`.
- W3 serves `web/app` read-only; it does not patch the renderer.
- Contract changes go through W4 + a decision entry, then all consumers.
- Integration happens at M1 acceptance (browser) and M2 acceptance (emulator).

## Definition of "current task"

A task is current only if it appears in the current milestone table with an
unchecked box and its dependencies are done. If you are unsure, ask in the
handoff or update this document with a decision entry; do not invent a parallel
roadmap.

## Explicitly deferred

- Full Perses UI parity.
- Dashboard editing/authoring in the app.
- Server-side rendering/proxy.
- Native chart widgets/Compose.
- Alerting/annotations.
- Grafana import.
- Multi-user/auth.
- App store distribution/release signing automation.
