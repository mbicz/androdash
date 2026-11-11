---
id: 0038
date: 2026-11-09
status: accepted
kind: contract
scope: web, app, contracts, docs
supersedes: []
amends: [0037]
---

# Threshold polarity: which direction is bad must be declared

## Context

C-005 defined threshold state by **position**: sort steps ascending, a value at
or above the first step is `warn`, at or above the second `crit`. Decision 0037
kept that rule for the car, keying colour on breach position instead of on the
threshold's name.

Both rules are wrong for positive-polarity metrics. The fleet fixture's `hosts`
panel queries `up{...}`, which is `1` when a host's exporter is scraped
successfully, and declares one step:

```json
"thresholds": { "steps": [{ "value": 1, "name": "Up" }] }
```

Under the position rule, `1` crosses the only step, so a **healthy** host reads
`crit`. A **down** host (`0`) sits below it and reads `ok`. The truth is exactly
inverted, and both surfaces did it:

```
thresholdState(1, [{value:1,name:"Up"}]) -> {"state":"crit"}    // phone and car
thresholdState(0, [{value:1,name:"Up"}]) -> {"state":"ok"}      // phone and car
```

The fixture already documents the intent — *"1 = the host's inference exporter
is being scraped successfully"* — but nothing in the data model expressed it.
Neither the value's position nor the threshold's name can: `Up` names the good
state, so mapping `Up` → `ok` would also paint a down host green.

This was a pre-existing defect in C-005, not only in the car: the phone renderer
had the same inversion.

## Decision

Add an explicit `thresholds.polarity` to the dashboard model (C-002):

| Value | Meaning |
|---|---|
| `high-is-bad` (default) | Crossing upward is worse: temperature, usage, saturation |
| `high-is-good` | Crossing upward is better: `up`, health, quota remaining |

C-005's rule becomes polarity-aware and mirrors for `high-is-good`:

- `high-is-bad` — unchanged: below step 1 `ok`; step 1 `warn`; step 2+ `crit`;
  a single step means `≥ step → crit`.
- `high-is-good` — above the highest step `ok`; below step 2 `warn`; below step 1
  `crit`; a single step means `< step → crit`.
- A `high-is-good` dashboard names its thresholds for the good direction, so
  there is no name for the bad state; `warn`/`crit` fall back to
  `Warning`/`Critical` rather than mislabelling a breach with a positive name.

The car projector mirrors this exactly (`CarProjector.HIGH_IS_BAD` /
`HIGH_IS_GOOD`), so the car and the phone cannot disagree.

The fleet fixture's `hosts` panel declares `"polarity": "high-is-good"`.

## Consequences

### Positive

- A healthy host reads `Up`/green and a down host reads `Critical`/red, on both
  surfaces. Verified on the AAOS host: healthy dot `(84,174,98)` green, down dot
  `(210,115,104)` red.
- Every other panel is untouched: the default keeps the existing rule, so
  temperatures, GPU usage, and memory render exactly as before.
- Polarity is data, not a name heuristic, so a dashboard can name its steps
  anything without changing their meaning.

### Negative / risks

- A dashboard that relies on positive polarity but omits the field still
  inverts. There is no way to infer it, so this is a data obligation; the
  default is the safe, historical behaviour rather than a guess.
- The field is an AndroDash extension, not part of Perses. Unknown fields are
  ignored by C-002's forward-compatibility rule, so a Perses dashboard that
  omits it behaves as before.

### Follow-ups

- Audit other positive-polarity metrics (quota remaining, "healthy" gauges) when
  new dashboards are added; they need `high-is-good` too.

## Contracts affected

- **C-002 amended**: `thresholds.polarity` is a documented field with a default.
- **C-005 amended**: the threshold rule is now polarity-aware; the position-only
  rule it previously pinned was a defect.
- **C-010 amended**: car severity honors polarity; the table now shows both
  directions.
- Decision 0037 amended in place (its "breach position" rule was incomplete);
  this entry records why.

## Verification

- Renderer: `thresholdState(1, [{value:1,name:"Up"}], "high-is-good")` →
  `{state:"ok", label:"Up"}`; the same call without polarity → `crit`, proving
  the default is unchanged.
- Car: `CarProjectorTest` covers healthy → severity 0, down → severity 3, the
  fixture end-to-end, and that the default polarity still treats rising values
  as worse. 173 Gradle tests pass.
- Renderer suite: 99 tests pass.
- On the AAOS host, driven by two stub Prometheus servers: `up=1` renders a green
  dot `(84,174,98)` with `1 · Up`; `up=0` renders a red dot `(210,115,104)` with
  `0 · Critical`.
- `check_docs.py`, `jq empty` over `contracts/`, tooling tests all pass.
