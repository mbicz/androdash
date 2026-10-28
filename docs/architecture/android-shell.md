# Android shell architecture

**Status:** implemented for M2; verified on `emulator-5554`. Physical-device and
soak work remains in M3.
**Workstream:** W1.
**Contracts:** C-001, C-007, C-008.
**Scope:** the native shell only. Dashboard/model/query/rendering logic belongs in
`web/app/`.

## 1. Responsibilities

The shell is deliberately thin:

1. Parse and validate launch configuration (Intent extras + persisted config).
2. Build the local renderer URL with encoded parameters.
3. Configure a locked-down WebView and load the renderer.
4. Apply kiosk/lifecycle behavior (fullscreen, keep awake, back handling).
5. Expose a minimal, allowlisted JavaScript bridge.
6. Show a native fatal screen when configuration or the local asset fails.
7. Log lifecycle and bridge events under the `AndroDash` tag.
8. Optionally run and supervise the bundled Prometheus collector on loopback
   (`collector=true`, decision 0019).

It must not parse Perses dashboards, build PromQL, schedule refreshes, or draw
anything.

## 2. Target package and files

Application ID and Kotlin package: **`com.mbicz.androdash`**.

```
app/
├── AGENTS.md
├── build.gradle.kts
├── proguard-rules.pro
└── src/
    ├── main/
    │   ├── AndroidManifest.xml
    │   ├── java/com/mbicz/androdash/
    │   │   ├── MainActivity.kt   # activity, WebView setup, kiosk/lock-screen, bridge
    │   │   ├── AppConfig.kt      # C-001 data model + JSON persistence shape
    │   │   ├── ConfigParser.kt   # Intent/persisted parsing, validation, launch URL
    │   │   ├── ConfigStore.kt    # SharedPreferences persistence (+ show_when_locked)
    │   │   ├── AssetServer.kt    # virtual-origin routes: renderer, bundled + stored dashboards
    │   │   ├── DashboardStore.kt # stored remote-dashboard copy (fixed files, atomic)
    │   │   ├── LockRelightPolicy.kt # pure power-button re-light state machine
    │   │   ├── CollectorConfig.kt   # pure: collector_targets grammar, prometheus.yml, arguments
    │   │   ├── CollectorService.kt  # foreground service running/supervising libprometheus.so
    │   │   ├── CollectorStatus.kt   # pure: collectorStatus() JSON + shared runtime state
    │   │   └── RestartPolicy.kt     # pure collector restart backoff
    │   └── res/
    │       ├── drawable/ic_launcher.xml, ic_collector.xml
    │       └── values/
    │           ├── colors.xml
    │           ├── strings.xml
    │           └── styles.xml
    └── test/java/com/mbicz/androdash/
        ├── AssetServerRouteTest.kt
        ├── CollectorConfigTest.kt
        ├── CollectorStatusTest.kt
        ├── ConfigParserTest.kt
        ├── DashboardStoreTest.kt
        ├── LockRelightPolicyTest.kt
        └── RestartPolicyTest.kt
```

Root Gradle files live at the repository root (`settings.gradle.kts`,
`build.gradle.kts`, `gradle.properties`, `gradlew`, `gradle/wrapper/`). The
project is a single `:app` module.

## 3. Build baseline

- Kotlin, no AndroidX (unless a decision entry is accepted).
- `minSdk 26`, `compileSdk 35`, `targetSdk 35`.
- JDK 17 toolchain; the local environment may use JDK 21 to run Gradle.
- AGP and Kotlin versions must be compatible with the Gradle wrapper checked in.
  Record upgrades in `changelog.d`.
- Manifest: `INTERNET` permission; `usesCleartextTraffic=true` (decision 0006);
  `WAKE_LOCK` (normal; the lock-screen re-light, decision 0016, and the
  collector's partial wake lock, decision 0019); `FOREGROUND_SERVICE` and
  `FOREGROUND_SERVICE_SPECIAL_USE` for `CollectorService`
  (`foregroundServiceType="specialUse"`, decision 0019); exported launcher
  activity with the kiosk intent filter. No other permissions in v1.
- Dependencies: Android framework + Kotlin standard library. No chart, network,
  JSON, or UI libraries.
- Assets: the Gradle module maps `web/app/` as the assets root. A `shouldInterceptRequest`
  handler (`AssetServer.kt`) serves those assets at
  `http://androdash.local/` (decision 0007); the WebView does not use `file://`.
  A second, generated assets root bundles the dashboards (decision 0018): the
  `copyDashboardAssets` Copy task copies `contracts/fixtures/*-dashboard.json`
  into `app/build/generated/dashboard-assets/dashboards/`, and that directory is
  registered on `sourceSets.main.assets` from the task's output, so
  `assembleDebug` runs it. Do not copy runtime assets or fixtures into `app/` by
  hand.
- Native library (decision 0019): the `fetchPrometheus` task downloads the
  pinned upstream `prometheus-3.15.1.linux-arm64.tar.gz` into
  `~/.gradle/androdash-cache/` (kept across `clean`, so clean builds work
  offline), verifies its SHA-256, streams out only `prometheus`, `LICENSE`, and
  `NOTICE`, verifies the binary's SHA-256, and writes
  `app/build/generated/collector-jniLibs/arm64-v8a/libprometheus.so` (a
  `jniLibs` source dir) and `app/build/generated/collector-assets/licenses/prometheus/`
  (an assets dir). `preBuild` depends on it. `packaging.jniLibs` uses
  `useLegacyPackaging = true` (extracted to `nativeLibraryDir`, where it may be
  executed) and keeps the binary unstripped; `abiFilters` is `arm64-v8a`, so
  the APK is arm64-only (lint `ChromeOsAbiSupport` warns about that). The debug
  APK is about 58 MiB, almost all of it the compressed binary (136 MB
  uncompressed). Upgrade: change `prometheusVersion` and both SHA-256 pins.
- Release build: minify is optional, but the renderer assets must remain intact.
  WebView debugging is disabled in release.

## 4. Launch configuration and URL

C-001 owns the wire format. The shell maps Intent extras to query parameters
one-to-one:

| Intent extra | Query parameter | Type |
|---|---|---|
| `dashboard_url` | `dashboard_url` | string |
| `prometheus_url` | `prometheus_url` | string |
| `refresh_seconds` | `refresh_seconds` | int |
| `time_range` | `time_range` | string |
| `step_seconds` | `step_seconds` | int |
| `kiosk` | `kiosk` | boolean |
| `debug` | `debug` | boolean |
| `layout_mode` | `layout_mode` | string (`auto`/`grid`/`stack`/`fit`) |
| `display_mode` | `display_mode` | string |
| `lock_style` | `lock_style` | string (`monochrome`/`color`) |
| `dashboard_source` | `dashboard_source` | string (`stored`/`url`) |
| `dashboard_name` | `dashboard_name` | string |
| `capabilities` | `capabilities` | comma string |
| `show_unsupported` | `show_unsupported` | boolean |
| `lock_task` | — | boolean (native-only; C-007, not in AppConfig) |
| `show_when_locked` | — | boolean (native-only; C-007, not in AppConfig; persisted as its own preference) |
| `collector` | — (sets `prometheus_url=http://127.0.0.1:19090` when true) | boolean (native-only; in AppConfig) |
| `collector_targets` | — | string (native-only; in AppConfig) |
| `collector_scrape_seconds` | — | int (native-only; in AppConfig) |
| `collector_retention` | — | string (native-only; in AppConfig) |

Boolean Intent extras use `--ez`, integers `--ei`, strings `--es` when launching
with `adb`.

The shell builds:

```
http://androdash.local/index.html?dashboard_url=<encoded>&prometheus_url=<encoded>&…
```

All values are percent-encoded with `Uri.encode`/`URLEncoder` semantics suitable
for a query string. Never concatenate raw values.

The shell parses and validates before creating the WebView. The renderer parses
again (defense in depth) and reports web-side errors. Validation failures produce
a native fatal screen with `E_CONFIG` and the offending field, not a blank
WebView.

### Persistence

After a valid launch, persist the canonical config JSON under
`SharedPreferences("androdash").getString("launch_config")`. On a later launch
without extras, use the persisted config, so tapping the launcher icon restores
the kiosk. Explicit extras override persisted fields; omitted optional fields
fall back to defaults (C-001). A persisted object without `lockStyle` (written
before it existed) decodes as `monochrome`. The renderer's
`AndroDash.setOption(name, value)` (`time_range`, `refresh_seconds`,
`layout_mode`, `lock_style`, `dashboard_source`) is validated with the same
rules as the launch extra, saved into this config, and folded into the renderer
URL (C-007). Do not persist secrets if auth is added later; record the storage
decision first.

### Stored dashboard

`DashboardStore` keeps one copy of a remote dashboard so the phone starts
without the dashboard server (C-001 `dashboard_source=stored`, decision 0018).
The renderer fetches the dashboard and hands it to
`AndroDash.storeDashboard(sourceUrl, json)`; the shell accepts it only for the
current `dashboard_url` in `stored` mode and never for an `androdash.local`
URL, checks it is one JSON object of at most 5 MiB UTF-8, and writes
`<filesDir>/dashboards/stored.json` then `stored.meta.json`
(`{"sourceUrl", "storedAt", "bytes"}`) with temp file + fsync + atomic rename,
meta last. `AssetServer` serves them back at `/stored/dashboard.json` and
`/stored/meta.json`. The shell never parses dashboard semantics; it only stores
and serves bytes.

### Collector

With `collector=true` (C-001, decision 0019), `MainActivity` saves the config,
starts `CollectorService` with `startForegroundService`, and loads the renderer
with `prometheus_url=http://127.0.0.1:19090`. The service reads the persisted
`AppConfig`, builds `CollectorConfig`, writes `<filesDir>/collector/prometheus.yml`,
and a supervisor thread runs `<nativeLibraryDir>/libprometheus.so` with a fixed
argument list (loopback listener, retention, `--log.level=warn`), output
appended to `prometheus.log` (deleted first when over 1 MiB). It restarts the
process with `RestartPolicy` backoff, holds a `PARTIAL_WAKE_LOCK`
(`androdash:collector`) while supervising, and on stop sends `SIGTERM`, then
`SIGKILL` after 5 s. A changed config replaces the supervisor after the old
process has exited. `collector=false` and `exitKiosk()` stop the service.
`CollectorService.runtime` holds the state that `AndroDash.collectorStatus()`
returns (C-007).

## 5. WebView configuration

C-008 is normative. The shell applies at least:

- JavaScript enabled; file access disabled; content access disabled.
- File access from file URLs and universal access from file URLs disabled.
- The virtual `http://androdash.local` origin is served from assets via
  `shouldInterceptRequest`; requests outside that origin are not intercepted.
- Mixed content never allowed.
- DOM storage disabled unless a decision adds a need.
- Cookies disabled; third-party cookies disabled.
- Built-in zoom and zoom controls disabled; viewport meta controls layout.
- Safe browsing enabled where available.
- `WebViewClient` blocks every navigation except the virtual app origin;
  external links are not opened by the kiosk.
- SSL errors are cancelled; no bypass UI.
- Downloads blocked.
- WebView debugging enabled only when `BuildConfig.DEBUG`.
- Console messages forwarded to logcat only in debug builds.
- A user-agent suffix `AndroDash/<version>` is appended so dashboard generators
  can identify the client if they wish.

The bridge (`window.AndroDash`) is added only for the virtual app origin and
exposes only the methods in C-007/C-008 (`platform`, `appVersion`, `reload`,
`exitKiosk`, `log`, `setOption`, `lockScreenEnabled`, `setLockScreen`,
`storeDashboard`, `clearStoredDashboard`). Keep
`@JavascriptInterface` methods small, synchronous, and incapable of arbitrary
file/network/Intent access.

### Virtual origin handler (`AssetServer.kt`)

- Intercept only `http://androdash.local/*` in `shouldInterceptRequest`.
- Main document: `/index.html`; `/` maps to it.
- Assets root: the module's `assets` (which maps `web/app/` plus the generated
  `dashboards/` directory).
- Routes (pure `AssetServer.route`, unit-tested): `/index.html`, `/styles.css`,
  `/src/**.js`, `/dashboards/<[A-Za-z0-9_.-]+>.json` from assets, and the exact
  `/stored/dashboard.json` and `/stored/meta.json` from `DashboardStore` (404
  when nothing is stored). Everything else is 404; `..`, `\`, `%`, `//` → 400.
- Normalize the URL path, decode once, reject `..`/backslashes/absolute paths;
  never serve outside the asset root.
- Only `GET`; return 405 for other methods.
- MIME map for `.html`, `.js`, `.mjs`, `.css`, `.json`, `.svg`, `.png`, `.ico`,
  `.woff2`; unknown → `application/octet-stream`.
- `Cache-Control: no-store` in dev/v1.
- Missing asset → 404 + log path; the main page failure triggers `E_ASSET_LOAD`.
- Do not proxy, redirect, or fetch remote content from this handler.
- Browser dev uses `tools/serve_demo.py` with the same paths; the runtime must
  not depend on the hostname.

## 6. Kiosk and lifecycle

- Single `Activity`, no action bar, dark theme, fullscreen.
- Immersive sticky mode: hide status/navigation bars and re-hide after focus or
  system UI changes.
- `FLAG_KEEP_SCREEN_ON` while the activity is foreground.
- Back: no-op in kiosk mode; finish only when `kiosk=false`.
- `kiosk=true` is the default. `lock_task=true` (optional, default false) calls
  `startLockTask()`; true unattended locking requires device-owner provisioning.
  The shell must tolerate failure and remain usable.
- `show_when_locked=true` (optional, default false) keeps the activity visible
  above the keyguard and turns the screen on. API 27+ uses
  `setShowWhenLocked`/`setTurnScreenOn`; API 26 uses the legacy window flags.
  It never dismisses the keyguard or reads credentials. It is ignored when
  `kiosk=false`. This is not an always-on-display guarantee; OEM behavior varies.
  While locked the shell dims the window (`screenBrightness=0.12`) and calls
  the constant `window.androdash.setLocked(true)` script so the renderer
  shows its simplified locked view — grayscale by default, the colour
  `amoled` palette with C-001 `lock_style=color` (the renderer chooses; the
  shell only passes the value); unlock restores brightness and pushes
  `false`. A runtime `SCREEN_OFF`/`SCREEN_ON`/`USER_PRESENT` receiver plus the
  pure `LockRelightPolicy` re-light the display once after the first power
  press (≤ 3 s `androdash:relight` wake lock); a second press leaves it off.
  The preference is persisted and can be toggled from the renderer with
  `AndroDash.setLockScreen()` (C-007 §Lock-screen display, decision 0016).
- Orientation: sensor default; no lock in v1. A future `screen_orientation`
  extra needs a contract change.
- Pause/resume: do not destroy the WebView. Notify the renderer via page
  visibility (the browser handles this) and let C-006 pause refresh while
  hidden.
- Process death: reload from persisted config.
- Escape hatch: when `debug=true`, the renderer shows a small debug affordance
  that can call `AndroDash.exitKiosk()`. Release builds hide it. `adb shell am
  force-stop com.mbicz.androdash` always works for the owner (it also kills the
  collector process; the service is not restarted until the next launch).

## 7. Native fatal screen

If config validation or loading the local asset fails:

- use a simple dark screen with the app name;
- show the error code (`E_CONFIG` or `E_ASSET_LOAD`) and a one-line, non-secret
  reason;
- show the exact `adb` command shape to fix it, without the user's values;
- provide a retry button;
- log the full (redacted) error under `AndroDash`.

The fatal screen must not offer a browser or arbitrary URL input.

## 8. Logging

- Tag: `AndroDash`.
- Log lifecycle transitions, config validation results, WebView load errors,
  bridge calls, and kiosk changes.
- Never log dashboard or Prometheus URLs with query strings or credentials.
  Log scheme + host + path only.
- Debug builds may log more; release builds stay quiet.

## 9. Manual acceptance for M2

1. `./gradlew :app:assembleDebug` succeeds with SDK 35.
2. `./gradlew :app:installDebug` installs on the running emulator.
3. Launch with the demo config from `docs/development.md`.
4. The WebView loads the local renderer, renders at least one chart, and refreshes
   against the mock.
5. Rotate the emulator; the layout reflows without a crash.
6. Press Back; kiosk mode stays. Launch with `kiosk=false`; Back exits.
7. Kill the app; relaunch from the launcher; persisted config restores the demo.
8. `adb logcat -s AndroDash` shows no secrets and no uncaught exceptions.
9. A deliberately invalid (non-http) `dashboard_url` shows the native fatal
   screen with `E_CONFIG`; a valid but unreachable URL shows the renderer's
   `E_DASHBOARD_FETCH` state, not a blank screen.

## 10. Open decisions (M2)

- Exact Gradle/AGP/Kotlin versions after resolving local caches.
- Whether to request `startLockTask()` automatically or only with `lock_task=true`
  (current contract: only with the extra).
- Verify `shouldInterceptRequest` covers the main document and module imports on
  API 35; if not, record a fallback decision (localhost server or classic
  scripts). Do not silently switch to `file://` with universal file access.
