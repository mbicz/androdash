---
id: 0016
date: 2026-10-27
status: accepted
kind: decision
scope: android
supersedes: []
---

# Lock-screen grayscale view, power-button re-light, and view/lock bridge methods

## Context

Decision 0011 lets a kiosk dashboard stay visible above the keyguard
(`show_when_locked`), but the display still behaved like any other app: the
first power press turned it off, and the dashboard looked the same locked and
unlocked. The wanted behavior is closer to Google Maps' lock-screen navigation:
when the phone locks, the dashboard keeps running over the lock screen in a
simplified, dim, grayscale view; unlocking restores colour.

Android gives ordinary apps no always-on-display API. What exists:
`setShowWhenLocked`/`setTurnScreenOn`, `FLAG_KEEP_SCREEN_ON`, the window
`screenBrightness` override, `KeyguardManager.isKeyguardLocked()`, the
`ACTION_SCREEN_OFF`/`ACTION_SCREEN_ON`/`ACTION_USER_PRESENT` broadcasts
(runtime receivers only), and a screen wake lock with `ACQUIRE_CAUSES_WAKEUP`
(deprecated since API 33).

The renderer also needs to remember a time range or refresh interval the user
picks on the phone, and the operator needs to switch the lock-screen mode
without an `adb` relaunch. Decision 0011 made `show_when_locked` a
current-launch posture that was not persisted; a runtime toggle only makes sense
if it is.

## Decision

`show_when_locked` stays opt-in (default `false`, gated by `kiosk=true`) and,
when effective, additionally:

1. Keeps `FLAG_KEEP_SCREEN_ON` while the dashboard is up (no idle timeout over
   the keyguard).
2. Pushes the locked state to the renderer with one of two fixed constant
   scripts through `evaluateJavascript` (allowed by C-008 for constant
   lifecycle scripts):
   `window.androdash && window.androdash.setLocked && window.androdash.setLocked(true)`
   and the same with `false`. `true` whenever the window is visible while the
   keyguard is locked (`onResume`, `ACTION_SCREEN_ON`, `onWindowFocusChanged`,
   just before a re-light); `false` on `ACTION_USER_PRESENT` and on resume when
   unlocked; the current state once from `onPageFinished`. With the mode off
   the renderer never receives `true`; disabling at runtime pushes `false` once.
3. Dims the window to `screenBrightness = 0.12` while locked and restores
   `BRIGHTNESS_OVERRIDE_NONE` on unlock.
4. Re-lights the display after the first power press. A runtime receiver for
   the three screen broadcasts drives a pure `LockRelightPolicy`
   (`UNLOCKED → LOCKED_LIT → LOCKED_DARK`):
   - screen off from normal use, with the dashboard in the foreground and the
     keyguard engaged (checked about 0.3 s after the screen-off, because the
     keyguard can lock as the display finishes turning off) → acquire a
     `SCREEN_DIM_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP` wake lock tagged
     `androdash:relight`, released automatically after at most 3 s; the
     dashboard appears dimmed and grayscale over the keyguard;
   - screen off while locked-lit (a second press) → the display stays off;
   - manual wake while locked → locked-lit again;
   - unlock → reset.
   No re-light when another app was in the foreground or the keyguard is not
   engaged, so an unlocked or lock-screen-less phone can always be turned off.
   Adds `android.permission.WAKE_LOCK` (normal permission).
5. Persists `show_when_locked` as its own boolean preference
   (`SharedPreferences("androdash")`, key `show_when_locked`), outside
   `launch_config`, so `AppConfig` and the C-001 schema are unchanged. An
   explicit extra replaces the stored value; a launch without the extra uses
   it. This supersedes the "not persisted" sentence of decision 0011 only;
   0011 otherwise stands.

Three bridge methods are added to `window.AndroDash` (C-007):

- `setView(timeRange, refreshSeconds)`: validated with the C-001 launch rules
  (`ConfigParser.applyView`; inputs ≤ 64 characters at the bridge, ≤ 32 to the
  parser), applied on the UI thread to the in-memory config, persisted
  `AppConfig`, and renderer URL so `reload()` keeps the choice. Invalid input
  logs a warning and is ignored.
- `lockScreenEnabled()`: the effective `show_when_locked`.
- `setLockScreen(enabled)`: persist and apply/clear immediately (window flags,
  receiver, wake lock, `setLocked(false)` and undim when disabling); enabling is
  ignored when `kiosk=false`.

## Consequences

### Positive

- A wall/charger phone behaves like Maps navigation: lock it and the
  dashboard keeps showing, dim and grayscale, without unlocking or weakening
  the keyguard.
- The re-light decision is a small pure class with JVM tests; the Android glue
  only feeds it events.
- The renderer owns the grayscale presentation; the shell sends a single
  boolean through a constant script, so no input reaches `evaluateJavascript`.
- Time range/refresh picked on the phone survive reloads and relaunches.

### Negative / risks

- **The first power press is overridden.** With the mode on, pressing power
  from the unlocked dashboard does not turn the display off; it comes back
  dimmed over the keyguard. Turning it off takes a second press. This is
  surprising for a phone in a pocket; the mode is opt-in only and meant for a
  docked/charging device.
- **Battery cost.** The display stays on (dimmed, keep-screen-on) over the
  keyguard until the user presses power again; the renderer keeps polling
  Prometheus while visible. Pair with a long `refresh_seconds` and charging.
- **Deprecated wake-up API.** `ACQUIRE_CAUSES_WAKEUP` is deprecated since API 33.
  AOSP already has a compat change (`REQUIRE_TURN_SCREEN_ON_PERMISSION`) that
  ignores it for future target SDKs unless the app holds the appop-gated
  `TURN_SCREEN_ON` permission; it is not enforced for `targetSdk 35`. A future
  `targetSdk` bump, an OEM power policy, or a later Android release may silently
  ignore the re-light; the dashboard then simply stays off until the user wakes
  it, which is the normal behavior.
- The keyguard check after screen-off is a heuristic (~0.3 s settle). On a
  device whose keyguard engages later (delayed lock), no re-light happens.
- Dashboard content stays visible while the phone is locked (as in 0011); use
  only on a trusted appliance.
- `setView`/`setLockScreen` let page script change persisted settings. Both are
  constrained to validated values and the documented fields; an XSS in the
  renderer could still change the time range or toggle lock-screen display.

### Follow-ups

- Verify the power-button sequence on the Pixel 10 and an emulator and record
  results (C-007 manual acceptance 4).
- If a future `targetSdk` enforces `TURN_SCREEN_ON`, decide between requesting
  that appop and dropping the re-light.

## Contracts affected

- C-007 (v3): `show_when_locked` meaning, new "Lock-screen display" section,
  persistence of the preference, lifecycle hooks, bridge methods `setView`,
  `lockScreenEnabled`, `setLockScreen`, the native → renderer `setLocked` push,
  manual acceptance and test obligations.
- C-001: native-only note covers `show_when_locked` persistence and runtime
  `setView`; out-of-scope list amended. No schema or query-parameter change.
- C-008: unchanged; the new scripts are fixed constants and the bridge methods
  validate and length-limit input.

## Verification

- `mise exec -- ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`:
  `LockRelightPolicyTest` (first press re-lights, second press stays off,
  manual wake is locked-lit, unlock resets, no re-light without keyguard or in
  another app) and `ConfigParserTest` (persisted `show_when_locked` precedence,
  `setView` validation) pass; lint stays at 0 errors.
- Manual on device: C-007 manual acceptance 4 (power-button sequence,
  grayscale/dim over the keyguard, colour after unlock, `setLockScreen(false)`).
