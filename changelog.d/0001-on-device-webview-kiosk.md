---
id: 0001
date: 2026-10-26
status: accepted
kind: decision
scope: architecture
supersedes: []
---

# Render dashboards on-device in an Android WebView kiosk

## Context

The goal is a wall dashboard that uses the RAM/CPU of a directly connected or
Wi-Fi Android phone, not a remote browser or screenshot service. Perses
dashboards are the input format; Prometheus is the first data source.

Native Android charting would require reimplementing Perses panel semantics in
Kotlin and would slow iteration. A server-side Perses UI would contradict the
"phone does the rendering" requirement.

## Decision

Ship a thin Android Kotlin shell that hosts a **local, bundled WebView
renderer**. The shell parses launch configuration, locks down the WebView, and
applies kiosk behavior. The WebView loads a bundled renderer from the virtual app
origin (refined by decision 0007), fetches the dashboard JSON and Prometheus data
directly, and renders on-device.

Kiosk mode is the default: fullscreen/immersive, keep screen on, Back disabled.
True lock task is optional and requires device-owner provisioning.

## Consequences

### Positive

- The phone performs layout, charting, and refresh using its own resources.
- No dashboard application server is required.
- Web tooling and browser debugging remain available.
- The native layer stays small and replaceable.

### Negative / risks

- WebView performance/memory depends on the device and WebView version.
- Cleartext LAN HTTP is needed for typical Prometheus setups (decision 0006).
- The app must defend against untrusted dashboard/Markdown content.
- A WebView is not a security boundary; kiosk is a posture, not containment.

### Follow-ups

- M2 Android shell: C-007/C-008.
- Emulator demo via `10.0.2.2`.
- Real-phone soak test and optional lock-task provisioning notes.

## Contracts affected

- C-001, C-007, C-008 established.

## Verification

- M2 manual checklist in `docs/architecture/testing.md`.
- Fullscreen/back/keep-awake behavior observed on the emulator.
- No remote code/navigation (C-008 audit).
