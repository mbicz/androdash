---
id: 0026
date: 2026-10-31
status: accepted
kind: decision
scope: tools, docs
supersedes: []
---

# Discover exporters from what answers, then seed with Ignition

## Context

Seeding a phone by hand means reading every exporter's port, guessing an
instance label, and writing `collector_targets` by hand. That is the step where a
device ends up pointing at an exporter that is not there, or at a host whose
name does not match the dashboard's `instance` label. The repository already has
one provisioning document (decision 0024) and bundled dashboards whose titles
come from `node_uname_info{nodename}`. The missing piece was deriving the
document from the network instead of from memory.

## Decision

1. **A discovery tool, not a phone feature.** `tools/discover_hosts.py` probes
   candidate hosts for the documented exporter ports (9100 node_exporter, 9106
   agenticmac-exporter, 9091 demo/mock Prometheus, 9400 spark-exporter) and
   reads `/metrics` to decide what each one is. Candidates come from `--host`,
   `--prometheus <base>/api/v1/targets`, the ARP table, and `tailscale status`;
   loopback targets are dropped because the phone cannot reach them that way.
2. **The phone has the last word.** `--device <adb serial>` (with `--adb` for a
   non-default adb server) re-probes every discovered exporter from that device
   with `adb shell nc -z`, and drops the ones it cannot reach. A target the Mac
   can reach but the phone cannot — a tailnet exporter while the phone is off
   the tailnet — is reported as dropped, not seeded as a permanently `0` target.
3. **Identity is evidence, not a guess.** A host's instance label is
   `node_uname_info{nodename}`, else the reverse-DNS first label, else the
   address. The macOS dashboard is only offered for `sysname="Darwin"` node
   exporters; each other dashboard requires its own metric family in
   `/metrics` (`spark_`, `agent_`, `demo_`). An exporter that does not prove
   itself is not listed.
4. **The document is the phone dashboard first.** The generated Ignition
   document always starts with the bundled `phone-dashboard.json` and selects
   it, so a freshly seeded device has data from the in-app exporter before any
   LAN target answers. Discovered dashboards follow, one per exporter, capped at
   the 8-dashboard limit; `collector.enabled` and `collector.phone` are true and
   `collector.targets` is the canonical C-001 string.
5. **Validated before it is written.** `validate_ignition` mirrors the shell's
   strict rules (unknown keys, URL shape, `current` membership, duplicate
   job/instance, the collector needs a target) so a document that would show
   `E_IGNITION` is never produced.

The tool is development tooling (W3). The phone never runs discovery; it applies
the document through the existing `ignition_url` path (decision 0024).

## Consequences

### Positive

- One command turns a LAN into a working phone: `discover_hosts.py
  --prometheus http://<host>:9090 --ignition ignition.json`, serve it, launch
  with `--es ignition_url`.
- The instance labels match what the dashboards group by, because both come
  from the same `node_uname_info` labels.

### Negative / risks

- Discovery reads `/metrics` from every host on the LAN, which is a scan of the
  operator's own network; it stays opt-in and bounded (4 ports, 1.5 s timeouts,
  at most 32 targets).
- A tailnet address is only usable when the phone is on the tailnet; the tool
  reports the source so the operator can drop those targets.
- The port list is the documented set. A new exporter integration must add its
  port and metric family here, or discovery will not see it.

## Verification

- `tools/test_discover_hosts.py` (11 cases): ARP/tailnet/Prometheus parsing,
  Darwin-only node_exporter, per-family classification, foreign metrics
  rejected, phone-first ordering, canonical targets, the 8-dashboard cap,
  duplicate job/instance collapse, every generated URL naming a bundled fixture,
  and the validator catching each rule the shell enforces.
- On a Pixel 4a (5G), `--prometheus http://192.168.192.16:9090` found
  `node:mike=192.168.192.16:9100`, `agenticmac:mike=192.168.192.16:9106`, and
  `demo:mike=192.168.192.16:9091`; the document ignited to 4 dashboards and 4
  targets (phone included), every `up` = 1, and a relaunch kept them without the
  file.
- With `--device 0B031JECB12106`, the same run also found
  `spark:gx10-5cc5=100.87.99.90:9400` here and dropped it because the phone is
  off the tailnet; the earlier document that kept it showed `up{job="spark"} 0`.
- Two device-reachability cases in `test_discover_hosts.py`: the adb command
  puts `-L tcp:5038` before the serial, and a target the device cannot reach is
  dropped from both the dashboards and the targets.
