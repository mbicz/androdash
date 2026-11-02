---
id: 0031
date: 2026-11-01
status: accepted
kind: contract
scope: web, docs
supersedes: []
---

# Repeated series labels carry the scrape target

## Context

Decision 0030 made the fit-layout header compact. Independently, the phone now
scrapes **two** GX10 hosts (`gx10-5cc5` at `192.168.192.48:9400` and
`gx10-e185` at `192.168.192.45:9400`) under one `spark` job, so
`spark-dashboard.json` renders two series per panel instead of one.

`seriesDisplayName` favors a small label set (`gpu`, `device`, `reading`,
`engine`, …) and deliberately omits `job`/`instance`. Two hosts exporting the
same metric share every favored label — both report `gpu="0"`, and both carry
the same synthetic `reading` values — so the display names collide. Measured on
the Pixel 4a (5G):

- Thermals: two tiles both labelled `gpu` (`66.0°C`, `74.0°C`).
- GPU utilization: two gauges both labelled `gpu=0`.
- Fabric capacity / RDMA traffic: repeated `device=rocep1s0f0` entries.
- Collector health: repeated `cpu`, `engine_stats`, `block_devices` rows.
- Host load: `node_load1` three times (two GX10s plus the Mac).

A tile, gauge, or legend row that reads `gpu` twice cannot be attributed to a
machine. That is a correctness problem for an operator dashboard, not a
cosmetic one: the whole point of the Spark dashboard is per-host GPU state.

## Decision

`disambiguateDisplayNames(names, labelsList)` in `web/app/src/prometheus.js`
appends the series `instance` label to any display name that occurs more than
once **within one panel**:

- `gpu` → `gx10-5cc5 · gpu` and `gx10-e185 · gpu`;
- `device=rocep1s0f0` → `gx10-5cc5 · device=rocep1s0f0` and `gx10-e185 · device=rocep1s0f0`;
- table cells `cpu` → `gx10-5cc5 · cpu` and `gx10-e185 · cpu`.

Rules:

- Disambiguation is per panel and per rendered slice (the tiles, gauges, or
  legend entries actually drawn), so a truncated list never claims a suffix it
  does not need.
- A name that occurs once is returned untouched. Single-target panels keep
  exactly the labels they had, so no existing dashboard changes.
- The suffix is the `instance` value only, separated by ` · ` (the same
  separator the important-label list already uses). No metric name, job, or
  port is added.
- When a series has no `instance` label the name is left as-is; a collision
  without a target is reported by the existing `W_VARIABLES_*`/diagnostics
  surface rather than invented.
- The canonical series key (`seriesKey`) is unchanged: this is presentation
  only, exactly as `seriesDisplayName` already was.

Applied in `renderStat` (tile labels and `data-series-label`/`aria-label`),
`renderGauge` (gauge labels), `renderTimeSeries` (legend labels), and
`renderTable` (`series-cell` text, including the shared-key column case).

## Consequences

### Positive

- Two-host dashboards are attributable: every tile, gauge, legend row, and table
  row names the machine it came from.
- Zero change to single-target dashboards: 96 existing renderer tests still pass
  and no label gained a suffix unless it repeated.
- No contract-level data change: no new config key, bridge method, capability
  ID, panel kind, or diagnostic field. The canonical series key is untouched.

### Negative / risks

- Labels are longer on multi-host panels (`gx10-5cc5 · gpu` is 15 characters
  instead of 3). On a 168 px stat tile the fit planner sizes the label row from
  the value, not the label, so long labels truncate rather than shrink the
  number. Two hosts on one phone is the intended worst case and it fits; a third
  host would push labels into ellipsis.
- The suffix repeats on every panel, so a multi-host dashboard spends label
  width everywhere. A dashboard-level "group by instance" toggle would be
  cheaper to read but is a larger feature; not needed for two hosts.
- Two series that differ only by a label *not* in the display set (e.g. `model`)
  still collide on the `reading` value and are disambiguated by instance even
  though they came from one host. Rare in the supported dashboards; the
  suffix is at least truthful.

### Follow-ups

- If a third Spark host is added, revisit the label budget: a per-host page
  (one dashboard per instance) becomes the better shape than 3× prefixes.
- The Thermals panel's `zone`/`hwmon` queries are `max(...)`, so they collapse
  across all scraped hosts into one unattributed tile. That matches what the
  panel claims ("hottest thermal zone"), so it was left as-is; switching to
  `max by (instance)` would let the new prefix attribute them per host.
- `spark-dashboard.json`'s `engine` variable defaults to `vllm` while the real
  label is `tensorfold`, and `gx10-e185` exports no `spark_engine_*` series at
  all. The renderer already resolves `engine` to the first available value and
  hides panels with no data, so no fake samples appear; worth a fixture update
  when the worker gains an engine.

## Contracts affected

- C-005: "Series display names" gains the repeated-name rule; "Table" gains the
  same rule for `series-cell` text.
- C-001, C-002, C-003, C-004, C-006, C-007, C-008, C-009: no change.

## Verification

- `web/tests/contract/c005-panels.test.js`:
  - "repeated series names carry the scrape target, unique names stay short":
    two-host stat tiles, chart legend, and gauges read
    `gx10-5cc5 · gpu` / `gx10-e185 · gpu`; a single host keeps `gpu`.
  - "repeated table cells carry the scrape target": shared-key rows read
    `gx10-5cc5 · cpu` / `gx10-e185 · cpu`.
  - Full renderer suite: 98 tests pass.
- On the Pixel 4a (5G), Spark dashboard with both GX10s scraped:
  Thermals shows `gx10-5cc5 · gpu` and `gx10-e185 · gpu`; Collector health rows
  are attributable; `up{job="spark"}` is 1 for both instances.
