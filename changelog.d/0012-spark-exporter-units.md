---
id: 0012
date: 2026-10-26
status: accepted
kind: contract
scope: integration
supersedes: []
---

# Consume Spark Exporter metrics and add physical units

## Context

The dashboard must be useful for the Spark Exporter workload: a GB10 host with
unified memory, a 200 Gb fabric, and inference engines exposing native token
counters. Spark Exporter publishes documented metric families with deliberate
absence semantics, and it also merges the bundled node_exporter.

A demo based only on `demo_*` metrics does not exercise realistic labels,
units, or failure semantics. The renderer also lacked display units for watts,
temperature, frequency, bit rates, and token rates, so a Spark dashboard would
have shown bare numbers or raw `short` values.

## Decision

1. Add `contracts/fixtures/spark-dashboard.json`: a 15-panel Perses subset
   dashboard for Spark Exporter. It uses only supported panel kinds and:
   - `spark_gpu_*`, `spark_system_memory_*`, `spark_engine_*`,
     `spark_rdma_*`, `spark_cpu_frequency_*`, `spark_collector_success`;
   - `node_load1`/`node_load5` from the bundled node_exporter;
   - Prometheus label-values variables for `gpu` and `engine`.
2. Extend the deterministic mock to answer every query in the fixture, with
   Spark-style labels and realistic values. Unknown queries still return a
   Prometheus error.
3. Add C-005 value units `watts`, `celsius`, `hertz`, `bits` (bits/second), and
   `tokens` (tokens/second). They are display suffixes with SI scaling; values
   are not converted.
4. Prefer additional labels for human series names (`direction`, `device`,
   `counter`, `gpu`, `reason`, `collector`, `unit`) so multi-series Spark panels
   are distinguishable without changing the canonical series identity.
5. Do not add a GPU-memory panel. GB10 omits unsupported framebuffer fields, and
   the fixture must demonstrate absence rather than invent a zero or a fallback.
6. Add an integration test that extracts every fixture query and requires the
   mock to return at least one series. Add renderer contract tests for the
   fixture's panel/query counts and full eligibility.

This is additive to C-005; the contract version becomes 3. The C-001/C-002 data
model is unchanged.

## Consequences

### Positive

- The demo exercises real exporter families, labels, and units.
- Missing driver fields remain visibly absent rather than fake.
- The Spark query cookbook is executable through the mock and tests.
- The renderer remains dependency-free.

### Negative / risks

- The mock grows with fixture-specific query matching; it is not a PromQL
  engine and must be updated when the fixture changes.
- Metric names are pinned to Spark Exporter v0.1.0. A future exporter rename
  requires fixture, mock, docs, and tests to change together.
- The fixture assumes one GPU (`gpu="0"`) and one engine family by default; the
  variables can select other label values when Prometheus exposes them.

### Follow-ups

- Validate the dashboard against a live Spark Exporter scrape on real hardware.
- Consider a small query result cache if 15 panels become too chatty on a phone.
- Add a native unit picker only if operators need more than the documented set.

## Contracts affected

- C-005: version 3; new units and series-display preference.
- C-002/C-004: fixture inventory and test coverage, no interface change.
- C-003: no interface change; the existing direct Prometheus path is used.

## Verification

- `python3 -m unittest discover -s tools -p 'test_*.py' -v`
- `mise exec -- node --test web/tests/`
- `find contracts -name '*.json' -print0 | xargs -0 -n1 jq empty`
- Emulator launch of the Spark fixture against the mock; verify 15 panels, true
  units, variables, and no empty panels.
