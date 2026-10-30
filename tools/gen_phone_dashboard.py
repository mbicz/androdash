"""Generate contracts/fixtures/phone-dashboard.json.

The dashboard reads the phone exporter built into the app (job `phone`, scraped
by the on-phone collector; decision 0021), so it always has data while the
collector runs, whatever else is reachable. It also shows whether every
collector target is up. Edit here, not in the JSON.

    python3 tools/gen_phone_dashboard.py
"""

from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "contracts" / "fixtures" / "phone-dashboard.json"
PHONE = '{job="phone"}'


def query(expr: str) -> dict:
    return {"kind": "TimeSeriesQuery", "spec": {"plugin": {"kind": "PrometheusTimeSeriesQuery",
            "spec": {"datasource": "$ds", "query": expr}}}}


def named(expr: str, reading: str) -> str:
    return f'label_replace({expr}, "reading", "{reading}", "", "")'


def by(expr: str, label: str) -> str:
    return f'label_replace({expr}, "reading", "$1", "{label}", "(.*)")'


def panel(name: str, description: str, kind: str, spec: dict, queries: list[str]) -> dict:
    return {"kind": "Panel", "spec": {"display": {"name": name, "description": description},
            "plugin": {"kind": kind, "spec": spec}, "queries": [query(q) for q in queries]}}


def m(name: str) -> str:
    return name + PHONE


panels = {
    "battery": panel(
        "Battery", "Charge level",
        "GaugeChart", {"calculation": "last-number", "format": {"unit": "percent", "decimalPlaces": 0}},
        [named("100 * " + m("android_battery_level_ratio"), "battery")]),
    "power": panel(
        "Power", "Battery current in amperes (negative = discharging on most devices) and voltage",
        "StatChart", {"calculation": "last-number", "format": {"unit": "none", "decimalPlaces": 2}},
        [named(m("android_battery_current_amperes"), "amps"),
         named(m("android_battery_voltage_volts"), "volts")]),
    "heat": panel(
        "Heat", "Battery temperature and Android thermal status (0 none … 6 shutdown)",
        "StatChart", {"calculation": "last-number", "format": {"unit": "celsius", "decimalPlaces": 1},
                      "thresholds": {"steps": [{"value": 40, "name": "Warm"}, {"value": 45, "name": "Hot"}]}},
        [named(m("android_battery_temperature_celsius"), "battery")]),
    "thermal": panel(
        "Thermal status", "0 none · 1 light · 2 moderate · 3 severe · 4 critical",
        "StatChart", {"calculation": "last-number", "format": {"unit": "none", "decimalPlaces": 0},
                      "thresholds": {"steps": [{"value": 2, "name": "Throttling"}, {"value": 4, "name": "Critical"}]}},
        [named(m("android_thermal_status"), "status")]),
    "battery-history": panel(
        "Battery level", "Charge over the selected range",
        "TimeSeriesChart", {"legend": {"position": "bottom"}, "format": {"unit": "percent", "decimalPlaces": 0}},
        [named("100 * " + m("android_battery_level_ratio"), "battery")]),
    "memory": panel(
        "Memory", "Available memory as Android reports it, and the dashboard's own processes",
        "StatChart", {"calculation": "last-number", "format": {"unit": "bytes", "decimalPlaces": 1}},
        [named(m("android_memory_available_bytes"), "available"),
         by(m("androdash_process_resident_memory_bytes"), "process")]),
    "storage": panel(
        "Storage used", "App data partition",
        "GaugeChart", {"calculation": "last-number", "format": {"unit": "percent", "decimalPlaces": 0},
                       "thresholds": {"steps": [{"value": 85, "name": "High"}, {"value": 95, "name": "Full"}]}},
        [named("100 * (1 - " + m("android_storage_available_bytes") + " / " + m("android_storage_total_bytes") + ")",
               "storage")]),
    "network": panel(
        "Network", "All interfaces, bits per second",
        "TimeSeriesChart", {"legend": {"position": "bottom"}, "format": {"unit": "bits", "decimalPlaces": 1}},
        [named("rate(" + m("android_network_receive_bytes_total") + "[1m]) * 8", "rx"),
         named("rate(" + m("android_network_transmit_bytes_total") + "[1m]) * 8", "tx")]),
    "wifi": panel(
        "Wi-Fi signal", "Received signal strength (dBm, closer to 0 is stronger)",
        "StatChart", {"calculation": "last-number", "format": {"unit": "none", "decimalPlaces": 0}},
        [named(m("android_wifi_rssi_dbm"), "dBm")]),
    "cpu": panel(
        "CPU clocks", "Current frequency per CPU cluster",
        "StatChart", {"calculation": "last-number", "format": {"unit": "hertz", "decimalPlaces": 2}},
        [by(m("android_cpu_frequency_hertz"), "policy")]),
    "collector-cpu": panel(
        "Dashboard CPU", "Share of one core used by the app and the on-phone collector",
        "TimeSeriesChart", {"legend": {"position": "bottom"}, "format": {"unit": "percent", "decimalPlaces": 1}},
        [by("100 * rate(" + m("androdash_process_cpu_seconds_total") + "[2m])", "process")]),
    "targets": panel(
        "Collector targets", "1 = the last scrape of that target succeeded",
        "Table", {"format": {"unit": "none", "decimalPlaces": 0}},
        ['label_join(max by (job, instance) (up), "target", " · ", "instance", "job")']),
    "uptime": panel(
        "Uptime (days)", "Since the phone booted",
        "StatChart", {"calculation": "last-number", "format": {"unit": "none", "decimalPlaces": 1}},
        [named(m("android_uptime_seconds") + " / 86400", "uptime")]),
}


def item(x: int, y: int, w: int, h: int, ref: str) -> dict:
    return {"x": x, "y": y, "width": w, "height": h, "content": {"$ref": f"#/spec/panels/{ref}"}}


def row(title: str, items: list[dict]) -> dict:
    return {"kind": "Grid", "spec": {"display": {"title": title, "collapse": {"open": True}}, "items": items}}


layouts = [
    row("Battery", [item(0, 0, 8, 6, "battery"), item(8, 0, 8, 3, "heat"), item(16, 0, 8, 3, "thermal"),
                    item(8, 3, 16, 3, "power"), item(0, 6, 24, 6, "battery-history")]),
    row("System", [item(0, 0, 12, 5, "memory"), item(12, 0, 12, 5, "storage"),
                   item(0, 5, 12, 6, "network"), item(12, 5, 6, 3, "wifi"), item(18, 5, 6, 3, "uptime"),
                   item(12, 8, 12, 3, "cpu")]),
    row("Dashboard", [item(0, 0, 12, 6, "collector-cpu"), item(12, 0, 12, 6, "targets")]),
]

dashboard = {
    "kind": "Dashboard",
    "metadata": {"name": "This phone", "project": "androdash",
                 "createdAt": "2026-10-29T00:00:00Z", "updatedAt": "2026-10-29T00:00:00Z", "version": 1},
    "spec": {
        "display": {"name": "$device", "description": "The phone running this dashboard (built-in phone exporter)"},
        "duration": "1h",
        "refreshInterval": "15s",
        "datasources": {"prom": {"default": True, "plugin": {"kind": "PrometheusDatasource",
                                                             "spec": {"directUrl": "http://127.0.0.1:19090"}}}},
        "variables": [
            {"kind": "ListVariable", "spec": {"name": "ds", "defaultValue": "prom", "allowMultiple": False,
             "allowAllValue": False, "plugin": {"kind": "DatasourceVariable",
                                                 "spec": {"datasourcePluginKind": "PrometheusDatasource"}}}},
            {"kind": "ListVariable", "spec": {"name": "device", "allowMultiple": False, "allowAllValue": False,
             "plugin": {"kind": "PrometheusLabelValuesVariable",
                        "spec": {"labelName": "model", "matchers": ["android_device_info"]}}}},
        ],
        "panels": panels,
        "layouts": layouts,
    },
}

if __name__ == "__main__":
    OUT.write_text(json.dumps(dashboard, indent=2, ensure_ascii=False) + "\n")
    print(OUT.relative_to(OUT.parents[2]), len(panels), "panels")
