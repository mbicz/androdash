# C-006 — Refresh and time semantics

- **Version:** 1
- **Status:** Accepted, 2026-10-26
- **Consumers:** Web renderer (W2)
- **Related:** C-001 (refresh/time params), C-002 (dashboard duration/refresh), C-003 (range queries), C-009 (status)

## Purpose

Define what "now", "refresh", "stale", and "manual" mean so every panel, the
status line, and tests agree.

## Time range resolution

For a dashboard boot/refresh cycle:

1. `time_range` from C-001, if set;
2. else dashboard `spec.duration` if valid;
3. else `1h`.

The range must be `1s…30d`. Duration grammar is C-002.

- `end` = wall-clock time captured once per cycle (Unix ms).
- `start` = `end - range`.
- All panels in the cycle use the same `start`/`end`.
- `step_seconds` overrides; otherwise `max(15, ceil(rangeSeconds / 240))`
  (C-003).
- Display timestamps in local time; machine artifacts use UTC ISO-8601 and Unix
  seconds for Prometheus.

No timezone configuration in v1. The phone's clock is authoritative; a wildly
wrong clock produces empty/odd charts, not a server correction.

## Refresh interval resolution

Precedence:

1. `refresh_seconds` from C-001 (`0` = manual only);
2. else dashboard `spec.refreshInterval` (`0s` = manual only);
3. else `30` seconds.

Clamps (C-001/C-002):

- `refresh_seconds` 1–4 → 5 s + `W_REFRESH_CLAMPED`;
- dashboard refresh 1–4 s → 5 s + `W_REFRESH_CLAMPED`;
- max auto interval: 3600 s; values above are rejected for `refresh_seconds`
  and clamped with `W_REFRESH_CLAMPED` for dashboard values;
- `0` disables auto refresh but does not disable the initial load.

Manual mode still performs the initial refresh and can be refreshed via the debug
overlay/`window.androdash.refresh()`.

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
- The panel shows a stale badge and the last successful time.
- The status line shows:
  - live/stale/error state;
  - last successful update time (local);
  - next refresh time/countdown (or "manual");
  - hidden panel count;
  - error count.
- A dashboard with some successes and some failures is `degraded`, not "live".
- A dashboard with no successful data panels is `error` (Markdown-only
  dashboards are `live` if loaded).
- Status updates when each panel settles; no spinner that runs forever.

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
- keep-last-good on error, empty clears;
- dashboard re-fetch only on reload;
- status state transitions/degraded;
- injected clock/timer determinism.

## Out of scope

- Calendar/timezone UI.
- Server-side time alignment.
- Streaming queries.
- Cross-cycle caching.
- Historical snapshots.
