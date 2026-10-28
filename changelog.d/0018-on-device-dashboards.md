---
id: 0018
date: 2026-10-28
status: accepted
kind: contract
scope: renderer, android
supersedes: []
---

# On-device dashboards: bundled, stored copy, or live from the URL

## Context

The phone is meant to run unattended, but every launch fetched the dashboard
definition from a static server on the Mac (`tools/serve_demo.py`). When that
server was down — it ran only during development sessions — the phone could not
start, even though Prometheus was up. The user asked to keep dashboards on the
device, with fetching from the URL still available as an option.

## Decision

1. **Bundled dashboards.** Every `contracts/fixtures/*-dashboard.json` is copied
   into the APK at build time (Gradle `copyDashboardAssets`, run from
   `preBuild`) and served at `http://androdash.local/dashboards/<file>.json`,
   which is a valid `dashboard_url`. A bundled dashboard is always local and
   never stored.
2. **Stored copy.** New C-001 field `dashboard_source`: `stored` (default) |
   `url` (additive; `schemaVersion` stays 1; also a `setOption` name). In
   `stored` mode the renderer loads `/stored/dashboard.json` when
   `/stored/meta.json`'s `sourceUrl` equals `dashboard_url` and does not contact
   the dashboard server. Otherwise it fetches `dashboard_url`, normalizes it,
   and hands the JSON to the new bridge method
   `AndroDash.storeDashboard(sourceUrl, json)`. A new `dashboard_url` replaces
   the copy on its first successful load. `url` mode fetches on every load and
   stores nothing. Without the shell (browser), `stored` behaves like `url`.
3. **The shell stores bytes, not dashboards.** It accepts only the current
   `dashboard_url` in `stored` mode, never an `androdash.local` URL, and only a
   single JSON object of at most 5 MiB. It keeps one copy in app-private
   storage under fixed names (`dashboards/stored.json`, then
   `stored.meta.json` `{sourceUrl, storedAt, bytes}`), each written via temp
   file + fsync + atomic rename, meta last; each file is readable only while
   its partner exists, so an interrupted write reads as "nothing stored".
   `clearStoredDashboard()` removes it. Logs carry byte counts only.
4. **Untrusted either way (C-008).** Stored and bundled JSON are served back
   verbatim only to the virtual origin (`no-store`, `nosniff`, `DENY`) and
   normalized by the renderer like any fetched dashboard. No path parameter or
   JSON field reaches the filesystem.
5. **Refresh path.** Settings → Dashboard: "Saved on phone" | "Live from URL",
   the time the copy was saved, and "Update from URL", which replaces the copy
   only if the new definition normalizes. A stored copy that cannot be read or
   normalized records `W_STORED_DASHBOARD_INVALID` and is re-fetched; a refused
   store records `W_DASHBOARD_NOT_STORED`. Diagnostics carry the dashboard
   `source` (`stored` | `url` | `bundled`) and `storedAt`.

Alternatives rejected: parsing or caching dashboards in Kotlin (AGENTS.md hard
rule: no dashboard logic in the shell); WebView DOM storage (C-008 keeps it
disabled; the shell owns persistence); keying the store by URL (would let the
page add files; one slot is enough for an appliance).

## Consequences

### Positive

- After one successful load the phone starts and renders with the dashboard
  server down; only Prometheus must be reachable.
- Bundled dashboards need no server at all, even on first launch.
- Live fetching remains one setting away.

### Negative / risks

- Edits on the dashboard server reach a phone in `stored` mode only after
  "Update from URL", a `dashboard_url` change, `dashboard_source=url`, or
  `clearStoredDashboard()`.
- Bundled dashboards change only with a new APK.
- Switching the source from the settings sheet posts `setOption` and reloads in
  the same moment; if the store request reaches the shell first it is refused
  (`W_DASHBOARD_NOT_STORED`) and the next load stores the copy.

## Contracts affected

- C-001 v4 (`dashboard_source`), C-002 v2 (dashboard sources), C-007 v5
  (`storeDashboard`, `clearStoredDashboard`, `setOption` name, stored files),
  C-008 v2 (stored dashboard trust model and routes), C-009 (diagnostics
  `source`/`storedAt`, two warning codes); `contracts/app-config.schema.json`,
  `contracts/diagnostics.schema.json`, and their example fixtures.

## Verification

```sh
mise exec -- node --test web/tests/               # 80 pass, incl. c002-stored
mise exec -- ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
unzip -l app/build/outputs/apk/debug/app-debug.apk | grep dashboards/
python3 tools/check_docs.py
```

On the Pixel 10: first launch stores the copy; with `serve_demo.py` stopped the
app still starts and renders from the stored copy; a bundled `dashboard_url`
renders with no server.
