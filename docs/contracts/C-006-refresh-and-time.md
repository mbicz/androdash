# C-006 — Refresh and time semantics

- **Version:** 3
- **Status:** Accepted, 2026-10-27 (v2: in-app time range and refresh controls,
  runtime interval change, header status without a countdown; decision 0015);
  amended 2026-10-28 (v3: controls move to the settings sheet, persisted one
  option at a time with `setOption`; decision 0017)
- **Consumers:** Web renderer (W2)
- **Related:** C-001 (refresh/time params), C-002 (dashboard duration/refresh), C-003 (range queries), C-005 (time axis, settings sheet), C-007 (`setOption` bridge), C-009 (status)

## Purpose

Define what "now", "refresh", "stale", and "manual" mean so every panel, the
header status, the in-app view controls, and tests agree.

## Time range resolution

For a dashboard boot/refresh cycle:

1. the in-app choice (see [In-app view controls](#in-app-view-controls)), if the
   user made one;
2. else `time_range` from C-001, if set;
3. else dashboard `spec.duration` if valid;
4. else `1h`.

In the Android app an in-app choice is persisted by the shell into the launch
config (C-007 `setOption`), so on later loads it arrives as `time_range` (1 → 2)
until a launch with an explicit extra replaces it. In a plain browser it lasts
for the session only.

The range must be `1s…30d`. Duration grammar is C-002.

- `end` = wall-clock time captured once per cycle (Unix ms).
- `start` = `end - range`.
- All panels in the cycle use the same `start`/`end`; the window is also every
  chart's x domain (C-005), not the extent of the returned data.
- `step_seconds` overrides; otherwise `max(15, ceil(rangeSeconds / 240))`
  (C-003).
- Display timestamps in local time; machine artifacts use UTC ISO-8601 and Unix
  seconds for Prometheus.

No timezone configuration in v1. The phone's clock is authoritative; a wildly
wrong clock produces empty/odd charts, not a server correction.

## Refresh interval resolution

Precedence:

1. the in-app choice, if the user made one (persisted as above);
2. else `refresh_seconds` from C-001 (`0` = manual only);
3. else dashboard `spec.refreshInterval` (`0s` = manual only);
4. else `30` seconds.

Clamps (C-001/C-002):

- `refresh_seconds` 1–4 → 5 s + `W_REFRESH_CLAMPED`;
- dashboard refresh 1–4 s → 5 s + `W_REFRESH_CLAMPED`;
- max auto interval: 3600 s; values above are rejected for `refresh_seconds`
  and clamped with `W_REFRESH_CLAMPED` for dashboard values;
- `0` disables auto refresh but does not disable the initial load.

Manual mode still performs the initial refresh and can be refreshed via the
header refresh action, the debug overlay, or `window.androdash.refresh()`.

## In-app view controls

The header's settings button (sliders icon, `aria-label="View settings"`) opens
the view settings sheet (C-005); the page itself carries no time controls. The
sheet offers:

- **Time range:** a segmented control (`role="radiogroup"`, each segment
  `role="radio"` with `aria-checked` and `aria-label="Last <range>"`) with the
  presets `5m`, `15m`, `1h`, `6h`, `24h`, `7d`. If the effective range (launch
  param or dashboard) is not one of them, it is added as one more segment,
  sorted by duration.
- **Refresh:** a segmented control (`aria-label="Refresh interval"`) with
  `Off`, `5s`, `10s`, `30s`, `1m`, `5m`, plus the effective interval if it is
  not one of them (sorted).

A choice applies immediately:

- a new range updates the effective range and `config.timeRange` and starts a
  refresh now (coalesced if a cycle is running), so every panel redraws on the
  new window;
- a new interval updates `config.refreshSeconds` and calls
  `Scheduler.setIntervalSeconds(seconds)`: the next cycle is rescheduled
  `seconds` from now (not from the last settle); `0` switches to manual. A
  cycle that is running keeps running and schedules itself with the new
  interval when it settles;
- choosing the current value is a no-op;
- then, when the shell bridge is present, the renderer calls
  `AndroDash.setOption(name, value)` for the option that changed —
  `("time_range", "<range>")` or `("refresh_seconds", "<seconds>")`, values as
  strings. The shell validates and persists it (C-007); bridge errors are
  swallowed. Without a shell the choice is session-only.

The sheet also holds the layout and lock-screen choices (C-005). The locked
view (C-005) hides the header actions and closes an open sheet, so the sheet
is never shown while locked; refreshing continues.

## Cycle lifecycle

States:

```
idle ──start──► running ──settle──► idle (schedule next)
                    │
                    └─ manual request while running → coalesce one rerun
```

Rules:

1. **Initial load:** after dashboard normalization/capability filtering/layout,
   start one cycle immediately.
2. **No overlap:** if a cycle is running, do not start another. A manual
   `refresh()` during a run sets `rerunAfter = true`; run once when it settles.
3. **Per-panel independence:** every eligible data panel fetches concurrently
   (bounded by the browser); one panel's failure does not abort others.
4. **Settle:** a cycle settles when every visible data panel has succeeded or
   failed. Markdown-only dashboards settle immediately.
5. **Schedule:** when settled, schedule the next cycle `refreshSeconds` after
   settle (not from cycle start). This avoids tight loops on slow networks.
6. **Manual only:** with `refreshSeconds = 0`, do not schedule; wait for
   `refresh()`.
7. **Reload:** `reloadDashboard()` re-fetches the dashboard JSON, re-probes
   capabilities, re-resolves variables, rebuilds layout, and starts a cycle.
   A normal refresh does **not** re-fetch dashboard JSON.
8. **Page visibility:**
   - `document.visibilityState === "hidden"` → do not start new cycles; abort or
     let the current cycle finish; clear the timer.
   - becoming visible → if the last successful update is older than the refresh
     interval (or no successful update), start a cycle immediately; otherwise
     schedule normally.
9. **Unload:** abort in-flight fetches on `pagehide`/unload; clear timers.
10. **Clock changes:** each cycle re-reads wall clock; do not assume monotonic
    time across visible/hidden transitions.

## Per-cycle data rules

- Capture `end` once; pass it to all range queries and instant queries.
- Do not mix windows within a panel (all queries in a panel share the window).
- On success: replace panel data, clear stale/error, update last value/time.
- On error:
  - if the panel has previous data, keep it and mark `stale` with the error;
  - if not, show the error state;
  - other panels continue;
  - the cycle still settles (does not hang).
- On partial data (some series missing), update with what arrived; do not keep
  stale series that are no longer present? For v1, replace the panel's series
  set with the latest successful response; if the response is empty, show
  `empty` but keep last-good behind the stale state? Simpler: an empty successful
  response is `empty` and clears previous data (the metric disappeared). An
  error keeps last-good.
- Last-good data is retained across cycles until a success or reload; there is no
  time-based expiry in v1. Staleness is always visible.

## Staleness and status

- Stale = last data exists but the latest cycle failed for that panel.
- The panel shows a `Stale` badge and the stale explanation line (C-005).
- One dashboard-wide status lives in the sticky header under the title
  (C-009): a state dot and one line of text — the last successful update time,
  `Stale since …`, `N of M failing · …`, `Offline [since …]`, or `Loading`.
- There is no next-refresh countdown and no per-second ticker. The status is
  recomputed only when a cycle settles or the scheduler state changes, so
  nothing runs while the dashboard is idle between refreshes. The next refresh
  time stays available in diagnostics (`nextRefreshAt`).
- A dashboard with some successes and some failures is `degraded`, not "live".
- A dashboard with no successful data panels is `error` (Markdown-only
  dashboards are `live` if loaded).
- No spinner that runs forever.

## Dashboard-level failure

If the dashboard fetch/normalize fails at boot, no refresh cycle exists. Show the
fatal card with `E_DASHBOARD_*` and a reload affordance (debug). If a reload
fails, keep the last good dashboard and show a non-fatal dashboard error? v1:
reload failure keeps the current dashboard and records `E_DASHBOARD_FETCH` with a
stale dashboard marker; the current data cycles continue. On first boot there is
nothing to keep → fatal.

## API and test seams

- `window.androdash.refresh()` → start a cycle now or coalesce.
- `window.androdash.reloadDashboard()` → re-fetch dashboard + capabilities.
- `window.androdash.getDiagnostics()` → includes `lastRefresh`, `nextRefreshAt`,
  cycle counts, error counts.
- `Scheduler.setIntervalSeconds(seconds)` → runtime interval change (in-app
  control).
- Scheduler accepts an injected clock/`setTimeout` for tests; production uses
  `Date.now`/`setTimeout`.
- Tests may force visibility state via the scheduler API.

## Timing edge cases

- Range `1s`, step auto = 15 s → one/zero samples; that's allowed; show empty if
  no points.
- Refresh 5 s with slow queries → cycles take as long as they take; next starts
  5 s after settle.
- Hidden page during a cycle: finish or abort; do not schedule from hidden state.
- System clock jumps backward: next cycle uses the new wall clock; charts may
  look odd; no attempt to correct.
- `refresh_seconds=0` + hidden → no work; visible → no auto work unless stale?
  Manual mode does not auto-refresh on visibility; keep explicit.

## Test obligations

`web/tests/contract/c006-refresh.test.js`:

- precedence (param > dashboard > default);
- `0` manual mode;
- clamp/warnings;
- no overlapping cycles;
- coalesced manual rerun;
- shared window across panels;
- visibility pause/resume;
- schedule after settle;
- runtime interval change reschedules from now; `0` switches to manual;
- keep-last-good on error, empty clears;
- dashboard re-fetch only on reload;
- status state transitions/degraded;
- injected clock/timer determinism.

## Out of scope

- Calendar/timezone UI and custom (absolute) ranges.
- Server-side time alignment.
- Streaming queries.
- Cross-cycle caching.
- Historical snapshots.
