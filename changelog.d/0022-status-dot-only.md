---
id: 0022
date: 2026-10-29
status: accepted
kind: contract
scope: renderer
supersedes: []
---

# Header status: the dot only

## Context

The header status showed a dot plus text: the last update time (`h:mm:ss`),
`Stale since …`, `N of M failing · …`, or `Offline`. That text re-rendered on
every refresh and on every swipe between dashboards. Even with a reserved
width (decision 0021), its changing glyphs drew the eye. The user wants only an
indication that the data is fresh. They do not want a clock in the header and
do not need one in a panel.

## Decision

- The header status is the dot alone: green `live`, amber `degraded`/`stale`,
  red `error`, gray `loading` (C-009).
- The dot sits just before the title in every layout, so it is not read as one
  of the page dots on the right; its position does not depend on the title.
- The status text is still computed when a cycle settles. It is the status
  element's `aria-label` (`<State>. <text>`) and `title`, but it is not drawn.
- No clock panel is added. If a time readout is wanted later, it belongs in a
  panel kind with its own contract entry, not in the header.

## Consequences

### Positive

- Nothing in the header changes on refresh or on a dashboard switch except the
  title and the dot colour.
- Fit layout gains the ~10 characters of width the time used.

### Negative / risks

- The time of the last update and the failing count need the diagnostics
  overlay (`debug=true`), a screen reader, or a hover tooltip.

## Contracts affected

- C-009: the header status shows only the dot; the text becomes its label.
- C-006: "Staleness and status" wording.

## Verification

- `node --test web/tests/` passes.
- Browser fit and scroll layouts: the header has the dot, page dots, and
  actions; the dot is green with mock data; `aria-label` reads
  `Live. <time>`.
- On the phone, swiping between dashboards changes only the title.
