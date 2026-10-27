# Android shell architecture

**Status:** planned for M2. No Kotlin code exists yet.
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

It must not parse Perses dashboards, build PromQL, schedule refreshes, or draw
anything.

## 2. Target package and files

Application ID and Kotlin package: **`dev.androdash`**.

```
app/
├── AGENTS.md
├── build.gradle.kts
└── src/
    ├── main/
    │   ├── AndroidManifest.xml
    │   ├── java/dev/androdash/
    │   │   ├── MainActivity.kt
    │   │   ├── AppConfig.kt
    │   │   ├── ConfigParser.kt
    │   │   ├── KioskController.kt
    │   │   ├── WebViewFactory.kt
    │   │   ├── AssetServer.kt
    │   │   ├── AndroidBridge.kt
    │   │   └── FatalScreen.kt
    │   └── res/values/
    │       ├── strings.xml
    │       └── themes.xml
    └── test/java/dev/androdash/
        ├── ConfigParserTest.kt
        └── LaunchUrlTest.kt
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
- Dependencies: Android framework + Kotlin standard library. No chart, network,
  JSON, or UI libraries.
- Assets: the Gradle module maps `web/app/` as the assets root. A `shouldInterceptRequest`
  handler (`AssetServer.kt`) serves those assets at
  `http://androdash.local/` (decision 0007); the WebView does not use `file://`.
  The exact Gradle wiring is part of M2; do not copy runtime assets into `app/`
  by hand.
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
| `layout_mode` | `layout_mode` | string |
| `dashboard_name` | `dashboard_name` | string |
| `capabilities` | `capabilities` | comma string |
| `show_unsupported` | `show_unsupported` | boolean |
| `lock_task` | — | boolean (native-only; C-007, not in AppConfig) |

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
fall back to defaults (C-001). Do not persist secrets if auth is added later;
record the storage decision first.

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
exposes only the methods in C-007/C-008. Keep `@JavascriptInterface` methods
small, synchronous, and incapable of arbitrary file/network/Intent access.

### Virtual origin handler (`AssetServer.kt`)

- Intercept only `http://androdash.local/*` in `shouldInterceptRequest`.
- Main document: `/index.html`; `/` maps to it.
- Assets root: the module's `assets` (which maps `web/app/`).
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
- Orientation: sensor default; no lock in v1. A future `screen_orientation`
  extra needs a contract change.
- Pause/resume: do not destroy the WebView. Notify the renderer via page
  visibility (the browser handles this) and let C-006 pause refresh while
  hidden.
- Process death: reload from persisted config.
- Escape hatch: when `debug=true`, the renderer shows a small debug affordance
  that can call `AndroDash.exitKiosk()`. Release builds hide it. `adb shell am
  force-stop dev.androdash` always works for the owner.

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
9. A deliberately invalid `dashboard_url` shows the fatal screen with
   `E_CONFIG`, not a blank screen.

## 10. Open decisions (M2)

- Exact Gradle/AGP/Kotlin versions after resolving local caches.
- Whether to request `startLockTask()` automatically or only with `lock_task=true`
  (current contract: only with the extra).
- Verify `shouldInterceptRequest` covers the main document and module imports on
  API 35; if not, record a fallback decision (localhost server or classic
  scripts). Do not silently switch to `file://` with universal file access.
