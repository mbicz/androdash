# C-001 — Launch configuration

- **Version:** 7
- **Status:** Accepted, 2026-10-29 (v4: `dashboard_source`, bundled and stored
  dashboards, decision 0018; v5: on-phone collector fields, decision 0019; v6:
  `dashboard_urls`, `rotate_seconds`, stored slots, decision 0020; v7:
  `collector_phone`, phone exporter job, targets optional, decision 0021)
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
| `dashboard_url` | string | **required** | Absolute `http://` or `https://` URL of the Perses dashboard JSON currently shown. A bundled dashboard is `http://androdash.local/dashboards/<file>.json` (see [Dashboard source](#dashboard-source)). Required unless `dashboard_urls` supplies it; persisted, so a relaunch shows the last viewed dashboard. |
| `dashboard_urls` | string | `[dashboard_url]` | Comma-separated list of the dashboards the renderer switches between (swipe, rotation); see [Multiple dashboards](#multiple-dashboards). 1–8 absolute `http(s)` URLs after deduplication, each validated like `dashboard_url`; a comma inside a URL must be written `%2C`. Added in v6. |
| `prometheus_url` | string | `null` | Absolute `http://`/`https://` base URL. Overrides dashboard datasource URLs for all Prometheus queries. |
| `refresh_seconds` | integer | `null` | Auto-refresh interval. `null` = use dashboard `refreshInterval`; `0` = manual only; `1–4` is clamped to `5` with a warning; max `3600`. |
| `time_range` | string | `null` | Duration such as `15m`, `1h`, `1h30m`, `7d`. `null` = dashboard `spec.duration`; fallback `1h`. Range `1s…30d`. |
| `step_seconds` | integer | `null` | Prometheus range-query step. `null` = auto (C-003); max `86400`. |
| `kiosk` | boolean | `true` | Native-only behavior (C-007). The renderer records it but does not enforce it. |
| `debug` | boolean | `false` | Enables the diagnostics overlay and debug affordances (C-009). |
| `layout_mode` | enum | `auto` | `auto` \| `grid` \| `stack` \| `fit` (C-005). `fit` is the fit-to-screen layout; added in v3. |
| `display_mode` | enum | `standard` | `standard` \| `amoled` \| `monochrome` (C-005). Additive in v2; older persisted configs without it default to `standard`. |
| `lock_style` | enum | `monochrome` | `monochrome` \| `color`. Renderer palette while the phone is locked with `show_when_locked` (C-007): `monochrome` is the grayscale locked view; `color` uses the `amoled` palette (near-black cards, full state and series colour) regardless of `display_mode`. The renderer decides the colours; the shell only passes the value. Additive in v3; older persisted configs without it default to `monochrome`. |
| `dashboard_source` | enum | `stored` | `stored` \| `url`. Where the renderer gets the dashboard JSON; see [Dashboard source](#dashboard-source). Additive in v4; older persisted configs without it default to `stored`. |
| `dashboard_name` | string | `null` | Selects a dashboard when the URL returns an array (C-002). Must be non-empty when set. |
| `capabilities` | string | `null` | Comma-separated capability IDs; when present, authoritative for filtering (C-004). 1–16 entries after deduplication. |
| `show_unsupported` | boolean | `false` | Render explicit placeholders for hidden panels instead of removing them. |
| `rotate_seconds` | integer | `0` | Advance to the next `dashboard_urls` entry every N seconds; `0` = off, else `10–3600`. Added in v6. |
| `collector` | boolean | `false` | Run the bundled Prometheus on the phone ([On-phone collector](#on-phone-collector), C-007). When `true` the shell passes `prometheus_url=http://127.0.0.1:19090` to the renderer instead of the configured `prometheus_url`. Native-only. Added in v5. |
| `collector_targets` | string | `null` | Comma-separated scrape targets, `[job:]instance=host:port` or `host:port`; 1–32 entries when set. With `collector=true` at least one of `collector_targets` and `collector_phone=true` is **required** (v7; before v7 the targets were always required). Native-only. Added in v5. |
| `collector_scrape_seconds` | integer | `15` | Collector scrape interval, `5–300`. Native-only. Added in v5. |
| `collector_retention` | string | `24h` | Collector TSDB retention; duration grammar as `time_range`, range `1h…30d`. Native-only. Added in v5. |
| `collector_phone` | boolean | `true` | While the collector runs, also run the in-app phone exporter on `127.0.0.1:19100` and scrape it as job `phone`, instance `phone` ([Phone exporter job](#phone-exporter-job)). Native-only; not a `setOption` name. Added in v7. |

Intent extras use `--es` (string), `--ei` (int), `--ez` (boolean) with `adb`.

`lock_task` and `show_when_locked` are native-only extras defined in C-007.
They are not part of `AppConfig` and are not passed to the renderer as query
parameters. `lock_task` is never persisted; `show_when_locked` is persisted as
its own boolean preference (not inside `launch_config`), can be toggled at
runtime with `AndroDash.setLockScreen()`, and while true the shell tells the
renderer the locked state through `window.androdash.setLocked()` (C-007,
decision 0016).

The five `collector*` fields are native-only too: they are part of `AppConfig`
(persisted in `launch_config`) but never renderer query parameters. Their only
effect on the wire is the substituted `prometheus_url` while `collector=true`.

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
  "dashboardSource": "stored",
  "dashboardName": null,
  "capabilities": null,
  "showUnsupported": false,
  "collector": false,
  "collectorTargets": null,
  "collectorScrapeSeconds": 15,
  "collectorRetention": "24h",
  "collectorPhone": true,
  "dashboardUrls": [
    "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json",
    "http://androdash.local/dashboards/macos-node-dashboard.json"
  ],
  "rotateSeconds": 0
}
```

`AppConfig` uses camelCase; the wire uses snake_case. The schema is normative
for types and constraints; this table is normative for semantics.

### Required and nullable

- `dashboardUrl` is required and non-empty, and is always an entry of
  `dashboardUrls`.
- `prometheusUrl`, `refreshSeconds`, `timeRange`, `stepSeconds`, `dashboardName`,
  and `capabilities` may be `null` when unset.
- `kiosk`, `debug`, and `showUnsupported` are always booleans after defaults.
- `displayMode` always resolves to one of the three enum values; it is omitted
  only by pre-v2 persisted objects, which default to `standard`.
- `lockStyle` always resolves to `monochrome` or `color`; it is omitted only by
  pre-v3 persisted objects, which default to `monochrome`. The field is
  additive, so `schemaVersion` stays `1`.
- `dashboardSource` always resolves to `stored` or `url`; it is omitted only by
  pre-v4 persisted objects, which default to `stored`. Additive; `schemaVersion`
  stays `1`.
- `collector`, `collectorScrapeSeconds`, `collectorRetention`, and
  `collectorPhone` always resolve to a value; `collectorTargets` is `null` when
  unset and must be a string when `collector` is `true` and `collectorPhone` is
  `false`. Pre-v5 persisted objects without them default to `false`, `15`,
  `24h`, and `null`; pre-v7 objects without `collectorPhone` default to `true`.
  Additive; `schemaVersion` stays `1`.
- `dashboardUrls` always holds 1–8 distinct URLs and `rotateSeconds` is `0` or
  `10–3600`. Pre-v6 persisted objects without them default to
  `[dashboardUrl]` and `0`. Additive; `schemaVersion` stays `1`.

## Multiple dashboards

Decision 0020. `dashboard_urls` lists the dashboards one launch can show;
`dashboard_url` is the one shown now.

Launch resolution (native, after the extras are read):

1. `dashboard_urls` explicit: entries are split on `,`, trimmed, blank entries
   skipped, each validated like `dashboard_url`, duplicates removed keeping the
   first; 1–8 entries remain or the launch is `E_CONFIG`.
   - `dashboard_url` absent → it becomes the first entry.
   - `dashboard_url` present and not in the list → it is inserted first (still
     at most 8 entries, else `E_CONFIG`).
2. `dashboard_urls` absent: the persisted list is kept while it contains the
   resolved `dashboard_url` (explicit or persisted); otherwise the list becomes
   `[dashboard_url]`. A launch with only a new `dashboard_url` therefore starts
   a one-entry list instead of growing the old one.

The renderer receives the list as `dashboard_urls=<comma-joined>` and
`rotate_seconds=<n>` and switches by calling `AndroDash.setOption("dashboard_url", …)`
(C-007) with an entry of the list, so the choice is persisted. With
`rotate_seconds > 0` it advances to the next entry (wrapping) every
`rotate_seconds`. At runtime the page may reorder or shrink the list and add
bundled dashboards through `setOption("dashboard_urls", …)`, but never add a
remote URL (C-007, C-008).

## On-phone collector

Decision 0019. With `collector=true` the shell runs the Prometheus binary
bundled in the APK as a foreground service (C-007) that scrapes the
configured targets and listens on `127.0.0.1:19090` only. The renderer is
launched with `prometheus_url=http://127.0.0.1:19090`; the configured
`prometheus_url` stays persisted and returns when `collector=false`.
Dashboards need no change: their queries run against the phone's own
Prometheus.

`collector_targets` grammar (after trimming each entry; blank entries are
skipped):

| Form | `job` | `instance` |
|---|---|---|
| `host:port` | `node` | `host:port` |
| `instance=host:port` | `node` | `instance` |
| `job:instance=host:port` | `job` | `instance` |

- `job` and an explicit `instance` match `[A-Za-z0-9_.-]{1,64}`.
- `host` is a DNS name (labels `[A-Za-z0-9-]`, ≤ 63 characters, no leading or
  trailing `-`, ≤ 253 total), a dotted IPv4 address, or a bracketed IPv6
  address (`[fd00::1]`, no zone ID).
- `port` is `1–65535` without leading zeros.
- At most 32 entries; one `job` + `instance` pair may appear once.
- A blank `collector_targets` extra keeps the persisted value (like every
  other string extra); a non-blank value must hold at least one entry (`,,` is
  `E_CONFIG`).
- The persisted canonical form is the entries joined by `,`, each written as
  `host:port` when it uses both defaults and as `job:instance=host:port`
  otherwise.

The shell builds `prometheus.yml` only from these validated fields (C-008): a
global `scrape_interval` of `collector_scrape_seconds` and one scrape job per
distinct `job`, each target with an `instance` label. The renderer is unaware
of the collector except through `AndroDash.collectorStatus()` (C-007).

### Phone exporter job

Decision 0021. With `collector=true` and `collector_phone=true` (the default)
the collector service also runs the in-app phone exporter (C-007, C-008,
[`docs/integrations/phone-exporter.md`](../integrations/phone-exporter.md))
and `prometheus.yml` gets one more job, written **first**:

```yaml
  - job_name: "phone"
    static_configs:
      - targets: ["127.0.0.1:19100"]
        labels:
          instance: "phone"
```

- `collector_targets` may then be unset: `--ez collector true` alone gives a
  collector that scrapes only the phone. With `collector_phone=false` it is
  required as before (`E_CONFIG` otherwise).
- A user target with job `phone` and instance `phone` duplicates the phone job
  and is `E_CONFIG` while `collector_phone=true`; other instances under job
  `phone` are allowed.
- The phone target counts in the notification's target count and in
  `collectorStatus().targets` (first), but not toward the 32-entry limit of
  `collector_targets`.

## Dashboard source

`dashboard_source` lets the phone start without the dashboard server
(decision 0018). The shell serves two kinds of on-device dashboard on the
virtual origin (C-008):

- **Bundled:** every `contracts/fixtures/*-dashboard.json` is packaged into the
  APK and served at `http://androdash.local/dashboards/<file>.json` (for
  example `.../dashboards/macos-node-dashboard.json`). Such a `dashboard_url`
  is valid like any other `http` URL. The build also generates
  `http://androdash.local/dashboards/index.json` =
  `{"dashboards": [{"file": "<file>.json", "title": "<metadata.name>"}]}`,
  one entry per bundled dashboard sorted by file name, so the renderer can
  offer them; `index.json` is not a dashboard.
- **Stored:** one copy per `dashboard_urls` position (8 slots), written by the
  renderer through `AndroDash.storeDashboard(sourceUrl, json)` (C-007) into
  the slot `i` of `sourceUrl` in `dashboard_urls`, and served read-only at
  `GET /stored/<i>/dashboard.json`, with `GET /stored/<i>/meta.json` =
  `{"sourceUrl": "<dashboard URL it came from>", "storedAt": <unix ms>, "bytes": <UTF-8 size>}`,
  for `i` = `0…7`. Both answer 404 when slot `i` holds nothing.

Renderer semantics (the shell does not fetch dashboards); `i` is the position
of `dashboard_url` in `dashboard_urls`:

| Value | Behavior |
|---|---|
| `stored` (default) | Read `/stored/<i>/meta.json`; when its `sourceUrl` equals `dashboard_url`, load `/stored/<i>/dashboard.json` and do not fetch. Otherwise fetch `dashboard_url` and, on success, call `AndroDash.storeDashboard(dashboard_url, json)`. |
| `url` | Fetch `dashboard_url` on every load; store nothing. |

- A bundled `http://androdash.local/dashboards/…` URL is always local: it is
  fetched from the APK in either mode and never stored (the shell refuses it).
- A slot is replaced by the first successful load of a different URL at that
  position; reordering `dashboard_urls` therefore refetches (the meta
  `sourceUrl` no longer matches) rather than showing the wrong dashboard.
- In browser development there is no bridge and no `/stored/` route: `stored`
  behaves like `url`.
- The stored copies are untrusted dashboard JSON and are normalized exactly
  like a fetched one (C-002).

## Precedence

Native:

1. Explicit Intent extras on the current launch.
2. Persisted last-valid `AppConfig` (if the app was launched before).
3. Built-in defaults for optional fields.
4. If `dashboardUrl` is still missing (no `dashboard_url`, no `dashboard_urls`,
   nothing persisted), fail with `E_CONFIG`.

Web:

1. Explicit query parameters.
2. Built-in defaults (above).
3. Fail with `E_CONFIG` if required values are invalid.

The web layer does not read Android storage. Native is responsible for
persistence.

## Validation

An implementation MUST reject:

- a missing or empty `dashboard_url` when `dashboard_urls` is absent too;
- `dashboard_urls` with no non-blank entry, more than 8 distinct entries
  (counting an inserted `dashboard_url`), or any entry that fails the URL rules
  below;
- `rotate_seconds` that is not an integer `0` or in `10–3600`;
- a URL that is not absolute `http`/`https`;
- `javascript:`, `file:`, `data:`, `content:`, `intent:`, or other schemes;
- userinfo (`user:password@`) in v1 (authentication is out of scope);
- a URL longer than 8192 characters;
- non-integer `refresh_seconds`/`step_seconds` or values outside their ranges;
- `time_range` that is not a supported duration or outside `1s…30d`;
- `layout_mode` outside the enum;
- `display_mode` outside the enum;
- `lock_style` outside the enum;
- `dashboard_source` outside the enum;
- `collector` or `collector_phone` that is not a boolean;
- `collector=true` with `collector_phone=false` and without a non-empty
  `collector_targets` (explicit or persisted);
- `collector=true` and `collector_phone=true` with a target of job `phone` and
  instance `phone`;
- `collector_targets` violating the [grammar](#on-phone-collector) or holding
  more than 32 entries;
- `collector_scrape_seconds` that is not an integer in `5–300`;
- `collector_retention` that is not a supported duration or outside `1h…30d`;
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
- The renderer may change `timeRange`, `refreshSeconds`, `layoutMode`,
  `lockStyle`, `dashboardSource`, `dashboardUrl`, `dashboardUrls`, and
  `rotateSeconds` at runtime through `AndroDash.setOption(name, value)`
  (C-007). The shell validates the value with the same rules as the launch
  extra of that name, plus: `dashboard_url` must be an entry of the current
  `dashboard_urls`; every `dashboard_urls` entry must be a bundled
  `http://androdash.local/dashboards/<name>.json` (not `index.json`) or already
  in the current list, and the current `dashboard_url` is inserted first when
  missing. It persists the updated `AppConfig` and rebuilds the local URL.
- Log the result with redacted URLs only.
- With `collector=true`, build the local URL with
  `prometheus_url=http://127.0.0.1:19090`, log that substitution, and start the
  collector service before loading the renderer (C-007).
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
- `layout_mode=fit`, `lock_style` default/`color`, and `dashboard_source`
  default/`url` round-trip;
- refresh clamping and bounds;
- duration parsing delegated to C-002 (validated here for range);
- capability list parsing, deduplication, sorting, 16-entry limit, and empty-list
  rejection;
- empty optional values become `null`, except invalid `dashboard_url`;
- canonical query → object → canonical query round-trip;
- `dashboard_urls` (with `%2C` inside an entry) and `rotate_seconds` parsing,
  defaults, and limits.

`app/src/test/java/com/mbicz/androdash/ConfigParserTest.kt` (M2):

- Intent extras → `AppConfig`;
- persisted config precedence, including `lockStyle` and `dashboardSource`
  round-trips and the `monochrome`/`stored` defaults for persisted objects
  without them;
- invalid input → `E_CONFIG`, including `dashboard_source`;
- a bundled `http://androdash.local/dashboards/<file>.json` `dashboard_url` is
  valid;
- local URL encoding and parameter names match the renderer parser;
- `setOption` for every allowed name, invalid values, and unknown names,
  including a rejected new remote `dashboard_urls` entry and a `dashboard_url`
  outside the list;
- `dashboard_urls` parsing, defaults, insertion of `dashboard_url`,
  deduplication, the 8-entry limit, `%2C` entries, persistence; and the
  `rotate_seconds` range;
- the C-007 intent-without-changes decision (`hasConfigExtras`,
  `keepsRenderer`);
- collector defaults, extras, persistence, the `prometheus_url` substitution
  (and its reversal with `collector=false`), the targets-or-phone requirement,
  `collector_phone`, and limits.

`CollectorConfigTest.kt` covers the `collector_targets` grammar, the phone
exporter job, the `prometheus.yml` text, and the Prometheus arguments.

`DashboardStoreTest.kt` and `AssetServerRouteTest.kt` cover the stored slots
(C-007), the legacy cleanup, and the `/dashboards/` (including `index.json`)
and `/stored/<i>/` routes (C-008).

## Out of scope

- Authentication/secrets.
- Remote config files.
- Changing kiosk settings at runtime (other than the C-007 `setOption` and
  `setLockScreen` bridge methods).

Adding any of these requires a contract change and a decision entry.
