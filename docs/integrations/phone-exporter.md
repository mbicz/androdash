# Phone exporter

**Status:** implemented in the Android shell (decision 0021); unit-tested on
the JVM.
**Exporter:** in the app — `PhoneExporter` + `PhoneSampler` + `PhoneMetrics`
(`app/src/main/java/com/mbicz/androdash/`), started by `CollectorService`.
**Contracts:** C-001 [Phone exporter job](../contracts/C-001-launch-config.md#phone-exporter-job),
C-007 [Phone exporter](../contracts/C-007-kiosk-lifecycle.md#phone-exporter),
C-008 [Phone exporter listener](../contracts/C-008-webview-security.md#phone-exporter-listener-decision-0021).

## What it is

A minimal Prometheus exporter for the phone itself, inside the app, so the
on-phone collector always has a target and a phone dashboard always has data
even when no LAN exporter is reachable.

- Runs only while the collector runs and `collector_phone=true` (default).
- Listens on `127.0.0.1:19100` only; `GET /metrics` returns Prometheus text
  format 0.0.4 (`text/plain; version=0.0.4; charset=utf-8`).
- The collector scrapes it as job `phone`, instance `phone`, at
  `collector_scrape_seconds`.
- Samples at scrape time with cheap calls; nothing runs between scrapes.
- Each source fails independently: its metrics disappear for that scrape and
  `android_exporter_source_errors_total{source}` increments. A missing family
  is not a zero.
- No identifiers: no serial, IMEI, Android ID, SSID/BSSID, IP/MAC address,
  or location. Labels are fixed enums, cpufreq policy numbers, and build
  strings.

```sh
adb shell am start -n com.mbicz.androdash/.MainActivity --ez collector true
adb forward tcp:19100 tcp:19100 && curl -s http://127.0.0.1:19100/metrics
```

## Metrics

All values are in base units. "Omitted" means the family has no sample (and
no `# HELP`/`# TYPE` lines) in that scrape.

| Metric | Type | Labels | Source (error `source`) | Meaning / omitted when |
|---|---|---|---|---|
| `android_device_info` | gauge | `manufacturer`, `model`, `release`, `sdk` | `Build` (`device`) | Always `1`. |
| `android_battery_level_ratio` | gauge | — | sticky `ACTION_BATTERY_CHANGED` (`battery`) | `level/scale`, 0–1. Omitted without level or scale. |
| `android_battery_charging` | gauge | — | `EXTRA_STATUS` (`battery`) | `1` while the status is *charging* (not when full or held at a charge limit). |
| `android_battery_plugged` | gauge | `source` = `ac` \| `usb` \| `wireless` \| `dock` \| `none` | `EXTRA_PLUGGED` (`battery`) | One series, value `1`, for the current power source. Omitted for an unknown plug type. |
| `android_battery_temperature_celsius` | gauge | — | `EXTRA_TEMPERATURE` ÷ 10 (`battery`) | |
| `android_battery_voltage_volts` | gauge | — | `EXTRA_VOLTAGE` ÷ 1000 (`battery`) | |
| `android_battery_current_amperes` | gauge | — | `BATTERY_PROPERTY_CURRENT_NOW` µA ÷ 10⁶ (`battery`) | Sign as the device reports it (Pixel: negative while discharging). Omitted when unsupported (`Integer.MIN_VALUE` or `0`). |
| `android_battery_charge_ampere_hours` | gauge | — | `BATTERY_PROPERTY_CHARGE_COUNTER` µAh ÷ 10⁶ (`battery`) | Omitted when unsupported (≤ 0). |
| `android_thermal_status` | gauge | — | `PowerManager.getCurrentThermalStatus()` (`thermal`) | 0 none, 1 light, 2 moderate, 3 severe, 4 critical, 5 emergency, 6 shutdown. API 29+. |
| `android_thermal_headroom_ratio` | gauge | — | `PowerManager.getThermalHeadroom(10)` (`thermal`) | 10 s forecast; `1.0` = severe throttling. API 30+; omitted when NaN. |
| `android_memory_total_bytes` | gauge | — | `ActivityManager.MemoryInfo.totalMem` (`memory`) | |
| `android_memory_available_bytes` | gauge | — | `MemoryInfo.availMem` (`memory`) | |
| `android_memory_low` | gauge | — | `MemoryInfo.lowMemory` (`memory`) | `1` when the system considers memory low. |
| `android_storage_total_bytes` | gauge | — | `StatFs(filesDir)` (`storage`) | App data volume size. |
| `android_storage_available_bytes` | gauge | — | `StatFs(filesDir)` (`storage`) | Free space available to apps. |
| `android_network_receive_bytes_total` | counter | — | `TrafficStats.getTotalRxBytes()` (`network`) | All interfaces since boot. Omitted when unsupported. |
| `android_network_transmit_bytes_total` | counter | — | `TrafficStats.getTotalTxBytes()` (`network`) | As above. |
| `android_network_type` | gauge | `type` = `wifi` \| `cellular` \| `ethernet` \| `vpn` \| `none` | active network capabilities (`network`) | One series, value `1`. `vpn` wins over the underlying transport; `none` without an active network or for any other transport. |
| `android_wifi_rssi_dbm` | gauge | — | active network's `WifiInfo.rssi` (`wifi`) | API 31+, only while the active network is Wi-Fi; omitted when invalid. No location permission. |
| `android_wifi_link_speed_bps` | gauge | — | `WifiInfo.linkSpeed` Mbps × 10⁶ (`wifi`) | As above; omitted when unknown. |
| `android_cpu_frequency_hertz` | gauge | `policy` (e.g. `0`, `4`, `7`) | `/sys/devices/system/cpu/cpufreq/policyN/scaling_cur_freq` kHz × 1000 (`cpu`) | One series per readable policy; `policy` is `N` (the first CPU of the cluster). Omitted when sysfs is unreadable. |
| `android_cpu_max_frequency_hertz` | gauge | `policy` | `…/policyN/cpuinfo_max_freq` kHz × 1000 (`cpu`) | As above. |
| `android_screen_on` | gauge | — | `PowerManager.isInteractive` (`screen`) | |
| `android_screen_brightness_ratio` | gauge | — | `Settings.System.SCREEN_BRIGHTNESS` ÷ 255 (`screen`) | The brightness *setting*, 0–1. Omitted when the setting is missing. |
| `android_uptime_seconds` | gauge | — | `SystemClock.elapsedRealtime()` (`time`) | Includes deep sleep. |
| `android_boot_time_seconds` | gauge | — | wall clock − elapsed realtime (`time`) | Unix seconds, whole. |
| `androdash_process_resident_memory_bytes` | gauge | `process` = `app` \| `collector` | `VmRSS` of `/proc/self/status` and of the Prometheus child (`process`) | `collector` only while Prometheus runs. |
| `androdash_process_cpu_seconds_total` | counter | `process` = `app` \| `collector` | `utime + stime` of `/proc/<pid>/stat` ÷ `_SC_CLK_TCK` (100 if unavailable) (`process`) | As above. |
| `androdash_collector_restarts_total` | counter | — | supervisor state (`collector`) | Restarts since the current collector configuration started; resets on reconfiguration. |
| `androdash_collector_up` | gauge | — | supervisor state (`collector`) | `1` while the Prometheus process runs. |
| `android_exporter_scrape_duration_seconds` | gauge | — | exporter | Time spent sampling this scrape. |
| `android_exporter_source_errors_total` | counter | `source` = `device` \| `battery` \| `thermal` \| `memory` \| `storage` \| `network` \| `wifi` \| `cpu` \| `screen` \| `time` \| `process` \| `collector` | exporter | Failed samplings since the exporter started; every source is always present (from `0`). |

Every series also carries `job="phone"` and `instance="phone"` from the
collector's scrape config, and the collector adds `up{job="phone"}` and the
usual `scrape_*` series.

## Query notes

- Use `rate()` / `increase()` on the `_total` counters. The network counters
  reset at boot, the process CPU counters when that process restarts,
  `android_exporter_source_errors_total` when the exporter restarts, and
  `androdash_collector_restarts_total` when the collector is reconfigured.
- `android_battery_plugged` and `android_network_type` are single-series
  state sets: select the label (`android_network_type == 1` → `{{type}}`).
- `android_memory_available_bytes / android_memory_total_bytes` and
  `android_storage_available_bytes / android_storage_total_bytes` give free
  ratios.
- `android_thermal_headroom_ratio` is a forecast that only some devices
  provide; a missing series is normal.

## Dashboard

[`phone-dashboard.json`](../../contracts/fixtures/phone-dashboard.json),
generated by [`tools/gen_phone_dashboard.py`](../../tools/gen_phone_dashboard.py)
and bundled in the APK (`http://androdash.local/dashboards/phone-dashboard.json`),
is titled with the phone model (`$device` from `android_device_info`) and shows
battery level and history, current and voltage, battery temperature, thermal
status, memory (including the app and the collector), storage used, network
throughput, Wi-Fi signal, CPU clocks, uptime, the CPU share of the app and the
collector, and `up` for every collector target — so it also tells you whether
the Mac is reachable. Its datasource is the collector on `127.0.0.1:19090`.

```sh
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_urls "http://androdash.local/dashboards/phone-dashboard.json,http://androdash.local/dashboards/agenticmac-dashboard.json,http://androdash.local/dashboards/macos-node-dashboard.json" \
  --ez collector true \
  --es collector_targets "node:mac=192.168.192.16:9100,agenticmac:mac=192.168.192.16:9106" \
  --es layout_mode fit
```
