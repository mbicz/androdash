# tools/AGENTS.md — Demo tooling (W3)

Read the root [`AGENTS.md`](../AGENTS.md), C-003, and
[`docs/architecture/testing.md`](../docs/architecture/testing.md).

## Scope

You own deterministic local tooling:

```
tools/mock_prometheus.py
tools/serve_demo.py
tools/check_docs.py
```

You do **not** own the renderer (`web/app/`) or Android shell (`app/`). Tools
serve/observe them; they do not patch them.

## Current state

M1 is planned. Only this file exists; the scripts above will be added in M1.
`tools/check_docs.py` is planned for M0/M1 and should require no third-party
packages.

## Requirements

### `mock_prometheus.py`

- Python 3 standard library only.
- Default bind `127.0.0.1`; `--host 0.0.0.0` for physical-device testing.
- Default port `9091`; `--port`.
- CORS: `Access-Control-Allow-Origin: *`, allow `GET`/`OPTIONS`, no credentials.
- Endpoints:
  - `GET /api/v1/status/buildinfo` → success envelope, version
    `2.53.0-androdash-mock`.
  - `GET /api/v1/query` → deterministic vector/scalar for demo metrics.
  - `GET /api/v1/query_range` → matrix; use `start`, `end`, `step`.
  - `GET /api/v1/label/<name>/values` → e.g. `["demo"]` for `job`.
- Demo metrics (see `contracts/fixtures/demo-dashboard.json`):
  - `demo_cpu_seconds_total{mode="user"|"system"}` (rate query returns 2 series)
  - `demo_load1`, `demo_load5`
  - `demo_memory_used_percent` (~62%)
  - `demo_disk_used_percent` (~78%)
  - `demo_requests_total{code="200"|"500"}`
  - `up{job="demo"}`
- Deterministic for fixed `start`/`end`; plausible smooth curves for live demo.
- The mock is not a PromQL engine: recognize the demo queries/metric names and
  return documented shapes. Return a useful error for unknown queries.
- Options for failure testing: `--latency-ms`, `--fail-rate` (documented, seeded
  if random). Never enable failures by default.
- Do not require auth or network access beyond localhost.

### `serve_demo.py`

- Serve the repository root (so `/contracts/fixtures/...` and `/web/app/...`
  work).
- Correct MIME types for `.html`, `.js`, `.css`, `.json`, `.svg`.
- No directory listing by default; no cache headers for JSON/JS in dev.
- Bind localhost by default; `--host` for device testing.
- Standard library only.

### `check_docs.py`

- Check relative Markdown links under `docs/`, root `*.md`, scoped
  `AGENTS.md`, and `changelog.d/`.
- Ignore external `http(s)` links, anchors, and mailto.
- Report missing targets with file/line; exit non-zero on failure.
- Standard library only; deterministic.

## Commands

```sh
python3 tools/mock_prometheus.py --port 9091
python3 tools/serve_demo.py --port 8099
python3 tools/check_docs.py
curl -s http://localhost:9091/api/v1/status/buildinfo | jq
```

## Definition of done

- Scripts run with Python 3.10+ and no `pip install`.
- Mock responses match the C-003 envelope shapes and demo fixture needs.
- CORS works from the virtual `http://androdash.local` origin (and `*` covers
  browser dev too).
- Fixed-time queries produce stable output.
- `check_docs.py` passes on the current tree and fails on a deliberately broken
  link (test it).
- No secrets, no external services.

## Don't

- Don't add Flask/FastAPI/requests or any third-party dependency for v1.
- Don't make the mock a production requirement.
- Don't hardcode private hosts or credentials.
- Don't edit renderer code to fit the mock; fix the mock/contract.
