# Machine-readable contracts and fixtures

This directory holds the artifacts that make contracts testable:

```
contracts/
├── app-config.schema.json       # canonical AppConfig object (C-001)
├── diagnostics.schema.json      # diagnostics snapshot (C-009)
└── fixtures/
    ├── app-config.example.json
    ├── demo-dashboard.json      # 9 panels: 6 eligible, 3 hidden
    ├── diagnostics.example.json
    └── prometheus/
        ├── buildinfo.json
        ├── label-values-job.json
        ├── query-error.json
        ├── query-range-cpu.json
        ├── query-range-load.json
        ├── query-ram.json
        └── query-requests.json
```

## Rules

- **Fixtures are normative.** Tests load these files; do not duplicate their
  contents inline in tests.
- **No secrets.** Use synthetic metrics, hosts, names, and values. The demo uses
  `localhost`/`10.0.2.2` only.
- **Determinism.** Fixed timestamps and values. Renderer tests inject the clock;
  mock integration may use relative time.
- **Bounds.** Keep the demo small enough to read. Contract limits still apply.
- **Schema changes** need a `changelog.d` entry and a version bump if breaking.
- **JSON formatting:** 2 spaces, UTF-8, no comments, trailing newline.

## Validation

```sh
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
```

Schema validation (when `jsonschema` is available):

```sh
python3 - <<'PY'
import json, jsonschema
schema = json.load(open('contracts/app-config.schema.json'))
data = json.load(open('contracts/fixtures/app-config.example.json'))
jsonschema.validate(data, schema)
print('app-config example: valid')
PY
```

Do not make `jsonschema` a runtime dependency. If it is unavailable, the
renderer/unit tests must still validate the same invariants programmatically.

## Fixture expectations

`demo-dashboard.json` is the shared integration target:

| Panel | Kind | Expected |
|---|---|---|
| `cpu` | TimeSeriesChart | visible, 2 series |
| `load` | TimeSeriesChart | visible, 2 series |
| `ram` | StatChart | visible |
| `disk` | GaugeChart | visible |
| `requests` | Table | visible |
| `notes` | Markdown | visible, sanitized |
| `traces` | TraceTable | hidden (`unsupported_query`: Tempo) |
| `logs` | LogsTable | hidden (`unsupported_query`: Loki) |
| `unknown` | FancyChart | hidden (`unsupported_panel`) |

`prometheus/*.json` are valid Prometheus API envelopes. The mock server should
produce equivalent shapes; the renderer normalizes both.

## Adding a fixture

1. Add the file under `fixtures/` with a descriptive name.
2. Reference it from the relevant contract doc and test.
3. Keep it small and deterministic.
4. Update `docs/contracts/README.md`/this README if the inventory changes.
5. Add a `changelog.d` entry only if it changes a contract, not for a new test
   fixture that matches an existing contract.
