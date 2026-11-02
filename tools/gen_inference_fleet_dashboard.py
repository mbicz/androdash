"""Generate contracts/fixtures/inference-fleet-dashboard.json.

One page for every host doing inference: the two GX10s (spark-exporter, port
9400) and the Mac (agenticmac-exporter, port 9106). It answers "how are the
inference hosts doing" and "which models are being served" without per-host
pages: utilization, temperature, KV cache, throughput, time-to-first-token,
and the model lanes.

Every query was checked against a live Prometheus scraping all three hosts.
There is no mock coverage for this fixture, like macos-node-dashboard.json:
the agenticmac and Spark families come from real exporters.

    python3 tools/gen_inference_fleet_dashboard.py
"""

from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "contracts" / "fixtures" / "inference-fleet-dashboard.json"


def query(expr: str) -> dict:
    return {"kind": "TimeSeriesQuery", "spec": {"plugin": {"kind": "PrometheusTimeSeriesQuery",
            "spec": {"datasource": "$ds", "query": expr}}}}


def by(expr: str, label: str) -> str:
    """Name each series by the bare value of `label` (C-005 `reading`)."""
    return f'label_replace({expr}, "reading", "$1", "{label}", "(.*)")'


def join(expr: str, *labels: str) -> str:
    """Name each series by several labels joined with ` · ` (C-005 `reading`)."""
    args = ", ".join(f'"{label}"' for label in labels)
    return f'label_join({expr}, "reading", " · ", {args})'


def panel(name: str, description: str, kind: str, spec: dict, queries: list[str]) -> dict:
    return {"kind": "Panel", "spec": {"display": {"name": name, "description": description},
            "plugin": {"kind": kind, "spec": spec}, "queries": [query(q) for q in queries]}}


# Reachability of every inference host. `spark` covers both GX10s; `agenticmac`
# is the Mac. The Mac's node job is excluded so it appears once.
UP = 'label_replace(up{job=~"spark|agenticmac"}, "reading", "$1", "instance", "(.*)")'

# Temperatures: GB10 edge sensors on both GX10s, plus the Mac's SoC and NVMe.
# HBM temperature is deliberately absent: GB10 answers N/A and the exporter
# omits the sample, so including it would render an empty tile.
TEMP = (
    f'{join("spark_gpu_temperature_celsius", "instance", "gpu")}'
    ' or ' + join("macos_soc_temperature_celsius", "instance", "sensor")
)

# GPU busy: the driver's ratio on each GB10 and the Mac's GPU active ratio.
GPU = (
    by("spark_gpu_utilization_ratio * 100", "instance") +
    ' or ' + by("macos_gpu_active_ratio * 100", "instance")
)

POWER = (
    join("spark_gpu_power_watts", "instance", "gpu") +
    ' or ' + join('macos_soc_power_watts{component="sys"}', "instance", "component")
)

# Unified-memory pressure: the same `1 - free/total` shape on both platforms.
MEMORY = (
    by("100 * (1 - spark_system_memory_available_bytes / spark_system_memory_total_bytes)", "instance") +
    ' or ' + by("100 * (1 - macos_memory_free_ratio)", "instance")
)

panels = {
    "hosts": panel(
        "Inference hosts", "1 = the host's inference exporter is being scraped successfully",
        "StatChart", {"calculation": "last-number", "format": {"unit": "none", "decimalPlaces": 0},
                      "thresholds": {"steps": [{"value": 1, "name": "Up"}]}},
        [UP]),
    "temperatures": panel(
        "Temperatures", "GB10 GPU edge on both GX10s and the Mac SoC sensors; all °C",
        "StatChart", {"calculation": "last-number", "format": {"unit": "celsius", "decimalPlaces": 0},
                      "thresholds": {"steps": [{"value": 80, "name": "Hot"}, {"value": 90, "name": "Critical"}]}},
        [TEMP]),
    "gpu-utilization": panel(
        "GPU utilization", "GB10 driver ratio on each GX10 and the Mac GPU active ratio",
        "GaugeChart", {"calculation": "last-number", "format": {"unit": "percent", "decimalPlaces": 0},
                       "thresholds": {"steps": [{"value": 85, "name": "Busy"}, {"value": 95, "name": "Saturated"}]}},
        [GPU]),
    "kv-cache": panel(
        "KV cache", "Engine KV-cache occupancy on the GX10 running inference",
        "GaugeChart", {"calculation": "last-number", "format": {"unit": "percent", "decimalPlaces": 0},
                       "thresholds": {"steps": [{"value": 85, "name": "Tight"}, {"value": 95, "name": "Full"}]}},
        [by("spark_engine_kv_cache_usage_ratio * 100", "instance")]),
    "throughput": panel(
        "Output tokens per second", "Engine generated-token counter rate on the serving GX10",
        "TimeSeriesChart", {"legend": {"position": "bottom"},
                            "format": {"unit": "tokens", "decimalPlaces": 1}},
        [join('spark_engine_tokens_per_second{direction="output"}', "instance", "engine")]),
    "ttft": panel(
        "Time to first token", "Engine mean on the GX10 and per-model means on the Mac; ms",
        "TimeSeriesChart", {"legend": {"position": "bottom"},
                            "yAxis": {"format": {"unit": "milliseconds", "decimalPlaces": 0}}},
        [join("spark_engine_time_to_first_token_seconds_mean * 1000", "instance", "engine"),
         'topk(3, ' + by("agent_model_time_to_first_token_seconds * 1000", "model") + ')']),
    "memory": panel(
        "Memory pressure", "Used share of system memory: unified memory on GB10, free ratio on the Mac",
        "StatChart", {"calculation": "last-number", "format": {"unit": "percent", "decimalPlaces": 0},
                      "thresholds": {"steps": [{"value": 90, "name": "Tight"}, {"value": 97, "name": "Critical"}]}},
        [MEMORY]),
    "power": panel(
        "Power", "GB10 GPU draw on both GX10s and the Mac SoC system power; all W",
        "TimeSeriesChart", {"legend": {"position": "bottom"},
                            "format": {"unit": "watts", "decimalPlaces": 1}},
        [POWER]),
    "lanes": panel(
        "Model lanes", "Supervisor lanes on the GX10 that hosts them: 1 = ready, 0 = stopped",
        "Table", {"format": {"unit": "none", "decimalPlaces": 0}},
        ['max by (model) (spark_supervisor_lane_state{state="ready"})'
         ' or 0 * max by (model) (spark_supervisor_lane_state{state="stopped"})']),
    "model-speed": panel(
        "Model speed on the Mac", "Recent output tokens per second per model (agenticmac decayed average)",
        "Table", {"format": {"unit": "tokens", "decimalPlaces": 0}},
        ["topk(8, max by (model) (agent_model_output_tokens_per_second))"]),
}


def item(x: int, y: int, w: int, h: int, ref: str) -> dict:
    return {"x": x, "y": y, "width": w, "height": h, "content": {"$ref": f"#/spec/panels/{ref}"}}


def row(title: str, items: list[dict]) -> dict:
    return {"kind": "Grid", "spec": {"display": {"title": title, "collapse": {"open": True}}, "items": items}}


layouts = [
    row("Fleet", [item(0, 0, 8, 4, "hosts"), item(8, 0, 16, 4, "temperatures"),
                  item(0, 4, 24, 6, "gpu-utilization")]),
    row("Inference", [item(0, 0, 8, 6, "kv-cache"), item(8, 0, 16, 6, "throughput"),
                      item(0, 6, 24, 6, "ttft")]),
    row("Headroom", [item(0, 0, 12, 4, "memory"), item(12, 0, 12, 4, "power")]),
    row("Models", [item(0, 0, 12, 8, "lanes"), item(12, 0, 12, 8, "model-speed")]),
]

dashboard = {
    "kind": "Dashboard",
    "metadata": {"name": "Inference fleet", "project": "androdash",
                 "createdAt": "2026-11-02T00:00:00Z", "updatedAt": "2026-11-02T00:00:00Z", "version": 1},
    "spec": {
        "display": {"name": "Inference fleet",
                    "description": "Both GX10s and the Mac: reachability, GPU utilization, temperatures, "
                                   "KV cache, throughput, time to first token, memory, power, model lanes. "
                                   "HBM temperature and engine panels stay absent on a host that exports "
                                   "no sample. See docs/integrations/inference-fleet.md."},
        "duration": "1h",
        "refreshInterval": "15s",
        "datasources": {"prom": {"default": True, "plugin": {"kind": "PrometheusDatasource",
                                                             "spec": {"directUrl": "http://localhost:9090"}}}},
        "variables": [
            {"kind": "ListVariable", "spec": {"name": "ds", "defaultValue": "prom", "allowMultiple": False,
             "allowAllValue": False, "plugin": {"kind": "DatasourceVariable",
                                                 "spec": {"datasourcePluginKind": "PrometheusDatasource"}}}},
        ],
        "panels": panels,
        "layouts": layouts,
    },
}

if __name__ == "__main__":
    OUT.write_text(json.dumps(dashboard, indent=2, ensure_ascii=False) + "\n")
    print(OUT.relative_to(OUT.parents[2]), len(panels), "panels")
