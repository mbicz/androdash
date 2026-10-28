# C-001 — Launch configuration

- **Version:** 3
- **Status:** Accepted, 2026-10-28
- **Consumers:** Android shell (W1), web renderer config (W2)
- **Machine-readable:** [`contracts/app-config.schema.json`](../../contracts/app-config.schema.json)
- **Fixtures:** [`app-config.example.json`](../../contracts/fixtures/app-config.example.json)
- **Related:** C-007 (kiosk), C-008 (URL security), C-009 (diagnostics)

## Purpose

Define how an operator points AndroDash at a dashboard and a metrics backend,
how the Android shell passes that configuration to the local renderer, and what
defaults/validation apply.

One canonical object (`AppConfig`) is used in three places:

1. Android parses Intent extras into it.
2. Android serializes it to query parameters on the local asset URL.
3. The renderer parses those query parameters back into the same object.

The round-trip must preserve the canonical object. Capability IDs are normalized
(trimmed, lowercased, sorted, deduplicated) as specified in C-004.

## Wire format

The renderer is loaded from a virtual, intercepted app origin (decision 0007):

```
http://androdash.local/index.html?<query>
```

There is no network listener or DNS entry for `androdash.local`; the Android
shell serves the bundled assets for that origin via `shouldInterceptRequest`.
Browser development uses the same query parameters over a normal static server.

Query parameter names are snake_case. Android Intent extras use the same names.
This is deliberate: one name per concept, easy to debug with `adb`.

| Parameter / Intent extra | Type | Default | Notes |
|---|---|---|---|
| `dashboard_url` | string | **required** | Absolute `http://` or `https://` URL of the Perses dashboard JSON. |
| `prometheus_url` | string | `null` | Absolute `http://`/`https://` base URL. Overrides dashboard datasource URLs for all Prometheus queries. |
| `refresh_seconds` | integer | `null` | Auto-refresh interval. `null` = use dashboard `refreshInterval`; `0` = manual only; `1–4` is clamped to `5` with a warning; max `3600`. |
| `time_range` | string | `null` | Duration such as `15m`, `1h`, `1h30m`, `7d`. `null` = dashboard `spec.duration`; fallback `1h`. Range `1s…30d`. |
| `step_seconds` | integer | `null` | Prometheus range-query step. `null` = auto (C-003); max `86400`. |
| `kiosk` | boolean | `true` | Native-only behavior (C-007). The renderer records it but does not enforce it. |
| `debug` | boolean | `false` | Enables the diagnostics overlay and debug affordances (C-009). |
| `layout_mode` | enum | `auto` | `auto` \| `grid` \| `stack` \| `fit` (C-005). `fit` is the fit-to-screen layout; added in v3. |
| `display_mode` | enum | `standard` | `standard` \| `amoled` \| `monochrome` (C-005). Additive in v2; older persisted configs without it default to `standard`. |
| `lock_style` | enum | `monochrome` | `monochrome` \| `color`. Renderer palette while the phone is locked with `show_when_locked` (C-007): `monochrome` is the grayscale locked view; `color` uses the `amoled` palette (near-black cards, full state and series colour) regardless of `display_mode`. The renderer decides the colours; the shell only passes the value. Additive in v3; older persisted configs without it default to `monochrome`. |
| `dashboard_name` | string | `null` | Selects a dashboard when the URL returns an array (C-002). Must be non-empty when set. |
| `capabilities` | string | `null` | Comma-separated capability IDs; when present, authoritative for filtering (C-004). 1–16 entries after deduplication. |
| `show_unsupported` | boolean | `false` | Render explicit placeholders for hidden panels instead of removing them. |

Intent extras use `--es` (string), `--ei` (int), `--ez` (boolean) with `adb`.

`lock_task` and `show_when_locked` are native-only extras defined in C-007.
They are not part of `AppConfig` and are not passed to the renderer as query
parameters. `lock_task` is never persisted; `show_when_locked` is persisted as
its own boolean preference (not inside `launch_config`), can be toggled at
runtime with `AndroDash.setLockScreen()`, and while true the shell tells the
renderer the locked state through `window.androdash.setLocked()` (C-007,
decision 0016).

## Canonical object

```json
{
  "schemaVersion": 1,
  "dashboardUrl": "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json",
  "prometheusUrl": "http://10.0.2.2:9091",
  "refreshSeconds": 10,
  "timeRange": "15m",
  "stepSeconds": null,
  "kiosk": true,
  "debug": true,
  "layoutMode": "auto",
  "displayMode": "standard",
  "lockStyle": "monochrome",
  "dashboardName": null,
  "capabilities": null,
  "showUnsupported": false
}
```

`AppConfig` uses camelCase; the wire uses snake_case. The schema is normative
for types and constraints; this table is normative for semantics.

### Required and nullable

- `dashboardUrl` is required and non-empty.
- `prometheusUrl`, `refreshSeconds`, `timeRange`, `stepSeconds`, `dashboardName`,
  and `capabilities` may be `null` when unset.
- `kiosk`, `debug`, and `showUnsupported` are always booleans after defaults.
- `displayMode` always resolves to one of the three enum values; it is omitted
  only by pre-v2 persisted objects, which default to `standard`.
- `lockStyle` always resolves to `monochrome` or `color`; it is omitted only by
  pre-v3 persisted objects, which default to `monochrome`. The field is
  additive, so `schemaVersion` stays `1`.

## Precedence

Native:

1. Explicit Intent extras on the current launch.
2. Persisted last-valid `AppConfig` (if the app was launched before).
3. Built-in defaults for optional fields.
4. If `dashboardUrl` is still missing, fail with `E_CONFIG`.

Web:

1. Explicit query parameters.
2. Built-in defaults (above).
3. Fail with `E_CONFIG` if required values are invalid.

The web layer does not read Android storage. Native is responsible for
persistence.

## Validation

An implementation MUST reject:

- a missing or empty `dashboard_url`;
- a URL that is not absolute `http`/`https`;
- `javascript:`, `file:`, `data:`, `content:`, `intent:`, or other schemes;
- userinfo (`user:password@`) in v1 (authentication is out of scope);
- a URL longer than 8192 characters;
- non-integer `refresh_seconds`/`step_seconds` or values outside their ranges;
- `time_range` that is not a supported duration or outside `1s…30d`;
- `layout_mode` outside the enum;
- `display_mode` outside the enum;
- `lock_style` outside the enum;
- an explicit empty `capabilities` list in the canonical object (an empty wire
  value is unset);
- more than 16 capability IDs after deduplication, or IDs not matching
  `^[a-z0-9][a-z0-9_-]*$`;
- more than 2000 characters of query string in the local URL (Android/WebView
  safety; dashboard URLs should be much shorter).

Booleans accept `true`/`false` (case-insensitive in query parameters); anything
else is `E_CONFIG`. Empty query values are treated as unset, except
`dashboard_url`, which is invalid. In particular, an empty `dashboard_name` is
unset, and an empty `capabilities` value is not a way to request an empty
advertised set.

### Clamping vs rejection

- `refresh_seconds` `1–4` → `5` + warning `W_REFRESH_CLAMPED`.
- `refresh_seconds` `> 3600` → reject (`E_CONFIG`) rather than silently changing
  operator intent.
- `step_seconds` is not clamped; out-of-range is `E_CONFIG`.
- Unknown capability IDs are kept (recorded) but have no effect.

## Errors and warnings

| Code | Condition |
|---|---|
| `E_CONFIG` | Invalid/missing required configuration; no renderer boot |
| `W_REFRESH_CLAMPED` | Refresh interval raised to the 5 s floor |
| `W_CAPABILITY_UNKNOWN` | An advertised capability ID is recognized as unknown (recorded, inert) |

The native shell shows `E_CONFIG` on its fatal screen. The renderer shows an
`E_CONFIG` fatal card if it is ever booted with bad parameters.

## Android behavior

- Parse and validate before creating the WebView.
- Build the local URL with proper percent-encoding; never concatenate raw values.
- Persist the canonical config only after successful validation.
- Explicit extras override persisted fields; missing optional metadata does not
  erase persisted values unless the operator explicitly clears it (a future
  settings UI may add `--ez reset_config true`, not in v1).
- The renderer may change `timeRange`, `refreshSeconds`, `layoutMode`, and
  `lockStyle` at runtime through `AndroDash.setOption(name, value)` (C-007).
  The shell validates the value with the same rules as the launch extra of that
  name, persists the updated `AppConfig`, and rebuilds the local URL.
- Log the result with redacted URLs only.
- If the local asset fails to load, show the native fatal screen.

## Renderer behavior

- Parse `location.search` (also works when served over HTTP for development).
- Apply defaults and validation; expose the canonical object via
  `window.androdash.getConfig()`.
- Never read config from `localStorage` or cookies in v1.
- Redact `dashboardUrl`/`prometheusUrl` in diagnostics (scheme + host + path).
- Pass the config into dashboard/capability/scheduler modules; no global mutable
  config beyond the frozen object.

## Test obligations

`web/tests/contract/c001-config.test.js`:

- valid example → canonical object;
- defaults applied;
- missing dashboard URL rejected;
- scheme/userinfo/length/type/enum rejections, including `display_mode` and
  `lock_style`;
- display mode defaults and `standard`/`amoled`/`monochrome` round-trip;
- `layout_mode=fit` and `lock_style` default/`color` round-trip;
- refresh clamping and bounds;
- duration parsing delegated to C-002 (validated here for range);
- capability list parsing, deduplication, sorting, 16-entry limit, and empty-list
  rejection;
- empty optional values become `null`, except invalid `dashboard_url`;
- canonical query → object → canonical query round-trip.

`app/src/test/java/com/mbicz/androdash/ConfigParserTest.kt` (M2):

- Intent extras → `AppConfig`;
- persisted config precedence, including `lockStyle` round-trip and the
  `monochrome` default for persisted objects without it;
- invalid input → `E_CONFIG`;
- local URL encoding and parameter names match the renderer parser;
- `setOption` for every allowed name, invalid values, and unknown names.

## Out of scope

- Authentication/secrets.
- Remote config files.
- Multiple dashboards in one launch (array selection is dashboard-level).
- Changing kiosk settings at runtime (other than the C-007 `setOption` and
  `setLockScreen` bridge methods).

Adding any of these requires a contract change and a decision entry.
