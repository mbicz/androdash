# app/AGENTS.md — Android shell (W1)

Read the root [`AGENTS.md`](../AGENTS.md), [`CONSTITUTION.md`](../CONSTITUTION.md),
then C-001, C-007, C-008, and
[`docs/architecture/android-shell.md`](../docs/architecture/android-shell.md).

## Scope

You own the Android Kotlin shell and the root Gradle project:

```
app/
settings.gradle.kts
build.gradle.kts
gradle.properties
gradlew
gradle/
```

You do **not** own `web/app/` runtime code, renderer contracts, or demo tools.
Do not edit them to make the shell pass. The shell treats `web/app/` as a
read-only assets source.

## Current state

M2 is planned. There is no Gradle project yet; `app/` contains only this file.
Do not claim `assembleDebug` works until you create it and run it.

## Requirements

- Application ID / package: `dev.androdash`.
- Kotlin, no AndroidX unless a decision entry accepts it.
- `minSdk 26`, `compileSdk 35`, `targetSdk 35`, JDK 17 target.
- Gradle wrapper checked in; use a Gradle/AGP/Kotlin combination that actually
  builds with the local SDK. Record upgrades in `changelog.d`.
- Assets: map `web/app/` as the module's assets root and serve it from the
  virtual `http://androdash.local` origin via `shouldInterceptRequest`
  (decision 0007). Do not copy runtime assets into `app/` by hand and do not
  use `file://`.
- Config: parse Intent extras into the canonical `AppConfig` (C-001), validate,
  build the local URL with encoded params, persist the last valid config.
- WebView: apply every C-008 setting; block navigation; no remote code.
- Kiosk: immersive, keep screen on, Back disabled when `kiosk=true`, optional
  `startLockTask()` only when `lock_task=true`, graceful failure.
- Bridge: only C-007 methods; no arbitrary URLs/files/Intents.
- Fatal screen: `E_CONFIG`/`E_ASSET_LOAD`, no blank WebView.
- Logging: tag `AndroDash`; no full URLs/secrets.

## Commands

```sh
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
./gradlew :app:installDebug
adb shell am start -n dev.androdash/.MainActivity \
  --es dashboard_url "http://10.0.2.2:8099/contracts/fixtures/demo-dashboard.json" \
  --es prometheus_url "http://10.0.2.2:9091" \
  --ez debug true
adb logcat -s AndroDash
```

Run the renderer demo tooling first (W3) or the WebView will show a fetch error.

## Definition of done

- APK builds and installs on the emulator (API 35).
- Demo renders (6 panels visible, 3 hidden, refresh working).
- Kiosk on/off behavior verified manually.
- Persisted config restores after force-stop/relaunch.
- Invalid URL shows `E_CONFIG`.
- Unit tests for config parsing/URL building pass.
- No secrets in logs; WebView debugging off in release.
- C-001/C-007/C-008 updated if behavior changed; decision entry added.

## Don't

- Don't parse dashboards or PromQL in Kotlin.
- Don't add a native charting library.
- Don't enable cleartext/debugging beyond the documented posture.
- Don't open arbitrary URLs or add generic bridge methods.
- Don't use AndroidX/Compose without a decision entry.
