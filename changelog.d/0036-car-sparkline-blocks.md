---
id: 0036
date: 2026-11-06
status: accepted
kind: decision
scope: app, docs, contracts
supersedes: [0035]
---

# Block sparklines, not braille rasters

## Context

Decision 0035 replaced the block sparkline with a braille raster, on the
strength of two measurements: braille is fixed-width (22.00 px), and a CAL row
allows two text lines. Braille packs a 2×4 dot grid per code point, so it
promised 48 × 8 dots in the space of 24 × 2 cells.

It rendered badly on the device, for two independent reasons:

1. **A bug of mine.** Empty cells were written as `' '` (advance 8.00 px) while
   filled cells were braille (advance 22.00 px). Every blank shifted the rest of
   the line 14 px left, so the two raster lines did not line up. The code comment
   said to use `U+2800`; the code did not.
2. **A property of braille.** Its dots are sparse by design. At native
   resolution a braille row renders as isolated clusters separated by gaps
   (`*#   -#  #.   #+`), not a filled area. Two text lines also carry a line gap
   between them, so a two-line raster reads as vertically offset.

Measured, for the record:

| Glyph | Advance | Fixed |
|---|---|---|
| Block elements `▁▂▃▄▅▆▇█` | 23.00 px | yes |
| Braille `U+2800..U+28FF` | 22.00 px | yes |
| Space | 8.00 px | yes |
| Emoji | 30 / 33 / 40 px | **no** |

## Decision

Go back to **block sparklines**, one line, 24 cells, every cell a block glyph:

- No space is ever emitted, so every cell advances 23.00 px and the row cannot
  drift.
- Blocks fill their whole cell, so the row tiles into a continuous filled area.
- The flat-series case uses `▅` (mid-height) rather than a space, which would
  both collapse to the baseline and break alignment.
- Emoji remain trailing state badges only (🟢 🟡 🔴 ⚪), never pixels.

## Consequences

### Positive

- The row renders as one continuous shape, and the alignment bug is gone: both
  sparkline rows measured on device share the same left edge (x=24) and right
  edge (x=431) at their baselines.
- One text line leaves the second line for the value and badge.
- A test now fails if a sparkline contains a space or a non-block character,
  which is the regression guard for this class of bug.

### Negative / risks

- Resolution drops from a promised 48 × 8 dots to 8 vertical levels over 24
  cells. The shape is coarser than braille would have been *if* it rendered as
  an area, which it does not.
- Still no axis, scale, or legend: it shows shape, not magnitude.

### Follow-ups

- If a host font lacks block elements, fall back to ASCII digits.

## Contracts affected

- **C-010 amended**: the sparkline section documents blocks as the chosen
  alphabet, records braille as tried-and-rejected with the measured widths, and
  states the no-space invariant.

## Verification

- `CarProjectorTest`: sparkline is 24 cells, contains no space, contains only
  block glyphs, rising data ends high, a flat series is `▅▅▅▅`, and 100 samples
  keep their shape. 14 projector tests pass.
- On the AAOS emulator: 10 panels / 9 series, `omittedCharts=0`, and the
  sparkline region captured at native resolution is a solid filled area.
- Pixel measurement of the two sparkline rows: baseline left edge 24, right edge
  431 for both — aligned.
- `tools/check_docs.py` passes; `jq empty` over `contracts/` passes.
