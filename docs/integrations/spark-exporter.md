# Spark Exporter integration

**Status:** implemented for the demo fixture and mock. Verified against the
documented metric catalogue of
[`mbicz/spark-exporter`](https://github.com/mbicz/spark-exporter) v0.1.0, not
against a live GB10 host.
**Workstreams:** W2 (renderer), W3 (mock), W4 (contracts/docs).
**Fixture:** [`spark-dashboard.json`](../../contracts/fixtures/spark-dashboard.json).

## Why this dashboard exists

Spark Exporter publishes host, GPU, fabric and inference telemetry for NVIDIA
GB10 systems. AndroDash consumes those metrics through Prometheus; the phone
renders the dashboard and queries Prometheus directly.

The fixture is a documented example of a real dashboard that fits the supported
Perses subset. It is also an integration test: `tools/mock_prometheus.py`
returns deterministic values for every query in the fixture, and
`tools/test_mock_prometheus.py` fails if the fixture and mock drift apart.

## Running it

```sh
# terminal 1
python3 tools/mock_prometheus.py --port 9091

# terminal 2
python3 tools/serve_demo.py --port 8099
```

Browser:

```text
http://localhost:8099/web/app/index.html?dashboard_url=http://localhost:8099/contracts/fixtures/spark-dashboard.json&prometheus_url=http://localhost:9091&debug=true
```

Emulator:

```sh
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_url "http://10.0.2.2:8099/contracts/fixtures/spark-dashboard.json" \
  --es prometheus_url "http://10.0.2.2:9091" \
  --ez debug true
```

The fixture's datasource URL is `http://localhost:9091`; `prometheus_url`
overrides it. A real deployment points at the Prometheus that scrapes the Spark
host.

## Metric families used

The dashboard deliberately uses both Spark Exporter families and the bundled
node_exporter counters. It does not assume a private hostname or model name.

| Panel | PromQL family | Why it is honest |
|---|---|---|
| Thermals | `spark_gpu_temperature_celsius`, `spark_gpu_memory_temperature_celsius`, `max(spark_thermal_zone_celsius)`, `max(spark_hwmon_temperature_celsius)` | One °C panel, four readings (`reading` = gpu, hbm, zone, hwmon). Driver edge temperature, HBM temperature, and the hottest zone/sensor. Missing sample stays missing. |
| Power | `spark_gpu_power_watts`, `spark_gpu_power_limit_watts` | Instantaneous draw and the enforced limit, both W (`reading` = draw, limit). |
| Memory pressure | `spark_system_memory_available_bytes`, `spark_system_memory_total_bytes` | `total - available` is a pressure signal on unified memory, not model residency. |
| GPU utilization | `spark_gpu_utilization_ratio` | Driver ratio, shown as percent. |
| KV cache | `spark_engine_kv_cache_usage_ratio` | Native cache occupancy. |
| Engine throughput | `spark_engine_tokens_per_second{direction=~"input\|output"}` | Normalized counter rate; not GPU utilization or per-request decode speed. |
| Token latency | `spark_engine_time_to_first_token_seconds_mean`, `spark_engine_inter_token_seconds_mean` | Two means in the same unit (ms). No invented p95. |
| Engine requests | `spark_engine_requests_running`, `spark_engine_requests_waiting` | Native queue depth (`reading` = running, waiting). |
| Clocks | `spark_gpu_clock_sm_hertz`, `spark_gpu_clock_memory_hertz`, `spark_cpu_frequency_current_hertz` | GPU SM/memory clocks and the CPU policy frequency in one Hz panel (`reading` = sm, mem, cpu). |
| Fabric capacity | `spark_rdma_rate_bits_per_second` | Advertised link capacity, not measured traffic. |
| RDMA traffic | `spark_rdma_counter_total{...counter="port_xmit_data\|port_rcv_data",unit="4_bytes"}` | The exporter reports 4-byte words; the query multiplies the rate by 32 to get bits/s. |
| Host load | `node_load1`, `node_load5` | Bundled node_exporter. |
| Collector health | `spark_collector_success` | `1` means the last collection succeeded. An absent family is not a zero. |
| About | none (Markdown) | Semantics and limits, rendered from the dashboard definition. |

### Grouping rule

Metrics that share a display unit share a panel. `StatChart` renders one tile
per series (up to 12), so a grouped panel is a dashboard-spec change, not a
renderer change. Each query gets a short name through a synthetic `reading`
label:

```promql
label_replace(spark_gpu_temperature_celsius{gpu="$gpu"}, "reading", "gpu", "", "")
```

C-005 documents `reading` as a reserved synthetic label; `seriesDisplayName`
returns its value alone. Aggregations that collapse labels (`max(...)`) carry no
`gpu`/`uuid` after the reduction, which is why the zone and hwmon queries keep
the `reading` label instead of a per-sensor breakdown.

Do not group across units. A °C reading and a W reading in one panel share one
`format.unit`, so the formatter would mislabel one of them.

Variables:

- `ds` selects the Prometheus datasource.
- `gpu` comes from `spark_gpu_info`; default `0`.
- `engine` comes from `spark_engine_endpoint_up`; default `vllm`.

`PrometheusLabelValuesVariable` is resolved at boot through the Prometheus label
values API. If Prometheus has multiple GPUs or engine families, edit the default
or select the matching label value in the dashboard definition.

## Semantics that must not be flattened

- **Absent is absent.** On GB10 the driver answers `N/A` for framebuffer memory
  and some clocks. Spark Exporter omits those samples and sets
  `spark_gpu_field_supported{field=...}` to `0`. Do not draw a zero or a
  substitute panel. The fixture does not include a GPU-memory panel for this
  reason.
- **Unified memory.** `spark_system_memory_total_bytes - available_bytes` is not
  model residency, and summing per-process GPU memory against it double-counts.
- **Tokens per second.** Output tok/s is a generated-token counter rate. Input
  tok/s has different semantics per engine. The two series remain separate.
- **Fabric capacity.** `spark_rdma_rate_bits_per_second` and
  `spark_nic_speed_bits_per_second` are advertised rates. Traffic comes from
  counters.
- **`port_rcv_data` units.** The kernel counter counts 4-byte words; the
  exporter records `unit="4_bytes"` rather than silently converting it. The
  dashboard query does the `* 32` conversion explicitly.
- **Collector failure.** A failed collector contributes no samples plus
  `spark_collector_success{collector="..."} 0`. The health table shows the zero;
  other panels show "No data" rather than stale synthetic values.
- **No fallback families.** Do not substitute `nv_inference_count`,
  `nv_trt_llm_v1_metrics`, or a gauge when a cumulative token counter is
  missing. The dashboard uses the normalized `spark_engine_*` families.

## Units added for this dashboard

C-005 now supports `watts`, `celsius`, `hertz`, `bits` (bits per second), and
`tokens` (tokens per second) in addition to the original units. They are
presentation-only: the metric value is never converted or rescaled.

## Verification

```sh
python3 -m unittest discover -s tools -p 'test_*.py' -v
mise exec -- node --test web/tests/
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
```

The Android emulator demo uses the same fixture and mock; see
[`development.md`](../development.md).

## Known limits

- The mock is deterministic synthetic data, not a Prometheus query engine.
- The fixture is pinned to the public metric names documented by Spark Exporter
  v0.1.0; a future exporter release may rename families. Update the dashboard,
  mock, and this page together.
- Only the supported Perses subset is rendered. A richer Spark dashboard can
  add panels without new renderer code only if it uses `TimeSeriesChart`,
  `StatChart`, `GaugeChart`, `Table`, or `Markdown`.
- No authentication or TLS is implemented for Prometheus in v1.
