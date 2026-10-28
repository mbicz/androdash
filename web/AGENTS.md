# web/AGENTS.md — Web renderer (W2)

Read the root [`AGENTS.md`](../AGENTS.md), [`CONSTITUTION.md`](../CONSTITUTION.md),
then C-001…C-006, C-009, and
[`docs/architecture/renderer.md`](../docs/architecture/renderer.md).

## Scope

You own the renderer runtime and tests:

```
web/app/         # runtime assets served by the WebView
web/tests/       # Node tests
```

You do **not** own `app/`, root Gradle files, `tools/`, or contracts. If a
contract is wrong, propose a change with a `changelog.d` entry; don't silently
diverge.

## Current state

M1 is implemented. `web/app/` contains the runtime; `web/tests/contract/` holds
73 passing Node contract tests. M3 is adding production-shaped fixtures and
polish; the contracts remain the interface.

## Requirements

- Vanilla ES2022 modules, no bundler, no runtime dependencies, no CDN.
- Must run from the virtual `http://androdash.local` origin in the WebView and
  over HTTP in a browser.
- Parse config (C-001) from `location.search`; no Android-only APIs required.
- Fetch/normalize the Perses subset (C-002), resolve variables, filter panels
  (C-004), lay out rows/panels (C-005), schedule refreshes (C-006), and expose
  diagnostics (C-009).
- Never inject untrusted strings via `innerHTML`; escape Markdown/labels/errors.
- No fake data. Unsupported/unavailable → hide/placeholder + reason.
- Bound series/points/panels; no overlapping cycles.
- `window.AndroDash` is optional; degrade gracefully in browser dev.
- Keep `main.js` thin; pure logic modules exported for tests.
- Support the `standard`, `amoled`, and `monochrome` presentations from C-005;
  no remote fonts/images.

## Entry points

Expected boot URL for browser development:

```
http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/demo-dashboard.json&prometheus_url=http://localhost:9091&debug=true
```

Expected Android URL:

```
http://androdash.local/index.html?dashboard_url=…&prometheus_url=…&…
```

## Commands

Run these from the repository root:

```sh
python3 tools/mock_prometheus.py --port 9091
python3 tools/serve_demo.py --port 8099
node --test web/tests/
node --test web/tests/contract/
```

Until W3 lands the tools, use any static server and a Prometheus-compatible mock;
do not add a runtime dependency to compensate.

## Definition of done

- Demo shows 6 supported panels + 3 hidden with reasons.
- Refresh works; stopping the mock shows stale/error without blanking data.
- `node --test web/tests/` passes.
- Contract tests named `c001…c006`, `c009` cover implemented clauses (C-007/C-008
  are Android checks).
- No remote assets, no untrusted `innerHTML`, no secrets.
- C-002/C-003/C-004/C-005/C-006/C-009 updated if behavior changed.

## Don't

- Don't add npm packages, a bundler, TypeScript, or a framework.
- Don't render unsupported panels generically or fabricate data.
- Don't touch `app/` or `tools/` to make integration pass.
- Don't add undocumented URL params/error codes/capability IDs.
- Don't log full URLs/query strings.
