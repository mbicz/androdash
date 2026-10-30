# Security architecture

**Status:** baseline for M0; implementation in M1/M2.
**Contracts:** C-007, C-008, C-009.
**Decision:** 0006 (cleartext LAN HTTP).

## 1. Threat model

| Asset | Threat | Impact |
|---|---|---|
| Android device / kiosk | Physical access, back navigation, screen lock bypass | Appliance shows something else or is unusable |
| Dashboard JSON | Malicious strings, huge payloads, Markdown with HTML/JS, hostile links | XSS in the WebView, resource exhaustion, escape from kiosk |
| Prometheus responses | Malicious labels/values, huge series, crafted error strings | XSS, memory exhaustion, misleading display |
| Metrics/config URLs | Tokens in query strings, credentials in userinfo, SSRF-like access to local services | Secret leakage, unintended network access |
| WebView bridge | Arbitrary native actions from injected JS | File/system/Intent access |
| LAN traffic | Cleartext HTTP to Prometheus/dashboard | Eavesdropping, tampering on untrusted Wi-Fi |
| Debug surface | WebView debugging, overlay, verbose logs in production | Information disclosure |

The app is a single-purpose appliance, but it must not become a browser for
untrusted dashboards.

## 2. Trust boundaries

- **Trusted:** APK code, bundled `web/app/` assets, the virtual
  `http://androdash.local` origin, the bridge allowlist.
- **Untrusted:** dashboard JSON, Markdown text, panel titles, labels, Prometheus
  errors, all HTTP responses.
- **Semi-trusted:** the configured Prometheus endpoint (operator-controlled but
  network-exposed) and the dashboard source.
- **Not trusted at all:** any URL loaded into the WebView other than the local
  renderer.

## 3. Controls

### 3.1 WebView lockdown (C-008)

- JavaScript enabled (required for the renderer).
- File/content access disabled; assets are served through the virtual
  `http://androdash.local` origin (decision 0007).
- `allowFileAccessFromFileURLs=false`; `allowUniversalAccessFromFileURLs=false`.
- Mixed content never allowed.
- DOM storage and cookies disabled in v1.
- Zoom disabled; no downloads; no file chooser; no permissions.
- Safe browsing enabled where available.
- SSL errors cancelled; no bypass.
- Navigation blocked except the initial local asset URL.
- WebView remote debugging off in release; on in debug builds only.
- User agent suffix identifies the app; no private data.

### 3.2 Local origin and CSP

The renderer is loaded from `http://androdash.local/index.html`. The shell
intercepts that host and serves bundled assets; no network listener or DNS entry
exists. The HTML includes a restrictive CSP:

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

`'unsafe-inline'` for styles is a v1 concession for chart styling. No inline
scripts. No remote scripts/styles/fonts. If a future change needs more, record a
decision and explain the risk.

`connect-src http: https:` is intentionally broad because the operator supplies
arbitrary dashboard/Prometheus URLs. The app does not proxy requests; the WebView
can reach whatever the network allows. Treat the device as being on a trusted
management network.

### 3.3 Untrusted content handling

- Never assign untrusted strings to `innerHTML`.
- Use `textContent` and explicit DOM creation.
- Markdown: render a small subset (headings, paragraphs, emphasis, inline code,
  fenced code, lists). No raw HTML. No clickable links in v1. Escape all text.
- URLs in Markdown are displayed as text, not navigated.
- Panel titles/descriptions are text.
- Prometheus label values are text.
- SVG is constructed from numeric data and fixed element names; labels are
  escaped text nodes. Do not inject raw SVG/HTML.
- Limit string lengths in diagnostics and error hints (e.g., 200 chars).

### 3.4 Bridge allowlist

The native bridge exposes only:

| Method | Purpose | Constraints |
|---|---|---|
| `platform()` | Return `"android"` | no input |
| `appVersion()` | Return version string | no input |
| `exitKiosk()` | Finish the activity / leave kiosk | no input; debug gating recommended |
| `reload()` | Reload the local renderer | no input |
| `log(level, message)` | Log to logcat | length-limited, redacted |
| `collectorStatus()` | Read the on-phone collector state (decision 0019) | no input; in-memory, ≤ 4 KiB JSON |

No file access, no arbitrary URL loading, no Intent launching, no clipboard, no
network calls. Bridge methods must not throw on malformed input.

The bridge is added only to the trusted local page. Navigation away is blocked,
so injected content cannot reach a different origin with the bridge attached.
Still, treat any XSS as a bridge compromise: keep the allowlist minimal.

### 3.5 URL validation (C-001)

- `dashboard_url` and `prometheus_url` must be absolute `http://` or `https://`.
- Reject `javascript:`, `file:`, `data:`, `content:`, `intent:`, and relative
  URLs.
- Reject userinfo (`user:pass@`) in v1; authentication is out of scope.
- Limit URL length and count.
- Diagnostics/logs redact userinfo and query strings; show scheme + host + path.

### 3.6 Cleartext HTTP

Prometheus on a home LAN commonly speaks HTTP. Android 9+ blocks cleartext by
default. AndroDash v1 allows cleartext (decision 0006) for dashboard and metrics
URLs. Both the dashboard source and Prometheus must allow CORS from the virtual
renderer origin (decision 0008); this is a hosting prerequisite, not a way to
relax WebView security.

Consequences:

- Traffic is readable/tamperable on an untrusted network.
- The app must be deployed on a trusted LAN/VPN or with an HTTPS reverse proxy.
- No credentials are sent in v1, which limits but does not eliminate risk.
- The UI/diagnostics must not imply that HTTP is secure.

Do not add a global "ignore TLS errors" path to compensate for HTTPS misconfig.

### 3.7 Kiosk and physical security

- Immersive mode + back disabled are usability controls, not a security boundary.
- True lock task requires device-owner provisioning; `lock_task=true` attempts it
  and fails gracefully.
- The debug overlay is only reachable with `debug=true`; release hides it.
- The owner can always `adb shell am force-stop com.mbicz.androdash`; document this.
- Do not store secrets on the device in v1.

### 3.8 Logging and diagnostics

- No credentials, tokens, full query strings, or sensitive labels.
- Redact URLs to scheme + host + path.
- Truncate Prometheus error bodies.
- Diagnostics overlay is debug-gated; the C-009 snapshot still redacts.
- Release logs are minimal.

### 3.9 Supply chain

- No runtime npm/CDN dependencies.
- Vendored code (if ever added) must be committed, pinned, and noted in
  `changelog.d`.
- Node is used only for tests, not shipped.
- Do not add a web build step without a decision.
- The one bundled native binary, upstream Prometheus (decision 0019), is
  downloaded at build time and must match the tarball and binary SHA-256 pins
  in `app/build.gradle.kts`; an upgrade changes the version and both pins in
  one reviewed change.

## 4. Residual risks (accepted for v1)

| Risk | Why accepted | Mitigation / revisit |
|---|---|---|
| Cleartext LAN traffic | Prometheus is usually plain HTTP on a home LAN | Trusted LAN/VPN; HTTPS proxy later |
| Physical access to kiosk | Consumer phone, no device-owner guarantee | Immersive + optional lock task; mount physically |
| No authentication to Prometheus | v1 scope | Network controls; auth in a later contract |
| Broad `connect-src` | Operator-supplied URLs | Trusted network; URL validation |
| `style-src 'unsafe-inline'` | SVG/chart styling simplicity | Remove when chart styling is class-based |
| No CSP for the native fatal screen | It is native, not HTML | Keep it text-only |
| Dashboard source can change content | It is an external input | Escape/sanitize; size limits |
| Dashboard source CORS `*` | Required for the virtual app origin (decision 0008) | Restrict at the host/proxy layer if possible |
| Prometheus CORS `*` | Required for the virtual app origin | Restrict at the Prometheus/proxy layer if possible |
| On-phone collector readable by other apps | Android does not isolate loopback ports per app (decision 0019) | Scrape only metrics that LAN exporters already serve openly; `collector=false` removes the listener |
| Phone exporter readable by other apps | Same loopback reason (decision 0021); content is device build, battery, thermal, memory, storage, network type/traffic, cpufreq, screen, uptime, and AndroDash process health only | No identifiers, SSID, IPs, or location (C-008); `collector_phone=false` removes the listener |

## 5. Security checklist for every change

- [ ] No new `innerHTML` with untrusted data.
- [ ] No new remote script/style/font/import.
- [ ] No new bridge method without a contract and review.
- [ ] No navigation away from the local page.
- [ ] No logging of secrets or full URLs.
- [ ] URL/scheme validation still applies.
- [ ] New network endpoint documented in C-003/C-008.
- [ ] Debug-only behavior gated by `debug` or `BuildConfig.DEBUG`.
- [ ] CSP updated if a new resource type is needed.
- [ ] Limits still bound memory/DOM.

## 6. Reporting

There is no bug bounty or private channel defined yet. For a security issue in a
deployed kiosk, take it offline: rotate network access, update the APK, and record
the fix in `changelog.d` without publishing exploit details.
