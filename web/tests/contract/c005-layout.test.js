import test from "node:test";
import assert from "node:assert/strict";
import { installMiniDom } from "../helpers/mini-dom.js";
import { bandItems, renderRows } from "../../app/src/layout.js";
import { niceTicks, timeTicks } from "../../app/src/panels/scale.js";

installMiniDom();

const item = (id, x, y, width, height) => ({
  x,
  y,
  width,
  height,
  panel: { id, panelKind: "TimeSeriesChart" },
});

function rows(items, collapsed = false) {
  const fragment = renderRows([{ title: "Now", collapsed, items }], {
    createPanel: (entry) => {
      const panel = document.createElement("section");
      panel.className = "panel";
      panel.dataset.panelId = entry.panel.id;
      return panel;
    },
  });
  return fragment.children[0];
}

test("C-005 side-by-side items form one horizontal band; full-width items stay vertical", () => {
  const bands = bandItems([
    item("free", 0, 7, 24, 3),
    item("disk", 12, 0, 12, 7),
    item("net", 0, 0, 12, 7),
  ]);
  assert.deepEqual(
    bands.map((band) => band.items.map((entry) => entry.panel.id)),
    [["net", "disk"], ["free"]],
  );
});

test("C-005 a tall item keeps the items stacked beside it in its band, column first", () => {
  const bands = bandItems([
    item("tall", 0, 0, 12, 8),
    item("top", 12, 0, 12, 4),
    item("bottom", 12, 4, 12, 4),
    item("after", 0, 8, 24, 3),
  ]);
  assert.deepEqual(
    bands.map((band) => band.items.map((entry) => entry.panel.id)),
    [["tall", "top", "bottom"], ["after"]],
  );
});

test("C-005 a horizontal band renders as a strip with one page dot per panel", () => {
  const section = rows([item("net", 0, 0, 12, 7), item("disk", 12, 0, 12, 7), item("free", 0, 7, 24, 3)]);
  const strip = section.querySelector(".panel-strip");
  assert.equal(strip.querySelectorAll(".panel").length, 2);
  assert.equal(section.querySelectorAll(".strip-dot").length, 2);
  assert.equal(section.querySelector(".row-body").children.filter((node) => node.classList.contains("panel-slot")).length, 1);
});

test("C-005 tapping a section header folds and unfolds it", () => {
  const section = rows([item("net", 0, 0, 24, 7)]);
  const header = section.querySelector(".row-header");
  const body = section.querySelector(".row-body");
  assert.equal(body.hidden, false);
  header.click();
  assert.equal(section.dataset.rowCollapsed, "true");
  assert.equal(header.getAttribute("aria-expanded"), "false");
  assert.equal(body.hidden, true);
  header.click();
  assert.equal(section.dataset.rowCollapsed, "false");
  assert.equal(body.hidden, false);
});

test("C-005 a section collapsed by the dashboard starts folded", () => {
  const section = rows([item("net", 0, 0, 24, 7)], true);
  assert.equal(section.querySelector(".row-body").hidden, true);
  assert.equal(section.querySelector(".row-header").getAttribute("aria-expanded"), "false");
});

test("C-005 value axes land on round numbers and binary units step in powers of 1024", () => {
  assert.deepEqual(niceTicks(2.13, 4.71, 4).ticks, [2, 3, 4, 5]);
  assert.deepEqual(niceTicks(0, 0, 4).ticks, [0, 0.25, 0.5, 0.75, 1]);
  const bytes = niceTicks(0, 9.2 * 1024 ** 2, 4, "bytes").ticks;
  assert.deepEqual(bytes, [0, 2.5, 5, 7.5, 10].map((value) => value * 1024 ** 2));
});

test("C-005 time axes tick on wall-clock boundaries inside the window", () => {
  const start = Date.UTC(2026, 9, 27, 20, 33, 17) / 1000;
  const { step, ticks } = timeTicks(start, start + 900, 4, 0);
  assert.equal(step, 300);
  assert.deepEqual(
    ticks.map((t) => new Date(t * 1000).toISOString().slice(11, 16)),
    ["20:35", "20:40", "20:45"],
  );
  const day = timeTicks(start, start + 86_400, 4, 0);
  assert.equal(day.step, 21_600);
  assert.ok(day.ticks.every((t) => t % 21_600 === 0));
});
