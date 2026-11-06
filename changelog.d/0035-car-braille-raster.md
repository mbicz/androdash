---
id: 0035
date: 2026-11-06
status: accepted
kind: decision
scope: app, docs, contracts
supersedes: [0034]
---

# Braille rasters and emoji badges on the car screen

## Context

Decision 0034 put a one-line block sparkline (`▁▂▃▄▅▆▇█`) on each chart row. It
was fixed-width and honest, but it resolved only 8 vertical levels over 24
columns — a coarse shape.

Two questions had to be settled by measurement, not assumption:

1. Are block glyphs actually fixed-width in the car font?
2. Do emoji break alignment?

Measured with `Paint.measureText` at 32 px on the AAOS Templates Host:

| Alphabet | Fixed | Advance |
|---|---|---|
| Braille `U+2800..U+28FF` | yes | 22.00 px |
| Blocks `▁▂▃▄▅▆▇█` | yes | 23.00 px |
| Box drawing `▏▎▍▌▋▊▉█` | yes | 23.00 px |
| Emoji | **no** | 30 / 33 / 40 px |

Also established from `RowConstraints`: a CAL row allows **at most two text
lines** (`maxTextLinesPerRow = 2`); a third throws `IllegalArgumentException`.

## Decision

Replace the block sparkline with a **braille raster**:

- Each braille character is a 2-wide by 4-tall dot grid, so it is the densest
  fixed-width glyph available.
- `SPARK_WIDTH` = 24 characters per line; `SPARK_LINES` = 2 (the CAL limit).
- The raster is therefore **48 × 8 dots** — 6× the vertical resolution of the
  block sparkline.
- Cells are filled at or below the series level, so the plot reads as a filled
  area. A flat series fills mid-height rather than collapsing to the baseline.
- The range is bucketed per dot column and averaged, so a long range keeps its
  shape.

Add **emoji state badges**, but only as trailing text:

- 🟢 Nominal, 🟡 Warning, 🔴 Critical, ⚪ No data.
- Emoji advance widths are not fixed, so they never appear inside a raster;
  they sit at the end of a line where alignment does not matter.

## Consequences

### Positive

- 8 vertical levels over 48 dot columns instead of 8 levels over 24 columns.
- The state word is now also a colour badge, readable at a glance.
- Both alphabets are text: `SA-1` (no animation) and `IU-1` (no images) still
  hold, and the IoT category is unchanged.

### Negative / risks

- Braille glyphs are small on a car screen. At a glance the raster reads as a
  filled shape, not a precise plot — it has no axis, scale, or legend.
- The raster costs the full two text lines, so a chart row cannot also show a
  long value string. The value shares the second line with the last raster row.
- Braille rendering depends on the host font covering `U+2800..U+28FF`. If a
  head unit's font lacks braille, the raster degrades to tofu boxes. The
  measurement above is for the AAOS Templates Host only.
- Emoji rendering depends on the host's emoji font; a monochrome fallback still
  aligns because it is trailing text.

### Follow-ups

- If a host lacks braille, fall back to blocks (also fixed-width, measured
  23.00 px).
- Measure the available row width from the host instead of the fixed 24.

## Contracts affected

- **C-010 amended**: the sparkline section becomes "Braille rasters and state
  badges", including the measured width table and the two-line limit.

## Verification

- `CarProjectorTest`: raster is two lines of 24 cells, braille-or-space only,
  rising data fills the lower line more than the upper, 100 samples keep their
  shape, a flat series fills mid-height, and every state badge maps to its
  emoji. 13 projector tests pass.
- On the AAOS emulator the fleet dashboard projected 10 panels / 9 series with
  `omittedCharts=0`, and logged rasters such as
  `⣶⣦⣄⡀         ⣀⣤⣶⣶⣷⣶⣦⣄` / `⣿⣿⣿⣿⣷⣤⣀⣀⣀⣀⣠⣴⣾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⣄`.
- The screen renders the badges (`1-Up🟢`, `52 °C · Nominal 🟢`) and the raster
  rows when scrolled into view.
- `tools/check_docs.py` passes; `jq empty` over `contracts/` passes.
