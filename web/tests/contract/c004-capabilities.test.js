import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parseConfig } from "../../app/src/config.js";
import { normalizeDashboard, resolveVariables } from "../../app/src/dashboard/normalize.js";
import { evaluatePanel, filterDashboard } from "../../app/src/eligibility.js";

const fixture = JSON.parse(
  await fs.readFile(new URL("../../../contracts/fixtures/demo-dashboard.json", import.meta.url)),
);
const sparkFixture = JSON.parse(
  await fs.readFile(new URL("../../../contracts/fixtures/spark-dashboard.json", import.meta.url)),
);
const macosFixture = JSON.parse(
  await fs.readFile(new URL("../../../contracts/fixtures/macos-node-dashboard.json", import.meta.url)),
);
const url = "http://localhost:8099/contracts/fixtures/demo-dashboard.json";
const baseConfig = parseConfig(
  `?dashboard_url=${encodeURIComponent(url)}&prometheus_url=http%3A%2F%2Flocalhost%3A9091`,
).config;

async function model(doc = fixture) {
  const dashboard = normalizeDashboard(structuredClone(doc), url, null, () => {});
  const variables = await resolveVariables(dashboard, {
    config: baseConfig,
    advertisedCapabilities: ["prometheus"],
    labelValues: async () => ["demo"],
    warn: () => {},
  });
  return { dashboard, variables };
}

test("C-004 demo capability matrix: 9 total, 6 eligible, 3 hidden", async () => {
  const { dashboard, variables } = await model();
  const filtered = filterDashboard(dashboard, {
    config: baseConfig,
    advertised: ["prometheus"],
    variables,
    probes: [{ baseUrl: "http://localhost:9091", ok: true }],
  });
  assert.deepEqual(filtered.counts.total, 9);
  assert.equal(filtered.counts.rendered, 6);
  assert.equal(filtered.counts.hidden, 3);
  assert.deepEqual(
    filtered.counts.hiddenReasons.map((item) => [item.panelId, item.reason, item.detail]),
    [
      ["logs", "unsupported_query", "LokiLogQuery"],
      ["traces", "unsupported_query", "TempoTraceQuery"],
      ["unknown", "unsupported_panel", "FancyChart"],
    ],
  );
  assert.deepEqual(filtered.dataPanelIds.sort(), ["cpu", "disk", "load", "ram", "requests"]);
  assert.equal(filtered.rows.length, 2);
});

test("C-004 Spark dashboard is fully eligible with Prometheus", async () => {
  const { dashboard, variables } = await model(sparkFixture);
  const filtered = filterDashboard(dashboard, {
    config: baseConfig,
    advertised: ["prometheus"],
    variables,
    probes: [{ baseUrl: "http://localhost:9091", ok: true }],
  });
  assert.equal(filtered.counts.total, 14);
  assert.equal(filtered.counts.rendered, 14);
  assert.equal(filtered.counts.hidden, 0);
  assert.equal(filtered.dataPanelIds.length, 13);
  assert.equal(filtered.rows.length, 5);
  assert.equal(filtered.visible.get("about").panel.panelKind, "Markdown");
});

test("C-004 macOS node_exporter dashboard is fully eligible without warnings", async () => {
  const warnings = [];
  const dashboard = normalizeDashboard(structuredClone(macosFixture), url, null, (code) =>
    warnings.push(code),
  );
  const variables = await resolveVariables(dashboard, {
    config: baseConfig,
    advertisedCapabilities: ["prometheus"],
    labelValues: async () => [],
    warn: (code) => warnings.push(code),
  });
  const filtered = filterDashboard(dashboard, {
    config: baseConfig,
    advertised: ["prometheus"],
    variables,
    probes: [{ baseUrl: "http://localhost:9091", ok: true }],
  });
  assert.deepEqual(warnings, []);
  assert.equal(filtered.counts.hidden, 0);
  assert.equal(filtered.counts.rendered, filtered.counts.total);
  assert.equal(filtered.visible.get("about").panel.panelKind, "Markdown");
});

test("C-004 no prometheus capability hides data panels but keeps Markdown", async () => {
  const { dashboard, variables } = await model();
  const config = parseConfig(
    `?dashboard_url=${encodeURIComponent(url)}&prometheus_url=http%3A%2F%2Flocalhost%3A9091&capabilities=inert`,
  ).config;
  const filtered = filterDashboard(dashboard, {
    config,
    advertised: ["inert"],
    variables,
    probes: [],
  });
  assert.equal(filtered.counts.rendered, 1);
  assert.equal(filtered.visible.has("notes"), true);
  assert.equal(filtered.hidden.get("cpu").reason, "capability_unavailable");
  assert.equal(filtered.hidden.get("traces").reason, "unsupported_query");
});

test("C-004 failed probe hides panels with probe_failed and keeps Markdown", async () => {
  const { dashboard, variables } = await model();
  const filtered = filterDashboard(dashboard, {
    config: baseConfig,
    advertised: ["prometheus"],
    variables,
    probes: [{ baseUrl: "http://localhost:9091", ok: false, error: "connection refused" }],
  });
  assert.equal(filtered.visible.has("notes"), true);
  assert.equal(filtered.hidden.get("ram").reason, "probe_failed");
  assert.equal(filtered.hidden.get("ram").detail, "connection refused");
});

test("C-004 show_unsupported keeps rows and creates placeholders", async () => {
  const { dashboard, variables } = await model();
  const config = parseConfig(
    `?dashboard_url=${encodeURIComponent(url)}&prometheus_url=http%3A%2F%2Flocalhost%3A9091&show_unsupported=true`,
  ).config;
  const filtered = filterDashboard(dashboard, {
    config,
    advertised: ["prometheus"],
    variables,
    probes: [{ baseUrl: "http://localhost:9091", ok: true }],
  });
  assert.equal(filtered.rows.length, 4);
  const placeholders = filtered.rows.flatMap((row) => row.items).filter((item) => item.state === "unsupported");
  assert.equal(placeholders.length, 3);
  assert.equal(filtered.counts.hidden, 3);
});

test("C-004 unsupported query wins over unsupported panel and capability unavailable", async () => {
  const doc = structuredClone(fixture);
  doc.spec.panels.mixed = structuredClone(doc.spec.panels.cpu);
  doc.spec.panels.mixed.spec.plugin = { kind: "FancyChart", spec: {} };
  doc.spec.panels.mixed.spec.queries.push(structuredClone(doc.spec.panels.traces.spec.queries[0]));
  doc.spec.layouts[0].spec.items.push({
    x: 0,
    y: 12,
    width: 6,
    height: 4,
    content: { $ref: "#/spec/panels/mixed" },
  });
  const { dashboard, variables } = await model(doc);
  const filtered = filterDashboard(dashboard, {
    config: baseConfig,
    advertised: ["prometheus"],
    variables,
    probes: [{ baseUrl: "http://localhost:9091", ok: true }],
  });
  assert.equal(filtered.hidden.get("mixed").reason, "unsupported_query");
  assert.equal(filtered.hidden.get("mixed").detail, "TempoTraceQuery");
});

test("C-004 no_queries and invalid_panel precedence", async () => {
  const doc = structuredClone(fixture);
  doc.spec.panels.empty = structuredClone(doc.spec.panels.ram);
  doc.spec.panels.empty.spec.queries = [];
  doc.spec.panels.broken = { kind: "Panel", spec: { plugin: { kind: "TimeSeriesChart", spec: "bad" } } };
  doc.spec.layouts[0].spec.items.push(
    { x: 0, y: 12, width: 6, height: 4, content: { $ref: "#/spec/panels/empty" } },
    { x: 6, y: 12, width: 6, height: 4, content: { $ref: "#/spec/panels/broken" } },
  );
  const { dashboard, variables } = await model(doc);
  const filtered = filterDashboard(dashboard, {
    config: baseConfig,
    advertised: ["prometheus"],
    variables,
    probes: [{ baseUrl: "http://localhost:9091", ok: true }],
  });
  assert.equal(filtered.hidden.get("empty").reason, "no_queries");
  assert.equal(filtered.hidden.get("broken").reason, "invalid_panel");
});

test("C-004 missing datasource is reported when no override exists", async () => {
  const doc = structuredClone(fixture);
  doc.spec.datasources = {};
  const { dashboard } = await model(doc);
  const config = parseConfig(`?dashboard_url=${encodeURIComponent(url)}`).config;
  const variables = await resolveVariables(dashboard, {
    config,
    advertisedCapabilities: ["prometheus"],
    labelValues: async () => [],
    warn: () => {},
  });
  const result = evaluatePanel(dashboard.panels.get("ram"), dashboard, {
    config,
    advertised: ["prometheus"],
    variables,
    probes: [],
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "missing_datasource");
});

test("C-004 explicit prometheus_url overrides a missing datasource", async () => {
  const doc = structuredClone(fixture);
  doc.spec.datasources = {};
  const { dashboard, variables } = await model(doc);
  const result = evaluatePanel(dashboard.panels.get("ram"), dashboard, {
    config: baseConfig,
    advertised: ["prometheus"],
    variables,
    probes: [{ baseUrl: "http://localhost:9091", ok: true }],
  });
  assert.equal(result.eligible, true);
});
