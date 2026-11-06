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

## Can we just declare a navigation/POI category and take the Surface?

**Technically yes. Legally and by policy, no.** Verified in the CAL 1.7.0 AAR:

- `ACCESS_SURFACE`, `NAVIGATION_TEMPLATES`, and `MAP_TEMPLATES` are ordinary
  `uses-permission` entries in the app manifest. They are **not** signature- or
  privilege-gated: `CarAppPermission` only does a runtime
  `PackageManager.checkPermission` and throws `SecurityException` if absent. Any
  app that declares them gets the Surface.
- So the gate is **not technical, it is the Play review plus the quality
  guidelines**. `NF-1` requires turn-by-turn navigation; `NF-2` requires the
  Surface to draw *only map content*; `NF-7` requires a test-drive mode;
  `NF-6` requires handling navigation intents. A monitoring dashboard declaring
  `NAVIGATION` fails every one of them, and the review is manual.
- The same applies to POI (`PF-1`) and weather (`WE-1`/`WE-3`).

Declaring a false category would therefore be a deliberate misrepresentation of
what the app does — Article 3 of the constitution ("Capability honesty") forbids
exactly that, and Play review rejects it. It is not a shortcut; it is a defect
with a rejection attached.

## What Integrated Engineering actually did

They did **not** use Android Auto. The POWERlink Suite release notes and the
launch material describe **CarPlay**: "Turning on Valet Mode now asks for
confirmation, on your phone and in CarPlay", "Saved Live View gauges now load
right away", and a launch video titled "CarPlay Powerlink Live Gauges".

CarPlay has a **Driving task** category that Android Auto has no equivalent for,
and it permits exactly this use case. But it also caps it:

- `Driving task` apps **must use the provided templates**; custom UI, custom
  maps, and real-time video "are not possible".
- **"Do not periodically refresh data items in the CarPlay UI more than once
  every 10 seconds (for example, no real-time engine data)."**

So even IE's live gauges are template-based and refresh-capped — not a live chart
surface. That is the closest thing to the requested feature that exists on either
platform, and it is CarPlay-only (this project is Android-only, and CarPlay needs
an iPhone plus Apple's entitlement approval).

## What each option would cost

| Option | What it gives | Blocker |
|---|---|---|
| Port the SVG renderer onto a `Surface` | Real charts on the car screen | `Surface` needs a navigation/POI/weather category; declaring one falsely fails Play review (`NF-1`, `NF-2`, `PF-1`) and violates Article 3 |
| IoT category + templates (grid/pane/list) | Glanceable numbers, status words, one-line summaries | No charts; Play distribution required for real cars |
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

## Getting onto a real car

This is the part that determines whether the whole plan is worth starting.

**A Play Console account is required before you can test on a real car.** There
is no free path. Verified:

| Step | Cost | Notes |
|---|---|---|
| Play Console registration | US$25 one-time | Personal or organization; no renewal |
| Identity verification | free | Government ID + card in the same legal name; **fee is not refunded if verification fails** |
| Device verification (personal accounts) | free | Must verify an Android device via the Play Console mobile app |
| Closed test before production (personal accounts created after 2023-11-13) | free | **12 testers opted in continuously for 14 days**, then apply for production access |
| Android Auto form factor | free | Opt in under **Advanced settings → Form factors**; requires an artifact on a testing track |

**Internal testing reaches real cars and skips review entirely.** Google's
distribution page gives the review impact per track:

| Track | Car form-factor review |
|---|---|
| Internal app sharing (Android Auto only) | **None** |
| Internal testing | **None** |
| Closed testing | Non-blocking (warned, still approved) |
| Open testing | Blocking |
| Production | Blocking |

So the minimal route to a real car is: register, verify identity, upload a
release-signed AAB/APK to internal app sharing (or an internal test track), enable
"Internal app sharing" in Play Store settings on the phone (tap the Play Store
version 7 times), install from the link, connect to the car. **No car review, no
12 testers, no production access.**

Consequences worth stating plainly:

- **You do not need production access to see the dashboard in your own car.**
  The 12-tester/14-day rule gates only *public* distribution. It does not gate
  internal testing or internal app sharing.
- **You do not need a car review to iterate.** Internal testing is exempt from
  form-factor review, so an IoT-category build can be tested on hardware without
  passing the `IT-1` judgement first. Review only becomes blocking when you
  promote to open testing or production.
- **Internal app sharing artifacts are re-signed by Google** with a per-app
  internal key, and links expire after 60 days / 100 downloads. Fine for a
  personal test loop, not for a distribution channel.
- **`adb install` alone is not enough.** Sideloaded CAL apps appear in the DHU
  but not in a real car launcher — confirmed by Google's testing doc ("Allow
  unknown sources" does not apply to CAL apps) and by a 2026 field report where
  DHU worked and the real car did not until internal app sharing was used.

**Recommendation:** register the account. US$25 is the entire entry cost, the
identity check is one-time, and without it there is no way to test on a real car
at all. But register *before* writing the car code, not after — the verification
can take days, and it is the only long-lead item in the plan.

## What must be decided before code

1. **Distribution.** A Play Console account is required even to *test* on a real
   car — see "Getting onto a real car" above. Decide whether to spend the US$25
   and the identity verification before building anything.
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
  guidelines for that category (`IT-1`: view device state and simple on/off
  actions while driving; no setup, no fine-grained control). Reporting
  inference-host state is a defensible reading of "view the current state of
  devices", but the manual review is the gate, and a debug-only build is
  untestable on hardware.
- **Category honesty.** Declaring `IOT` for a telemetry dashboard is arguable but
  defensible; declaring `NAVIGATION` or `POI` to obtain the Surface is not, and
  would fail review on `NF-1`/`NF-2`/`PF-1`.
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
