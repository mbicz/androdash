---
id: 0019
date: 2026-10-28
status: accepted
kind: decision, contract
scope: android, security
supersedes: []
---

# Prometheus on the phone: bundled collector service

## Context

AndroDash renders on the phone but needed a Prometheus elsewhere to query. The
only always-on host in the deployment is the phone itself: the Mac sleeps and
travels, so dashboards went blank whenever its Prometheus was down. A spike on
2026-10-28 ran the unmodified upstream Prometheus v3.15.1 linux-arm64 binary
on the Pixel 10 (Android 17) as the adb shell user, scraping the Mac's
node_exporter over the LAN and serving AndroDash on loopback:

- 9/9 panels rendered from `http://127.0.0.1:9090` with the bundled macOS
  dashboard;
- about 1.5–1.9 % of one core with the screen on (541 series, 10 s scrape,
  app refreshing 9 panels every 10 s);
- 35–100 MiB RSS (68–75 MiB early, trimmed to ~34 MiB by Android);
- about 2.8 MiB/h of disk writes, data dir ~883 KiB after 36 min;
- scrapes stopped while the CPU dozed (a shell process holds no wake lock), and
  nothing restarted Prometheus after a reboot.

The user approved productionising it. The phone is an appliance: always on a
charger, screen on; power is not a concern.

## Decision

1. **Bundle the upstream binary.** Gradle task `fetchPrometheus` downloads
   `prometheus-3.15.1.linux-arm64.tar.gz` from the GitHub release, verifies
   its SHA-256 against a value pinned in `app/build.gradle.kts`
   (`ceb6d214…74f21b26`, from the release's `sha256sums.txt`), caches it in
   `~/.gradle/androdash-cache/` so clean builds work offline, streams out only
   `prometheus` (SHA-256 pinned too, `373c0a54…35b3bb0f`), `LICENSE`, and
   `NOTICE`, and packages the binary as `lib/arm64-v8a/libprometheus.so`
   (legacy packaging so it is extracted to `nativeLibraryDir` and executable;
   unstripped) with the licences under `assets/licenses/prometheus/`. The APK
   is arm64-only.
2. **C-001 fields** (additive, `schemaVersion` stays 1, native-only):
   `collector` (default `false`), `collector_targets`
   (`[job:]instance=host:port` or `host:port`, ≤ 32, required when
   `collector=true`), `collector_scrape_seconds` (`5–300`, default `15`),
   `collector_retention` (`1h–30d`, default `24h`). With `collector=true` the
   renderer gets `prometheus_url=http://127.0.0.1:19090`; dashboards need no
   change.
3. **`CollectorService`** (C-007): a `specialUse` foreground service with a
   low-importance "Collector" notification. It writes `prometheus.yml` built
   only from the validated fields and runs the binary on `127.0.0.1:19090`
   with no admin API, lifecycle API, or remote-write receiver, logs to a
   1 MiB-capped file, restarts it with 1–60 s exponential backoff (reset after
   10 min healthy), and holds a `PARTIAL_WAKE_LOCK` while running so scrapes
   continue in doze. Stop is SIGTERM, then SIGKILL after 5 s. The Activity
   starts it before loading the renderer and stops it on `collector=false` and
   `exitKiosk()`. No boot autostart.
4. **Bridge** `collectorStatus()` returns a ≤ 4 KiB JSON status. The settings
   sheet shows it read-only: running/restarts and one row per target coloured
   by `up` from the collector (C-005).
5. **Boot gaps heal themselves (renderer, C-004/C-002).** The renderer starts
   while the collector is still binding its port and before the first scrape,
   so a boot probe can fail and a label-values variable (`$host`) can resolve
   empty. Failed probes are re-checked every 15 s and empty label-values
   variables every 60 s at the start of refresh cycles; when either closes,
   the dashboard reloads. This also covers a phone that boots before Wi-Fi.

Alternatives rejected:

- **A PromQL subset in JS with in-browser storage:** a second, partial query
  engine to maintain, no durable TSDB, and every dashboard query would need to
  fit the subset.
- **Prometheus agent mode:** smaller, but it has no query API; the renderer
  needs `/api/v1/query_range`.
- **Prometheus on the Mac only:** there is no always-on host besides the
  phone; the dashboard is blank whenever the Mac is asleep or away.

## Consequences

### Positive

- The phone needs only the LAN exporters; no other host has to stay up.
- Scrapes continue in doze; the service restarts a crashed Prometheus.
- Upstream Prometheus is used unchanged, so dashboards and PromQL behave as on
  any server.

### Negative / risks

- **APK size:** the debug APK is now about 58 MiB (60 486 826 bytes), almost
  all of it the 136 MB binary deflated to ~57 MiB; `app/build` grows to
  ~600 MB. The first build downloads ~100 MB.
- **Policy changes:** `FOREGROUND_SERVICE_SPECIAL_USE` and untimed partial
  wake locks are scrutinised by Play policy and may be restricted further by
  future Android releases (exec from `nativeLibraryDir` likewise). The app is
  sideloaded today.
- **Loopback is readable by other apps:** any app on the phone with
  `INTERNET` can query `127.0.0.1:19090` (C-008). Scrape only metrics the
  exporters already serve openly on the LAN.
- **Pinned binary upgrades** are manual: change the version and both SHA-256
  pins in `app/build.gradle.kts` together, rebuild, and re-verify on the phone.
  Security fixes in Prometheus reach the phone only through a new APK.
  `--storage.tsdb.retention.time` is marked deprecated in 3.15.1 in favour of
  the config-file field `storage.tsdb.retention.time`; both apply the same
  retention there (checked with Homebrew Prometheus 3.15.1, no warning at
  `--log.level=warn`). Move retention into `prometheus.yml` when an upgrade
  drops the flag.
- The battery cost is unmeasured; the deployment assumes a charger.
- After a reboot or force-stop the collector runs again only once the app is
  launched.

### Follow-ups

- Soak: first 2 h block compaction and retention deletion on the phone.
- Diagnostics snapshot (C-009) does not yet include `collectorStatus()`; the
  settings sheet shows it.

## Contracts affected

- C-001 v5: four `collector*` fields, `prometheus_url` substitution;
  `contracts/app-config.schema.json` and `app-config.example.json`.
- C-007 v6: collector service lifecycle, `collectorStatus()`, `exitKiosk()`
  stops the service, collector files, manual acceptance.
- C-008 v3: bundled executable trust model, loopback-only listener, config from
  validated fields only, loopback readable by other apps.
- C-002 / C-004 (amended): retry of empty label-values variables and failed
  boot probes. C-005: Collector group in the settings sheet.

## Verification

```sh
mise exec -- ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep -E 'libprometheus|licenses/prometheus'
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
python3 tools/check_docs.py
```

`CollectorConfigTest`, `RestartPolicyTest`, `CollectorStatusTest`, and the
collector cases in `ConfigParserTest` cover the pure logic. On-device behaviour
is C-007 manual acceptance item 12.

Verified on the arm64 emulator (the Pixel 10 was offline): with
`--ez collector true --es collector_targets "node:mac=192.168.192.16:9100"` and
the bundled macOS dashboard, `libprometheus.so` runs as the app (≈ 90 MiB RSS),
`up{job="node",instance="mac"}` is 1, all 9 data panels render from
`http://127.0.0.1:19090`, a killed collector restarts after 1 s, and a cold
start with an empty TSDB heals within 20 s (probe retry → reload; title
resolves to the host name).
