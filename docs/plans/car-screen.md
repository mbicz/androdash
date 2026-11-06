# Plan: the dashboard on the car screen

**Status:** proposed. Not started. This is a design document, not an accepted
decision; it becomes one only when the first slice ships with tests.

**Question it answers:** when the phone is connected to an Android Auto car, can
AndroDash show the dashboard on the car's screen — using the car's geometry, not
the phone's — and can one dashboard span several swipeable surfaces?

## Short answer

Partially, and not the way the question assumes.

- **Charts cannot be drawn on the car screen by this app.** The Car App Library
  (CAL) only grants a drawing `Surface` to navigation, POI, and weather apps, and
  AndroDash is none of those. An IoT-category app (the only honest fit for a
  monitoring dashboard) can only use templates: lists, grids, panes, and
  messages. There is no chart template and no `Surface` for it.
- **Templated apps also cannot be sideloaded into Android Auto.** Google's own
  testing guide says the "Allow unknown sources" developer option "doesn't apply
  to apps built using the Android for Cars App Library". A debug APK of this app
  will not appear in the car launcher without Play distribution.
- **Multiple swipeable surfaces map onto the Tab template** (2–4 tabs, one
  embedded template each) — not onto a free-form pager. A dashboard split across
  tabs is feasible; a dashboard split across arbitrary swipe pages is not.
- **The car's geometry is discoverable**, via `ConstraintManager` content limits
  and the `CarContext` configuration, so "fit to the car screen" is implementable
  within the template model.

So the honest feature is: **a templated, glanceable summary of the dashboard on
the car screen**, with per-tab panels and car-sized content limits — not the SVG
renderer ported to the car.

## What each option would cost

| Option | What it gives | Blocker |
|---|---|---|
| Port the SVG renderer onto a `Surface` | Real charts on the car screen | `Surface` is navigation/POI/weather only; would require declaring a false category, which fails review |
| IoT category + templates (grid/pane/list) | Glanceable numbers, status words, one-line sparkline-free summaries | No charts; Play distribution required for real cars |
| Parked app (`CAR_LAUNCHER` activity) | Full-screen custom UI on Android 15+ head units, **while parked** | Only games are supported for Android Auto today; a monitoring dashboard does not qualify |
| Phone-only mirroring (cast/AA Mirror) | Existing WebView rendered on the car | Not an Android Auto feature; unsupported, brittle, and outside this project's threat model |

The second row is the only one that is both honest and reachable. The rest are
either policy violations or dead ends.

## Proposed shape (IoT template app)

One `CarAppService`, category `androidx.car.app.category.IOT`, exporting a
`TabTemplate` with up to four tabs, each an embedded template:

```
Tab 1 "Fleet"    → PaneTemplate   host up/down, hottest sensor, memory pressure
Tab 2 "Inference"→ PaneTemplate   output tok/s, KV cache, time to first token
Tab 3 "Models"   → GridTemplate   one grid item per model lane (ready/stopped)
Tab 4 "Alerts"   → MessageTemplate (only when something is warn/crit)
```

Everything is derived from the **same** dashboard fixture the phone renders, via
a small projector that reads the normalized dashboard model and emits car
content. That keeps the "what to display" decision in one place instead of
forking a second dashboard definition for cars.

### Geometry discovery

Two limits, both read at runtime, never hardcoded:

- `ConstraintManager.getContentLimit(CONTENT_LIMIT_TYPE_GRID)` → grid items
  (minimum 6, higher in some cars). Drives how many model lanes fit.
- `ConstraintManager.getContentLimit(CONTENT_LIMIT_TYPE_LIST)` → list rows.
- The `CarContext` configuration gives the car screen's `screenWidthDp` /
  `screenHeightDp`; the host may also vary rows per template.

The phone's own screen is irrelevant here: the CAL host renders on the head
unit, so layout decisions must come from `CarContext`, not `Activity` metrics.
This is the part of the request that is directly implementable.

### Multi-surface positioning

"One dashboard across several swipeable surfaces" becomes: the projector assigns
each dashboard row to a tab (reading order preserved), and a tab whose content
exceeds the host's limit spills into the next tab rather than truncating
silently. That is a paging rule with a contract, not free-form swipe geometry.

## What must be decided before code

1. **Distribution.** Without Play (internal test track) this cannot run on a real
   car at all. Decide whether that is acceptable before building anything.
2. **Content contract.** A car projection is a *different rendering target* for
   the same dashboard. It needs its own contract (call it C-010) defining which
   panel kinds project to which template, how numbers are formatted for glance
   reading, and what is omitted. Reusing C-005 unchanged would mean "the car
   silently drops charts", which the constitution forbids.
3. **Refresh.** Car templates are refreshed by calling `invalidate()` on the
   `Screen`; polling must respect the existing C-006 semantics, and the car's
   host may throttle. A stale-data indicator is required.
4. **Driving safety.** Values must be glanceable: no interaction required, no
   scrolling required, no text that needs reading at length. That constrains the
   projector more than the phone layout does.

## Slices

Each slice is independently verifiable; later slices assume earlier ones.

| ID | Slice | Verify |
|---|---|---|
| C1 | C-010 contract doc + a projector from the normalized dashboard to a car view model (pure Kotlin or pure JS, no CAL dependency) | Unit tests over fixtures: which panels project, which are omitted and why |
| C2 | `CarAppService` + manifest (`IOT` category, `minCarApiLevel`), a `TabTemplate` shell with placeholder panes | Desktop Head Unit renders the tabs |
| C3 | Pane/grid content from the C1 view model; `ConstraintManager` limits applied | DHU at 800×480 and 1920×1080 configs |
| C4 | Refresh + stale indicator, driven by the same collector/`prometheusUrl` the phone uses | DHU shows updates and a stale state |
| C5 | Optional: alert tab only when a threshold is crossed | DHU with a synthetic warn fixture |

## Test strategy

- The projector is pure: fixtures in, view model out. No CAL types in tests.
- CAL itself is exercised only in the Desktop Head Unit (no emulator assertions),
  because the host is Google's code.
- The DHU configurations named by Google (800×480 small landscape, 1920×1080
  wide landscape, 1920×1080 portrait) are the geometry acceptance matrix.

## Risks

- **Play review.** An IoT monitoring dashboard must satisfy the car app quality
  guidelines for that category; a debug-only build is untestable on hardware.
- **Category honesty.** Calling a dashboard "IoT" is defensible (it reports on
  connected devices) but thin; review may disagree.
- **Duplication.** A second rendering path doubles the surface area for display
  bugs. C-010 must state the projection rules precisely, or the car view will
  drift from the phone view.
- **No charts.** The most useful part of this project's UI — the SVG line charts
  — cannot appear on the car screen at all under these rules.

## Explicit non-goals

- Rendering the SVG renderer on the car screen.
- Using the car screen as a second phone display (mirroring/casting).
- Interactive charts or drill-down on the car screen.
- Supporting Android Automotive OS in this slice (separate platform, separate
  distribution path).
