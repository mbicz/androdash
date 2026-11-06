---
id: 0033
date: 2026-11-06
status: accepted
kind: decision
scope: app, docs, contracts
supersedes: []
---

# Android Auto via the Cars App Library, IOT category, and AndroidX

## Context

The phone dashboard is useful while driving, but the phone is mounted and its
screen is small. Android Auto can show a second screen on the car's head unit.

Two facts constrained the design, both verified against CAL 1.7.0:

- **The `Surface` gate is policy, not permission.** `androidx.car.app.ACCESS_SURFACE`,
  `NAVIGATION_TEMPLATES`, and `MAP_TEMPLATES` are ordinary `uses-permission`
  entries, and `CarAppPermission` only runs `PackageManager.checkPermission`.
  Any app that declares them receives a drawing surface. What actually stops a
  dashboard is the manual Play review plus the quality guidelines: `NF-1`
  (turn-by-turn directions), `NF-2` (the surface draws *only* map content),
  `NF-6` (navigation intents), `NF-7` (test-drive mode), `PF-1` (POI). Declaring
  a false category is precisely what Article 3 forbids.
- **CAL requires AndroidX**, while `gradle.properties` pins
  `android.useAndroidX=false` and `docs/architecture/android-shell.md` says "No
  AndroidX (unless a decision entry is accepted)".

`docs/plans/car-screen.md` proposed the IoT template route. This entry accepts
it and unblocks the dependency.

## Decision

1. **Ship an IOT-category templated app**, not a navigation/POI impostor.
   `IT-1` explicitly permits *viewing the current state of devices* while
   driving, which is what this dashboard does.
2. **Enable AndroidX** (`android.useAndroidX=true`) because
   `androidx.car.app:app` and `app-projected` 1.7.0 cannot be consumed without
   it. No support-library dependency exists today, so this is a no-op for the
   rest of the app; it only lets AndroidX artifacts resolve.
3. **Add contract C-010** defining the projection: which panel kinds map to car
   rows, which are omitted and counted, tab packing, `ConstraintManager`
   geometry, and the refresh floor.
4. **The projector is pure Kotlin** (`CarProjector`), with no CAL types, so it
   is unit-testable on the JVM. The CAL layer only turns the view model into
   templates.

## Consequences

### Positive

- The car view is glanceable numbers and state words, which is what a driver can
  use, and it is derived from the same dashboard the phone renders.
- Omitted panels are counted and surfaced in a "Not shown" section, so the
  view is honest about being a summary.
- The projector has no Android dependency, so its tests run in the existing
  `testDebugUnitTest` task with no emulator.

### Negative / risks

- **No charts.** `TimeSeriesChart` and `Markdown` panels cannot be shown; the
  most useful part of the phone UI is absent by construction.
- **Real cars need Play.** Sideloaded CAL apps appear in the Desktop Head Unit
  but not in a real car launcher: "Allow unknown sources" does not apply to CAL
  apps. Internal app sharing or an internal test track is the documented route,
  and both need a Play Console account (US$25 + identity verification).
- **AndroidX is now enabled.** Future work may assume it; that assumption is
  recorded here rather than discovered later.
- The app's `applicationId` is unchanged, so an existing Play listing (if any)
  would need the Android Auto form factor enabled.

### Follow-ups

- Play Console registration, then internal app sharing for real-car testing.
- Add the Android Auto form factor in Play Console once an artifact exists.
- Revisit whether a `SectionedItemTemplate` reads better than a `ListTemplate`
  for the Summary section (C-010 leaves the template choice to the CAL layer).

## Contracts affected

- **C-010 added** (car projection).
- C-001: no change (`prometheus_url` and `dashboard_url` are reused as-is).
- C-002, C-003, C-004, C-005, C-006, C-007, C-008, C-009: no change.

## Verification

- `CarProjectorTest`: omission counts, no-data rendering, formatting parity with
  C-005, calculation modes, tab cap and overflow, reading order, stale marking.
- `./gradlew :app:testDebugUnitTest` passes.
- The Desktop Head Unit renders the tabs at 800×480 and 1920×1080.
- `python3 tools/check_docs.py` and `jq empty` over `contracts/` pass.
