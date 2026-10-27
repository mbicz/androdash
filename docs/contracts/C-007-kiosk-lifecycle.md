# C-007 — Kiosk and lifecycle

- **Version:** 1
- **Status:** Accepted, 2026-10-26
- **Consumers:** Android shell (W1), renderer debug affordance (W2)
- **Related:** C-001 (config), C-008 (WebView security), C-009 (diagnostics)

## Purpose

Define the appliance behavior: fullscreen, keep awake, back handling, optional
lock task, persistence/relaunch, the escape hatch, and the minimal JS bridge.

Kiosk is a usability/posture feature, not a security boundary. A determined user
with physical access can always use recovery/ADB. Do not overclaim.

## Configuration

| Extra | Default | Meaning |
|---|---|---|
| `kiosk` | `true` | Apply immersive fullscreen, keep awake, and back-disabled behavior |
| `lock_task` | `false` | Attempt Android lock task (`startLockTask()`); requires device-owner/provisioning for unattended use. Native-only; not part of `AppConfig` (C-001 note). If promoted, update C-001 and the schema. |

`lock_task` is intentionally separate from `kiosk`. Immersive mode works on any
phone; lock task often requires provisioning and can surprise the user with a
system confirmation dialog.

## Behavior

### Always (foreground)

- Single Activity, no action bar, dark theme, fullscreen.
- `FLAG_KEEP_SCREEN_ON` while foreground; release with the window when stopped.
- Hide status/navigation bars; re-apply after focus changes, overlays, or
  transient system UI.
- Orientation: sensor default; no lock in v1.
- Render the local renderer only; no browser chrome, no address bar, no tabs.
- Handle configuration changes without losing the page (avoid Activity recreate
  or preserve WebView state).

### `kiosk=true`

- Back button/gesture is a no-op (do not finish).
- Home/recents are not intercepted (requires lock task/device owner for real
  containment; do not fake it).
- Apply immersive sticky mode.
- If `lock_task=true`, call `startLockTask()`:
  - success → app is pinned/allowlisted as the system permits;
  - failure/exception → log, remain in immersive kiosk, do not crash.
- A debug affordance (only when `debug=true`) can exit/reload.

### `kiosk=false`

- Immersive may remain, but Back finishes the Activity.
- Intended for development; do not use for a deployed wall dashboard.
- `lock_task` is ignored when `kiosk=false` (do not pin a dev session).

## Escape hatch

A kiosk must be serviceable:

- `debug=true` → the renderer shows a small debug control (e.g. bottom-left
  "⋮") opening diagnostics with:
  - reload page;
  - reload dashboard;
  - exit kiosk (`AndroDash.exitKiosk()`);
  - config/capability/error details.
- `debug=false` → no affordance.
- The owner can always:
  - `adb shell am force-stop dev.androdash`;
  - reboot the device;
  - use device-owner/provisioning controls if configured.
- Do not hide a physical long-press secret in v1; the debug flag is explicit and
  auditable.

## Persistence and relaunch

- After a valid launch, persist the canonical `AppConfig` in
  `SharedPreferences("androdash")` under `launch_config` (JSON).
- On launch with no extras, use the persisted config. This makes the launcher
  icon restore the wall dashboard after a reboot/crash.
- Explicit extras override persisted fields.
- If no valid config exists, show the native fatal screen (`E_CONFIG`) with the
  launch command shape; do not open a blank WebView.
- Do not persist secrets (none in v1).
- Boot-to-kiosk (after device reboot) is an Android launcher/device-owner concern;
  v1 does not add a boot receiver. Document the limitation.

## Lifecycle

- `onCreate`: parse config, configure WebView, load local URL, apply kiosk.
- `onResume`/`onWindowFocusChanged`: re-apply immersive.
- `onPause`: keep the WebView alive; the renderer pauses refreshes via page
  visibility.
- `onStop`: release keep-awake implicitly via the window flag.
- `onDestroy`: destroy the WebView only when finishing, not on configuration
  change.
- `onSaveInstanceState`: preserve the config/URL if the Activity is recreated;
  the renderer can rebuild from the dashboard URL (data may refetch).
- Renderer crash (`onRenderProcessGone`): recreate the WebView, reload the local
  URL, log; do not leave a dead surface.
- Network changes: no native callback in v1; the renderer retries on the next
  cycle.

## JS bridge

Optional `window.AndroDash` (present only in the Android shell):

| Method | Input | Behavior |
|---|---|---|
| `platform()` | none | Returns `"android"` |
| `appVersion()` | none | Returns the app version string |
| `reload()` | none | Reload the local renderer page |
| `exitKiosk()` | none | Finish the Activity; renderer may prompt/confirm in debug |
| `log(level, message)` | strings | Log a redacted, length-limited message |

Rules:

- Methods are synchronous and side-effect-minimal.
- Inputs are length-limited and never injected into shell/Intent/file APIs.
- No arbitrary URL loading, file access, clipboard, Intent launching, or
  network calls.
- If the bridge is absent (browser dev), the renderer must degrade gracefully.
- The renderer calls `exitKiosk()` only from the debug affordance, never
  automatically.
- C-008 governs bridge exposure and navigation blocking.

## Native fatal screen

Triggered by config validation failure, local asset load failure, or an
unrecoverable WebView error.

Contents:

- app name and "Cannot start";
- error code (`E_CONFIG`, `E_ASSET_LOAD`);
- one-line reason (redacted);
- the command shape to relaunch with a valid dashboard URL (no user values);
- retry button;
- no address bar, no arbitrary link, no file picker.

## Manual acceptance

1. Launch with `kiosk=true`: status/nav hidden, screen stays on, Back no-op.
2. Launch with `kiosk=false`: Back exits.
3. `lock_task=true` on a non-provisioned emulator: no crash; logs the failure;
   immersive remains.
4. Rotate: layout reflows; page does not lose data unexpectedly.
5. Force-stop + launcher relaunch: persisted demo restores.
6. Kill the WebView renderer (DevTools/`chrome://inspect` or low-memory): shell
   reloads and the dashboard recovers.
7. `debug=true` overlay can reload/exit; `debug=false` has no affordance.
8. Invalid (non-http) dashboard URL: native fatal screen, `E_CONFIG`, no blank
   WebView. A valid but unreachable dashboard URL is a renderer
   `E_DASHBOARD_FETCH` state instead.

## Test obligations

- Android unit tests: config persistence, URL building (C-001).
- Manual emulator checklist above; record commands/results in the handoff.
- Logcat: no uncaught exceptions; no secrets.
- If `lock_task` is promoted to C-001, add a unit/manual matrix for device-owner
  and non-owner states.

## Out of scope

- Full device-owner provisioning automation.
- Kiosk browser features (tabs, navigation, downloads).
- Boot receiver/auto-start.
- Screen orientation locking.
- Preventing screenshots.
- MDM integration.
