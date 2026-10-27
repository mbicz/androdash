# Development guide

**Current state:** M0 (foundation). The renderer and Android app do not exist
yet. Commands marked **planned** will fail until their milestone lands. This file
is the canonical command reference; if a command here is wrong, fix it.

## 1. Prerequisites

| Tool | Version / notes |
|---|---|
| JDK | 17+ (this workstation: Temurin 21) |
| Android SDK | platform 35, build-tools 35.x |
| Android emulator | an API 35 AVD, or a physical phone with USB debugging |
| adb | SDK platform-tools |
| Gradle | use the checked-in wrapper; this workstation has Gradle 8.14.3 cached |
| Node.js | 20+ for renderer tests (this workstation: 26.x) |
| Python | 3.10+ for demo tooling (this workstation: 3.14) |
| jq | JSON validation |

No Android Studio is required. No global Gradle install is required once the
wrapper exists.

## 2. Repository bootstrap

```sh
git clone <repo> androdash
cd androdash
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
python3 tools/check_docs.py
```

Read `AGENTS.md`, `CONSTITUTION.md`, and `docs/index.md` before changing code.

## 3. What is real today (M0)

```sh
# Validate contracts and fixtures
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty

# Check local Markdown links
python3 tools/check_docs.py

# Inspect the foundation
find docs contracts changelog.d -type f | sort
```

There is no build, no server, and no APK yet.

## 4. Planned: renderer browser harness (M1)

Terminal 1 — synthetic Prometheus:

```sh
python3 tools/mock_prometheus.py --port 9091
```

Terminal 2 — static server for the repo (web runtime + dashboard fixture):

```sh
python3 tools/serve_demo.py --port 8099
```

Browser:

```
http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/demo-dashboard.json&prometheus_url=http://localhost:9091&debug=true
```

Tests:

```sh
node --test web/tests/
node --test web/tests/contract/
```

Use the static server; `file://` is not a supported renderer origin. The Android
WebView path is the virtual `http://androdash.local/index.html` origin (served
from assets via `shouldInterceptRequest`, decision 0007).

## 5. Planned: Android build (M2)

Gradle project layout:

```
settings.gradle.kts        # root, includes :app
build.gradle.kts           # root plugin versions
gradle.properties
gradlew, gradle/wrapper/   # checked in
app/build.gradle.kts
app/src/main/AndroidManifest.xml
app/src/main/java/dev/androdash/...
web/app/                   # mapped as the app's assets source
```

Build and install:

```sh
./gradlew :app:assembleDebug
./gradlew :app:installDebug
```

If the wrapper is missing, generate it once with a compatible Gradle:

```sh
gradle wrapper --gradle-version 8.14.3
```

Use the version compatible with the chosen AGP; record upgrades in
`changelog.d/`.

### Launch the demo on the emulator

```sh
adb devices
adb shell am start -n dev.androdash/.MainActivity \
  --es dashboard_url "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json" \
  --es prometheus_url "http://10.0.2.2:9091" \
  --ez debug true
```

`10.0.2.2` is the emulator's alias for the host loopback. For a physical phone on
the same Wi-Fi, use the host's LAN IP (e.g. `192.168.1.20`) and allow ports 8099
and 9091 through the host firewall.

Kiosk off for development:

```sh
adb shell am start -n dev.androdash/.MainActivity \
  --es dashboard_url "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json" \
  --es prometheus_url "http://10.0.2.2:9091" \
  --ez kiosk false --ez debug true
```

Reload / stop:

```sh
adb shell am force-stop dev.androdash
adb logcat -c
adb logcat -s AndroDash
```

Screenshot:

```sh
adb exec-out screencap -p > /tmp/androdash.png
```

## 6. Emulator setup

List AVDs and start one:

```sh
$ANDROID_HOME/emulator/emulator -list-avds
$ANDROID_HOME/emulator/emulator -avd <name> -no-snapshot-load
```

Check the device and WebView:

```sh
adb devices
adb shell getprop ro.build.version.sdk
adb shell wm size
adb shell pm list packages | grep -i webview
```

If the emulator has no network to the host, verify with:

```sh
adb shell 'command -v curl >/dev/null && curl -s http://10.0.2.2:9091/api/v1/status/buildinfo'
```

Some emulator images lack `curl`; use the app's diagnostics instead.

## 7. Debugging

### WebView renderer

- Debug builds allow `chrome://inspect` from the host Chrome; inspect the
  `http://androdash.local/index.html` page.
- Release builds disable WebView debugging.
- Use the in-app debug overlay (`debug=true`) for config, capabilities, hidden
  panels, and request timings.
- Browser console works for the M1 harness; no remote source maps or bundler.

### Android shell

```sh
adb logcat -s AndroDash
adb shell dumpsys activity activities | grep -i androdash
adb shell am force-stop dev.androdash
```

### Prometheus/mock

```sh
curl -s http://localhost:9091/api/v1/status/buildinfo | jq
curl -s 'http://localhost:9091/api/v1/query?query=up' | jq
curl -s -D- -o /dev/null http://localhost:9091/api/v1/status/buildinfo
```

Check CORS headers (`Access-Control-Allow-Origin`) and cleartext reachability.

## 8. Coding standards

### General

- ASCII in source and docs unless a Unicode character is essential.
- UTC ISO-8601 for machine timestamps; local time only in the UI.
- No secrets, real credentials, private hostnames, or personal data in fixtures.
- Prefer small pure functions and explicit error codes.
- Add tests for every new branch that encodes a rule.

### Kotlin (W1)

- Official Kotlin style; 4-space indent.
- No AndroidX unless a decision entry accepts it.
- No networking/JSON libraries; use the framework.
- Keep `MainActivity` thin; config parsing and URL building live in testable
  classes.
- Never log full URLs or query strings.

### JavaScript (W2)

- ES2022 modules, 2-space indent, semicolons, single quotes.
- `const`/`let`; no `var`; no `eval`/`new Function`.
- No runtime dependencies/build step.
- Pure modules must not touch `window` at import time.
- Use `textContent`/DOM builders, never untrusted `innerHTML`.
- Export functions for tests; keep `main.js` as wiring.
- Node test runner only (`node:test`, `node:assert/strict`).

### Python tools (W3)

- Standard library only.
- Deterministic output for fixed `start`/`end`.
- Bind to localhost by default; expose `--host` for physical-device testing.
- CORS `*` on the mock; no auth.
- Small, documented endpoints.

### Docs and contracts (W4)

- Relative links; no absolute `file://` paths.
- One contract per file; stable IDs.
- Mark planned behavior clearly.
- Keep machine-readable schemas in sync with prose.
- Every material decision gets a `changelog.d` entry.

## 9. Git and parallel work

- Use one git worktree per workstream when running agents in parallel.
- Keep commits scoped: `renderer: ...`, `android: ...`, `tools: ...`, `docs: ...`,
  `contracts: ...`.
- Do not mix a contract change with an unrelated UI change.
- Do not commit build outputs, local SDK paths (`local.properties`), screenshots
  with private data, or `.DS_Store`.
- If you change a contract, include the contract doc, schema/fixture, consumers,
  tests, and changelog entry in the same change.

## 10. Troubleshooting

| Symptom | Check |
|---|---|
| Renderer shows `E_ASSET_LOAD` | Virtual-origin handler/MIME/path; check `adb logcat -s AndroDash` |
| Renderer shows `E_DASHBOARD_FETCH` | URL reachable from the device; dashboard source allows CORS from `http://androdash.local` (or `*`); emulator uses `10.0.2.2`, not `localhost` |
| `E_PROM_NETWORK` / CORS | Prometheus sends `Access-Control-Allow-Origin: *`; device can reach the URL |
| Panels hidden unexpectedly | Capability filter: query/panel kind, datasource URL, `prometheus` probe; open debug overlay |
| No data but no error | PromQL matches nothing, variable resolved to empty, or time range mismatch; check the mock/Prometheus directly |
| Chart blank | Check series/point caps, null handling, and panel `data-state` |
| Kiosk won't exit | Use `adb shell am force-stop dev.androdash`; relaunch with `kiosk=false` |
| WebView debugging unavailable | Use a debug build; `setWebContentsDebuggingEnabled(true)` only then |
| Cleartext blocked | Check `usesCleartextTraffic`/network security config and Android version |
| Gradle can't find SDK | Set `ANDROID_HOME` or `local.properties` (do not commit it) |
| Gradle/AGP version mismatch | Use the checked-in wrapper; record upgrades |

## 11. Handoff format

Report:

1. What changed and why (link the contract/decision).
2. Commands run and observed results.
3. Tests and screenshots (paths).
4. Known gaps or follow-ups.
5. Anything a parallel workstream must know.

If you could not run a verification, say so explicitly. Do not imply success.
