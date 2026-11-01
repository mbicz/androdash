---
id: 0029
date: 2026-11-01
status: accepted
kind: contract
scope: web, docs
supersedes: []
---

# Fit layout in landscape moves the header into a left rail

## Context

The fit layout spends the whole screen on panels: the planner sizes rows to the
viewport below the header, and a chart that does not fit scrolls the grid. On a
phone held sideways the viewport is about 780 × 361, and the one-line header
costs roughly 40 px of that — more than a tenth of the height available for
panels, and enough to push a chart past its plot floor into `W_FIT_OVERFLOW` on
a dashboard that fits in portrait.

The header carries the dashboard title (often the host name), the status dot, the
page dots, and two or three icon buttons. It is not optional information: it is
the only place the host name and the freshness of the data appear.

Options considered: hide the header in landscape (loses the host name and
freshness, and the controls); collapse it to icons only (still a row of height);
overlay it on the panels (covers the top row's content); keep it and accept the
loss (the status quo).

## Decision

In the fit layout, when the viewport is **clearly landscape** — `width ≥ 1.3 ×
height` — and wide enough that a rail still leaves a panel at the planner's
minimum width (`width − 44 ≥ 150 + 2 × 16`), the header becomes a **fixed rail
down the left edge**:

- `#app[data-header-rail="true"]`, a 44 px rail, full height, `position: fixed`;
- the title rotates bottom-to-top (`writing-mode: vertical-rl` +
  `transform: rotate(180deg)`), ellipsised along its own axis at 15 px;
- the status dot, page dots, and icon buttons stack below it;
- `.fit-grid` keeps a left margin equal to the rail, so panels start beside it;
- `--header-h` is `0px`, so a zoomed panel starts beside the rail, not under it.

The predicate is `headerRail(width, height)` in `web/app/src/layout.js` (pure,
unit-tested). A near-square viewport keeps the one-line header: rotating a title
there costs more width than the header costs height. Scroll layouts (`auto`,
`grid`, `stack`) always keep the sticky one-line header — the rail is a fit-layout
decision only.

The contents and order of the header do not change, so the accessibility tree is
identical (`banner` → heading, status, buttons); only their arrangement is.

## Consequences

### Positive

- In landscape the entire viewport height goes to panels; the host name and
  freshness stay visible instead of being dropped.
- Dashboards that fit in portrait now also fit sideways, because the planner
  gets the full height.
- No new markup, no new bridge method, no config field: a stylesheet switch plus
  one dataset attribute.

### Negative / risks

- A 44 px column is permanently unavailable in landscape. The predicate refuses
  the rail when that would leave a panel below its minimum width, so it costs
  nothing on small screens.
- Rotated text is less comfortable to read than horizontal text. It is limited to
  the title, which is the one item that benefits from the full height.
- `writing-mode` support in the WebView is the same as desktop Chromium (Android
  5+); no fallback is needed for the supported API range.

### Follow-ups

- Consider hiding the title entirely (leaving only the status dot and buttons) on
  very short landscape screens where the rotated title still crowds the rail.

## Contracts affected

- C-005: the fit-layout "Header" bullet gains a "Landscape rail" rule, and the
  header section notes that the rail keeps the same contents.
- C-001, C-007, C-009: no change (no new config, bridge, or diagnostic surface).

## Verification

- `web/tests/contract/c005-fit.test.js`: `headerRail(361, 780)` and
  `headerRail(400, 380)` are false (portrait, and too narrow for a rail);
  `headerRail(780, 361)` and `headerRail(1000, 500)` are true; a square
  `headerRail(500, 500)` is false. Full renderer suite: 96 tests pass.
- In the demo at 780 × 361 with `layout_mode=fit`: `data-header-rail="true"`, the
  header measures 44 × 361 at x = 0, `<main>` starts at x = 52 with width 712 and
  height 353, `--header-h` is `0px`, the body does not scroll, and the
  accessibility tree still exposes the heading, status, and both buttons.
- On the Pixel 4a (5G) in landscape the same dashboard renders with the rail and
  no `W_FIT_OVERFLOW`.
