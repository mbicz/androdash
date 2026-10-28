#!/usr/bin/env python3
"""Deterministic Prometheus API mock for AndroDash development.

This is intentionally not a PromQL engine. It recognizes the demo queries in
contracts/fixtures/demo-dashboard.json and the Spark Exporter queries in
contracts/fixtures/spark-dashboard.json, then returns stable, plausible data.
Unknown queries return a Prometheus-style error envelope.

Usage:
    python3 tools/mock_prometheus.py --port 9091
    python3 tools/mock_prometheus.py --host 0.0.0.0 --port 9091 --latency-ms 40
"""

from __future__ import annotations

import argparse
import json
import math
import random
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse


BUILDINFO = {
    "version": "2.53.0-androdash-mock",
    "revision": "mock",
    "branch": "main",
    "buildUser": "mock",
    "buildDate": "20261026-00:00:00",
    "goVersion": "go1.22",
}


def _number(value: float, digits: int = 4) -> str:
    return f"{value:.{digits}f}".rstrip("0").rstrip(".")


def _series(
    name: str | None,
    points: list[tuple[float, float]],
    **labels: str,
) -> dict[str, Any]:
    metric = {**({"__name__": name} if name else {}), "job": "demo", "instance": "demo-1", **labels}
    return {
        "metric": metric,
        "values": [[_number(t, 3), _number(v)] for t, v in points],
    }


def _spark_series(
    name: str | None,
    points: list[tuple[float, float]],
    **labels: str,
) -> dict[str, Any]:
    return _series(name, points, job="spark", instance="spark-gb10", **labels)


def _vector(
    name: str,
    timestamp: float,
    value: float,
    **labels: str,
) -> dict[str, Any]:
    metric = {"__name__": name, "job": "demo", "instance": "demo-1", **labels}
    return {"metric": metric, "value": [_number(timestamp, 3), _number(value)]}


def _times(start: float, end: float, step: float) -> list[float]:
    if not math.isfinite(start) or not math.isfinite(end):
        start, end = time.time() - 900, time.time()
    if end < start:
        start, end = end, start
    step = max(1.0, step)
    count = int((end - start) / step) + 1
    count = max(1, min(count, 1200))
    return [start + i * step for i in range(count)]


@dataclass
class MockState:
    latency_ms: int = 0
    fail_rate: float = 0.0
    seed: int = 7
    rng: random.Random = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self.rng = random.Random(self.seed)

    def maybe_fail(self) -> bool:
        if self.fail_rate <= 0:
            return False
        return self.rng.random() < self.fail_rate


def _wave(t: float, base: float, amplitude: float, period: float, phase: float = 0.0) -> float:
    return base + amplitude * math.sin(t / period + phase)


def _spark_range(
    query: str,
    ts: list[float],
) -> list[dict[str, Any]] | None:
    """Deterministic Spark Exporter demo data for the fixture's real queries.

    The mock is not a PromQL engine. Each branch matches a metric family used by
    contracts/fixtures/spark-dashboard.json and returns plausible values with
    the labels the exporter documents.
    """

    if "spark_gpu_temperature_celsius" in query:
        return [
            _spark_series(
                "spark_gpu_temperature_celsius",
                [
                    (t, 52.0 + 2.8 * math.sin(t / 300.0) + 0.5 * math.sin(t / 47.0))
                    for t in ts
                ],
                gpu="0",
                uuid="GPU-demo",
                reading="gpu",
            )
        ]

    if "spark_gpu_memory_temperature_celsius" in query:
        return [
            _spark_series(
                "spark_gpu_memory_temperature_celsius",
                [
                    (t, 58.4 + 2.1 * math.sin(t / 310.0 + 0.6))
                    for t in ts
                ],
                gpu="0",
                uuid="GPU-demo",
                reading="hbm",
            )
        ]

    if "spark_thermal_zone_celsius" in query:
        return [
            _spark_series(
                None,
                [
                    (t, 47.2 + 1.6 * math.sin(t / 260.0 + 1.2))
                    for t in ts
                ],
                zone="0",
                type="gpu-thermal",
                reading="zone",
            )
        ]

    if "spark_hwmon_temperature_celsius" in query:
        return [
            _spark_series(
                None,
                [
                    (t, 44.8 + 1.1 * math.sin(t / 340.0 + 2.4))
                    for t in ts
                ],
                chip="gb10",
                sensor="temp1",
                label="board",
                reading="hwmon",
            )
        ]

    if "spark_gpu_power_limit_watts" in query:
        return [
            _spark_series(
                "spark_gpu_power_limit_watts",
                [(t, 120.0) for t in ts],
                gpu="0",
                uuid="GPU-demo",
                reading="limit",
            )
        ]

    if "spark_gpu_power_watts" in query:
        return [
            _spark_series(
                "spark_gpu_power_watts",
                [
                    (t, 61.5 + 6.2 * math.sin(t / 240.0 + 0.4) + 1.5 * math.sin(t / 31.0))
                    for t in ts
                ],
                gpu="0",
                uuid="GPU-demo",
                reading="draw",
            )
        ]

    if "spark_gpu_clock_sm_hertz" in query:
        return [
            _spark_series(
                "spark_gpu_clock_sm_hertz",
                [
                    (t, 1.42e9 + 0.06e9 * math.sin(t / 280.0 + 0.9))
                    for t in ts
                ],
                gpu="0",
                uuid="GPU-demo",
                reading="sm",
            )
        ]

    if "spark_gpu_clock_memory_hertz" in query:
        return [
            _spark_series(
                "spark_gpu_clock_memory_hertz",
                [
                    (t, 1.18e9 + 0.04e9 * math.sin(t / 300.0 + 1.7))
                    for t in ts
                ],
                gpu="0",
                uuid="GPU-demo",
                reading="mem",
            )
        ]

    if "spark_system_memory_available_bytes" in query:
        total = 128.0 * 1024**3
        return [
            _spark_series(
                None,
                [
                    (t, 100.0 * (1.0 - (92.0 - 2.0 * math.sin(t / 420.0)) / 128.0))
                    for t in ts
                ],
                scope="unavailable",
                total_bytes=str(int(total)),
            )
        ]

    if "spark_gpu_utilization_ratio" in query:
        scale = 100.0 if "* 100" in query else 1.0
        return [
            _spark_series(
                "spark_gpu_utilization_ratio",
                [
                    (
                        t,
                        scale
                        * min(0.99, max(0.01, 0.62 + 0.18 * math.sin(t / 180.0 + 1.1))),
                    )
                    for t in ts
                ],
                gpu="0",
                uuid="GPU-demo",
            )
        ]

    if "spark_engine_tokens_per_second" in query:
        return [
            _spark_series(
                "spark_engine_tokens_per_second",
                [
                    (t, 3600.0 + 520.0 * math.sin(t / 420.0))
                    for t in ts
                ],
                engine="vllm",
                engine_port="8000",
                model="qwen3-coder-30b",
                direction="input",
            ),
            _spark_series(
                "spark_engine_tokens_per_second",
                [
                    (t, 980.0 + 160.0 * math.sin(t / 380.0 + 0.8))
                    for t in ts
                ],
                engine="vllm",
                engine_port="8000",
                model="qwen3-coder-30b",
                direction="output",
            ),
        ]

    if "spark_engine_kv_cache_usage_ratio" in query:
        scale = 100.0 if "* 100" in query else 1.0
        return [
            _spark_series(
                "spark_engine_kv_cache_usage_ratio",
                [
                    (
                        t,
                        scale
                        * min(0.98, max(0.05, 0.58 + 0.12 * math.sin(t / 330.0 + 0.5))),
                    )
                    for t in ts
                ],
                engine="vllm",
                engine_port="8000",
                model="qwen3-coder-30b",
            )
        ]

    if "spark_engine_time_to_first_token_seconds_mean" in query:
        scale = 1000.0 if "* 1000" in query else 1.0
        labels = {"stage": "ttft"}
        if "sum by (stage)" not in query:
            labels.update(
                engine="vllm",
                engine_port="8000",
                model="qwen3-coder-30b",
            )
        return [
            _spark_series(
                "spark_engine_time_to_first_token_seconds_mean",
                [
                    (t, scale * (0.22 + 0.055 * math.sin(t / 270.0 + 0.3)))
                    for t in ts
                ],
                **labels,
            )
        ]

    if "spark_engine_inter_token_seconds_mean" in query:
        scale = 1000.0 if "* 1000" in query else 1.0
        return [
            _spark_series(
                "spark_engine_inter_token_seconds_mean",
                [
                    (t, scale * (0.028 + 0.006 * math.sin(t / 220.0 + 1.4)))
                    for t in ts
                ],
                stage="inter_token",
            )
        ]

    if "spark_engine_requests_running" in query:
        return [
            _spark_series(
                "spark_engine_requests_running",
                [
                    (t, max(0.0, 3.8 + 1.3 * math.sin(t / 210.0 + 0.2)))
                    for t in ts
                ],
                state="running",
            )
        ]

    if "spark_engine_requests_waiting" in query:
        return [
            _spark_series(
                "spark_engine_requests_waiting",
                [
                    (t, max(0.0, 0.8 + 0.6 * math.sin(t / 180.0 + 1.8)))
                    for t in ts
                ],
                state="waiting",
            )
        ]

    if "spark_rdma_counter_total" in query:
        counter = "port_xmit_data" if "port_xmit_data" in query else "port_rcv_data"
        base = 8.4e9 if counter == "port_xmit_data" else 8.1e9
        amplitude = 1.2e9 if counter == "port_xmit_data" else 1.1e9
        return [
            _spark_series(
                "spark_rdma_counter_total",
                [
                    (t, base + amplitude * math.sin(t / 260.0 + (0.0 if counter == "port_xmit_data" else 2.1)))
                    for t in ts
                ],
                device="mlx5_0",
                port="1",
                source="counters",
                counter=counter,
                unit="4_bytes",
            )
        ]

    if "spark_rdma_rate_bits_per_second" in query:
        return [
            _spark_series(
                "spark_rdma_rate_bits_per_second",
                [(t, 200e9) for t in ts],
                device="mlx5_0",
                port="1",
            )
        ]

    if "spark_cpu_frequency_current_hertz" in query:
        return [
            _spark_series(
                "spark_cpu_frequency_current_hertz",
                [
                    (t, 3.8e9 + 0.1e9 * math.sin(t / 500.0))
                    for t in ts
                ],
                policy="0",
                cpu="0-19",
                reading="cpu",
            )
        ]

    if "spark_collector_success" in query:
        return [
            _spark_series(
                "spark_collector_success",
                [(t, 1.0) for t in ts],
                collector=collector,
            )
            for collector in (
                "gpu",
                "memory",
                "thermal",
                "nics",
                "rdma",
                "engine_stats",
                "node_exporter",
            )
        ]

    if "node_load1" in query:
        return [
            _spark_series(
                "node_load1",
                [
                    (t, 1.2 + 0.25 * math.sin(t / 210.0) + 0.08 * math.sin(t / 37.0))
                    for t in ts
                ],
            )
        ]

    if "node_load5" in query:
        return [
            _spark_series(
                "node_load5",
                [
                    (t, 1.45 + 0.15 * math.sin(t / 260.0 + 0.7))
                    for t in ts
                ],
            )
        ]

    return None


def _spark_instant_result(query: str, timestamp: float) -> list[dict[str, Any]] | None:
    range_result = _spark_range(query, [timestamp])
    if range_result is None:
        return None
    return [
        {
            "metric": item["metric"],
            "value": [item["values"][-1][0], item["values"][-1][1]],
        }
        for item in range_result
    ]


def _range_result(
    query: str,
    start: float,
    end: float,
    step: float,
) -> list[dict[str, Any]] | None:
    ts = _times(start, end, step)

    spark = _spark_range(query, ts)
    if spark is not None:
        return spark

    if "rate(demo_cpu_seconds_total" in query:
        system = []
        user = []
        for t in ts:
            system.append(
                (
                    t,
                    6.4
                    + 2.1 * math.sin(t / 190.0)
                    + 0.7 * math.sin(t / 43.0 + 0.8),
                )
            )
            user.append(
                (
                    t,
                    20.0
                    + 4.2 * math.sin(t / 240.0 + 1.2)
                    + 1.1 * math.sin(t / 61.0),
                )
            )
        return [
            _series("demo_cpu_seconds_total", system, mode="system"),
            _series("demo_cpu_seconds_total", user, mode="user"),
        ]

    if "demo_load1" in query:
        return [
            _series(
                "demo_load1",
                [
                    (t, 0.56 + 0.18 * math.sin(t / 210.0) + 0.05 * math.sin(t / 37.0))
                    for t in ts
                ],
            )
        ]

    if "demo_load5" in query:
        return [
            _series(
                "demo_load5",
                [
                    (t, 0.58 + 0.10 * math.sin(t / 260.0 + 0.7))
                    for t in ts
                ],
            )
        ]

    if "demo_memory_used_percent" in query:
        return [
            _series(
                "demo_memory_used_percent",
                [
                    (t, 62.4 + 1.9 * math.sin(t / 420.0) + 0.4 * math.sin(t / 53.0))
                    for t in ts
                ],
            )
        ]

    if "demo_disk_used_percent" in query:
        return [
            _series(
                "demo_disk_used_percent",
                [
                    (t, 78.0 + 4.2 * math.sin(t / 600.0 + 0.9))
                    for t in ts
                ],
            )
        ]

    if "demo_requests_total" in query:
        return [
            _series(
                "demo_requests_total",
                [
                    (t, 18432 + 45 * math.sin(t / 300.0) + (t - ts[0]) * 0.08)
                    for t in ts
                ],
                code="200",
            ),
            _series(
                "demo_requests_total",
                [
                    (t, 17 + 4 * math.sin(t / 240.0 + 2.0))
                    for t in ts
                ],
                code="500",
            ),
        ]

    if "up{" in query or query.strip() == "up":
        return [
            _series(
                "up",
                [(t, 1.0) for t in ts],
            )
        ]

    return None


def _instant_result(query: str, timestamp: float) -> list[dict[str, Any]] | None:
    spark = _spark_instant_result(query, timestamp)
    if spark is not None:
        return spark
    if "demo_memory_used_percent" in query:
        return [_vector("demo_memory_used_percent", timestamp, 62.4 + 1.2 * math.sin(timestamp / 420.0))]
    if "demo_disk_used_percent" in query:
        return [_vector("demo_disk_used_percent", timestamp, 78.0 + 4.2 * math.sin(timestamp / 600.0 + 0.9))]
    if "demo_requests_total" in query:
        return [
            _vector("demo_requests_total", timestamp, 18432 + 45 * math.sin(timestamp / 300.0), code="200"),
            _vector("demo_requests_total", timestamp, 17 + 4 * math.sin(timestamp / 240.0 + 2.0), code="500"),
        ]
    if "demo_load1" in query:
        return [_vector("demo_load1", timestamp, 0.56 + 0.18 * math.sin(timestamp / 210.0))]
    if "demo_load5" in query:
        return [_vector("demo_load5", timestamp, 0.58 + 0.10 * math.sin(timestamp / 260.0 + 0.7))]
    if "rate(demo_cpu_seconds_total" in query:
        return [
            _vector("demo_cpu_seconds_total", timestamp, 6.4 + 2.1 * math.sin(timestamp / 190.0), mode="system"),
            _vector("demo_cpu_seconds_total", timestamp, 20.0 + 4.2 * math.sin(timestamp / 240.0 + 1.2), mode="user"),
        ]
    if "up{" in query or query.strip() == "up":
        return [_vector("up", timestamp, 1.0)]
    return None


def _parse_float(params: dict[str, list[str]], key: str, fallback: float) -> float:
    raw = params.get(key, [""])[0]
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return fallback
    return value if math.isfinite(value) else fallback


class Handler(BaseHTTPRequestHandler):
    server_version = "AndroDashMock/1.0"
    protocol_version = "HTTP/1.1"

    state: MockState

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Accept, Content-Type")
        self.send_header("Cache-Control", "no-store")

    def _send_json(self, payload: dict[str, Any], status: int = 200) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, message: str, status: int = 400, error_type: str = "bad_data") -> None:
        self._send_json(
            {"status": "error", "errorType": error_type, "error": message},
            status=status,
        )

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.state.latency_ms:
            time.sleep(self.state.latency_ms / 1000.0)
        if self.state.maybe_fail():
            self._send_error("mock failure injected by --fail-rate", status=503, error_type="unavailable")
            return

        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query, keep_blank_values=True)

        if path == "/api/v1/status/buildinfo":
            self._send_json({"status": "success", "data": BUILDINFO})
            return

        if path.startswith("/api/v1/label/") and path.endswith("/values"):
            name = unquote(path[len("/api/v1/label/") : -len("/values")]).strip("/")
            values = {
                "job": ["demo", "spark"],
                "instance": ["demo-1", "spark-gb10"],
                "mode": ["system", "user"],
                "code": ["200", "500"],
                "gpu": ["0"],
                "engine": ["vllm"],
                "collector": ["gpu", "memory", "thermal", "nics", "rdma", "engine_stats", "node_exporter"],
                "device": ["mlx5_0"],
                "__name__": [
                    "demo_cpu_seconds_total",
                    "demo_load1",
                    "demo_load5",
                    "demo_memory_used_percent",
                    "demo_disk_used_percent",
                    "demo_requests_total",
                    "node_load1",
                    "node_load5",
                    "spark_collector_success",
                    "spark_cpu_frequency_current_hertz",
                    "spark_engine_inter_token_seconds_mean",
                    "spark_engine_kv_cache_usage_ratio",
                    "spark_engine_requests_running",
                    "spark_engine_requests_waiting",
                    "spark_engine_time_to_first_token_seconds_mean",
                    "spark_engine_tokens_per_second",
                    "spark_gpu_power_watts",
                    "spark_gpu_temperature_celsius",
                    "spark_gpu_utilization_ratio",
                    "spark_rdma_counter_total",
                    "spark_rdma_rate_bits_per_second",
                    "spark_system_memory_available_bytes",
                    "spark_system_memory_total_bytes",
                    "up",
                ],
            }.get(name)
            if values is None:
                self._send_json({"status": "success", "data": []})
            else:
                self._send_json({"status": "success", "data": values})
            return

        if path == "/api/v1/query":
            query = params.get("query", [""])[0]
            timestamp = _parse_float(params, "time", time.time())
            result = _instant_result(query, timestamp)
            if result is None:
                self._send_error(f"unsupported demo query: {query[:120]}")
                return
            self._send_json(
                {
                    "status": "success",
                    "data": {"resultType": "vector", "result": result},
                }
            )
            return

        if path == "/api/v1/query_range":
            query = params.get("query", [""])[0]
            end = _parse_float(params, "end", time.time())
            start = _parse_float(params, "start", end - 900)
            step = _parse_float(params, "step", 15)
            result = _range_result(query, start, end, step)
            if result is None:
                self._send_error(f"unsupported demo query: {query[:120]}")
                return
            self._send_json(
                {
                    "status": "success",
                    "data": {"resultType": "matrix", "result": result},
                }
            )
            return

        self._send_json(
            {
                "status": "error",
                "errorType": "not_found",
                "error": "unknown endpoint",
            },
            status=404,
        )

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[mock] {self.address_string()} {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9091)
    parser.add_argument("--latency-ms", type=int, default=0)
    parser.add_argument("--fail-rate", type=float, default=0.0)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    if not 0 <= args.fail_rate <= 1:
        parser.error("--fail-rate must be between 0 and 1")
    if not 0 <= args.latency_ms <= 30_000:
        parser.error("--latency-ms must be between 0 and 30000")

    Handler.state = MockState(
        latency_ms=args.latency_ms,
        fail_rate=args.fail_rate,
        seed=args.seed,
    )
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"mock Prometheus: http://{args.host}:{args.port}")
    print("  GET /api/v1/status/buildinfo")
    print("  GET /api/v1/query")
    print("  GET /api/v1/query_range")
    print("  GET /api/v1/label/<name>/values")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
