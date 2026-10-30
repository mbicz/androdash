---
id: 0023
date: 2026-10-29
status: accepted
kind: contract
scope: android, renderer, security, tooling
supersedes: []
---

# Dashboards and collector targets are edited in the app

## Context

The settings sheet could add only dashboards compiled into the APK. Remote
dashboard URLs and collector targets came from adb launch extras alone, a rule
from decision 0020 meant to stop page content from pointing the kiosk
elsewhere. In practice the phone could not be set up without a computer. The
bundled demo and Spark dashboards also showed "No data": their Prometheus
targets (the mock, a Spark exporter) could not be added from the phone. The
mock could not be scraped at all, so the demo had no data under the on-phone
collector.

## Decision

1. **Dashboards from anywhere.** `setOption("dashboard_urls", …)` accepts any
   absolute `http`/`https` URL. This supersedes the "page never introduces a
   remote URL" rule of decision 0020. In the settings sheet, **Add from URL**
   fetches and normalizes the dashboard first and adds it only if that
   succeeds.
2. **Inline dashboards.** **Paste dashboard JSON** validates the text in the
   page, then calls the new bridge method `addInlineDashboard(json)`. The shell
   stores the text as `files/inline/<sha256-prefix>.json` and serves it at
   `http://androdash.local/inline/<id>.json`. It is a local dashboard like a
   bundled one. Files that leave `dashboard_urls` are deleted.
3. **Collector in the app.** `setOption` accepts `collector` and
   `collector_targets`; an empty `collector_targets` means no user targets. The
   sheet shows On/Off, the targets with Remove, and an Add target form. A
   change re-syncs the collector service. When the renderer's Prometheus URL
   changes, the shell reloads the page.
4. **`setOption` returns a reason.** It validates on the bridge thread and
   returns `""` or a short error, so the sheet can show why a URL or target was
   refused.
5. **`collectorStatus().targets`** always lists the configured targets, so a
   disabled collector can still be edited.
6. **Scrapeable demo.** `tools/mock_prometheus.py` serves the demo metrics on
   `/metrics`. A phone with the collector shows the bundled demo after adding
   the target `demo:demo=<host>:9091`.

## Consequences

### Positive

- A phone can be set up entirely from its own screen: dashboards, data
  sources, and targets.
- Inline dashboards need no server at all.

### Negative / risks

- Script running in the page could now add a remote dashboard URL or a scrape
  target. The renderer still has no path from dashboard or Prometheus content
  to script (C-008 untrusted content), dashboard fetches remain CORS `fetch`
  requests, and targets are scraped by Prometheus, not by the WebView. The
  change widens what a compromised page could configure, not what it could
  execute.
- Typing URLs and `host:port` on a phone keyboard is slow; launch extras remain
  available.

## Contracts affected

- C-001: runtime-editable `dashboard_urls` (any URL), `collector`,
  `collector_targets`; inline dashboard URLs.
- C-002: `inline` dashboard source.
- C-005: settings sheet Dashboards and Collector groups.
- C-007 v9: `setOption` return value and names, `addInlineDashboard`,
  `collectorStatus` targets.
- C-008 v6: `/inline/<id>.json` route; the page may add remote dashboards and
  targets from user input.

## Verification

- `node --test web/tests/`, `python3 -m unittest discover -s tools -p 'test_*.py'`,
  and `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`
  pass.
- On the phone: adding a dashboard by URL from `tools/serve_demo.py`, pasting
  dashboard JSON, adding the mock as target `demo:demo=<host>:9091` (the demo
  dashboard then renders from the collector), removing it, and switching the
  collector off and on.
