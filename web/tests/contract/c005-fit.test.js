import test from "node:test";
import assert from "node:assert/strict";
import { bestCellGrid, panelDemand, planFit } from "../../app/src/fit.js";

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
  // Chrome + plot floor + axis: legend lines may go, the plot may not.
  assert.equal(chartRow.rigidHeight, 30 + 44 + 14);
  assert.ok(chartRow.minHeight >= chartRow.rigidHeight);
  const statRow = plan.rows.find((row) => row.cells.some((cell) => cell.id === "mem"));
  // Numbers cannot shrink at all: the row is rigid at its own minimum.
  assert.equal(statRow.rigidHeight, statRow.minHeight);
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
