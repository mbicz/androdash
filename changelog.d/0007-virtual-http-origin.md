---
id: 0007
date: 2026-10-26
status: accepted
kind: decision
scope: architecture
supersedes: []
---

# Serve the bundled renderer from a virtual local HTTP origin

## Context

The first draft loaded the renderer from `file:///android_asset/index.html`.
That is simple, but modern WebViews treat `file://` as an opaque/`null` origin:
ES module imports are commonly blocked by CORS, service workers/storage have
opaque-origin quirks, and Prometheus CORS must allow `null`. We want plain ES
modules (decision 0005), no web build step, and a real origin we can document.

Using a real HTTPS app origin would make HTTP Prometheus requests mixed content
and block the primary home-LAN use case (decision 0006). A local HTTP server adds
a server process and a port to the shell.

## Decision

Serve the bundled renderer from a **virtual HTTP origin** intercepted inside the
WebView:

```
http://androdash.local/index.html?<C-001 query>
```

- No real network listener and no DNS lookup.
- `WebViewClient.shouldInterceptRequest` maps `http://androdash.local/*` to the
  bundled assets (`web/app/`) via `AssetManager`.
- The main document and all ES modules/styles load from this origin.
- The shell blocks navigation to every other URL; Prometheus/dashboard fetches
  are not navigations and go to their configured http(s) URLs.
- `http://` (not `https://`) is deliberate so HTTP Prometheus requests are not
  mixed content. The origin is intercepted and never exposed to the network.
- The handler:
  - only serves `GET`;
  - normalizes paths and rejects traversal outside the asset root;
  - serves `/` as `/index.html`;
  - sets correct MIME types and `Cache-Control: no-store`;
  - returns 404 for missing assets and logs the path without secrets.
- If the main document cannot be served, the shell shows the native
  `E_ASSET_LOAD` fatal screen.

## Consequences

### Positive

- ES modules and normal fetch/CORS behavior work without a bundler.
- Prometheus CORS sees a concrete origin (`http://androdash.local`) instead of
  `null`; `*` still works.
- No mixed-content blocking for HTTP Prometheus.
- No file/content access is needed in the WebView, tightening C-008.
- No local server process, port, or permission.

### Negative / risks

- Custom interception code must be tested for MIME/path/traversal/404 cases.
- An HTTP origin is not a secure context; v1 does not need powerful web APIs.
- A future HTTPS app origin would require HTTPS Prometheus or a new mixed-content
  decision.
- Prometheus CORS must allow the virtual origin (or `*`).

### Follow-ups

- M2: implement and test the handler on the emulator (main page + modules + CSS).
- Verify `shouldInterceptRequest` is invoked for the main document and module
  imports on API 35.
- If interception proves unreliable, fall back to a localhost HTTP server or a
  single classic script, and record a new decision. Do not silently switch to
  `file://` with universal file access.

## Contracts affected

- C-001: renderer URL.
- C-003: CORS origin and mixed-content wording.
- C-007: native fatal/asset loading.
- C-008: trust model, file access settings, navigation policy, CSP.

## Verification

- Emulator loads `http://androdash.local/index.html?...` and all modules.
- `shouldInterceptRequest` serves HTML/JS/CSS with correct MIME; unknown paths
  404; traversal attempts 404.
- Prometheus requests carry `Origin: http://androdash.local` and succeed with
  CORS `*`.
- Navigation to `http://example.com` is blocked.
