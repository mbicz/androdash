---
id: 0030
date: 2026-11-01
status: accepted
kind: contract
scope: web, docs
supersedes: [0029]
---

# Landscape fit keeps the header horizontal and compact

## Context

Decision 0029 moved the fit-layout header into a 44 px rail down the left edge
in landscape, with the title rotated bottom-to-top (`writing-mode: vertical-rl`)
so the host name and controls cost panels no height at all.

On the Pixel 4a (5G) that is wrong in practice:

- **Rotated text is hard to read.** The host name is the one thing an operator
  glances at to confirm which machine they are looking at; reading it sideways
  defeats the purpose.
- **It trades the wrong axis.** Landscape has width to give and height to spare
  relative to portrait, so spending width to buy height is backwards.
- **It is not actually cheaper on a cutout device.** Landscape puts the camera
  cutout on the left edge (`env(safe-area-inset-left)` = 52 px on this phone),
  so a column that respects the cutout costs 52 + 112 = 164 px of the 891 px
  width, and `env()` values lag one frame after rotation, which made the inset
  visibly wrong for a moment.

Measured on that phone at 891 × 411: rail 44 px gave `<main>` 823 × 403; an
in-flow 48 px header gave 859 × 355; the compact line below gives 859 × 373.

## Decision

In the fit layout, when the viewport is clearly landscape (`width ≥ 1.3 ×
height`, `headerCompact()` in `web/app/src/layout.js`), the header stays **in
flow and horizontal** and collapses to one tight line
(`app[data-header-compact="true"]`):

- top padding is `env(safe-area-inset-top)` with 2 px below (not the portrait
  `max(12px, …)` + 10 px);
- the title is 15 px instead of 20 px;
- page dots are 14 × 20 px instead of 16 × 24 px;
- icon buttons are 26 px with 15 px glyphs instead of 30 px with 16 px glyphs;
- gap 8 px instead of 10 px.

Result on the Pixel 4a (5G): **30 px** instead of 48 px in landscape (and
instead of 92 px with the portrait cutout padding). The whole difference goes to
panels. Nothing is rotated, moved, hidden, or reordered; the accessibility tree
is unchanged.

Portrait and near-square screens keep the normal header. Scroll layouts are
unaffected. `--header-h` follows the real measured height, so a zoomed panel
still starts below the bar.

The predicate is pure and unit-tested; the CSS is a stylesheet switch plus one
dataset attribute, so there is no new markup, bridge method, or config field.

## Consequences

### Positive

- The host name reads normally in every orientation.
- 18 px more panel height in landscape than the previous one-line header, and 62
  px more than a portrait-padded bar would cost.
- No width is taken from panels, so no dashboard loses a column or gains a row
  because of the header.
- Nothing to maintain per-device: no cutout arithmetic in the header.

### Negative / risks

- The bar still occupies a row, so panels never get the *entire* viewport in
  landscape. That is the deliberate trade: a readable title is worth 30 px.
- 15 px title and 26 px buttons are at the low end of comfortable touch targets
  (Android's guidance is 48 dp; the kiosk's primary controls are the panels and
  gestures, and these buttons remain reachable). Worth revisiting if mis-taps
  appear.
- A dashboard whose own minimum height exceeds the landscape viewport still
  scrolls (`W_FIT_OVERFLOW`) regardless of the header; the header is no longer
  the cause. On the "Agents on mike" dashboard the 4-column plan needs 438 px
  and landscape offers 373 px, with or without the rail.

### Follow-ups

- If landscape dashboards keep overflowing, the next lever is the planner's
  column count and the chart legend budget, not the header.

## Contracts affected

- C-005: the fit-layout "Header" section replaces the "Landscape rail" bullet
  with "Compact header in landscape"; the header section notes that the bar is
  collapsed, not rotated or moved.
- C-001, C-007, C-008, C-009: no change (no config, bridge, or diagnostic
  surface).

## Verification

- `web/tests/contract/c005-fit.test.js`: `headerCompact(361, 780)` and
  `headerCompact(500, 500)` are false; `headerCompact(780, 361)`,
  `headerCompact(1000, 500)`, and `headerCompact(891, 411)` are true. Full
  renderer suite: 96 tests pass.
- On the Pixel 4a (5G), landscape 891 × 411 with `layout_mode=fit`:
  `data-header-compact="true"`, header 891 × 30, `<main>` 859 × 373 at y = 30,
  `--header-h` 30 px, title `horizontal-tb` at 15 px. Portrait 411 × 891:
  `data-header-compact="false"`, normal header, `<main>` 379 × 791 at y = 92,
  no overflow.
- The residual `W_FIT_OVERFLOW` in landscape is the dashboard's own 438 px
  minimum at 4 columns, identical for the rail (823 × 403), the 48 px header
  (859 × 355), and the 92 px portrait bar (859 × 311) — so it is not a header
  regression.
