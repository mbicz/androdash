---
id: 0027
date: 2026-11-01
status: accepted
kind: contract
scope: android, docs, tools
supersedes: []
amended-by: [0028]
---

# Device-code provisioning: a phone fetches its own Ignition document

## Context

Ignition (decision 0024) seeds a device from one document, but the document has
to be fetched from a URL that is the same for every phone, or copied to each
phone over `adb`. In a fleet, the operator has to know which phone is which
before the first launch. The phone also has no way to say "I am here and I am
not configured yet".

The identity has to come from the phone, survive app updates and in-app edits,
and be short enough to read off the screen and type into a server. Constraints:

- `ignition_url` is validated as an http(s) URL with no userinfo (C-001), so no
  secret can ride in it. A token in the URL would be logged by every proxy.
- A MAC address is not usable: on Android 6+ `/sys/class/net/wlan0/address` is
  unreadable (verified on the Pixel 4a (5G): permission denied) and the address
  is randomised per SSID.
- `Settings.Secure.ANDROID_ID` is a stable device fingerprint; printing it on an
  unattended LAN screen leaks an identifier that survives reinstalls.
- C-008 forbids a LAN listener on the phone, so the phone must poll, not be
  pushed to, and no mDNS responder can run.

Options considered and rejected: MAC as the key; `ANDROID_ID` as the only key;
`Build.MODEL` or a hostname as the key (not unique in a fleet of identical
appliances); a secret in the URL; mDNS/Bonjour registration; a phone-side HTTP
server; a QR code (no camera path in v1, and additive later).

## Decision

1. **Six-digit device code, generated once by the app.** `SecureRandom` picks
   `100000…999999`; it is stored in the existing `androdash` preferences file
   under `device_code` and never regenerated while it exists. It is shown on the
   unprovisioned screen, so an operator can read it off the phone and type it
   into the server.
2. **URL template, not a new URL grammar.** `ignition_url` stays a plain http(s)
   URL, but two tokens are substituted by the shell before the fetch:
   `{device}` → the six-digit code, `{deviceId}` → the first 8 lowercase hex
   characters of SHA-256 of `ANDROID_ID`. Any other `{…}` token, a fragment, or
   an over-long result is `E_IGNITION_FETCH`.
3. **Identity parameters are always appended.** `device_code`, `device_model`
   (`Build.MANUFACTURER Build.MODEL`), and `device_ip` (the LAN IPv4 address,
   omitted when the phone has none) are added when the URL does not already
   carry them. A server can therefore key on anything with a plain URL, without
   templating. Values are percent-encoded (`%20` for spaces).
4. **Opt-in wait mode.** `--ez ignition_wait true` makes "no document yet" a
   state instead of an error:
   - `404`, `410`, and `204` mean pending; every other non-2xx status and every
     transport failure is retried too.
   - The shell shows a provisioning screen — the code, the redacted URL, the
     last outcome, the attempt count, and Retry — and retries every
     `ignition_wait_seconds` (`15` by default, `1…300`).
   - A device that already has a persisted config keeps running it while a
     re-fetch fails; a document that arrives is applied exactly like a one-shot
     seed.
   - A 2xx document that does not parse is still `E_IGNITION`: that is operator
     error, not a pending state.
   - After a successful apply the template and interval are persisted
     (`ignition_url`, `ignition_wait_seconds`) and the extra is dropped, so the
     next launch re-fetches. The re-fetch happens on launch only; it never
     overwrites a live in-app edit.
   - `--ez ignition_wait false` (or no template and no persisted URL) returns to
     one-shot mode and clears the stored template.
5. **One-shot stays the default.** Without `ignition_wait`, an `ignition_url`
   extra behaves exactly as in decision 0024: fetch once, apply, delete the file
   source, drop the extra; every non-2xx is `E_IGNITION_FETCH`. A persisted
   provisioning URL alone re-fetches in wait mode; that is how a provisioned
   device keeps checking in.
6. **Server side is a file convention.** `provisioning/<code>.json` served by
   `tools/serve_demo.py` under `/ignition/`; a missing file is a natural 404.
   Every poll is appended to `provisioning/requests.jsonl` (bounded to 500
   lines), so `tools/provision.py pending` lists the codes waiting, `write`
   validates a document with the same rules the shell enforces before storing
   it, and `clear` returns a code to the waiting state.
7. **Native only.** The code, the tokens, and wait mode never reach the
   renderer: they are not `AppConfig` fields and not query parameters. There is
   no new bridge method.

## Consequences

### Positive

- A phone can be provisioned without anyone knowing its serial number first:
  launch it, read the six digits, write that file.
- The code is stable across app updates and config resets, and survives the
  one-shot consumption of decision 0024 because it lives under its own key.
- A fleet can be seeded by a static directory; no new service or credentials.

### Negative / risks

- Six digits are guessable. The convention is unauthenticated, like the rest of
  v1: anyone who can reach the provisioning directory can write a document for
  any code, exactly as anyone who can reach the phone can send a launch extra.
  It is not a security boundary and must not be treated as one.
- The provisioning screen keeps the CPU awake only while it polls; the retry
  timer stops in `onStop`.
- `device_model` and `device_ip` are sent to the provisioning server. That is
  the point of provisioning, but it means the URL must stay on a trusted LAN.
- Wait mode re-fetches on every launch. An operator who edits targets in the app
  and then relaunches the appliance gets the server's document again; that is
  the documented trade-off of wait mode, and `ignition_wait=false` opts out.

### Follow-ups

- A Settings entry that shows the device code and the provisioning state.
- An authenticated variant (a shared secret or a one-time token) if the
  provisioning server ever leaves the trusted LAN.

## Contracts affected

- C-001: wire-format rows `ignition_wait`, `ignition_wait_seconds`; Ignition
  section gains token substitution, identity parameters, and the one-shot vs
  wait table.
- C-009: `E_IGNITION_FETCH` now also covers a rejected `ignition_url` template
  (an unknown `{token}`, a fragment, or an over-long result). No new code is
  introduced: a missing document in wait mode is a state shown on the
  provisioning screen, not an error code.
- C-007: no change; the code and wait mode are native-only and there is no new
  bridge method.
- C-008: no change; the phone still has no LAN listener.

## Verification

- `ProvisioningTest` (13 cases): code generation/validation, device-id hash,
  token substitution, appended identity parameters, offline omission, unknown
  token, invalid template shapes, wait bounds, persisted-template reuse and
  opt-out.
- `tools/test_provisioning.py` (9 cases): code validation and path safety,
  round-trip, invalid documents rejected, clear idempotence, served/waiting
  lists, bounded request log.
- On the Pixel 4a (5G): `--es ignition_url http://192.168.192.16:8099/ignition/{device}.json --ez ignition_wait true`
  shows the provisioning screen with a code equal to `shared_prefs/androdash.xml`;
  with no document it stays on that screen and retries; writing
  `<code>.json` applies it within one interval and the dashboard renders.
