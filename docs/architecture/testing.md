# Testing architecture

**Status:** test plan for M1/M2; no test code exists yet.
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
web/tests/contract/c003-prometheus.test.js
web/tests/contract/c004-capabilities.test.js
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

**C-005 panels**
- demo dashboard renders/ hides the expected panel IDs;
- TimeSeriesChart series/legend/limit;
- Stat/Gauge calculations and thresholds;
- Table rows and limit;
- Markdown escaping (no HTML/JS);
- formatting units;
- DOM state attributes;
- responsive ordering (stack/grid).

**C-006 refresh**
- precedence: param > dashboard > default;
- `0` disables auto refresh;
- no overlapping cycles;
- visibility pause/resume;
- shared time window per cycle;
- keep-last-good on error;
- dashboard not re-fetched per tick;
- manual refresh coalescing.

**C-009 diagnostics**
- required fields and error codes;
- redaction of userinfo/query strings;
- bounded request/error arrays;
- hidden reasons included.

### Fixtures

Use only `contracts/fixtures/`:

- `demo-dashboard.json` — 9 panels, 6 eligible, 3 hidden (Tempo, Loki, unknown).
- `prometheus/*.json` — deterministic API responses.
- `app-config.example.json` — canonical object.
- `diagnostics.example.json` — snapshot shape.

Tests must not depend on fixture ordering unless the contract defines it. Sort
before asserting where order is not contractual.

## 5. Android unit tests

`app/src/test/java/dev/androdash/`:

- `ConfigParserTest` — Intent extras, defaults, invalid schemes, integer/duration
  bounds, persistence precedence.
- `LaunchUrlTest` — percent encoding, parameter names, round-trip with the
  renderer parser (shared expectations in the contract doc).

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
- status line shows a successful update and a next refresh;
- waiting one interval updates values without a full page reload;
- stopping the mock marks panels stale/error while keeping last data;
- restarting the mock recovers on the next cycle.

### Emulator (M2)

Prerequisites: SDK 35, emulator running, `adb` available.

```sh
./gradlew :app:installDebug
adb shell am start -n dev.androdash/.MainActivity \
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
