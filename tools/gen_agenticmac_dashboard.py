"""Generate contracts/fixtures/agenticmac-dashboard.json.

The dashboard reads agenticmac-exporter (AI coding harnesses + macOS gaps) and
node_exporter, both scraped as `instance="mac"`. Every query was checked against
a live Prometheus; edit here, not in the JSON.

    python3 tools/gen_agenticmac_dashboard.py
"""

from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "contracts" / "fixtures" / "agenticmac-dashboard.json"


def query(expr: str) -> dict:
    return {"kind": "TimeSeriesQuery", "spec": {"plugin": {"kind": "PrometheusTimeSeriesQuery",
            "spec": {"datasource": "$ds", "query": expr}}}}


def by(expr: str, label: str) -> str:
    """Name each series by the bare value of `label` (C-005 `reading`)."""
    return f'label_replace({expr}, "reading", "$1", "{label}", "(.*)")'


def panel(name: str, description: str, kind: str, spec: dict, queries: list[str]) -> dict:
    return {"kind": "Panel", "spec": {"display": {"name": name, "description": description},
            "plugin": {"kind": kind, "spec": spec}, "queries": [query(q) for q in queries]}}


RUNNING = 'sum by (harness) (agent_processes{role="interactive"}) > 0'

panels = {
    "harnesses": panel(
        "Running agents", "Interactive harness processes (omp, opencode, codex, claude, …)",
        "StatChart", {"calculation": "last-number", "format": {"unit": "none", "decimalPlaces": 0}},
        [by(RUNNING, "harness")]),
    "sessions": panel(
        "Active sessions", "Sessions written within the exporter's active window, for running harnesses",
        "StatChart", {"calculation": "last-number", "format": {"unit": "none", "decimalPlaces": 0}},
        [by("sum by (harness) (agent_sessions_active) and on (harness) (" + RUNNING + ")", "harness")]),
    "throughput": panel(
        "Output tokens per second", "Generated tokens, 5m rate, per harness",
        "TimeSeriesChart", {"legend": {"position": "bottom"}, "format": {"unit": "tokens", "decimalPlaces": 1}},
        [by('sum by (harness) (rate(agent_tokens_total{type="output"}[5m]))', "harness")]),
    "spend": panel(
        "Spend per hour (USD)", "List-price estimate from harness usage records; subscriptions are not billed this",
        "TimeSeriesChart", {"legend": {"position": "bottom"}, "format": {"unit": "none", "decimalPlaces": 2}},
        [by("sum by (harness) (rate(agent_cost_usd_total[15m])) * 3600", "harness")]),
    "quota": panel(
        "Quota used", "Subscription rate-limit windows reported by omp",
        "GaugeChart", {"calculation": "last-number", "format": {"unit": "percent", "decimalPlaces": 0},
                       "thresholds": {"steps": [{"value": 80, "name": "High"}, {"value": 95, "name": "Limit"}]}},
        ['label_join(100 * max by (provider, window) (agent_quota_used_ratio), "reading", " ", "provider", "window")']),
    "models": panel(
        "Model speed", "Recent output tokens per second per model (omp, decayed average)",
        "Table", {"format": {"unit": "tokens", "decimalPlaces": 0}},
        ["topk(8, max by (model) (agent_model_output_tokens_per_second))"]),
    "pressure": panel(
        "Pressure", "macOS memory and thermal pressure levels (0 normal)",
        "StatChart", {"calculation": "last-number", "format": {"unit": "none", "decimalPlaces": 0},
                      "thresholds": {"steps": [{"value": 1, "name": "Elevated"}, {"value": 2, "name": "Critical"}]}},
        ['label_replace(macos_memory_pressure_level, "reading", "memory", "", "")',
         'label_replace(macos_thermal_pressure_level, "reading", "thermal", "", "")']),
    "power": panel(
        "SoC power", "Apple Silicon power by component (macmon)",
        "TimeSeriesChart", {"legend": {"position": "bottom"}, "format": {"unit": "watts", "decimalPlaces": 1}},
        [by('macos_soc_power_watts{component=~"cpu|gpu|ram|sys"}', "component")]),
    "temperature": panel(
        "Temperature", "SoC sensors (macmon) and the internal NVMe drive",
        "StatChart", {"calculation": "last-number", "format": {"unit": "celsius", "decimalPlaces": 0},
                      "thresholds": {"steps": [{"value": 80, "name": "Hot"}, {"value": 95, "name": "Critical"}]}},
        [by("macos_soc_temperature_celsius", "sensor"),
         'label_replace(macos_nvme_temperature_celsius, "reading", "nvme", "", "")']),
    "agent-memory": panel(
        "Agent memory", "Resident memory of harness processes",
        "StatChart", {"calculation": "last-number", "format": {"unit": "bytes", "decimalPlaces": 1}},
        [by("sum by (harness) (agent_process_resident_memory_bytes) > 0", "harness")]),
    "services": panel(
        "Homebrew services", "1 = running",
        "Table", {"format": {"unit": "none", "decimalPlaces": 0}},
        ["max by (service) (macos_brew_service_up)"]),
    "vms": panel(
        "Lima VMs", "1 = running",
        "Table", {"format": {"unit": "none", "decimalPlaces": 0}},
        ["max by (vm) (macos_lima_vm_running)"]),
}


def item(x: int, y: int, w: int, h: int, ref: str) -> dict:
    return {"x": x, "y": y, "width": w, "height": h, "content": {"$ref": f"#/spec/panels/{ref}"}}


def row(title: str, items: list[dict]) -> dict:
    return {"kind": "Grid", "spec": {"display": {"title": title, "collapse": {"open": True}}, "items": items}}


layouts = [
    row("Agents", [item(0, 0, 12, 4, "harnesses"), item(12, 0, 12, 4, "sessions"),
                   item(0, 4, 12, 7, "throughput"), item(12, 4, 12, 7, "spend"),
                   item(0, 11, 12, 8, "quota"), item(12, 11, 12, 8, "models")]),
    row("Mac", [item(0, 0, 8, 4, "pressure"), item(8, 0, 8, 4, "temperature"), item(16, 0, 8, 4, "agent-memory"),
                item(0, 4, 24, 7, "power"),
                item(0, 11, 12, 6, "services"), item(12, 11, 12, 6, "vms")]),
]

dashboard = {
    "kind": "Dashboard",
    "metadata": {"name": "Agents on the Mac", "project": "androdash",
                 "createdAt": "2026-10-28T00:00:00Z", "updatedAt": "2026-10-28T00:00:00Z", "version": 1},
    "spec": {
        "display": {"name": "$host", "description": "AI coding harnesses and macOS health (agenticmac-exporter)"},
        "duration": "1h",
        "refreshInterval": "15s",
        "datasources": {"prom": {"default": True, "plugin": {"kind": "PrometheusDatasource",
                                                             "spec": {"directUrl": "http://localhost:9090"}}}},
        "variables": [
            {"kind": "ListVariable", "spec": {"name": "ds", "defaultValue": "prom", "allowMultiple": False,
             "allowAllValue": False, "plugin": {"kind": "DatasourceVariable",
                                                 "spec": {"datasourcePluginKind": "PrometheusDatasource"}}}},
            {"kind": "ListVariable", "spec": {"name": "host", "allowMultiple": False, "allowAllValue": False,
             "plugin": {"kind": "PrometheusLabelValuesVariable",
                        "spec": {"labelName": "nodename", "matchers": ["node_uname_info"]}}}},
        ],
        "panels": panels,
        "layouts": layouts,
    },
}

if __name__ == "__main__":
    OUT.write_text(json.dumps(dashboard, indent=2, ensure_ascii=False) + "\n")
    print(OUT.relative_to(OUT.parents[2]), len(panels), "panels")
