# Testing architecture

**Status:** implemented for M1/M2; extend the existing suites as behavior grows.
**Workstreams:** W2 (renderer), W3 (tooling), W1 (shell).
**Contracts:** all. Test names encode contract IDs.

## 1. Principles

- Deterministic: no live Prometheus, no public internet, no wall-clock-dependent
  assertions. Inject clocks/timestamps.
- Contract-first: each contract has at least one test that fails if the contract
  is violated.
- Cheap by default: Node's built-in test runner for renderer logic, JUnit for
  the Kotlin config parser, a tiny Python mock for integration.
- Demo is the integration test: the fixture dashboard plus mock Prometheus must
  render the expected visible/hidden panels in a browser and on the emulator.
- No test may require a secret or a real LAN address.

## 2. Test layers

| Layer | Tool | Scope | Command |
|---|---|---|---|
| Docs/contracts | `jq`, link checker | JSON validity, local links | see §3 |
| Mock/tooling | Python `unittest` | fixture-query coverage, absence semantics, unknown queries | `python3 -m unittest discover -s tools -p 'test_*.py' -v` |
| Renderer unit | `node --test` | parsing, normalization, filtering, HTTP URL building, calculations, formatting, Markdown escaping | `node --test web/tests/` |
| Renderer contract | `node --test` | one file per contract C-001…C-006, C-009 | `node --test web/tests/contract/` |
| Renderer integration | browser + mock | load demo, assert DOM states/counts | manual + (later) headless |
| Android unit | JUnit | Intent parsing, URL building, validation | `./gradlew :app:testDebugUnitTest` |
| Android integration | emulator + mock | install, launch, render, refresh, kiosk | manual/adb script |
| Soak | emulator | 30 min refresh, memory/DOM stability | manual |

No Playwright/Selenium dependency is required for v1. If a headless browser is
added, it must be a dev-only tool and recorded in `changelog.d`.

## 3. Baseline checks (available now)

```sh
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
python3 tools/check_docs.py
```

`tools/check_docs.py` checks relative Markdown links and reports missing targets.
It does not require network access.

## 4. Renderer unit and contract tests

### Naming

```
web/tests/contract/c001-config.test.js
web/tests/contract/c002-dashboard.test.js
web/tests/contract/c002-stored.test.js
web/tests/contract/c003-prometheus.test.js
web/tests/contract/c004-capabilities.test.js
web/tests/contract/c005-fit.test.js
web/tests/contract/c005-layout.test.js
web/tests/contract/c005-panels.test.js
web/tests/contract/c006-refresh.test.js
web/tests/contract/c009-diagnostics.test.js
```

### Required cases (minimum)

**C-001 config**
- defaults and canonical object shape against
  `contracts/app-config.schema.json`;
- required `dashboard_url`;
- rejection of `javascript:`, `file:`, relative URLs, userinfo;
- integer/duration/enum validation;
- capabilities parsing and normalization;
- URL round-trip (query param → config).

**C-002 dashboard**
- accept a single Dashboard and an EphemeralDashboard;
- array selection with/without `dashboard_name`;
- normalize object and array datasources;
- resolve `$ref` items and inline panels;
- reject missing/invalid spec, panels, layouts;
- duration parsing (`5m`, `1h30m`, `0s` refresh);
- limits (size/panel/item counts);
- variable defaults and interpolation (`$job`, `${job}`, `$$`);
- title interpolation into dashboard/row/panel titles with fallback;
- unknown layout/panel handling.

**C-003 Prometheus**
- URL construction for query, query_range, label values;
- matrix/vector/scalar normalization;
- null/gap handling for NaN/Inf;
- HTTP/error/network mapping;
- step formula and range edges;
- datasource resolution precedence;
- redaction.

**C-004 capabilities**
- probe success/failure;
- advertised override;
- eligibility matrix: supported/unsupported panel, query, datasource, missing
  capability, no queries;
- hidden reasons and counts;
- `show_unsupported` placeholders.

**C-005 panels and layout**
- demo dashboard renders/ hides the expected panel IDs;
- TimeSeriesChart series/legend/limit; series colour by position; x axis on
  the cycle window with round time ticks;
- `niceTicks`/`timeTicks` round values, 1024-step bytes, wall-clock alignment;
- Stat/Gauge calculations and thresholds; state word only on crossing; meter
  only with thresholds;
- Table rows and limit; a shared single label key becomes the heading; fit
  tables show the rows their box holds plus `+N more`;
- Markdown escaping (no HTML/JS);
- formatting units;
- DOM state attributes;
- bands, strips with page dots, and row folding (`c005-layout.test.js`);
- responsive ordering (stack/grid);
- fit planner (`c005-fit.test.js`): every panel on one phone screen in reading
  order, one full-width column when it fits, no panel below its minimum width,
  type shrinks to the 0.72 floor then overflow is reported, charts take the
  growth while tables stop at their rows, cell grids follow the box shape.

**C-006 refresh**
- precedence: param > dashboard > default;
- `0` disables auto refresh;
- no overlapping cycles;
- visibility pause/resume;
- shared time window per cycle;
- keep-last-good on error;
- dashboard not re-fetched per tick;
- manual refresh coalescing;
- runtime interval change reschedules; `0` switches to manual.

**C-009 diagnostics**
- required fields and error codes;
- redaction of userinfo/query strings;
- bounded request/error arrays;
- hidden reasons included.

### Fixtures

Use only `contracts/fixtures/`:

- `demo-dashboard.json` — 9 panels, 6 eligible, 3 hidden (Tempo, Loki, unknown).
- `spark-dashboard.json` — 15 Spark Exporter panels, all eligible with
  Prometheus. `tools/test_mock_prometheus.py` requires the mock to answer every
  query; C-002/C-004 assert the panel, row, and query counts.
- `prometheus/*.json` — deterministic API responses.
- `app-config.example.json` — canonical object.
- `diagnostics.example.json` — snapshot shape.

Tests must not depend on fixture ordering unless the contract defines it. Sort
before asserting where order is not contractual.

## 5. Android unit tests

`app/src/test/java/com/mbicz/androdash/`:

- `ConfigParserTest` — Intent extras, defaults, invalid schemes, integer/duration
  bounds, persistence precedence (including the separately persisted
  `show_when_locked`), capability limits, `display_mode` validation,
  `layout_mode=fit`, `lock_style` defaults/round-trip (missing → `monochrome`),
  `show_when_locked` gating, and `setOption` validation (each allowed name
  applied; invalid values and unknown names rejected). Launch-URL encoding is
  covered here too (the planned standalone `LaunchUrlTest` was folded in). The
  JVM tests use a test-scope `org.json:json` because android.jar's `org.json`
  is a stub there.
- `LockRelightPolicyTest` — the lock-screen re-light state machine (C-007):
  first power press re-lights, a second press (even before the re-light lands)
  stays off, manual wake returns to locked-lit, a late screen-on counts as a
  wake, unlock resets, and no re-light when another app is in the foreground
  or the keyguard is not engaged.
- `CollectorConfigTest` — the on-phone collector (decision 0019):
  `collector_targets` grammar and limits (DNS/IPv4/bracketed IPv6 hosts,
  ports, names, 32 entries, duplicates), canonical form, deterministic
  `prometheus.yml`, loopback-only Prometheus arguments, retention durations.
  `ConfigParserTest` covers the `collector*` extras, persistence, and the
  `prometheus_url` substitution.
- `RestartPolicyTest` — collector backoff 1, 2, 4, … 60 s and the 10 min
  healthy reset.
- `CollectorStatusTest` — `collectorStatus()` JSON shape and the 4 KiB bound.

`DashboardStoreTest` and `AssetServerRouteTest` cover the stored dashboard and
the virtual-origin routes.

Use plain JUnit 4 (no AndroidX test runner) for pure Kotlin classes. Activity,
WebView, and kiosk behavior are verified manually on the emulator for v1.

## 6. Demo and emulator acceptance

### Browser harness (M1)

```sh
python3 tools/mock_prometheus.py --port 9091
python3 tools/serve_demo.py --port 8099
# open:
# http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/demo-dashboard.json&prometheus_url=http://localhost:9091&debug=true
```

Expected:

- header shows `AndroDash Demo`;
- 6 panels visible: CPU, load, RAM stat, disk gauge, requests table, notes;
- 3 panels hidden: Tempo traces, Loki logs, unknown chart;
- debug overlay lists hidden reasons;
- the header status shows the last successful update time with a green dot
  (no countdown); panel headers show no `Live` badge;
- waiting one interval updates values without a full page reload;
- stopping the mock marks panels stale/error while keeping last data;
- restarting the mock recovers on the next cycle.

### Spark Exporter demo

Use the same servers and open:

```text
http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/spark-dashboard.json&prometheus_url=http://localhost:9091&debug=true
```

Expected: 14 panels in 5 rows; `gpu` and `engine` variables resolve from label
values; units render as `°C`, `W`, `%`, `tok/s`, `ms`, `Gb/s`, and `GHz`;
stopping the mock leaves last-good data with `Stale` badges and an amber
`Stale since …` header status. See
[`integrations/spark-exporter.md`](../integrations/spark-exporter.md) for the
query semantics.

### Emulator (M2)

Prerequisites: SDK 35, emulator running, `adb` available.

```sh
./gradlew :app:installDebug
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_url "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json" \
  --es prometheus_url "http://10.0.2.2:9091" \
  --ez debug true

adb logcat -s AndroDash
adb exec-out screencap -p > /tmp/androdash-demo.png
```

Expected: same visible/hidden panels; fullscreen; no browser chrome; refresh
continues; Back does not exit in kiosk mode; persisted config restores on
relaunch.

`10.0.2.2` is the emulator's host loopback. A physical phone uses the host LAN
IP and the same ports, with the host firewall allowing them.

### Negative checks

- Dashboard URL 404 → fatal `E_DASHBOARD_FETCH`, no blank screen.
- Dashboard source without CORS → `E_DASHBOARD_FETCH` with an origin/CORS hint.
- Prometheus stopped → hidden/data panels show stale/error; Markdown remains.
- Unsupported panel → hidden and counted; with `show_unsupported=true` →
  placeholder.
- Invalid `dashboard_url=javascript:...` → native `E_CONFIG`, no WebView.
- Emulator offline → error states, no crash; recovery on reconnect.

## 7. Performance/soak checks (v1 targets, soft)

- First paint with demo: < 2 s on the emulator.
- Refresh of 6 eligible panels with mock: < 1 s typical.
- 30-minute soak at 10 s refresh: no unbounded DOM growth, no timer pile-up, no
  memory trend that suggests a leak.
- Diagnostics request/error arrays capped.
- Series/point caps enforced.

Record observed numbers in the M1/M2 handoff; do not turn soft targets into
flaky CI thresholds without a decision.

## 8. Evidence and handoff

A test report must include:

- commands run;
- pass/fail counts;
- fixture used;
- screenshot path for UI checks (no private data);
- known gaps (e.g., "C-005 gauge thresholds are visual-only, no pixel test");
- links to updated contracts/decisions.

Do not write "works on emulator" without the command and the observed result.
