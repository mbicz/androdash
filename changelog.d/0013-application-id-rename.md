---
id: 0013
date: 2026-10-27
status: accepted
kind: decision
scope: architecture
supersedes: []
---

# Rename the Android application ID to `com.mbicz.androdash`

## Context

M2 shipped the debug shell as `dev.androdash`. That identifier is a
developer-style placeholder: `dev` is not a namespace this project controls, so
the ID is not defensible for installation on a real phone, for a published APK,
or for device-owner provisioning, where the package name is what an operator
pins, allowlists, and force-stops.

The Kotlin package and the Gradle `namespace` follow the application ID, so the
rename touches source paths, the manifest resolution, adb commands in docs, and
the fatal-screen hint the renderer prints.

## Decision

1. `applicationId` and `namespace` become `com.mbicz.androdash`.
2. Kotlin sources move from `app/src/{main,test}/java/dev/androdash/` to
   `app/src/{main,test}/java/com/mbicz/androdash/`; every `package` declaration
   becomes `com.mbicz.androdash`.
3. Documentation, adb commands, and the renderer's fatal-screen command hint use
   the new ID.
4. `versionCode`/`versionName`, `schemaVersion`, contract versions, the
   `AndroDash` log tag, and the `http://androdash.local` WebView origin are
   unchanged. The rename is an install identity change, not a contract change.

This is a breaking install-identity change: `com.mbicz.androdash` is a separate
app. The old `dev.androdash` package is not migrated; it must be uninstalled so
two dashboards do not compete for the kiosk role. Nothing is released yet, so no
user data or persisted config needs migrating — a persisted config from the old
package simply does not exist for the new one.

## Consequences

### Positive

- The ID uses a namespace the project owner actually controls.
- Operators get a stable package to allowlist for device-owner/lock-task
  provisioning and to force-stop in recovery.
- Docs, adb snippets, and the renderer hint all agree on one name.

### Negative / risks

- `adb shell am start`/`force-stop` commands with `dev.androdash` stop working.
- Any local scripts, launcher shortcuts, or pinned tasks referencing the old
  package must be recreated.
- Uninstalling the old package clears its persisted config.

### Follow-ups

- None; the debug APK is not distributed.

## Contracts affected

- C-001: no field or schema change; `dashboardUrl` and friends are unaffected.
- C-007/C-008: no semantic change; the package name in examples is updated.
- C-009: the fatal-screen command hint shows the new package.

## Verification

- `mise exec -- ./gradlew :app:testDebugUnitTest`
- `mise exec -- ./gradlew :app:assembleDebug`
- `mise exec -- ./gradlew :app:lintDebug`
- `adb uninstall dev.androdash`; `adb install -r app/build/outputs/apk/debug/app-debug.apk`
- `adb shell am start -n com.mbicz.androdash/.MainActivity ...` renders the demo.
- `python3 tools/check_docs.py`, `mise exec -- node --test web/tests/`,
  `python3 -m unittest discover -s tools -p 'test_*.py'`.
