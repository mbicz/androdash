---
id: 0028
date: 2026-11-01
status: accepted
kind: contract
scope: android, docs
supersedes: []
amends: [0027]
---

# Wait mode keeps polling after a document applies

## Context

Decision 0027 made a phone fetch its own Ignition document: a six-digit code,
a templated `ignition_url`, and a provisioning screen while no document exists.
It deliberately stopped there — the re-fetch happened **on launch only**, so a
poll could never overwrite a live in-app edit.

That limit means re-provisioning an appliance needs a relaunch or a reboot. For
a wall-mounted dashboard that is the normal case: an operator adds a target,
rotates a dashboard, or changes a collector interval, writes the new
`<code>.json`, and has to walk over to the phone to restart the activity.

The trade-off was chosen in the other direction: a server may re-provision a
running appliance, and the phone accepts that this overwrites its in-app edits.

## Decision

1. **Polling continues after a successful apply.** In wait mode the shell
   reschedules `startProvisioningAttempt()` after a document is applied, at the
   same `ignition_wait_seconds` interval. The provisioning state
   (`provisioningBackground`) stays set so a failed poll keeps the dashboard
   running and logs instead of switching screens.
2. **An unchanged document is a no-op.** The shell keeps the SHA-256 of the last
   applied body in memory (`Provisioning.documentDigest`). A poll that returns
   the same bytes does not rebuild the page and does not touch the config; a
   differing body is applied exactly like a first seed. The digest is **not**
   persisted, so a relaunch applies the stored document once more.
3. **One-shot is untouched.** Without `ignition_wait`, a launch still fetches
   once, applies, deletes the file source, and drops the extra. `--ez
   ignition_wait false` clears the persisted template, stops polling, and returns
   the phone to that mode.
4. **Polling is activity-scoped.** The timer stops in `onStop` and resumes in
   `onStart`, for both the provisioning screen and a live dashboard.
5. **A launch during a poll is deferred, not dropped.** Continuous polling makes
   "an attempt is in flight" common, so `applyIntent` stores the intent and
   replays it when the attempt finishes; previously such a launch was ignored,
   which could silently discard an operator's new extras.
6. **Still no renderer surface.** The code, tokens, template, and interval remain
   native-only: not `AppConfig` fields, not query parameters, no new bridge
   method.

## Consequences

### Positive

- Writing `<code>.json` re-provisions a running appliance within one interval;
  no relaunch, no adb.
- A steady server costs one conditional GET per interval and no repaint.

### Negative / risks

- **This is the deliberate relaxation of 0027.** A poll that differs overwrites
  in-app edits (targets, dashboard choice, layout) within `ignition_wait_seconds`.
  The provisioning server is the source of truth in wait mode; `ignition_wait=false`
  is the only way to make the phone's own edits stick. Documented in C-001,
  C-009, and `docs/getting-started.md`.
- A poll every 15 s keeps the radio warm on a phone that never sleeps. That is
  what an appliance does anyway, but `ignition_wait_seconds` should be raised for
  fleets that change rarely.
- The digest is memory-only, so a relaunch applies the stored document even when
  nothing changed. That is intentional (it also re-establishes the config after
  a data wipe) and costs one page rebuild per launch.

### Follow-ups

- A Settings entry showing provisioning state and a "stop checking in" action.
- Persisting the digest if relaunch rebuilds ever become noticeable.

## Contracts affected

- C-001: the wait-mode row says polling continues; the bullets cover the no-op
  poll, the deferred launch, and the activity-scoped timer.
- C-009: the unprovisioned-state section notes that a configured device logs a
  failed poll and that an unchanged document produces no status change. No new
  code.
- C-005, C-007, C-008: no change.

## Verification

- `ProvisioningTest` (14 cases, including `document digest is stable hex and
  detects a changed document`): same body → same digest, a trailing space or a
  changed port → a different digest.
- On the Pixel 4a (5G): launch with
  `--es ignition_url http://192.168.192.16:8099/ignition/{device}.json --ez ignition_wait true --ei ignition_wait_seconds 5`;
  after the first apply, rewrite `<code>.json` with a different dashboard list
  and observe the page rebuild within one interval without a relaunch; rewrite it
  with identical bytes and observe no rebuild in logcat (`document unchanged`).
- `python3 tools/provision.py pending` keeps listing the code while the phone
  polls, which is the server-side view of continuous polling.
