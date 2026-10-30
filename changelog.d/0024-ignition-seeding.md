---
id: 0024
date: 2026-10-30
status: accepted
kind: contract
scope: android, security
supersedes: []
---

# Ignition: one document seeds dashboards and collector targets

## Context

Setting up a phone meant a long `adb shell am start …` line, or many taps in the
settings sheet: dashboard URLs, the collector, every scrape target. The same
device often has to be re-provisioned with the same set. The repository already
documents launch extras as the canonical configuration; a provisioning document
that carries both dashboards and targets, and is applied once, keeps a device
reproducible from a file.

## Decision

1. **One document, two sources.** A JSON Ignition document seeds the persisted
   config at launch. `--es ignition_url <http(s) URL>` fetches it; otherwise
   `<filesDir>/ignition.json` is read. The extra wins.
2. **One-shot.** After a successful apply the file is deleted and the extra is
   removed from the intent. Later launches, including in-app edits, are not
   overwritten. A failed apply keeps the source and persists nothing.
3. **What it seeds.** `dashboards.urls` (1–8 URLs, replacing the list),
   `dashboards.current`, `dashboards.inline` (0–8 pasted dashboard documents
   stored like `addInlineDashboard`), `collector.{enabled,targets,phone,
   scrapeSeconds,retention}`, and the scalar launch options. Absent keys keep
   the persisted value.
4. **Strict.** Unknown keys anywhere, wrong types, out-of-range values, more
   than 8 dashboards including inline ones, and a merged config that fails
   C-001 validation are rejected with `E_IGNITION`; a failed fetch is
   `E_IGNITION_FETCH`. Both are native fatal screens.
5. **Native only.** The renderer never receives the document; the merged config
   reaches it through the usual launch URL. `ignition_url` is a launch extra
   that forces a reload and is never folded into that URL.
6. **Bounded.** 5 MiB document and per-inline-dashboard cap; the fetch has a
   10 s connect/read timeout, follows no redirects, and accepts 2xx only.

## Consequences

### Positive

- A device can be rebuilt from one file: `adb shell run-as com.mbicz.androdash`
  plus a copied `files/ignition.json`, or a URL on the LAN or tailnet.
- Inline dashboards can ship with the seed, so the phone needs no dashboard
  server at all.

### Negative / risks

- The document can point a device at any dashboard and any exporter, exactly
  like the launch extras; it is trusted provisioning input, not page content.
- A wrong document leaves the device on the fatal screen until the source is
  fixed or removed (the Retry button re-reads it).
- The file source is only reachable through `run-as` on a debug build.

## Contracts affected

- C-001: `ignition_url`; new "Ignition" section; `E_IGNITION`/`E_IGNITION_FETCH`.
- C-007 v10: launch applies Ignition before loading the renderer; one-shot
  consumption.
- C-009: the two new fatal codes.

## Verification

- `IgnitionTest` (13 cases): merge semantics, list replacement and `current`,
  inline append, collector merge and rejection, unknown keys, wrong types,
  limits, oversize.
- `ConfigParserTest`: `ignition_url` is a config extra and forces a reload; it
  never appears in the launch URL.
- On the phone: a file document seeds dashboards and targets once, is deleted,
  and a second launch keeps in-app edits; an invalid document shows
  `E_IGNITION`.
