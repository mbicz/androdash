import test from "node:test";
import assert from "node:assert/strict";
import { bestCellGrid, panelDemand, planCandidates, planFit } from "../../app/src/fit.js";
import { headerCompact } from "../../app/src/layout.js";

const mac = [
  { id: "util", kind: "GaugeChart", count: 4 },
  { id: "mem", kind: "StatChart", count: 4 },
  { id: "cpu", kind: "TimeSeriesChart", count: 2 },
  { id: "load", kind: "TimeSeriesChart", count: 3 },
  { id: "net", kind: "TimeSeriesChart", count: 2 },
  { id: "disk", kind: "TimeSeriesChart", count: 2 },
  { id: "free", kind: "StatChart", count: 3 },
  { id: "uptime", kind: "StatChart", count: 1 },
  { id: "collectors", kind: "Table", count: 13 },
];

const order = (plan) => plan.rows.flatMap((row) => row.cells.map((cell) => cell.id));
const minTotal = (plan) =>
  plan.rows.reduce((sum, row) => sum + row.minHeight, 0) + 8 * (plan.rows.length - 1);

test("C-005 fit keeps every panel, in reading order, within one phone screen", () => {
  const plan = planFit(mac, { width: 361, height: 780 });
  assert.deepEqual(order(plan), mac.map((item) => item.id));
  assert.equal(plan.overflow, false);
  assert.equal(plan.scale, 1);
  assert.ok(minTotal(plan) <= 780);
  for (const row of plan.rows) {
    assert.equal(row.cells.reduce((sum, cell) => sum + cell.span, 0), plan.columns);
  }
});

test("C-005 fit uses one full-width column when the screen allows it", () => {
  const plan = planFit(mac.slice(0, 3), { width: 361, height: 780 });
  assert.equal(plan.columns, 1);
  assert.ok(plan.rows.every((row) => row.cells.length === 1));
});

test("C-005 fit never makes a panel narrower than it can be read", () => {
  const plan = planFit(mac, { width: 361, height: 500 });
  const column = (361 - 8 * (plan.columns - 1)) / plan.columns;
  for (const row of plan.rows) {
    for (const cell of row.cells) {
      const kind = mac.find((item) => item.id === cell.id).kind;
      const width = column * cell.span + 8 * (cell.span - 1);
      assert.ok(width + 0.5 >= panelDemand(kind, 2, width).minW, `${cell.id} ${width}`);
    }
  }
});

test("C-005 fit shrinks type to a floor, then reports overflow instead of hiding panels", () => {
  const tight = planFit(mac, { width: 361, height: 600 });
  assert.ok(tight.scale < 1 && tight.scale >= 0.72);
  assert.equal(tight.overflow, false);
  const impossible = planFit(mac, { width: 361, height: 300 });
  assert.equal(impossible.scale, 0.72);
  assert.equal(impossible.overflow, true);
  assert.equal(order(impossible).length, mac.length);
});

test("C-005 fit charts take the growth; a table never grows past its rows", () => {
  const plan = planFit(mac, { width: 361, height: 780 });
  const chartRow = plan.rows.find((row) => row.cells.some((cell) => cell.id === "cpu"));
  const tableRow = plan.rows.find((row) => row.cells.some((cell) => cell.id === "collectors"));
  assert.equal(chartRow.weight, 3);
  if (tableRow.cells.length === 1) assert.ok(tableRow.maxHeight >= tableRow.minHeight);
});

test("C-005 fit never shrinks a chart below its plot and axis", () => {
  const items = [
    { id: "cpu", kind: "TimeSeriesChart", count: 2 },
    { id: "load", kind: "TimeSeriesChart", count: 3 },
    { id: "mem", kind: "StatChart", count: 4 },
  ];
  const plan = planFit(items, { width: 361, height: 780 });
  const chartRow = plan.rows.find((row) => row.cells.some((cell) => cell.id === "cpu"));
  // Chrome + plot floor + axis padding: legend lines may go, the plot may not.
  assert.equal(chartRow.rigidHeight, 30 + 58);
  assert.ok(chartRow.minHeight >= chartRow.rigidHeight);
  const statRow = plan.rows.find((row) => row.cells.some((cell) => cell.id === "mem"));
  // Numbers cannot shrink at all: the row is rigid at its own minimum.
  assert.equal(statRow.rigidHeight, statRow.minHeight);
});

test("C-005 fit scrolls least when nothing fits at the rigid height", () => {
  const items = [
    { id: "harnesses", kind: "StatChart", count: 2 },
    { id: "sessions", kind: "StatChart", count: 2 },
    { id: "throughput", kind: "TimeSeriesChart", count: 2 },
    { id: "spend", kind: "TimeSeriesChart", count: 2 },
    { id: "tiers", kind: "StatChart", count: 2 },
    { id: "quota", kind: "GaugeChart", count: 4 },
    { id: "models", kind: "Table", count: 8 },
    { id: "pressure", kind: "StatChart", count: 2, thresholds: true },
    { id: "temperature", kind: "StatChart", count: 3, thresholds: true },
    { id: "agent-memory", kind: "StatChart", count: 2 },
    { id: "power", kind: "TimeSeriesChart", count: 2 },
    { id: "services", kind: "Table", count: 3 },
    { id: "vms", kind: "Table", count: 3 },
  ];
  const box = { width: 859, height: 355 };
  const plans = planCandidates(items, box);
  assert.ok(plans.length > 1);
  assert.ok(plans.every((plan) => plan.rigidRoom < 0), "no column count fits");
  const least = Math.min(...plans.map((plan) => plan.rigidTotal));
  const plan = planFit(items, box);
  const chosen = plans.find((candidate) => candidate.columns === plan.columns);
  assert.equal(chosen.rigidTotal, least, "the plan that scrolls least wins");
  assert.equal(plan.overflow, true);
  // Every panel is still placed, in order.
  assert.deepEqual(order(plan), items.map((item) => item.id));
});

test("C-005 cell grids follow the box shape", () => {
  assert.equal(bestCellGrid(4, 300, 300, { aspect: 1 }).columns, 2);
  assert.equal(bestCellGrid(4, 600, 120, { aspect: 1 }).columns, 4);
  assert.equal(bestCellGrid(4, 120, 600, { aspect: 1 }).columns, 1);
});

test("C-005 fit gives text panels a bounded share; they scroll inside", () => {
  const plan = planFit([...mac, { id: "about", kind: "Markdown", count: 1 }], { width: 361, height: 780 });
  const row = plan.rows.find((r) => r.cells.some((cell) => cell.id === "about"));
  assert.ok(row, "Markdown is placed in the fit layout");
  if (row.cells.length === 1) assert.ok(row.maxHeight !== null && row.maxHeight <= 36 + 132);
});

test("C-005 landscape fit collapses the header to a compact line instead of taking height", () => {
  // Portrait and square keep the normal header.
  assert.equal(headerCompact(361, 780), false);
  assert.equal(headerCompact(500, 500), false);
  // A phone on its side and any wider screen collapse the bar.
  assert.equal(headerCompact(780, 361), true);
  assert.equal(headerCompact(1000, 500), true);
  assert.equal(headerCompact(891, 411), true);
});
