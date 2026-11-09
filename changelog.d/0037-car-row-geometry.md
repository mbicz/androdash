---
id: 0037
date: 2026-11-09
status: accepted
kind: decision
scope: app, docs, contracts
supersedes: []
---

# Predetermined car row geometry: dot column, block bars, breach-keyed color

## Context

The car view rendered correctly but read as loose text. Measured on the AAOS
host (1024x768, density 160) from its own rendering:

- Value lines ended at x=115, 220, 207, 207, 207 — a ragged right edge.
- State emoji floated at each line's ragged end, so the green/red column
  wandered from row to row.
- Rows used roughly 200 px of a 973 px content box.

The obvious fix — pad labels with spaces to a fixed column — cannot work. The
car font is proportional:

| Text | Glyphs | Width | Per glyph |
|---|---|---|---|
| `Inference hosts` | 15 | 188 px | 12.53 px |
| `Temperatures` | 12 | 170 px | 14.17 px |
| `KV cache` | 8 | 115 px | 14.38 px |

A ~20% spread per glyph means the same character count is a different pixel
width, so space padding drifts. Only fixed-width glyphs can be aligned with:
blocks and `░` advance 17.00 px, a space advances 8.00 px, and emoji advance
30/33/40 px.

## Decision

Every row gets the same three-band shape:

```
● label
  ███████████████░░░░░░░░░░░░░░░
  58% · Busy
```

1. **A host-laid-out leading dot.** `Row.setImage` with a tinted state dot. The
   host sizes and positions that column itself, so the dot lands on the same x
   regardless of label or value length. Measured: x=145..170 on every row, 0 px
   variance. This is the only guaranteed alignment CAL offers.
2. **A fixed-width block bar.** Percent panels get a meter (`█` measured, `░`
   remaining) because percent is the only unit with a defined 0..100 maximum.
   Every other unit gets a sparkline of its *measured* range instead — a bar for
   °C or watts would invent a scale (`IU-1`).
3. **Breach-keyed color.** The state word is tinted with
   `ForegroundCarColorSpan`, and severity comes from *which threshold the value
   crossed*, not the threshold's name.

## Consequences

### Positive

- The screen reads as a table: dot column exact, bar column exact (39 cells,
  663 px, 0 px variance), value column within 1 px.
- Every row has the same shape, so no row looks like an afterthought.
- Color adds a second channel without replacing the word (`AC-1`).

### Negative / risks

- Row height grows: a shape row uses two text lines (the CAL limit), so fewer
  rows fit above the fold. The host limit still governs.
- Bars are limited to 39 cells because the host clips a text line at x=880.
  Going wider is not harmless — the visible proportion stops matching the value.

### Follow-ups

- If a host allows a wider line, re-measure before raising the width.

## Defect found while verifying

The first build keyed color off the state *word*. Dashboards name their own
thresholds — the fleet fixture uses `Busy`, `Tight`, `Hot` — so the map matched
none of them and fell through to green. A GPU at 90% (above its 85 `Busy`
threshold) rendered a **green** dot while the value line read `Busy`.

This was caught only by rendering a warning-state dashboard on the host; unit
tests on the canonical four state words all passed. Fixed by splitting the
fields: `Row.state` is the word displayed, `Row.severity` is the breach position
used for color. Verified on the host afterwards: `Busy` yellow `(223,155,62)`,
`Critical` red `(229,99,89)`, `Nominal` green `(95,169,110)`.

## Contracts affected

- **C-010 amended**: row geometry (dot column, fixed-width bars, the 39-cell
  clip limit), meter bars and their percent-only rule, and breach-keyed
  severity. `SPARK_WIDTH` and `BAR_WIDTH` are both 39.

## Verification

- `CarProjectorTest`: 20 tests, including meter width/proportion/clamping, the
  percent-only rule, one-shape-per-row, and a regression that a custom-named
  breached threshold is not severity 0.
- On the AAOS host, measured from the capture: dots at x=145..170 on all rows
  (0 px variance); bars at x=204..866 (39 cells, 0 px variance); meter fill
  ratio 0.256 for 27% and 0.744 for 60%, matching the values.
- Color verified by driving a stub Prometheus: `Critical` red, `Busy` yellow,
  `Nominal` green.
- 169 Gradle tests, 99 renderer, 36 tooling, lint clean, docs 74 files, JSON valid.
