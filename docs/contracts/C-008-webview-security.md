# C-008 — WebView security

- **Version:** 2
- **Status:** Accepted, 2026-10-28 (v2: bundled and stored dashboards on the
  virtual origin, decision 0018)
- **Consumers:** Android shell (W1), web renderer (W2)
- **Related:** C-001 (URL validation), C-003 (CORS/cleartext), C-007 (bridge), C-009 (redaction)

## Purpose

Define the WebView security posture, allowed content, URL/navigation rules, and
the JavaScript bridge boundary. The dashboard JSON and Prometheus responses are
untrusted; the local renderer is trusted.

## Trust model

- Trusted: APK code, `web/app` assets served from the virtual
  `http://androdash.local` origin (decision 0007), the limited bridge.
- Untrusted: dashboard JSON — including the bundled `/dashboards/*.json`
  fixtures and the stored copy under `/stored/` — Markdown, labels, error
  strings, every HTTP response. Serving dashboard JSON from the virtual origin
  does not make it trusted.
- Not allowed: any remote page, script, style, font, iframe, or navigation.

## WebView settings

Required in v1:

| Setting | Value | Reason |
|---|---|---|
| JavaScript | enabled | Renderer |
| DOM storage | disabled | No need; smaller surface |
| Database | disabled | No need |
| Geolocation | disabled | No need |
| Media playback / autoplay | disabled / requires gesture | No media |
| File access | disabled | Renderer is served through the virtual origin, not `file://` |
| Content access | disabled | No `content://` |
| File access from file URLs | disabled | No file-origin reads |
| Universal access from file URLs | disabled | No CORS bypass |
| Mixed content | `MIXED_CONTENT_NEVER_ALLOW` | No HTTPS→HTTP page |
| Safe browsing | enabled where available | Defense in depth |
| Built-in zoom / controls | disabled | Kiosk layout |
| Support zoom | disabled | Layout stability |
| Cookies | disabled; third-party disabled | No auth in v1 |
| Cache mode | default; app fetches `no-store` | Avoid stale dashboards/data |
| WebView debugging | off in release; on in debug | No remote inspection in production |
| Downloads | blocked | No escape |
| File chooser | blocked/not offered | No file access |
| Permissions | denied / not requested | No camera/mic/location |
| Cleartext traffic | allowed (decision 0006) | LAN HTTP dashboard/Prometheus |
| SSL errors | cancel | No bypass |
| User agent | default + `AndroDash/<version>` | Optional generator hint |

If a setting needs to change, update this table and the security doc.

## URL and navigation policy

- The only allowed document URL is the virtual renderer:
  `http://androdash.local/index.html?…` with the C-001 parameters.
- The shell intercepts every request to `http://androdash.local` and serves it
  from bundled assets (decision 0007). No network listener or DNS exists for that
  host. Only an explicit route list is reachable: `/`, `/index.html`,
  `/styles.css`, `/src/**.js`, `/dashboards/<name>.json` (bundled dashboards,
  `[A-Za-z0-9_.-]+`), and the two exact stored-dashboard paths below. Paths with
  `..`, `\`, `%`, or `//` are rejected (400); anything else is 404.
- `WebViewClient.shouldOverrideUrlLoading` returns `true` (block) for every URL
  outside `http://androdash.local/`. Do not open an external browser from kiosk
  mode.
- Block `javascript:` URLs, `data:`, `content:`, `intent:`, `file:`, and unknown
  schemes.
- Block redirects that leave the virtual origin. The dashboard/Prometheus fetches
  are not navigations; they are subject to C-003/CORS.
- Do not allow `window.open`/target=_blank; renderer never creates links.
- Do not inject `evaluateJavascript` from untrusted input. Native may evaluate a
  fixed, constant script for lifecycle (if needed); prefer bridge/page APIs.

### Stored dashboard (decision 0018)

- The shell keeps at most one stored dashboard: untrusted JSON that the
  renderer fetched from the configured `dashboard_url` and handed back through
  `AndroDash.storeDashboard` (C-007). It is served back verbatim, only to the
  same virtual origin, at `GET /stored/dashboard.json` and
  `GET /stored/meta.json` (`application/json`, `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`; 404 when absent).
- The shell checks only that it is one JSON object of at most 5 MiB UTF-8; it
  does not interpret it. The renderer normalizes the stored copy as untrusted
  exactly like a fetched dashboard (C-002, [Untrusted content
  handling](#untrusted-content-handling)); storing it grants no privilege.
- No path parameter, query, or JSON field reaches the filesystem: the store
  uses the fixed names `dashboards/stored.json` and `dashboards/stored.meta.json`
  in app-private storage. The routes take no parameters.
- `storeDashboard` accepts only the current `dashboard_url` in
  `dashboard_source=stored` mode and never a virtual-origin URL, so a page cannot
  plant a dashboard for a different URL or overwrite a bundled one.
- The shell never logs stored contents or source URLs; it logs byte counts.

## Content Security Policy

`index.html` includes:

```
default-src 'none';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
connect-src http: https:;
font-src 'self';
base-uri 'none';
form-action 'none';
frame-ancestors 'none';
```

Notes:

- No inline scripts. All JS is a local module.
- `style-src 'unsafe-inline'` is a v1 concession for SVG/chart styling; no remote
  styles. Prefer classes/attributes and remove this when practical.
- `connect-src http: https:` is required because Prometheus/dashboard URLs are
  operator-supplied. This is a deliberate, documented exposure; see decision
  0006.
- `img-src data:` is for simple inline status icons only; no remote images.
- No `frame-src`, `object-src`, or `media-src` allowances.
- If a future feature needs another source, update the CSP and this contract.

CSP is defense in depth; the renderer still escapes untrusted strings.

## Untrusted content handling

- Never use `innerHTML`/`outerHTML` with untrusted data. Use `textContent` and
  DOM builders.
- Markdown is rendered by a sanitizing subset renderer (C-005): no raw HTML, no
  images, no links/navigations.
- SVG is constructed from fixed element names and numeric values; labels are
  text nodes. Never inject raw SVG/HTML from dashboard metadata.
- Prometheus labels/errors are text; truncate/escape before display.
- Panel/dashboard titles/descriptions are text.
- URLs are not rendered as clickable links in v1.
- Reject/strip control characters in displayed strings if they can break layout.

## Bridge

`window.AndroDash` is added only to the local page and exposes only C-007
methods. It must not expose:

- arbitrary `loadUrl`, `evaluateJavascript`, file/Intent access;
- clipboard, contacts, location, camera/mic;
- network requests or shell commands;
- reflection/class loading.

Every `@JavascriptInterface` method:

- validates input types/lengths;
- can only perform its documented action;
- logs without secrets;
- never throws to JS (return a safe value / no-op on error).

Treat XSS as a bridge-compromise scenario. The allowlist is the last line of
defense.

## URL validation (defense in depth)

C-001 validates launch URLs, but the renderer also:

- rejects non-http(s) datasource/dashboard URLs;
- rejects userinfo in v1;
- resolves relative datasource URLs only against the dashboard origin;
- never navigates to a response-provided URL;
- does not fetch arbitrary URLs from Markdown/panel content.

Prometheus requests go to configured base URLs only (plus API paths). No
response-driven request routing.

## Cleartext HTTP

Allowed for local LAN metrics/dashboards (decision 0006). The dashboard source
and Prometheus must also permit CORS from `http://androdash.local` (or `*`);
this is a deployment prerequisite (C-002/C-003), not a browser setting.

Constraints:

- No credentials/tokens over cleartext.
- Deploy on a trusted LAN/VPN or behind an HTTPS reverse proxy.
- Do not add `onReceivedSslError` bypasses.
- Mixed content remains disabled; if the renderer is served over HTTPS later,
  HTTP Prometheus URLs would be blocked. Record a decision before changing the
  serving scheme.
- The UI must not imply that HTTP is secure.

## Logging and diagnostics

- Redact URLs to scheme + host + path (no query/userinfo).
- Truncate Prometheus error bodies and labels.
- Debug logging only in debug builds or with `debug=true`.
- No `console.log` of raw dashboard JSON or full responses in release.
- Diagnostics overlay follows C-009.

## Security checklist (PR gate)

- [ ] No remote scripts/styles/fonts/iframes/images.
- [ ] No untrusted `innerHTML`; no `eval`/`new Function`.
- [ ] Navigation remains blocked; no external browser.
- [ ] Bridge unchanged or contract updated/reviewed.
- [ ] URL validation still applies; no userinfo.
- [ ] CSP still matches the resource types used.
- [ ] WebView debugging off in release.
- [ ] No secrets/full URLs in logs/diagnostics.
- [ ] Cleartext use documented; no TLS bypass.
- [ ] Downloads/file chooser/permissions stay disabled.
- [ ] Limits still bound untrusted payload sizes (stored dashboard ≤ 5 MiB).
- [ ] Virtual-origin routes unchanged, or this contract and
      `AssetServerRouteTest` updated; stored-dashboard files keep fixed names.

## Residual risks

See `docs/architecture/security.md` §4. Accepted for v1: cleartext LAN,
physical access, no auth, broad `connect-src`, inline styles, dashboard/Prometheus
CORS permissiveness. Revisit each with a decision when the deployment changes.

## Out of scope

- Authentication/token storage.
- Certificate pinning/mTLS.
- Remote dashboard editing.
- Multi-origin/CORS proxy.
- Android permissions for location/camera/mic.
- Preventing screenshots or screen recording.
