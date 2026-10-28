import { calculations, formatValue, sortedThresholds, splitUnit, thresholdState } from "./format.js";
import { seriesDisplayName } from "../prometheus.js";
import { arcPath, polar, svgEl } from "./svg.js";
import { bestCellGrid } from "../fit.js";

/** Screen angles (0° = right, clockwise): a 240° arc open at the bottom. */
const START = 150;
const SWEEP = 240;
const LABEL_HEIGHT = 18;
const GAP = 12;

function clampedRatio(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

const attention = (state) => state.state === "warn" || state.state === "crit";

/** Radius and stroke for an arc that must fit a width × height box. */
function ringGeometry(width, height) {
  const byWidth = width / 2;
  const byHeight = height / 1.5;
  const outer = Math.max(14, Math.min(byWidth, byHeight));
  const stroke = Math.min(10, Math.max(4, outer * 0.13));
  const radius = outer - stroke / 2 - 1;
  return { radius, stroke, width: Math.round(outer * 2), height: Math.round(outer * 1.5 + stroke / 2 + 2) };
}

/**
 * One open ring drawn at exact CSS pixels. The track is a quiet hairline-dark
 * arc; the value arc carries the state colour (C-005). Thresholds are notches
 * cut into the track, not coloured zones. `text` puts the value in the ring.
 */
function ring({ width, height, value, state, format, steps, max, warn, text }) {
  const geometry = ringGeometry(width, height);
  const { radius, stroke } = geometry;
  const w = geometry.width;
  const h = geometry.height;
  const cx = w / 2;
  const cy = stroke / 2 + 1 + radius;
  const formatted = formatValue(value, format, { warn });

  const svg = svgEl("svg", {
    class: "gauge-svg",
    viewBox: `0 0 ${w} ${h}`,
    width: w,
    height: h,
    role: "img",
    "aria-label": attention(state) ? `${formatted}, ${state.label}` : formatted,
  });
  svg.append(
    svgEl("path", {
      d: arcPath(cx, cy, radius, START, START + SWEEP),
      fill: "none",
      "stroke-width": stroke,
      "stroke-linecap": "round",
      class: "gauge-track",
    }),
  );
  const ratio = clampedRatio(value, max);
  if (ratio > 0) {
    svg.append(
      svgEl("path", {
        d: arcPath(cx, cy, radius, START, START + SWEEP * Math.max(ratio, 0.004)),
        fill: "none",
        "stroke-width": stroke,
        "stroke-linecap": "round",
        class: `gauge-value-arc state-${state.state}`,
      }),
    );
  }
  for (const step of steps) {
    const angle = START + SWEEP * clampedRatio(step.value, max);
    const inner = polar(cx, cy, radius - stroke / 2 - 0.5, angle);
    const outer = polar(cx, cy, radius + stroke / 2 + 0.5, angle);
    svg.append(
      svgEl("line", { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, class: "gauge-notch" }),
    );
  }
  if (text) {
    const { number, unit } = splitUnit(formatted);
    const size = Math.max(13, Math.min(40, radius * 0.56));
    const label = svgEl("text", {
      x: cx,
      y: cy + size * 0.36,
      "text-anchor": "middle",
      class: "gauge-value",
      "font-size": size.toFixed(1),
    });
    const numberSpan = svgEl("tspan", {});
    numberSpan.textContent = number;
    label.append(numberSpan);
    if (unit) {
      const unitSpan = svgEl("tspan", { class: "gauge-unit", "font-size": (size * 0.55).toFixed(1), dx: "1" });
      unitSpan.textContent = unit;
      label.append(unitSpan);
    }
    svg.append(label);
  }
  return svg;
}

function readout(value, state, format, warn) {
  const element = document.createElement("div");
  element.className = `gauge-readout state-${state.state}`;
  const { number, unit } = splitUnit(formatValue(value, format, { warn }));
  const valueEl = document.createElement("span");
  valueEl.className = "metric-value";
  valueEl.textContent = number;
  if (unit) {
    const unitEl = document.createElement("span");
    unitEl.className = "metric-unit";
    unitEl.textContent = unit;
    valueEl.append(unitEl);
  }
  element.append(valueEl);
  if (attention(state)) {
    const stateEl = document.createElement("span");
    stateEl.className = "metric-state";
    stateEl.textContent = state.label;
    element.append(stateEl);
  }
  return element;
}

export function renderGauge(panel, series, { warn = null, size = null } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "gauge-wrap";
  const calculation = panel.panelSpec?.calculation || "last-number";
  const format = panel.panelSpec?.format || {};
  const steps = sortedThresholds(panel.panelSpec?.thresholds?.steps);
  const gauges = [];

  for (const item of series) {
    const value = calculations(item, calculation, { warn });
    if (value === null) continue;
    gauges.push({ item, value });
  }

  if (gauges.length === 0) {
    wrapper.dataset.empty = "true";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No data";
    wrapper.append(empty);
    return wrapper;
  }

  const maxGauges = 4;
  if (gauges.length > maxGauges) {
    warn?.("W_GAUGES_TRUNCATED", `Gauge panel kept ${maxGauges} gauges`, panel.id, null);
  }
  wrapper.dataset.empty = "false";
  const kept = gauges.slice(0, maxGauges).map((gauge) => ({
    ...gauge,
    state: steps.length > 0 ? thresholdState(gauge.value, steps) : { state: "none", label: "" },
    max:
      format.unit === "percent"
        ? 100
        : Math.max(1, ...steps.map((step) => step.value), Number(gauge.value) || 0) * 1.12,
  }));
  const single = kept.length === 1;
  const grid = document.createElement("div");
  grid.className = `gauge-grid${single ? " single" : ""}`;
  const box = { width: size?.width ?? 338, height: size?.height ?? 120 };

  /**
   * Arrange the rings for the box they were given: a single gauge sits beside
   * its readout when the box is wide and alone with the value inside when it
   * is not; several gauges take the column count that makes rings largest.
   */
  function arrangement() {
    if (single) {
      const inline = box.width >= box.height * 1.5;
      const side = inline ? Math.min(box.height, box.width * 0.42) : Math.min(box.width, box.height);
      return { inline, columns: 1, cell: { width: side, height: side } };
    }
    const layout = bestCellGrid(kept.length, box.width, box.height, { aspect: 1.05, gap: GAP });
    return {
      inline: false,
      columns: layout.columns,
      cell: {
        width: (box.width - GAP * (layout.columns - 1)) / layout.columns,
        height: (box.height - GAP * (layout.rows - 1)) / layout.rows - LABEL_HEIGHT,
      },
    };
  }

  let shape = arrangement();

  function dial(gauge) {
    return ring({
      width: shape.cell.width,
      height: shape.cell.height,
      value: gauge.value,
      state: gauge.state,
      format,
      steps,
      max: gauge.max,
      warn,
      text: !shape.inline,
    });
  }

  function applyShape() {
    grid.style.gridTemplateColumns = `repeat(${shape.columns}, minmax(0, 1fr))`;
    grid.classList.toggle("inline", shape.inline);
  }
  applyShape();

  for (const gauge of kept) {
    const cell = document.createElement("div");
    cell.className = `gauge-cell state-${gauge.state.state}`;
    cell.append(dial(gauge));
    if (single) {
      const read = readout(gauge.value, gauge.state, format, warn);
      read.hidden = !shape.inline;
      cell.append(read);
    } else {
      const label = document.createElement("div");
      label.className = "gauge-label";
      label.textContent = seriesDisplayName(gauge.item.labels);
      if (attention(gauge.state)) {
        const stateEl = document.createElement("span");
        stateEl.className = "metric-state";
        stateEl.textContent = gauge.state.label;
        label.append(stateEl);
      }
      cell.append(label);
    }
    grid.append(cell);
  }
  wrapper.append(grid);

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (!wrapper.isConnected) {
        observer.disconnect();
        return;
      }
      const rect = wrapper.getBoundingClientRect?.();
      if (!rect || !(rect.width > 0) || !(rect.height > 0)) return;
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      if (Math.abs(next.width - box.width) < 1 && Math.abs(next.height - box.height) < 1) return;
      box.width = next.width;
      box.height = next.height;
      shape = arrangement();
      applyShape();
      [...grid.children].forEach((cell, index) => {
        cell.firstChild.replaceWith(dial(kept[index]));
        if (single) cell.lastChild.hidden = !shape.inline;
      });
    });
    observer.observe(wrapper);
  }

  return wrapper;
}
