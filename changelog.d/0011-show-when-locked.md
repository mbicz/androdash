---
id: 0011
date: 2026-10-26
status: accepted
kind: decision
scope: security
supersedes: []
---

# Allow the kiosk dashboard to show above the keyguard

## Context

A wall/charger dashboard should be visible when the device locks, without
requiring a user to unlock it. Android activities can opt into showing above the
keyguard, but this is a privacy-sensitive posture: content that was visible only
while the app was foreground may now be visible while the device is locked.

Android does not expose a general always-on-display API to ordinary apps.
`setShowWhenLocked`/`setTurnScreenOn` (API 27+) and the legacy
`FLAG_SHOW_WHEN_LOCKED`/`FLAG_TURN_SCREEN_ON` flags (API 26) keep an activity
visible above the keyguard; OEM lock screens and battery policies may still
change behavior.

## Decision

Add a native-only `show_when_locked` Intent extra (not part of `AppConfig`):

- default `false`;
- only honored when `kiosk=true`;
- when enabled, use `setShowWhenLocked(true)` and `setTurnScreenOn(true)` on API
  27+, and the legacy window flags on API 26;
- never call `dismissKeyguard`, read credentials, disable the keyguard, or
  change lock-screen security;
- tolerate failure by logging and remaining in normal kiosk;
- pair with `display_mode=monochrome` for the intended black-and-white
  lockscreen/screensaver presentation.

The extra is intentionally not persisted: it is a current-launch posture, like
`lock_task`.

## Consequences

### Positive

- The dashboard remains useful on a locked wall device without disabling device
  security.
- The implementation is small, uses documented platform APIs, and does not add
  permissions.
- The operator opts in explicitly; default behavior is unchanged.

### Negative / risks

- Dashboard content, including metric labels, is visible while the device is
  locked. Use only on a trusted appliance and avoid sensitive dashboards.
- Showing above the keyguard does not unlock the device or keep other apps out;
  it is not a security boundary.
- OEM keyguard/battery policy may ignore or curtail the behavior, and it is not
  an AOD replacement.
- A bug that leaves the activity visible after kiosk exit would be a privacy
  problem; the normal kiosk exit uses `finishAndRemoveTask()`.

### Follow-ups

- Add an operator warning/confirmation in a future settings UI.
- Revisit automatic keyguard detection and dimming if the mode is used
  overnight.
- Document OEM-specific AOD limitations when real-device testing lands.

## Contracts affected

- C-007: new `show_when_locked` extra, behavior, manual acceptance.
- C-001: explicit note that the extra is native-only; no AppConfig field.
- C-008: unchanged WebView security posture; no keyguard bypass.

## Verification

- Unit: `ConfigParserTest` gates `show_when_locked` by `kiosk`.
- Emulator: launch with `kiosk=true`, `show_when_locked=true`,
  `display_mode=monochrome`; lock/wake the device and confirm the dashboard is
  visible above the keyguard. Confirm `kiosk=false` ignores the extra.
- Logcat: no keyguard/credential APIs are called; no uncaught exceptions.
