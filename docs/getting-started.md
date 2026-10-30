# Getting started

This guide takes you from a clone to a phone showing live dashboards. Every
command here was run against the current code. For the full option set, see
[C-001 Launch configuration](contracts/C-001-launch-config.md). For every
development command, see [`development.md`](development.md).

1. [Try it in a browser](#1-try-it-in-a-browser)
2. [Build and install the app](#2-build-and-install-the-app)
3. [First launch: the phone dashboard](#3-first-launch-the-phone-dashboard)
4. [Show a Mac's metrics](#4-show-a-macs-metrics)
5. [Choose dashboards](#5-choose-dashboards)
6. [Use it day to day](#6-use-it-day-to-day)
7. [Bring your own dashboard](#7-bring-your-own-dashboard)
8. [Troubleshooting](#8-troubleshooting)

## 1. Try it in a browser

The renderer is plain HTML and ES modules, so any browser runs it. The mock
Prometheus returns deterministic values for every query in the bundled
fixtures.

```sh
python3 tools/mock_prometheus.py --port 9091
python3 tools/serve_demo.py --port 8099
```

Open one of these:

| Dashboard | URL |
|---|---|
| Spark Exporter, fit to screen | <http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/spark-dashboard.json&prometheus_url=http://localhost:9091&layout_mode=fit> |
| Demo, with the diagnostics overlay | <http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/demo-dashboard.json&prometheus_url=http://localhost:9091&debug=true> |

Launch options are the same query parameters in the browser and intent extras
on the phone.

## 2. Build and install the app

| Need | Notes |
|---|---|
| Android phone, arm64, Android 8+ | Developer options → USB or wireless debugging on |
| JDK 17+, Android SDK platform 35, adb | `mise install` provides JDK 21, Node, Python, and Gradle from [`.mise.toml`](../.mise.toml) |
| ~1 GB free disk | The first build downloads the pinned Prometheus release (~100 MB) into `~/.gradle/androdash-cache/`; `app/build` grows to ~600 MB |

```sh
mise exec -- ./gradlew :app:assembleDebug
adb devices                                     # the phone must be listed
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Wireless debugging works too: pair with `adb pair <ip:port>`, then use
`adb -s <serial>` in every command below.

## 3. First launch: the phone dashboard

The app has no configuration until it is launched with extras once. The
configuration then persists: the launcher icon, a reboot, or a crash all
restore it.

```sh
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_url "http://androdash.local/dashboards/phone-dashboard.json" \
  --ez collector true \
  --es layout_mode fit
```

- `http://androdash.local/dashboards/…` is a dashboard bundled in the APK. It
  needs no server.
- `collector=true` starts the bundled Prometheus as a foreground service
  ("Collector" notification). It listens on `127.0.0.1:19090`, and the dashboard
  queries it there.
- The collector scrapes the in-app phone exporter (`127.0.0.1:19100`) by
  default, so it has a target with no further setup.
- History starts empty and charts fill as scrapes arrive (every 15 s by
  default).

Expected result: the title is the phone model (for example "Pixel 10"), every
panel shows data within about 30 s, and the "Collector targets" panel lists
`phone · phone` with `1`.

The collector holds a partial wake lock so scrapes continue while the phone
dozes. Keep the phone on a charger.

## 4. Show a Mac's metrics

Run node_exporter on the Mac and make it reachable from the phone:

```sh
brew install node_exporter
echo '--web.listen-address=0.0.0.0:9100' > "$(brew --prefix)/etc/node_exporter.args"
brew services start node_exporter
ipconfig getifaddr en0          # the Mac's LAN address, e.g. 192.168.1.20
```

There are two ways to get the Mac's metrics onto the phone.

### A. The phone scrapes the Mac (recommended)

Prometheus runs on the phone and the Mac only runs exporters. The phone keeps
its history while the Mac sleeps or travels.

```sh
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_urls "http://androdash.local/dashboards/macos-node-dashboard.json,http://androdash.local/dashboards/phone-dashboard.json" \
  --ez collector true \
  --es collector_targets "node:mac=192.168.1.20:9100" \
  --es layout_mode fit
```

`collector_targets` is a comma-separated list of `[job:]instance=host:port`
entries, at most 32. The bundled dashboards expect these jobs: `node` for
node_exporter, `agenticmac` for
[agenticmac-exporter](integrations/agenticmac-exporter.md), and `phone`, which
is added automatically.

### B. The phone queries the Mac's Prometheus

If you already run Prometheus, point the renderer at it. Its default
`--web.cors.origin=.*` already allows `http://androdash.local`.

```sh
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_url "http://androdash.local/dashboards/macos-node-dashboard.json" \
  --es prometheus_url "http://192.168.1.20:9090"
```

Prometheus must listen beyond loopback (`--web.listen-address=0.0.0.0:9090`).

### Away from home: Tailscale

Exporters that listen on `0.0.0.0` are also reachable over Tailscale. Use the
Mac's tailnet address (`tailscale ip -4`) or its MagicDNS name in
`collector_targets` or `prometheus_url`. The phone can then follow the Mac
anywhere. If the phone's active network is the Tailscale VPN, the phone
exporter still reports Wi-Fi signal from the underlying Wi-Fi network.

> **Security.** Prometheus and the exporters have no authentication here. Keep
> them on a trusted LAN or tailnet ([decision 0006](../changelog.d/0006-cleartext-lan-http.md),
> [C-008](contracts/C-008-webview-security.md)).

## 5. Choose dashboards

| Option | Example | Effect |
|---|---|---|
| `dashboard_urls` | `--es dashboard_urls "<url>,<url>"` | Up to 8 dashboards; swipe sideways between them |
| `rotate_seconds` | `--ei rotate_seconds 60` | Advance automatically; `0` turns rotation off, otherwise 10–3600 |
| `layout_mode` | `--es layout_mode fit` | `fit` puts every panel on one screen; `auto`/`grid`/`stack` scroll |
| `display_mode` | `--es display_mode amoled` | `standard`, true-black `amoled`, or grayscale `monochrome` |
| `show_when_locked` | `--ez show_when_locked true` | Keep the dashboard above the keyguard, dimmed, in grayscale or colour (`lock_style`) |
| `time_range` / `refresh_seconds` | `--es time_range 1h --ei refresh_seconds 30` | Override the dashboard's defaults |
| `dashboard_source` | `--es dashboard_source url` | `stored` (default) keeps a copy of a remote dashboard on the phone; `url` fetches it on every load |

Most of these can also be changed on the phone. Tap the settings button (the
sliders icon) to open the sheet: time range, refresh, layout, dashboards
(show, add a bundled one, remove, rotate), the stored dashboard copy, the
collector status, and the lock-screen view. Changes apply at once and persist.

The settings sheet can add bundled dashboards but never new remote URLs. Remote
URLs come only from launch extras, so content on a dashboard page cannot point
the kiosk somewhere else.

## 6. Use it day to day

| Gesture | Does |
|---|---|
| Swipe left / right | Next or previous dashboard (anywhere in fit layout; on the header in scroll layouts) |
| Vertical drag on a panel | Scrolls that panel's content; the panels stay put |
| Double-tap a panel | Zoom it to full screen with larger type; double-tap again to return |
| Tap a row title (scroll layouts) | Collapse or expand the row |
| Back | Ignored in kiosk mode |

The status dot next to the clock is green when data is fresh, amber when it is
stale, and red on error. Panels show the same states on their edge. A panel
that cannot be rendered is hidden, never drawn with made-up data.

To leave kiosk mode, relaunch with `--ez kiosk false` (Back then exits) or run
`adb shell am force-stop com.mbicz.androdash`. With `--ez collector false` the
collector stops and the configured `prometheus_url` is used again.

## 7. Bring your own dashboard

Any Perses dashboard JSON served over HTTP(S) works if it stays inside the
supported subset:

- panels: `TimeSeriesChart`, `StatChart`, `GaugeChart`, `Table`, `Markdown`
  ([C-005](contracts/C-005-panel-rendering.md#supported-panels));
- queries: Prometheus time-series queries, with dashboard variables
  ([C-002](contracts/C-002-dashboard-source.md),
  [C-004](contracts/C-004-capability-negotiation.md)).

The server must allow CORS from `http://androdash.local` (or `*`).
`tools/serve_demo.py --host <lan-ip>` does this for files in the repository.
After the first successful load the phone keeps a copy, so the server can go
away.

To bundle a dashboard in the APK, add `contracts/fixtures/<name>-dashboard.json`
and rebuild. It is then served at
`http://androdash.local/dashboards/<name>-dashboard.json` and offered in the
settings sheet. The bundled dashboards are generated by scripts such as
[`tools/gen_phone_dashboard.py`](../tools/gen_phone_dashboard.py) and
[`tools/gen_agenticmac_dashboard.py`](../tools/gen_agenticmac_dashboard.py).
Copy one as a starting point and validate each query against a real Prometheus
first.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Native screen with `E_CONFIG` | First launch had no extras, or a value is invalid; the screen names the field. Relaunch with valid extras. |
| `E_DASHBOARD_FETCH` | The phone cannot reach the URL, or the server lacks CORS. Use a bundled dashboard to rule out the network. |
| A panel says No data | The query matched nothing. Check `up` for its job in Prometheus (or the "Collector targets" panel), and check that the exporter listens on `0.0.0.0`, not `127.0.0.1`. |
| Collector targets show `0` | The phone cannot reach `host:port`. From the Mac: `curl http://<ip>:9100/metrics`. Check the firewall, the Wi-Fi/VLAN, or Tailscale. |
| Charts empty right after launch | Collector history starts empty; wait a few scrape intervals. |
| Anything else | Relaunch with `--ez debug true` for the diagnostics overlay, and watch `adb logcat -s AndroDash`. |

More: [`development.md` § Troubleshooting](development.md#10-troubleshooting),
[collector inspection commands](development.md#prometheus-on-the-phone-collector).
