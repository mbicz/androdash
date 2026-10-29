import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { installMiniDom } from "../helpers/mini-dom.js";
import {
  calculations,
  formatValue,
  thresholdState,
} from "../../app/src/panels/format.js";
import { renderMarkdown } from "../../app/src/panels/markdown.js";
import { renderStat } from "../../app/src/panels/stat.js";
import { renderGauge } from "../../app/src/panels/gauge.js";
import { renderTable } from "../../app/src/panels/table.js";
import { renderTimeSeries } from "../../app/src/panels/time-series.js";
import { normalizeEnvelope } from "../../app/src/prometheus.js";

installMiniDom();

const cpuEnvelope = JSON.parse(
  await fs.readFile(
    new URL("../../../contracts/fixtures/prometheus/query-range-cpu.json", import.meta.url),
  ),
);
const ramEnvelope = JSON.parse(
  await fs.readFile(
    new URL("../../../contracts/fixtures/prometheus/query-ram.json", import.meta.url),
  ),
);
const cpu = normalizeEnvelope(cpuEnvelope).series;
const ram = normalizeEnvelope(ramEnvelope).series;

const panel = (kind, spec = {}, extra = {}) => ({
  id: "p",
  title: "Panel",
  description: "",
  panelKind: kind,
  panelSpec: spec,
  queries: [],
  invalid: false,
  ...extra,
});

test("C-005 formats values and thresholds deterministically", () => {
  assert.equal(formatValue(62.4, { unit: "percent", decimalPlaces: 1 }), "62.4%");
  assert.equal(formatValue(1536, { unit: "bytes" }), "1.5 KiB");
  assert.equal(formatValue(18432, { unit: "short" }), "18.4K");
  assert.equal(formatValue(1.5, { unit: "seconds" }), "1.50 s");
  assert.equal(formatValue(61.5, { unit: "watts" }), "61.5 W");
  assert.equal(formatValue(1500, { unit: "watts" }), "1.5 kW");
  assert.equal(formatValue(52.4, { unit: "celsius", decimalPlaces: 1 }), "52.4 °C");
  assert.equal(formatValue(3_800_000_000, { unit: "hertz" }), "3.8 GHz");
  assert.equal(formatValue(200_000_000_000, { unit: "bits" }), "200 Gb/s");
  assert.equal(formatValue(3200, { unit: "tokens" }), "3.2K tok/s");
  assert.equal(formatValue(4, {}), "4");
  assert.deepEqual(thresholdState(62, [{ value: 80 }, { value: 90 }]), {
    state: "ok",
    label: "Nominal",
  });
  assert.equal(thresholdState(82, [{ value: 80, name: "Disk" }, { value: 90 }]).state, "warn");
  assert.equal(thresholdState(96, [{ value: 80 }, { value: 90 }]).state, "crit");
  assert.equal(thresholdState(96, [{ value: 90 }]).state, "crit");
  assert.equal(calculations({ points: [{ v: 1 }, { v: 3 }] }, "mean"), 2);
  assert.equal(calculations({ points: [{ v: 1 }, { v: 3 }] }, "last-number"), 3);
});

test("C-005 Markdown renders a safe subset and escapes raw HTML", () => {
  const element = renderMarkdown(
    panel("Markdown", {
      text: "## Title\n\n<script>alert(1)</script>\n\n- one\n- two\n\n```text\n<b>code</b>\n```",
    }),
  );
  assert.equal(element.dataset.empty, "false");
  assert.equal(element.querySelector("script"), null);
  assert.equal(element.querySelector("h2").textContent, "Title");
  assert.equal(element.querySelectorAll("li").length, 2);
  assert.equal(element.querySelector("pre code").textContent, "<b>code</b>");
  assert.match(element.textContent, /<script>alert\(1\)<\/script>/);
});

test("C-005 TimeSeriesChart renders SVG paths and a textual legend", () => {
  const element = renderTimeSeries(panel("TimeSeriesChart"), cpu);
  assert.equal(element.dataset.empty, undefined);
  assert.equal(element.querySelectorAll("path.series-line").length, 2);
  assert.equal(element.querySelectorAll(".legend-entry").length, 2);
  assert.match(element.querySelector("svg").getAttribute("aria-label"), /2 series/);
  assert.match(element.textContent, /mode=system/);
});

test("C-005 series in one chart never share a colour or a dash slot", () => {
  const element = renderTimeSeries(panel("TimeSeriesChart"), cpu);
  const lines = element.querySelectorAll("path.series-line");
  assert.equal(lines.length, 2);
  assert.notEqual(lines[0].getAttribute("stroke"), lines[1].getAttribute("stroke"));
  assert.notEqual(lines[0].getAttribute("data-series"), lines[1].getAttribute("data-series"));
});

test("C-005 time axis spans the cycle window and ticks on round minutes", () => {
  const startMs = Date.UTC(2026, 9, 27, 20, 33, 17);
  const endMs = startMs + 15 * 60_000;
  const element = renderTimeSeries(panel("TimeSeriesChart"), cpu, {
    size: { width: 343, height: 120 },
    timeWindow: { startMs, endMs },
  });
  const xLabels = element
    .querySelectorAll(".axis-label")
    .filter((node) => node.getAttribute("y") === String(120 - 4))
    .map((node) => node.textContent);
  assert.ok(xLabels.length >= 2);
  assert.ok(xLabels.every((label) => /:(00|05|10|15|20|25|30|35|40|45|50|55)\b/.test(label)), xLabels.join());
});

test("C-005 positive-only charts do not invent a negative y-axis", () => {
  const element = renderTimeSeries(panel("TimeSeriesChart"), [
    {
      labels: { __name__: "positive_metric" },
      points: [
        { t: 1_793_000_000, v: 5 },
        { t: 1_793_000_060, v: 6 },
      ],
    },
  ]);
  const labels = element.querySelectorAll(".axis-label").map((node) => node.textContent);
  assert.ok(labels.every((text) => !text.startsWith("-")));
});

test("C-005 StatChart names a threshold only when a value crosses it", () => {
  const spec = {
    calculation: "last-number",
    format: { unit: "percent", decimalPlaces: 1 },
    thresholds: { steps: [{ value: 80, name: "Disk" }, { value: 90, name: "Full" }] },
  };
  const ok = renderStat(panel("StatChart", spec), [
    { ...ram[0], labels: { __name__: "demo_memory_used_percent" } },
  ]);
  assert.equal(ok.dataset.empty, "false");
  assert.equal(ok.querySelector(".metric-value").textContent, "62.4%");
  assert.ok(ok.querySelector(".stat-tile").className.includes("state-ok"));
  assert.equal(ok.querySelector(".metric-state"), null);

  const high = renderStat(panel("StatChart", spec), [
    { labels: { __name__: "demo_memory_used_percent" }, points: [{ t: 1, v: 93 }] },
  ]);
  assert.ok(high.querySelector(".stat-tile").className.includes("state-crit"));
  assert.equal(high.querySelector(".metric-state").textContent, "Full");
});

test("C-005 StatChart omits the meter when no threshold scale exists", () => {
  const element = renderStat(
    panel("StatChart", {
      calculation: "last-number",
      format: { unit: "watts", decimalPlaces: 1 },
    }),
    [{ ...ram[0], labels: { __name__: "spark_gpu_power_watts", reading: "draw" } }],
  );
  assert.equal(element.querySelector(".stat-meter"), null);
  assert.ok(element.querySelector(".stat-tile").className.includes("state-none"));
  assert.equal(element.querySelector(".metric-unit").textContent, "W");
});

test("C-005 StatChart scales the meter against the highest threshold", () => {
  const element = renderStat(
    panel("StatChart", {
      calculation: "last-number",
      format: { unit: "celsius", decimalPlaces: 1 },
      thresholds: { steps: [{ value: 80, name: "Warm" }, { value: 90, name: "Critical" }] },
    }),
    [{ ...ram[0], labels: { __name__: "spark_gpu_temperature_celsius", reading: "gpu" } }],
  );
  const bar = element.querySelector(".stat-meter span");
  assert.match(bar.style.width, /^69\.3/);
});

test("C-005 GaugeChart renders an arc and value arc", () => {
  const element = renderGauge(
    panel("GaugeChart", {
      calculation: "last-number",
      format: { unit: "percent", decimalPlaces: 1 },
      thresholds: { steps: [{ value: 80, name: "Disk" }, { value: 90, name: "Full" }] },
    }),
    [{ ...ram[0], labels: { __name__: "demo_memory_used_percent" } }],
  );
  assert.equal(element.dataset.empty, "false");
  assert.equal(element.querySelectorAll(".gauge-value-arc").length, 1);
  assert.equal(element.querySelectorAll(".gauge-notch").length, 2);
  assert.match(element.textContent, /62.4%/);
});

test("C-005 Table renders sorted deterministic rows and keeps raw values without format", () => {
  const tablePanel = panel("Table");
  const element = renderTable(tablePanel, [
    {
      labels: { __name__: "demo_requests_total", code: "500" },
      points: [{ t: 1, v: 17.25 }],
    },
    {
      labels: { __name__: "demo_requests_total", code: "200" },
      points: [{ t: 1, v: 18432 }],
    },
  ]);
  assert.equal(element.dataset.empty, "false");
  const rows = element.querySelectorAll("tbody tr");
  assert.equal(rows.length, 2);
  assert.equal(element.querySelector("th").textContent, "code");
  assert.equal(rows[0].querySelector(".series-cell").textContent, "200");
  assert.match(rows[0].textContent, /18432/);
  assert.match(rows[1].textContent, /17.25/);
});

test("C-005 empty series produce an empty state, not fabricated data", () => {
  const empty = renderStat(panel("StatChart"), []);
  assert.equal(empty.dataset.empty, "true");
  assert.match(empty.textContent, /No data/);
  const emptyGauge = renderGauge(panel("GaugeChart"), []);
  assert.equal(emptyGauge.dataset.empty, "true");
  const emptyTable = renderTable(panel("Table"), []);
  assert.equal(emptyTable.dataset.empty, "true");
});
