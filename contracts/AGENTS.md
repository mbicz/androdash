# contracts/AGENTS.md — Machine-readable contracts (W4)

Read the root [`AGENTS.md`](../AGENTS.md),
[`docs/contracts/README.md`](../docs/contracts/README.md), and
[`contracts/README.md`](README.md).

## Scope

You own JSON Schemas and fixtures here. You do not own runtime code. If a schema
change is needed, the contract doc and every consumer change too.

## Rules

- Fixtures are normative; tests load them instead of duplicating shapes.
- No secrets, private hosts, or real data. Use synthetic `demo` values.
- Deterministic values and timestamps.
- 2-space JSON, UTF-8, trailing newline, no comments.
- Keep files small and readable; enforce documented limits.
- Update the inventory in `README.md` when adding/removing files.
- Every contract-affecting change gets a `changelog.d` entry and version bump if
  breaking.

## File map

- `app-config.schema.json` — canonical AppConfig (C-001).
- `diagnostics.schema.json` — diagnostics snapshot (C-009).
- `fixtures/app-config.example.json` — valid example for tests.
- `fixtures/diagnostics.example.json` — valid snapshot for tests.
- `fixtures/demo-dashboard.json` — shared Perses subset demo (9 panels, 6
  eligible, 3 hidden).
- `fixtures/prometheus/*.json` — deterministic Prometheus API envelopes.

## Validation

```sh
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
```

If `jsonschema` is available, validate the examples:

```sh
python3 - <<'PY'
import json, jsonschema
for name in ('app-config', 'diagnostics'):
    schema = json.load(open(f'contracts/{name}.schema.json'))
    data = json.load(open(f'contracts/fixtures/{name}.example.json'))
    # diagnostics refs app-config.schema.json relatively
    resolver = jsonschema.RefResolver.from_schema(
        schema, store={'app-config.schema.json': json.load(open('contracts/app-config.schema.json'))}
    ) if hasattr(jsonschema, 'RefResolver') else None
    if resolver:
        jsonschema.validate(data, schema, resolver=resolver)
    print(name, 'valid')
PY
```

Do not add a runtime dependency for validation.

## Demo fixture invariants

- 9 panels total; 6 eligible with `prometheus`; 3 hidden:
  - `traces` → `unsupported_query` (`TempoTraceQuery`)
  - `logs` → `unsupported_query` (`LokiLogQuery`)
  - `unknown` → `unsupported_panel`
- 4 rows; the two unsupported rows become empty and are omitted by default.
- `cpu` has 2 series; `load` has 2 queries / 2 series; stat/gauge have
  thresholds; table has 2 rows; Markdown contains a literal `<script>` string
  for escaping tests.
- Datasource URL is `http://localhost:9091`; the app overrides it with
  `prometheus_url=http://10.0.2.2:9091` in the emulator.

## Don't

- Don't "fix" a fixture to hide a renderer bug.
- Don't add a schema field without a contract/test.
- Don't make fixtures depend on wall-clock time.
- Don't use real dashboards with private labels/jobs.
