# Inference fleet integration

**Dashboard:** [`inference-fleet-dashboard.json`](../../contracts/fixtures/inference-fleet-dashboard.json)
**Generator:** [`tools/gen_inference_fleet_dashboard.py`](../../tools/gen_inference_fleet_dashboard.py)

One page for every host doing inference: the two GX10s (`gx10-5cc5`,
`gx10-e185`) and the Mac. It answers "how are the inference hosts doing" and
"which models are being served" without paging between per-host dashboards.

## What it scrapes

| Host | Exporter | Port | Job |
|---|---|---:|---|
| `gx10-5cc5` | spark-exporter | 9400 | `spark` |
| `gx10-e185` | spark-exporter | 9400 | `spark` |
| Mac | agenticmac-exporter | 9106 | `agenticmac` |

Both GX10s share the `spark` job and are told apart by `instance`. The Mac's
`node` job is deliberately not used here: the agenticmac exporter already
carries the macOS health families, so including both would render the Mac
twice.

All three must be scraped by one Prometheus. The phone's collector does this
with targets:

```
spark:gx10-5cc5=192.168.192.48:9400,spark:gx10-e185=192.168.192.45:9400,agenticmac:mike=192.168.192.16:9106
```

## Panels

| Panel | Kind | Query | Why it is honest |
|---|---|---|---|
| Inference hosts | StatChart | `up{job=~"spark\|agenticmac"}` | Reachability only: 1 means that host's inference exporter is being scraped. |
| Temperatures | StatChart | `spark_gpu_temperature_celsius`, `macos_soc_temperature_celsius` | GB10 edge sensor per GX10 plus the Mac SoC sensor. HBM temperature is omitted: GB10 answers `N/A` and the exporter drops the sample, so a tile would be empty. |
| GPU utilization | GaugeChart | `spark_gpu_utilization_ratio * 100`, `macos_gpu_active_ratio * 100` | The GB10 driver ratio and the Mac GPU active ratio. They measure different things; the label names the host. |
| KV cache | GaugeChart | `spark_engine_kv_cache_usage_ratio * 100` | Engine occupancy. Only the GX10 running an engine contributes a series. |
| Output tokens per second | TimeSeriesChart | `spark_engine_tokens_per_second{direction="output"}` | Generated-token counter rate on the serving engine. Not GPU utilization. |
| Time to first token | TimeSeriesChart | `spark_engine_time_to_first_token_seconds_mean * 1000`, `topk(3, agent_model_time_to_first_token_seconds * 1000)` | Engine mean per GX10 and the Mac's per-model means, both in ms. |
| Memory pressure | StatChart | `100 * (1 - spark_system_memory_available_bytes / spark_system_memory_total_bytes)`, `100 * (1 - macos_memory_free_ratio)` | Used share. Unified memory on GB10 is not model residency. |
| Power | TimeSeriesChart | `spark_gpu_power_watts`, `macos_soc_power_watts{component="sys"}` | GB10 GPU draw per host and the Mac SoC system power, all W. |
| Model lanes | Table | `spark_supervisor_lane_state` | Supervisor lanes per GX10 with their `ready`/`stopped` state. |
| Model speed on the Mac | Table | `agent_model_output_tokens_per_second` | Per-model output tok/s from the Mac's harness records. |

## Semantics that must not be flattened

- **Absent is absent.** A GX10 with no inference engine (`gx10-e185` today)
  exports no `spark_engine_*` family. KV cache, throughput, and time-to-first-
  token simply have no series for it; nothing is drawn as a zero.
- **Two kinds of "utilization".** The GB10 ratio is driver-reported SM
  occupancy; `macos_gpu_active_ratio` is the Mac's GPU busy share. They are
  grouped in one gauge panel because both are percentages, not because they
  are the same measurement.
- **Memory pressure is not model residency.** `total - available` on unified
  memory says how full the pool is; it does not say how much a model occupies.
- **No mock coverage.** Unlike the demo and Spark fixtures, the mock Prometheus
  does not synthesize agenticmac families. Tests check eligibility and live
  queries were validated against a real Prometheus scraping all three hosts.

## Fit budget

The page is designed to fit one phone screen in the fit layout: 10 panels, no
Markdown block. Measured with real data at 393 × 795 CSS px: `--fit-scale`
0.984, no overflow; at 859 × 373 (landscape): scale 0.874, no overflow. Adding
a panel or a series per panel costs vertical space; the planner's own numbers
are in `web/app/src/fit.js`, and `W_FIT_OVERFLOW` in diagnostics reports when
the page starts scrolling.

## Launch

```sh
adb shell am start -n com.mbicz.androdash/.MainActivity \
  --es dashboard_url "http://androdash.local/dashboards/inference-fleet-dashboard.json" \
  --ez collector true \
  --es collector_targets "spark:gx10-5cc5=192.168.192.48:9400,spark:gx10-e185=192.168.192.45:9400,agenticmac:mike=192.168.192.16:9106" \
  --ez layout_mode fit
```

Against an existing Prometheus instead, drop `--ez collector` and pass
`--es prometheus_url <url>`; the dashboard's datasource URL is
`http://localhost:9090`, which that flag overrides.

## Verification

```sh
python3 tools/gen_inference_fleet_dashboard.py
mise exec -- node --test web/tests/
python3 tools/check_docs.py
find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty
```

## Known limits

- The `engine` label is not a variable here: the fleet has one engine
  (`tensorfold`) on one host, so the queries select it by metric family rather
  than by a resolved variable.
- Temperatures show one sensor per host. Per-sensor breakdowns stay on the
  per-host Spark dashboard.
- Agent harness counts, subscription quota, and macOS pressure levels live on
  the "Agents on the Mac" dashboard: they describe the client, not inference
  health.
- There is no Markdown panel: the dashboard description carries the caveats
  instead. A text block cost 41 px in landscape and pushed the page into
  scrolling.
