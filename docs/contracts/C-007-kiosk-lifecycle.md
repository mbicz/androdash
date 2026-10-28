# C-007 — Kiosk and lifecycle

- **Version:** 6
- **Status:** Accepted, 2026-10-28 (v3: lock-screen grayscale, re-light, view
  and lock-screen bridge methods, decision 0016; v4: generic `setOption`
  bridge method, `lock_style`, decision 0017; v5: stored dashboard bridge
  methods, `dashboard_source` option, decision 0018; v6: collector service and
  `collectorStatus`, decision 0019)
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
| `show_when_locked` | `false` | Keep the Activity visible above the keyguard and turn the screen on when locked; while locked, dim the window and switch the renderer to its simplified locked view (grayscale unless C-001 `lock_style=color`); re-light the display once after the first power press (see [Lock-screen display](#lock-screen-display)). Native-only (not in `AppConfig`, not a renderer query parameter); persisted under its own preferences key; ignored when `kiosk=false`. Does not dismiss or bypass the keyguard. Runtime toggle: `AndroDash.setLockScreen()`. |

`lock_task` is intentionally separate from `kiosk`. Immersive mode works on any
phone; lock task often requires provisioning and can surprise the user with a
system confirmation dialog.

`show_when_locked` is a display posture, not a security bypass: the device
remains locked, the keyguard is not dismissed, and no credential is read. It
does make dashboard content visible while the device is locked, so use it only
on a trusted appliance. It is not an always-on-display API and OEM keyguard
behavior may vary; document the limitation rather than promising AOD.

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
- If `show_when_locked=true`, request lock-screen visibility:
  - API 27+ (`O_MR1`): `setShowWhenLocked(true)` and `setTurnScreenOn(true)`;
  - API 26: `FLAG_SHOW_WHEN_LOCKED` and `FLAG_TURN_SCREEN_ON`;
  - failure/exception → log, remain in normal kiosk, do not crash;
  - never dismiss the keyguard, request device credentials, or change the lock
    screen security settings;
  - apply the [lock-screen display](#lock-screen-display) behavior below.
- A debug affordance (only when `debug=true`) can exit/reload.

### Lock-screen display

Only when the effective `show_when_locked` is true (decision 0016). With it
false none of this runs and the renderer never sees `locked=true`.

- `FLAG_KEEP_SCREEN_ON` stays set while the dashboard is up, so the display has
  no idle timeout over the keyguard either.
- Locked state is pushed to the renderer with one of two fixed constant scripts
  via `evaluateJavascript` (C-008 allows constant lifecycle scripts; no input
  reaches them):
  `window.androdash && window.androdash.setLocked && window.androdash.setLocked(true)`
  and the same with `false`.
  - push `true` whenever the window is visible while
    `KeyguardManager.isKeyguardLocked()`: `onResume`, `ACTION_SCREEN_ON`,
    `onWindowFocusChanged`, and just before a re-light;
  - push `false` on `ACTION_USER_PRESENT` (unlock) and on `onResume` when not
    locked;
  - push the current state once from `onPageFinished`, so a cold start or reload
    on the lock screen starts in the locked view;
  - push `false` once when the mode is disabled at runtime.
- The shell does not choose locked colours. C-001 `lock_style` (`monochrome`
  default, or `color`) reaches the renderer in the launch URL; the renderer
  decides the palette: the grayscale `monochrome` palette, or the `amoled`
  palette (near-black cards, full state and series colour) for `color`.
  Dimming, `setLocked`, and re-light behave the same for both values.
- While locked, dim the window (`screenBrightness = 0.12`); restore
  `BRIGHTNESS_OVERRIDE_NONE` on unlock or disable.
- Power-button re-light (Maps-like). While the Activity exists, a runtime
  receiver listens for `ACTION_SCREEN_OFF`, `ACTION_SCREEN_ON`, and
  `ACTION_USER_PRESENT`. The pure `LockRelightPolicy` decides:
  - first screen-off from normal use (dashboard in the foreground, keyguard
    engaged ~0.3 s after the screen-off) → re-light at once with a
    `SCREEN_DIM_WAKE_LOCK | ACQUIRE_CAUSES_WAKEUP` wake lock, tag
    `androdash:relight`, auto-released after ≤ 3 s; the dashboard shows dimmed
    and grayscale over the keyguard (locked-lit);
  - screen-off while locked-lit (the user pressed power again) → nothing; the
    display stays off;
  - a later manual wake with the keyguard up → locked-lit again;
  - unlock (`ACTION_USER_PRESENT`, or resume while unlocked) → reset, so the
    next first press re-lights again;
  - no re-light when another app was in the foreground or the keyguard is not
    engaged (no lock screen, or a delayed lock).
- Requires `android.permission.WAKE_LOCK` (normal permission).

### `kiosk=false`

- Immersive may remain, but Back finishes the Activity.
- Intended for development; do not use for a deployed wall dashboard.
- `lock_task` is ignored when `kiosk=false` (do not pin a dev session).
- `show_when_locked` is ignored when `kiosk=false` (do not keep a dev session
  visible over the lock screen).

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
  - `adb shell am force-stop com.mbicz.androdash`;
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
- The native-only `show_when_locked` preference is persisted separately as a
  boolean under `show_when_locked` in the same preferences file. An explicit
  extra overrides and replaces it; `AndroDash.setLockScreen()` updates it. The
  effective value is still gated by `kiosk`. `lock_task` is never persisted.
- `AndroDash.setOption()` updates `timeRange`, `refreshSeconds`, `layoutMode`,
  `lockStyle`, or `dashboardSource` in the persisted `AppConfig` and the current
  renderer URL.
- The stored dashboard copy (C-001 `dashboard_source=stored`, decision 0018)
  lives in app-private storage as two fixed files,
  `<filesDir>/dashboards/stored.json` and `stored.meta.json`
  (`{"sourceUrl", "storedAt", "bytes"}`). Each is written to a temp file, synced,
  and atomically renamed; the old meta is deleted first and the new meta is
  renamed in last, and the dashboard is readable only while its meta exists, so
  an interrupted write reads as "nothing stored". It survives relaunch and
  reboot, is replaced by the next successful store, and is removed by
  `clearStoredDashboard()` or clearing app data. It is independent of
  `launch_config`.
- If no valid config exists, show the native fatal screen (`E_CONFIG`) with the
  launch command shape; do not open a blank WebView.
- Do not persist secrets (none in v1).
- Boot-to-kiosk (after device reboot) is an Android launcher/device-owner concern;
  v1 does not add a boot receiver. Document the limitation. The collector
  service is not started at boot either; it starts with the Activity.
- The collector's files live in `<filesDir>/collector/`: `prometheus.yml`
  (rewritten from `AppConfig` on every service start), `data/` (the TSDB,
  bounded by `collector_retention`), and `prometheus.log`.

## Collector service

Decision 0019; configuration in C-001
[On-phone collector](C-001-launch-config.md#on-phone-collector).

- `CollectorService` is a foreground service with
  `foregroundServiceType="specialUse"` (`PROPERTY_SPECIAL_USE_FGS_SUBTYPE`
  explains the local metrics collector). Permissions: `FOREGROUND_SERVICE`,
  `FOREGROUND_SERVICE_SPECIAL_USE`, `WAKE_LOCK`. It does not request
  `POST_NOTIFICATIONS`; on Android 13+ the notification is then hidden from
  the shade but the service still runs (and is listed in the task manager).
- Notification channel `collector` ("Collector", `IMPORTANCE_LOW`); text
  "Collecting N targets"; tapping it opens the dashboard.
- **Start.** `MainActivity` persists the launch config, then, when
  `collector=true`, calls `startForegroundService` before loading the
  renderer. The service reads the persisted `AppConfig` (so a sticky restart
  after a process kill uses the same config), writes
  `<filesDir>/collector/prometheus.yml`, and runs:

  ```
  <nativeLibraryDir>/libprometheus.so
    --config.file=<filesDir>/collector/prometheus.yml
    --storage.tsdb.path=<filesDir>/collector/data
    --storage.tsdb.retention.time=<collector_retention>
    --web.listen-address=127.0.0.1:19090
    --web.max-connections=32
    --log.level=warn
  ```

  No admin API, lifecycle API, or remote-write receiver flag is passed.
  stdout/stderr append to `<filesDir>/collector/prometheus.log`, which is
  deleted before a process start when it exceeds 1 MiB.
- **Reconfigure.** A launch with changed collector fields stops the running
  process (see Stop) and starts a new one after it has exited; an unchanged
  config leaves it running.
- **Supervise.** When Prometheus exits, it is restarted after the pure
  `RestartPolicy` delay: 1, 2, 4, … s, capped at 60 s; a run of at least 10 min
  resets the sequence to 1 s. Each exit is recorded for `collectorStatus`.
- **Wake lock.** A `PARTIAL_WAKE_LOCK` (tag `androdash:collector`, no timeout)
  is held while the supervisor runs, so scrapes continue in doze. This assumes
  an always-plugged appliance (decision 0019).
- **Stop.** `SIGTERM`; `SIGKILL` if the process has not exited after 5 s; then
  release the wake lock. The service stops when a launch resolves
  `collector=false` and on `AndroDash.exitKiosk()`. Leaving the Activity
  (Home, screen off, finishing with Back) does not stop it.
- A `startForegroundService` refusal is logged; the renderer still loads (its
  queries then fail against the loopback URL, which the dashboard shows).

## Lifecycle

- `onCreate`: parse config, configure WebView, load local URL, apply kiosk.
- `onResume`/`onWindowFocusChanged`: re-apply immersive; with
  `show_when_locked`, push the locked state and dim/undim (see above).
- `onPageFinished` (local renderer): with `show_when_locked`, push the current
  locked state.
- `onPause`: keep the WebView alive; the renderer pauses refreshes via page
  visibility.
- `onStop`: release keep-awake implicitly via the window flag. Stopping while
  the display is still on means the user left for another app; the power
  button then does not re-light.
- `onDestroy`: unregister the screen receiver and release the re-light wake
  lock; destroy the WebView only when finishing, not on configuration change.
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
| `reload()` | none | Reload the local renderer page (with the latest `setOption` choices) |
| `exitKiosk()` | none | Stop the collector service (if running), then finish the Activity; renderer may prompt/confirm in debug |
| `log(level, message)` | strings | Log a redacted, length-limited message |
| `setOption(name, value)` | strings, ≤ 64 chars each | The user changed one renderer option. `name` is one of `time_range`, `refresh_seconds`, `layout_mode`, `lock_style`, `dashboard_source`; `value` is validated with the C-001 rules for the launch extra of that name: durations `1s…30d`; refresh `0` = manual, `5–3600`, `1–4` clamps to `5` with `W_REFRESH_CLAMPED`; `layout_mode` `auto`/`grid`/`stack`/`fit`; `lock_style` `monochrome`/`color`; `dashboard_source` `stored`/`url` (enum values are trimmed and lowercased). Runs on the UI thread, then the in-memory config, persisted `AppConfig`, and renderer URL are updated; the page is not reloaded. An unknown name, a `null`/blank value, or an invalid value logs a warning and is ignored. Returns nothing. |
| `lockScreenEnabled()` | none | Returns the effective `show_when_locked` boolean |
| `setLockScreen(enabled)` | boolean | Toggle `show_when_locked` at runtime: persist it, apply/clear the keyguard window flags and screen receiver immediately, and push `setLocked(false)` and undim when disabling. Enabling is ignored (warning) when `kiosk=false`. |
| `storeDashboard(sourceUrl, json)` | strings; `json` ≤ 5 MiB UTF-8 | Store the dashboard JSON the renderer fetched (C-001 [Dashboard source](C-001-launch-config.md#dashboard-source)). Accepted only when `sourceUrl` equals the current `dashboard_url` exactly, `dashboard_source` is `stored`, and `sourceUrl` is not an `http://androdash.local/` URL; `json` must parse as one JSON object (nothing after it) and be at most 5 MiB (5 242 880 bytes) as UTF-8. Replaces the previous copy (see [Persistence](#persistence-and-relaunch)). Runs the file IO on the calling bridge thread. Returns `true` when stored, `false` on any rejection or IO failure (with a warning); never throws. Logs sizes only, never contents or URLs. |
| `clearStoredDashboard()` | none | Delete the stored copy; `/stored/*` answers 404 afterwards. Never throws. Returns nothing. |
| `collectorStatus()` | none | Returns the [collector](#collector-service) state as a JSON string of at most 4 KiB (UTF-8): `{"enabled": bool, "running": bool, "url": "http://127.0.0.1:19090" \| null, "targets": [{"job", "instance", "address"}], "restarts": n, "startedAt": unix ms \| null, "lastExit": string \| null}`. `enabled` is the current `collector` value; `url` and `targets` are set only when enabled (trailing targets are dropped if the list would exceed 4 KiB); `running` is true while the Prometheus process is alive; `restarts` counts supervisor restarts of the current configuration; `startedAt` is the current process's start (null when not running); `lastExit` is printable ASCII ≤ 200 characters such as `exited with code 1 after 3s`, `start failed: IOException`, or `stopped`. Never throws (falls back to the disabled shape). |

Native → renderer (not a bridge method): with `show_when_locked`, the shell
calls `window.androdash.setLocked(true|false)` through the two constant scripts
in [Lock-screen display](#lock-screen-display). The renderer owns the
simplified grayscale presentation; it must tolerate repeated calls with the
same value, and must not assume the call happens at all (browser dev, or
`show_when_locked=false`).

Rules:

- Methods are synchronous and side-effect-minimal; `setOption` and
  `setLockScreen` post their work to the UI thread; `storeDashboard` and
  `clearStoredDashboard` do bounded file IO on the bridge thread;
  `collectorStatus` reads in-memory state only. None throws to JS.
- Inputs are length-limited and never injected into shell/Intent/file APIs.
  The stored dashboard uses fixed file names; no input becomes a path.
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
4. `show_when_locked=true` with `display_mode=monochrome`: wake the locked
   emulator and confirm the dashboard is visible above the keyguard, dimmed and
   grayscale; the device still requires its normal unlock for other apps.
   Unlock: colour and system brightness return. With `kiosk=false` the extra is
   ignored.
   - Power button, on a phone with a lock screen: press power once → the
     display comes back within about a second showing the dimmed grayscale
     dashboard over the keyguard; press power again → the display stays off;
     wake manually → the dashboard is shown over the keyguard again; unlock →
     colour; press power → re-light again.
   - `AndroDash.setLockScreen(false)` from the renderer: the next lock shows
     the normal keyguard, no re-light; `lockScreenEnabled()` returns `false`
     and the setting survives relaunch without extras.
   - `lock_style=color` (extra or `AndroDash.setOption("lock_style", "color")`):
     the locked view is dimmed exactly as above but uses the colour `amoled`
     palette; the choice survives relaunch without extras.
5. Rotate: layout reflows; page does not lose data unexpectedly.
6. Force-stop + launcher relaunch: persisted demo restores.
7. Kill the WebView renderer (DevTools/`chrome://inspect` or low-memory): shell
   reloads and the dashboard recovers.
8. `debug=true` overlay can reload/exit; `debug=false` has no affordance.
9. Invalid (non-http) dashboard URL: native fatal screen, `E_CONFIG`, no blank
   WebView. A valid but unreachable dashboard URL is a renderer
   `E_DASHBOARD_FETCH` state instead — unless `dashboard_source=stored` already
   holds a copy for that exact URL, which then renders without the server.
10. Bundled dashboard: launch with
    `--es dashboard_url "http://androdash.local/dashboards/macos-node-dashboard.json"`
    and no dashboard server: the dashboard renders; `/stored/meta.json` stays
    404 (bundled URLs are never stored).
11. Stored dashboard: launch with a LAN `dashboard_url` while the server is up;
    logcat shows `dashboard stored (<n> bytes)`. Stop the server, force-stop,
    relaunch from the launcher: the same dashboard renders. Relaunch with
    `--es dashboard_source url`: `E_DASHBOARD_FETCH` while the server is down.
12. Collector (physical arm64 phone): launch with
    `--ez collector true --es collector_targets "node:mac=<mac-lan-ip>:9100"`
    and the bundled `macos-node-dashboard.json`. Logcat shows
    `collector=true: renderer uses prometheus_url=http://127.0.0.1:19090` and
    `collector starting: 1 targets`; the Collector notification appears in
    the task manager; `run-as com.mbicz.androdash ls files/collector` lists
    `prometheus.yml`, `data`, `prometheus.log`; the dashboard renders from the
    phone's Prometheus. `AndroDash.collectorStatus()` reports `running: true`.
    - Kill the Prometheus process (`run-as com.mbicz.androdash kill <pid>` or
      `kill` as shell when permitted): it is back within ~1 s and
      `restarts` increments.
    - Turn the screen off for 10 min while plugged in: the
      `count_over_time(up[5m])` series has no gaps.
    - Relaunch with `--ez collector false`: the process exits within 5 s, the
      notification goes away, and the renderer uses the configured
      `prometheus_url` again. `exitKiosk()` also stops the service.

## Test obligations

- Android unit tests: config persistence, URL building (C-001), native-only
  `lock_task`/`show_when_locked` gating by `kiosk`, the persisted
  `show_when_locked` precedence, `setOption` validation (`ConfigParserTest`),
  the re-light transitions (`LockRelightPolicyTest`: first press re-lights,
  second press stays off, manual wake is locked-lit, unlock resets), the stored
  dashboard (`DashboardStoreTest`: write/read/meta, UTF-8 size limit,
  non-object JSON rejected, overwrite, clear, meta-last consistency, the
  `storeDashboard` source gate), the virtual-origin routes
  (`AssetServerRouteTest`), and the collector (`CollectorConfigTest`:
  target grammar, `prometheus.yml`, arguments; `RestartPolicyTest`: backoff
  sequence, cap, healthy reset; `CollectorStatusTest`: payload shape, 4 KiB
  bound).
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
