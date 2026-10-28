import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../../app/src/config.js";
import {
  DiagnosticsStore,
  deriveStatus,
  redactConfig,
  redactUrl,
  statusLabel,
} from "../../app/src/diagnostics.js";

const { config } = parseConfig(
  "?dashboard_url=https%3A%2F%2Fexample.com%2Fd.json%3Ftoken%3Dsecret&prometheus_url=https%3A%2F%2Fprom.example.com%2F&debug=true",
);

function newStore() {
  return new DiagnosticsStore({ config, startedAt: Date.UTC(2026, 9, 26, 12, 0, 0) });
}

test("C-009 snapshot has every required field and redacts URLs", () => {
  const store = newStore();
  store.request({ url: "https://prom.example.com/api/v1/query?query=secret", status: 200, durationMs: 12 });
  store.setCapabilities({ advertised: ["prometheus"], unknown: [], probed: [] });
  store.setDashboard({
    url: redactUrl("https://example.com/d.json?token=secret"),
    name: "Demo",
    duration: "15m",
    refreshInterval: "10s",
    panelsTotal: 9,
    rowsTotal: 4,
  });
  store.setPanels({
    total: 9,
    rendered: 6,
    hidden: 3,
    errors: 0,
    hiddenReasons: [
      { panelId: "traces", panelKind: "TraceTable", reason: "unsupported_query", detail: "TempoTraceQuery" },
    ],
  });
  store.setLastRefresh({
    startedAt: "2026-10-26T12:00:00.000Z",
    endedAt: "2026-10-26T12:00:00.120Z",
    ok: true,
    durationMs: 120,
    succeeded: 6,
    failed: 0,
  });
  store.setNextRefreshAt("2026-10-26T12:00:10.120Z");
  const snapshot = store.snapshot();
  for (const key of [
    "schemaVersion",
    "renderer",
    "generatedAt",
    "startedAt",
    "config",
    "capabilities",
    "dashboard",
    "panels",
    "lastRefresh",
    "nextRefreshAt",
    "requests",
    "errors",
    "warnings",
  ]) {
    assert.ok(key in snapshot, key);
  }
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.config.displayMode, "standard");
  assert.equal(snapshot.config.dashboardUrl, "https://example.com/d.json");
  assert.equal(snapshot.requests[0].url, "https://prom.example.com/api/v1/query");
  assert.equal(snapshot.dashboard.url, "https://example.com/d.json");
  assert.equal(snapshot.panels.hiddenReasons[0].reason, "unsupported_query");
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);
});

test("C-009 redaction handles userinfo, query, fragment, and invalid input", () => {
  assert.equal(redactUrl("https://user:pass@example.com/a/b?x=1#frag"), "https://example.com/a/b");
  assert.equal(redactUrl("not a url"), "[invalid-url]");
  assert.equal(redactUrl(null), null);
  assert.equal(redactConfig(config).dashboardUrl, "https://example.com/d.json");
});

test("C-009 request, error, and warning logs are bounded", () => {
  const store = newStore();
  for (let i = 0; i < 80; i += 1) {
    store.request({ url: `https://example.com/${i}?x=1`, status: 200, durationMs: i });
    store.error("E_PROM_NETWORK", `error ${i}`, "p", null);
    store.warn("W_SERIES_TRUNCATED", `warning ${i}`, "p", null);
  }
  const snapshot = store.snapshot();
  assert.equal(snapshot.requests.length, 50);
  assert.equal(snapshot.errors.length, 50);
  assert.equal(snapshot.warnings.length, 50);
  assert.equal(snapshot.errors[0].message, "error 30");
  assert.equal(snapshot.warnings[0].message, "warning 30");
  assert.ok(snapshot.requests.every((request) => !request.url.includes("?x=1")));
});

test("C-009 status transitions are deterministic", () => {
  assert.equal(deriveStatus({ phase: "loading" }), "loading");
  assert.equal(deriveStatus({ phase: "idle", total: 0 }), "live");
  assert.equal(deriveStatus({ phase: "idle", total: 5, succeeded: 5, failed: 0 }), "live");
  assert.equal(deriveStatus({ phase: "idle", total: 5, succeeded: 3, failed: 2 }), "degraded");
  assert.equal(deriveStatus({ phase: "idle", total: 5, succeeded: 0, failed: 5, hasLastGood: true }), "stale");
  assert.equal(deriveStatus({ phase: "idle", total: 5, succeeded: 0, failed: 5, hasLastGood: false }), "error");
  assert.equal(deriveStatus({ phase: "idle", fatal: true }), "error");
  assert.equal(statusLabel("degraded"), "Degraded");
});
