# C-007 — Kiosk and lifecycle

- **Version:** 10
- **Status:** Accepted, 2026-10-29 (v3: lock-screen grayscale, re-light, view
  and lock-screen bridge methods, decision 0016; v4: generic `setOption`
  bridge method, `lock_style`, decision 0017; v5: stored dashboard bridge
  methods, `dashboard_source` option, decision 0018; v6: collector service and
  `collectorStatus`, decision 0019; v7: multiple dashboards — `setOption`
  `dashboard_url`/`dashboard_urls`/`rotate_seconds`, stored slots, API 33+
  back callback, new intents without reload, decision 0020; v8: phone exporter
  under the collector service, decision 0021; v9: `setOption` returns a
  reason, accepts remote and inline dashboard URLs, `collector`, and
  `collector_targets`; `addInlineDashboard`; `collectorStatus` always lists
  targets, decision 0023; v10: Ignition documents seed dashboards and
  collector targets once at launch, decision 0024)
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

- Back button/gesture is a no-op (do not finish):
  - API 33+: the activity sets `android:enableOnBackInvokedCallback="true"`
    and registers an `OnBackInvokedCallback` at `PRIORITY_DEFAULT` while
    `kiosk=true` that consumes Back (logs `back ignored in kiosk`), so no
    predictive-back animation peeks at the launcher. It is unregistered when a
    launch resolves `kiosk=false`.
  - Before API 33 (and on API 33, where the per-activity opt-in is not read):
    `onBackPressed` ignores Back while `kiosk=true`.
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
  `lockStyle`, `dashboardSource`, `dashboardUrl`, `dashboardUrls`,
  `rotateSeconds`, `collector`, or `collectorTargets` in the persisted
  `AppConfig` and the current renderer URL. Inline dashboards live in
  `<filesDir>/inline/<id>.json`. A
  relaunch therefore shows the last viewed dashboard.
- The stored dashboard copies (C-001 `dashboard_source=stored`, decision 0018,
  slots decision 0020) live in app-private storage as 8 fixed slots, one per
  `dashboard_urls` position: slot `i` (`0…7`) is the pair
  `<filesDir>/dashboards/stored-<i>.json` and `stored-<i>.meta.json`
  (`{"sourceUrl", "storedAt", "bytes"}`). Each file is written to a temp file,
  synced, and atomically renamed; the slot's old meta is deleted first and the
  new meta is renamed in last, and a dashboard is readable only while its meta
  exists, so an interrupted write reads as "nothing stored". Slots survive
  relaunch and reboot, are replaced by the next successful store into the same
  slot, and are all removed by `clearStoredDashboard()` or clearing app data.
  They are independent of `launch_config`. The pre-slot single copy
  (`stored.json`, `stored.meta.json`) is deleted on every Activity start.
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
  "Collecting N targets" (N includes the phone exporter job); tapping it opens
  the dashboard.
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

### Phone exporter

Decision 0021; configuration in C-001
[Phone exporter job](C-001-launch-config.md#phone-exporter-job); metrics in
[`docs/integrations/phone-exporter.md`](../integrations/phone-exporter.md);
listener rules in C-008.

- **Same lifecycle as the collector.** With `collector_phone=true`,
  `CollectorService` starts `PhoneExporter` on every start command before
  (re)starting the supervisor, and stops it in `onDestroy` and when a start
  command resolves `collector_phone=false`. A collector reconfiguration that
  keeps `collector_phone=true` leaves the exporter running. With
  `collector=false` neither runs.
- **Listener.** One daemon thread (`androdash-phone-exporter`) binds
  `127.0.0.1:19100` (`SO_REUSEADDR`, backlog 8) and serves one connection at a
  time. A failed bind is logged and retried every 5 s until stopped. Stop
  closes the listener; the thread ends without being joined.
- **Sampling at scrape time.** Each `GET /metrics` samples the phone with
  cheap framework calls and small `/proc`/`/sys` reads; nothing runs between
  scrapes, so the exporter costs no CPU while idle. Each source (`device`,
  `battery`, `thermal`, `memory`, `storage`, `network`, `wifi`, `cpu`,
  `screen`, `time`, `process`, `collector`) runs in its own try/catch: a
  failure drops only its metrics and increments
  `android_exporter_source_errors_total{source}`.
- **Never crashes the service.** Request, sampling, and listener failures are
  caught and logged (per-request failures at debug level); start/stop
  failures in `CollectorService` are logged.
- **Collector process.** `androdash_collector_up` and
  `androdash_collector_restarts_total` come from the supervisor state also used
  by `collectorStatus`; the Prometheus child's `/proc` entry is found by parent
  pid and command name (`libprometheus.s…`) once per process start.

## Lifecycle

- `onCreate`: delete the legacy stored copy, parse config, configure WebView,
  load local URL, apply kiosk. When the launch carries `ignition_url`, or
  `<filesDir>/ignition.json` exists and no such extra is given, the shell first
  fetches/reads and applies the Ignition document off the UI thread (C-001
  [Ignition](C-001-launch-config.md#ignition)): store its inline dashboards,
  merge it over the persisted config, persist, prune, sync the collector, then
  load the renderer. The source is consumed once (file deleted, extra removed)
  only after a successful apply; a failure shows `E_IGNITION` or
  `E_IGNITION_FETCH` and persists nothing.
- `onNewIntent` (`launchMode=singleTask`: launcher tap, `adb am start`, a
  SystemUI re-start right after launch): parse the intent like a launch. When
  a renderer is live (WebView present, no fatal screen) and the intent either
  carries no C-001/C-007 launch extra or resolves to the renderer URL already
  loaded, keep the WebView — no recreate, no reload — and log
  `intent without changes; keeping renderer`; only persist the config and
  re-apply kiosk/back handling, `show_when_locked`, `lock_task`, and the
  collector sync. Otherwise recreate the WebView and load the new URL.
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
| `setOption(name, value)` | strings; `name` ≤ 64 chars; `value` ≤ 2048 chars for `dashboard_url`/`dashboard_urls`/`collector_targets`, else ≤ 64 | The user changed one option in the settings sheet. `name` is one of `time_range`, `refresh_seconds`, `layout_mode`, `lock_style`, `dashboard_source`, `dashboard_url`, `dashboard_urls`, `rotate_seconds`, `collector`, `collector_targets`; `value` is validated with the C-001 rules for the launch extra of that name: durations `1s…30d`; refresh `0` = manual, `5–3600`, `1–4` clamps to `5` with `W_REFRESH_CLAMPED`; `layout_mode` `auto`/`grid`/`stack`/`fit`; `lock_style` `monochrome`/`color`; `dashboard_source` `stored`/`url` (enum values are trimmed and lowercased); `rotate_seconds` `0` or `10–3600`; `collector` `true`/`false`; `collector_targets` the C-001 target list, where the empty string (allowed for this name only) means no user targets. `dashboard_url` must be an entry of the current `dashboard_urls`. `dashboard_urls` is a comma list of 1–8 absolute `http`/`https` URLs: remote dashboards, bundled `http://androdash.local/dashboards/<name>.json`, or inline `http://androdash.local/inline/<id>.json` (decision 0023); when the current `dashboard_url` is not in the new list it is inserted first. The resulting config must be valid as a whole, including the collector (`collector=true` needs targets or `collector_phone=true`; a user target may not repeat `phone`/`phone`). Validation runs on the calling bridge thread; the accepted change is applied on the UI thread: the in-memory config, persisted `AppConfig`, and renderer URL are updated. A changed `collector` or `collector_targets` re-syncs the [collector service](#collector-service); when the Prometheus URL the renderer receives changes (collector on ↔ off) the shell reloads the renderer with the new URL; otherwise the page is not reloaded. A changed `dashboard_urls` deletes inline dashboards no longer listed. **Returns** `""` when accepted, else a short reason (≤ 120 chars) for an unknown name, a blank value, or an invalid value; the config is then unchanged. |
| `lockScreenEnabled()` | none | Returns the effective `show_when_locked` boolean |
| `setLockScreen(enabled)` | boolean | Toggle `show_when_locked` at runtime: persist it, apply/clear the keyguard window flags and screen receiver immediately, and push `setLocked(false)` and undim when disabling. Enabling is ignored (warning) when `kiosk=false`. |
| `storeDashboard(sourceUrl, json)` | strings; `json` ≤ 5 MiB UTF-8 | Store the dashboard JSON the renderer fetched (C-001 [Dashboard source](C-001-launch-config.md#dashboard-source)) in slot `i`, the position of `sourceUrl` in the current `dashboard_urls`. Accepted only when `sourceUrl` equals a `dashboard_urls` entry exactly, `dashboard_source` is `stored`, and `sourceUrl` is not an `http://androdash.local/` URL; `json` must parse as one JSON object (nothing after it) and be at most 5 MiB (5 242 880 bytes) as UTF-8. Replaces that slot's previous copy (see [Persistence](#persistence-and-relaunch)). Runs the file IO on the calling bridge thread. Returns `true` when stored, `false` on any rejection or IO failure (with a warning); never throws. Logs sizes and the slot only, never contents or URLs. |
| `clearStoredDashboard()` | none | Delete every stored slot; `/stored/*` answers 404 afterwards. Never throws. Returns nothing. |
| `addInlineDashboard(json)` | string ≤ 5 MiB UTF-8 | Store a dashboard document the user pasted in the settings sheet (decision 0023). `json` must parse as one JSON object (nothing after it) and be at most 5 MiB as UTF-8. The exact text is written atomically to app-private `inline/<id>.json`, where `id` is the first 16 lowercase hex characters of its SHA-256 (the same text gives the same id). Returns `http://androdash.local/inline/<id>.json`, or `""` when rejected or on IO failure; never throws. It does not change `dashboard_urls`: the renderer adds the URL with `setOption("dashboard_urls", …)`. Inline files no longer listed in `dashboard_urls` are deleted whenever `dashboard_urls` changes (by `setOption` or a launch); at most 8 are kept. Logs size and id, never contents. |
| `collectorStatus()` | none | Returns the [collector](#collector-service) state as a JSON string of at most 4 KiB (UTF-8): `{"enabled": bool, "running": bool, "url": "http://127.0.0.1:19090" \| null, "targets": [{"job", "instance", "address"}], "restarts": n, "startedAt": unix ms \| null, "lastExit": string \| null}`. `enabled` is the current `collector` value; `url` and `targets` are set only when enabled; `targets` lists the phone exporter job (`phone`/`phone`/`127.0.0.1:19100`) first when `collector_phone=true`, then `collector_targets` (trailing targets are dropped if the list would exceed 4 KiB); `running` is true while the Prometheus process is alive; `restarts` counts supervisor restarts of the current configuration; `startedAt` is the current process's start (null when not running); `lastExit` is printable ASCII ≤ 200 characters such as `exited with code 1 after 3s`, `start failed: IOException`, or `stopped`. Never throws (falls back to the disabled shape). |

Native → renderer (not a bridge method): with `show_when_locked`, the shell
calls `window.androdash.setLocked(true|false)` through the two constant scripts
in [Lock-screen display](#lock-screen-display). The renderer owns the
simplified grayscale presentation; it must tolerate repeated calls with the
same value, and must not assume the call happens at all (browser dev, or
`show_when_locked=false`).

Rules:

- Methods are synchronous and side-effect-minimal; `setOption` validates on
  the bridge thread and posts the change to the UI thread, `setLockScreen`
  posts its work to the UI thread; `storeDashboard`, `clearStoredDashboard`,
  and `addInlineDashboard` do bounded file IO on the bridge thread;
  `collectorStatus` reads in-memory state only. None throws to JS.
- Inputs are length-limited and never injected into shell/Intent/file APIs.
  The stored dashboards use fixed file names per slot; the slot is the bounded
  position in `dashboard_urls`. An inline dashboard's file name is a hash the
  shell computes; no input becomes a path.
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
   On API 34+ (gesture navigation) a back swipe shows no predictive-back
   preview of the launcher and logcat shows `back ignored in kiosk`.
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
    and no dashboard server: the dashboard renders; `/stored/0/meta.json` stays
    404 (bundled URLs are never stored).
11. Stored dashboard: launch with a LAN `dashboard_url` while the server is up;
    logcat shows `dashboard stored (slot 0, <n> bytes)`. Stop the server,
    force-stop, relaunch from the launcher: the same dashboard renders.
    Relaunch with `--es dashboard_source url`: `E_DASHBOARD_FETCH` while the
    server is down.
12. Collector (physical arm64 phone): launch with
    `--ez collector true --es collector_targets "node:mac=<mac-lan-ip>:9100"`
    and the bundled `macos-node-dashboard.json`. Logcat shows
    `collector=true: renderer uses prometheus_url=http://127.0.0.1:19090` and
    `collector starting: 2 targets (phone true)`; the Collector notification appears in
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
13. Return without reload: with the dashboard showing, press Home, then tap
    the launcher icon (and separately re-run the same `adb am start` command):
    logcat shows `intent without changes; keeping renderer`, no
    `renderer loaded`, and the page keeps its state (no reload flash). A
    relaunch with a different `dashboard_url` does reload.
14. Multiple dashboards: launch with
    `--es dashboard_urls "http://androdash.local/dashboards/agenticmac-dashboard.json,http://androdash.local/dashboards/macos-node-dashboard.json" --es rotate_seconds 60`:
    the first dashboard shows; the renderer switches (swipe, or every 60 s)
    with `setOption("dashboard_url", …)` (logcat `option set … dashboard=2/2`);
    force-stop and relaunch from the launcher shows the last viewed one.
15. Phone exporter: launch with only `--ez collector true` (no
    `collector_targets`, Mac unreachable is fine). Logcat shows
    `phone exporter listening on 127.0.0.1:19100` and
    `collector starting: 1 targets (phone true)`; within one scrape interval
    `up{job="phone"}` is `1` on `127.0.0.1:19090` and
    `android_battery_level_ratio` has a sample. Relaunch with
    `--ez collector_phone false --es collector_targets "node:mac=<mac-lan-ip>:9100"`:
    the log shows `phone exporter stopped` and port 19100 refuses connections;
    `--ez collector false` stops both.

## Test obligations

- Android unit tests: config persistence, URL building (C-001), native-only
  `lock_task`/`show_when_locked` gating by `kiosk`, the persisted
  `show_when_locked` precedence, `setOption` validation (`ConfigParserTest`),
  the re-light transitions (`LockRelightPolicyTest`: first press re-lights,
  second press stays off, manual wake is locked-lit, unlock resets), the stored
  dashboard slots (`DashboardStoreTest`: write/read/meta per slot, slot
  bounds, independent slots, UTF-8 size limit, non-object JSON rejected,
  overwrite, clear-all, meta-last consistency, legacy cleanup, the
  `storeDashboard` slot gate), the intent-without-changes decision
  (`ConfigParserTest`: `hasConfigExtras`, `keepsRenderer`), the virtual-origin routes
  (`AssetServerRouteTest`), and the collector (`CollectorConfigTest`:
  target grammar, `prometheus.yml`, arguments; `RestartPolicyTest`: backoff
  sequence, cap, healthy reset; `CollectorStatusTest`: payload shape, 4 KiB
  bound, phone target), and the phone exporter (`PhoneMetricsTest`: exposition
  text, omission, escaping, unit conversions, `/proc` parsing; `MiniHttpTest`:
  bounded request head, request line, routing, response framing).
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
