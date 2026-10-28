---
id: 0010
date: 2026-10-26
status: accepted
kind: decision
scope: ui
supersedes: []
---

# Add AMOLED and monochrome display modes

## Context

The standard dark-glass theme uses layered gradients, glows, shadows, blur, and
animated transitions. That looks good on a desk, but on an AMOLED wall panel it
lights up pixels that could be pure black, and at night or on a lock screen the
decorative chrome is more visual noise than information. A simplified
black-and-white presentation is also easier to read at a glance and reduces the
risk of burn-in from static colored elements.

The renderer already has a strict `display_mode`-free layout system and a dark
theme. The request is presentation-only: same dashboard, data, panel kinds,
limits, filtering, and diagnostics.

## Decision

Add an additive C-001 field, `display_mode`, with three values:

| Value | Behavior |
|---|---|
| `standard` | Existing dark-glass presentation. Default. |
| `amoled` | True-black surfaces; no gradients, glows, shadows, backdrop blur, or non-essential animation; semantic state colors and the data series palette remain. |
| `monochrome` | AMOLED base plus black-and-white text, borders, accents, and states; grayscale/dashed chart series; simplified chrome (brand and header meta chips hidden) for lock-screen/screensaver use. |

`display_mode` is a renderer concern. The native shell parses, validates,
persists, and forwards it like the other C-001 fields. An unknown value is
`E_CONFIG`.

The field is additive: persisted configs without it default to `standard`, and
`schemaVersion` stays 1.

## Consequences

### Positive

- AMOLED panels use true black and avoid unnecessary pixel/GPU work.
- A high-contrast B&W mode is readable at a distance and in low light.
- Monochrome charts remain distinguishable through grayscale plus dash patterns,
  not color alone.
- No new runtime dependency, build step, or server behavior.

### Negative / risks

- More CSS override surface to keep in sync with the standard theme.
- `monochrome` deliberately hides some chrome; an operator cannot see refresh
  interval or time-range chips (the status bar still reports freshness and
  failures).
- `amoled` retains semantic colors, so it is not fully black-and-white. Use
  `monochrome` for that.

### Follow-ups

- Consider a user-controlled brightness/dim level for overnight wall use.
- Consider automatic mode switching on keyguard state; v1 keeps it explicit.

## Contracts affected

- C-001: new `display_mode` parameter/canonical field, validation, schema.
- C-005: theme section defines the three modes and monochrome series rules.
- C-009: diagnostics `config` includes the field (schema/fixture updated).
- C-007: no new native behavior here; see 0011 for lock-screen visibility.

## Verification

- `node --test web/tests/` includes C-001 display-mode parsing and C-005
  monochrome series/dash assertions.
- `./gradlew :app:testDebugUnitTest` covers native parsing, persistence, and URL
  round-trip.
- Emulator: launch the demo with `--es display_mode monochrome`; verify pure
  black background, no gradients/animations, grayscale charts, and hidden brand
  and meta chips. Launch with `amoled`; verify true black with semantic colors.
