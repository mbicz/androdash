# C-008 — WebView security

- **Version:** 6
- **Status:** Accepted, 2026-10-29 (v2: bundled and stored dashboards on the
  virtual origin, decision 0018; v3: bundled Prometheus executable on
  loopback, decision 0019; v4: stored-dashboard slots, generated
  `dashboards/index.json`, `setOption("dashboard_urls")` cannot add remote
  URLs, decision 0020; v5: in-app phone exporter, second loopback listener,
  decision 0021; v6: the settings sheet can add remote and inline dashboards
  and edit collector targets, `/inline/<id>.json` route, decision 0023)
- **Consumers:** Android shell (W1), web renderer (W2)
- **Related:** C-001 (URL validation), C-003 (CORS/cleartext), C-007 (bridge), C-009 (redaction)

## Purpose

Define the WebView security posture, allowed content, URL/navigation rules, and
the JavaScript bridge boundary. The dashboard JSON and Prometheus responses are
untrusted; the local renderer is trusted.

## Trust model

- Trusted: APK code, `web/app` assets served from the virtual
  `http://androdash.local` origin (decision 0007), the limited bridge, and the
  pinned upstream Prometheus binary bundled as `libprometheus.so` (decision
  0019; trusted as code, not its scrape data).
- Untrusted: dashboard JSON — including the bundled `/dashboards/*.json`
  fixtures and the stored copies under `/stored/` — Markdown, labels, error
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
  `/styles.css`, `/src/**.js`, `/dashboards/<name>.json` (bundled dashboards
  and the build-generated `dashboards/index.json` listing them,
  `[A-Za-z0-9_.-]+`), the stored-dashboard slot paths below, and inline
  dashboards at `/inline/<id>.json` (`^/inline/([0-9a-f]{16})\.json$`, served
  like the stored slots; 404 when absent). Paths with
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

### Stored dashboards (decisions 0018, 0020)

- The shell keeps at most 8 stored dashboards, one per position (slot `i`,
  `0…7`) in C-001 `dashboard_urls`: untrusted JSON that the renderer fetched
  from a configured dashboard URL and handed back through
  `AndroDash.storeDashboard` (C-007). Each is served back verbatim, only to the
  same virtual origin, at `GET /stored/<i>/dashboard.json` and
  `GET /stored/<i>/meta.json`, matched exactly by
  `^/stored/([0-7])/(dashboard|meta)\.json$` (`application/json`,
  `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`; 404 when the slot is empty). No other `/stored/`
  path exists; the pre-slot `/stored/dashboard.json` and `/stored/meta.json`
  are 404.
- The shell checks only that it is one JSON object of at most 5 MiB UTF-8; it
  does not interpret it. The renderer normalizes a stored copy as untrusted
  exactly like a fetched dashboard (C-002, [Untrusted content
  handling](#untrusted-content-handling)); storing it grants no privilege.
- No path parameter, query, or JSON field reaches the filesystem: slot `i`
  uses the fixed names `dashboards/stored-<i>.json` and
  `dashboards/stored-<i>.meta.json` in app-private storage, where `i` is the
  route digit or the bounded list position, never caller text.
- `storeDashboard` accepts only a current `dashboard_urls` entry in
  `dashboard_source=stored` mode and never a virtual-origin URL, so a page cannot
  plant a dashboard for a different URL or overwrite a bundled one.
- The settings sheet adds dashboards on the user's behalf (decision 0023):
  `setOption("dashboard_urls", …)` (C-007) accepts any absolute `http`/`https`
  URL, and `setOption("collector_targets", …)` any valid `host:port`. Both are
  user input typed into the sheet; the renderer never derives them from
  dashboard or Prometheus content, which it renders as text only. Dashboard
  fetches stay `fetch` requests under C-003, never navigations, and collector
  targets are scraped by Prometheus, not by the WebView.
- Inline dashboards (`addInlineDashboard`) are untrusted JSON like any
  fetched dashboard. The file name is the shell-computed SHA-256 prefix;
  at most 8 exist, and those no longer in `dashboard_urls` are deleted.
- The shell never logs stored contents or source URLs; it logs byte counts and
  slot numbers.

## Bundled executable (decision 0019)

With C-001 `collector=true`, the shell runs a native executable: the upstream
Prometheus linux-arm64 release, packaged as
`lib/arm64-v8a/libprometheus.so` and executed from `nativeLibraryDir`.

- **Provenance.** The build downloads one pinned release tarball and fails
  unless both the tarball and the extracted binary match SHA-256 values pinned
  in `app/build.gradle.kts`. The binary is packaged unstripped and unmodified;
  its `LICENSE` and `NOTICE` ship as `assets/licenses/prometheus/`. Upgrading
  means changing the version and both pins together (decision 0019).
- **Loopback only.** Prometheus listens on `127.0.0.1:19090`, never on a LAN
  interface, with at most 32 connections. No admin API, lifecycle API, or
  remote-write receiver is enabled. The renderer reaches it as an ordinary
  `connect-src http:` Prometheus URL; Prometheus's default CORS policy allows
  the `http://androdash.local` origin.
- **Other apps can read it.** Android does not isolate loopback ports by app:
  any app on the phone with `INTERNET` can query `127.0.0.1:19090` and read
  every collected metric (and the target list via the HTTP API). The data is
  what the LAN exporters already serve unauthenticated; do not scrape
  exporters whose metrics must stay private from other apps on the phone.
- **Config from validated fields only.** `prometheus.yml` is generated from
  the C-001 collector fields after validation: job and instance names are
  `[A-Za-z0-9_.-]{1,64}`, addresses are `host:port` with a DNS name, IPv4, or
  bracketed IPv6 host. Every value is double-quoted and cannot contain a quote,
  backslash, or control character, so no input can add YAML keys. The command
  line is a fixed argument list (no shell); only the retention value comes from
  config, as a canonical duration. Nothing comes from the renderer, dashboard
  JSON, or the bridge.
- **Scrapes are outbound LAN HTTP** from the app's UID, like the renderer's
  Prometheus queries (decision 0006). Scraped samples are untrusted data;
  they reach the renderer only as Prometheus query results.
- **Files** live in app-private storage (`<filesDir>/collector/`); the log is
  capped at 1 MiB per start and contains Prometheus's own warnings.

## Phone exporter listener (decision 0021)

With C-001 `collector=true` and `collector_phone=true` the app itself listens
on a second loopback port, served by Kotlin code in the app process (C-007
"Phone exporter"):

- **Loopback only.** `127.0.0.1:19100`, never a LAN interface. One daemon
  thread serves one connection at a time.
- **Minimal HTTP/1.1.** The request head (request line plus headers) is read
  up to 8 KiB, with a 5 s socket timeout. `GET /metrics` (query string
  ignored) returns `200` with `Content-Type: text/plain; version=0.0.4;
  charset=utf-8`; any other well-formed request returns `404`; a malformed,
  incomplete, or oversized head returns `400`. Every response has
  `Content-Length` and `Connection: close`. No other method, path, header,
  or body is interpreted; request bytes never reach a file, process, or log.
- **Content: phone state, no identifiers.** Only the metrics listed in
  [`docs/integrations/phone-exporter.md`](../integrations/phone-exporter.md):
  device build (manufacturer, model, Android release, SDK level), battery,
  thermal, memory, storage, traffic counters, network transport type, Wi-Fi
  RSSI and link speed, cpufreq, screen state and brightness, uptime/boot
  time, AndroDash process RSS/CPU, collector health, and exporter self
  metrics. No serial, IMEI, Android ID, account, SSID/BSSID, IP or MAC
  address, location, app list, or notification content. Labels are bounded
  (fixed enums, cpufreq policy numbers, build strings).
- **Permissions.** `ACCESS_NETWORK_STATE` and `ACCESS_WIFI_STATE` (normal,
  install-time). Wi-Fi data comes from the active network's redacted
  `WifiInfo` (API 31+); location permission is never requested. No runtime
  permission prompt.
- **Other apps can read it** over loopback, like the collector (decision
  0019). The content above is chosen to be harmless to expose to other apps on
  the same phone; `collector_phone=false` or `collector=false` removes the
  listener.

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
      `AssetServerRouteTest` updated; stored-dashboard slots keep fixed names.
- [ ] Bundled Prometheus still pinned by both SHA-256 values, listening on
      `127.0.0.1` only, with no admin/lifecycle/remote-write flags
      (`CollectorConfigTest`).
- [ ] Phone exporter still `127.0.0.1:19100` only, `GET /metrics` only, head
      ≤ 8 KiB, no identifier metrics or labels (`MiniHttpTest`,
      `PhoneMetricsTest`).

## Residual risks

See `docs/architecture/security.md` §4. Accepted for v1: cleartext LAN,
physical access, no auth, broad `connect-src`, inline styles, dashboard/Prometheus
CORS permissiveness, and collector and phone-exporter metrics readable by
other apps over loopback (decisions 0019, 0021). Revisit each with a decision
when the deployment changes.

## Out of scope

- Authentication/token storage.
- Certificate pinning/mTLS.
- Remote dashboard editing.
- Multi-origin/CORS proxy.
- Android permissions for location/camera/mic.
- Preventing screenshots or screen recording.
