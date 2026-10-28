import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  DashboardError,
  interpolate,
  normalizeDashboard,
  resolveVariables,
} from "../../app/src/dashboard/normalize.js";

const fixture = JSON.parse(
  await fs.readFile(new URL("../../../contracts/fixtures/demo-dashboard.json", import.meta.url)),
);
const sparkFixture = JSON.parse(
  await fs.readFile(new URL("../../../contracts/fixtures/spark-dashboard.json", import.meta.url)),
);
const url = "http://localhost:8099/contracts/fixtures/demo-dashboard.json";

function normalize(document, options = {}) {
  const warnings = [];
  const dashboard = normalizeDashboard(
    structuredClone(document),
    options.url || url,
    options.name ?? null,
    (...args) => warnings.push(args),
  );
  return { dashboard, warnings };
}

test("C-002 normalizes the demo dashboard", () => {
  const { dashboard, warnings } = normalize(fixture);
  assert.equal(dashboard.title, "AndroDash Demo");
  assert.equal(dashboard.panelsTotal, 9);
  assert.equal(dashboard.rowsTotal, 4);
  assert.equal(dashboard.durationText, "15m");
  assert.equal(dashboard.durationMs, 900000);
  assert.equal(dashboard.refreshSeconds, 10);
  assert.equal(dashboard.datasources.get("prom").pluginKind, "PrometheusDatasource");
  assert.equal(dashboard.datasources.get("prom").url, "http://localhost:9091");
  assert.equal(dashboard.panels.get("cpu").panelKind, "TimeSeriesChart");
  assert.equal(dashboard.panels.get("cpu").queries.length, 1);
  assert.equal(warnings.length, 0);
});

test("C-002 normalizes the Spark Exporter dashboard", () => {
  const { dashboard, warnings } = normalize(sparkFixture, {
    url: "http://localhost:8099/contracts/fixtures/spark-dashboard.json",
  });
  assert.equal(dashboard.title, "Spark Exporter");
  assert.equal(dashboard.panelsTotal, 14);
  assert.equal(dashboard.rowsTotal, 5);
  assert.equal(dashboard.durationText, "15m");
  assert.equal(dashboard.refreshSeconds, 10);
  assert.deepEqual(
    [...dashboard.variables].map((variable) => variable.name),
    ["ds", "gpu", "engine"],
  );
  const queries = [...dashboard.panels.values()].flatMap((panel) =>
    panel.queries.map((query) => query.query),
  );
  assert.equal(queries.length, 23);
  assert.ok(queries.some((query) => query.includes("spark_engine_tokens_per_second")));
  assert.ok(queries.some((query) => query.includes("spark_rdma_counter_total")));
  assert.ok(queries.some((query) => query.includes("node_load1")));
  assert.equal(warnings.length, 0);
});

test("C-002 selects by metadata.name and warns on multiple dashboards", () => {
  const second = structuredClone(fixture);
  second.metadata.name = "Second";
  second.spec.display.name = "Second";
  const warnings = [];
  const selected = normalizeDashboard([fixture, second], url, "Second", (...args) => warnings.push(args));
  assert.equal(selected.title, "Second");
  const warnings2 = [];
  const first = normalizeDashboard([fixture, second], url, null, (...args) => warnings2.push(args));
  assert.equal(first.title, "AndroDash Demo");
  assert.equal(warnings2[0][0], "W_DASHBOARD_MULTIPLE");
  assert.throws(() => normalizeDashboard([fixture], url, "Missing", () => {}), DashboardError);
});

test("C-002 falls back to one stacked row per panel", () => {
  const doc = structuredClone(fixture);
  delete doc.spec.layouts;
  const { dashboard, warnings } = normalize(doc);
  assert.equal(dashboard.rowsTotal, 9);
  assert.ok(warnings.some(([code]) => code === "W_LAYOUT_FALLBACK"));
  assert.equal(dashboard.rows[0].items[0].width, 24);
});

test("C-002 decodes JSON-pointer refs and skips invalid items", () => {
  const doc = structuredClone(fixture);
  doc.spec.panels["nested/id"] = structuredClone(doc.spec.panels.ram);
  doc.spec.layouts[0].spec.items.push({
    x: 0,
    y: 10,
    width: 6,
    height: 4,
    content: { $ref: "#/spec/panels/nested~1id" },
  });
  doc.spec.layouts[0].spec.items.push({
    x: "bad",
    y: 0,
    width: 6,
    height: 4,
    content: { $ref: "#/spec/panels/ram" },
  });
  const { dashboard, warnings } = normalize(doc);
  assert.ok(dashboard.rows[0].items.some((item) => item.panelId === "nested/id"));
  assert.ok(warnings.some(([code]) => code === "W_LAYOUT_ITEM_SKIPPED"));
});

test("C-002 supports inline panels with synthetic IDs", () => {
  const doc = structuredClone(fixture);
  const inline = structuredClone(doc.spec.panels.ram);
  inline.spec.display.name = "Inline";
  doc.spec.layouts[0].spec.items.push({
    x: 0,
    y: 10,
    width: 6,
    height: 4,
    content: { ...inline, kind: "Panel" },
  });
  const { dashboard } = normalize(doc);
  assert.equal(dashboard.panels.has("inline:0:3"), true);
  assert.equal(dashboard.panels.get("inline:0:3").title, "Inline");
  assert.equal(dashboard.panelsTotal, 10);
});

test("C-002 resolves relative datasource URLs and flags unusable ones", () => {
  const doc = structuredClone(fixture);
  doc.spec.datasources.prom.plugin.spec = { directUrl: "/metrics/" };
  doc.spec.datasources.bad = {
    plugin: { kind: "PrometheusDatasource", spec: { directUrl: "ftp://nope" } },
  };
  const { dashboard, warnings } = normalize(doc);
  assert.equal(dashboard.datasources.get("prom").url, "http://localhost:8099/metrics");
  assert.equal(dashboard.datasources.get("bad").url, null);
  assert.ok(warnings.some(([code]) => code === "W_DATASOURCE_INVALID"));
});

test("C-002 defaults malformed durations and clamps refresh", () => {
  const doc = structuredClone(fixture);
  doc.spec.duration = "nonsense";
  doc.spec.refreshInterval = "2s";
  const { dashboard, warnings } = normalize(doc);
  assert.equal(dashboard.durationMs, 3600000);
  assert.equal(dashboard.durationText, "1h");
  assert.equal(dashboard.refreshSeconds, 5);
  assert.ok(warnings.some(([code]) => code === "W_DURATION_INVALID"));
  assert.ok(warnings.some(([code]) => code === "W_REFRESH_CLAMPED"));
});

test("C-002 resolves static and datasource variables", async () => {
  const { dashboard } = normalize(fixture);
  const warnings = [];
  const values = await resolveVariables(dashboard, {
    config: { prometheusUrl: "http://localhost:9091" },
    advertisedCapabilities: ["prometheus"],
    labelValues: async () => ["demo"],
    warn: (...args) => warnings.push(args),
  });
  assert.equal(values.get("job"), "demo");
  assert.equal(values.get("ds"), "prom");
  assert.equal(warnings.length, 0);
});

test("C-002 interpolates variables, missing variables, and literal dollars", () => {
  const warnings = [];
  const values = new Map([
    ["job", "demo"],
    ["job_name", "api"],
  ]);
  assert.equal(
    interpolate("up{job=\"$job\", x=\"${job_name}\", y=\"$$5\"}", values, (...args) => warnings.push(args)),
    "up{job=\"demo\", x=\"api\", y=\"$5\"}",
  );
  assert.equal(interpolate("up{job=\"$missing\"}", values, (...args) => warnings.push(args)), "up{job=\"\"}");
  assert.equal(warnings[0][0], "W_VARIABLE_MISSING");
});

test("C-002 rejects empty and oversized dashboards", () => {
  assert.throws(() => normalize({ kind: "Dashboard", metadata: { name: "x" }, spec: { panels: {} } }), DashboardError);
  const doc = structuredClone(fixture);
  doc.kind = "NotADashboard";
  assert.throws(() => normalize(doc), DashboardError);
});
