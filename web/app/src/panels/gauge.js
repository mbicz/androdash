import { calculations, formatValue, sortedThresholds, thresholdState } from "./format.js";
import { seriesDisplayName } from "../prometheus.js";
import { arcPath, svgEl, svgText } from "./svg.js";

const START = -120;
const SWEEP = 240;

function clampedRatio(value, max) {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

function zonesFor(steps, max) {
  if (steps.length === 0) return [{ from: 0, to: max, state: "ok" }];
  if (steps.length === 1) {
    return [
      { from: 0, to: steps[0].value, state: "ok" },
      { from: steps[0].value, to: max, state: "crit" },
    ];
  }
  return [
    { from: 0, to: steps[0].value, state: "ok" },
    { from: steps[0].value, to: steps[1].value, state: "warn" },
    { from: steps[1].value, to: max, state: "crit" },
  ];
}

/**
 * Draw a 240° arc into an exact CSS-pixel box. The viewBox equals the rendered
 * size, so nothing is scaled: strokes stay 1:1 with the phone's CSS pixels.
 *
 * `text: false` omits the inner value/state labels; the caller then shows them
 * as HTML beside the arc, which is how a single-gauge panel uses the full width
 * of a phone card instead of centering a small dial.
 */
function gaugeSvg({ width, height, value, state, format, steps, max, warn, text = true }) {
  const w = Math.max(40, Math.round(width));
  const h = Math.max(40, Math.round(height));
  const cx = w / 2;
  const radius = Math.max(12, Math.min(w / 2 - 6, h / 2 - 4));
  const cy = h / 2 + radius * 0.06;
  const stroke = Math.max(5, radius * 0.2);

  const svg = svgEl("svg", {
    class: "gauge-svg",
    viewBox: `0 0 ${w} ${h}`,
    role: "img",
    "aria-label": `${formatValue(value, format, { warn })} (${state.label})`,
  });

  svg.append(
    svgEl("path", {
      d: arcPath(cx, cy, radius, START, START + SWEEP),
      fill: "none",
      stroke: "var(--gauge-track)",
      "stroke-width": stroke,
      "stroke-linecap": "round",
    }),
  );

  for (const zone of zonesFor(steps, max)) {
    const from = clampedRatio(zone.from, max);
    const to = clampedRatio(zone.to, max);
    if (to <= from) continue;
    svg.append(
      svgEl("path", {
        d: arcPath(cx, cy, radius, START + SWEEP * from, START + SWEEP * to),
        fill: "none",
        stroke: `var(--state-${zone.state})`,
        "stroke-width": Math.max(4, radius * 0.14),
        "stroke-opacity": 0.34,
        "stroke-linecap": "butt",
      }),
    );
  }

  const ratio = clampedRatio(value, max);
  if (ratio > 0) {
    svg.append(
      svgEl("path", {
        d: arcPath(cx, cy, radius, START, START + SWEEP * ratio),
        fill: "none",
        stroke: `var(--state-${state.state === "muted" ? "muted" : state.state})`,
        "stroke-width": Math.max(5, radius * 0.17),
        "stroke-linecap": "round",
        class: "gauge-value-arc",
      }),
    );
  }

  for (const step of steps) {
    const angle = ((START + SWEEP * clampedRatio(step.value, max)) * Math.PI) / 180;
    const inner = radius * 0.88;
    const outer = radius * 1.12;
    svg.append(
      svgEl("line", {
        x1: cx + Math.cos(angle) * inner,
        y1: cy + Math.sin(angle) * inner,
        x2: cx + Math.cos(angle) * outer,
        y2: cy + Math.sin(angle) * outer,
        stroke: "var(--panel)",
        "stroke-width": 2,
      }),
    );
  }

  if (text) {
    const valueSize = Math.max(14, Math.min(30, radius * 0.66));
    svg.append(
      svgText(formatValue(value, format, { warn }), {
        x: cx,
        y: cy + valueSize * 0.14,
        "text-anchor": "middle",
        class: "gauge-value",
        "font-size": valueSize,
      }),
    );
    svg.append(
      svgText(state.label, {
        x: cx,
        y: cy + valueSize * 0.14 + Math.max(10, radius * 0.34),
        "text-anchor": "middle",
        class: `gauge-state state-${state.state}`,
      }),
    );
  }
  return svg;
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
  const kept = gauges.slice(0, maxGauges);
  const single = kept.length === 1;
  const grid = document.createElement("div");
  grid.className = `gauge-grid${single ? " single" : ""}`;

  const box = { width: size?.width ?? 338, height: size?.height ?? 104 };

  function maxFor(value) {
    return format.unit === "percent"
      ? 100
      : Math.max(1, ...steps.map((step) => step.value), Number(value) || 0) * 1.12;
  }

  for (const { item, value } of kept) {
    const state = thresholdState(value, steps);
    const max = maxFor(value);
    const card = document.createElement("div");
    card.className = `gauge-card state-${state.state}${single ? " inline" : ""}`;

    if (single) {
      // Dial on the left, large readout on the right: no half-empty card.
      const dial = Math.round(Math.min(box.height, box.width * 0.44));
      card.append(
        gaugeSvg({
          width: dial,
          height: Math.min(box.height, dial),
          value,
          state,
          format,
          steps,
          max,
          warn,
          text: false,
        }),
      );
      const readout = document.createElement("div");
      readout.className = "gauge-readout";
      const valueEl = document.createElement("span");
      valueEl.className = "gauge-value-text";
      valueEl.textContent = formatValue(value, format, { warn });
      const stateEl = document.createElement("span");
      stateEl.className = `gauge-state-text state-${state.state}`;
      const dot = document.createElement("span");
      dot.className = "state-dot";
      const stateText = document.createElement("span");
      stateText.textContent = state.label;
      stateEl.append(dot, stateText);
      readout.append(valueEl, stateEl);
      card.append(readout);
    } else {
      card.append(
        gaugeSvg({
          width: Math.round(box.width / 2 - 12),
          height: Math.max(56, Math.round(box.height / 2 - 12)),
          value,
          state,
          format,
          steps,
          max,
          warn,
          text: true,
        }),
      );
      const label = document.createElement("div");
      label.className = "gauge-label";
      label.textContent = seriesDisplayName(item.labels);
      card.append(label);
    }
    grid.append(card);
  }

  wrapper.append(grid);

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (!wrapper.isConnected) {
        observer.disconnect();
        return;
      }
      const rect = wrapper.getBoundingClientRect?.();
      if (!rect || !(rect.width > 0)) return;
      const next = { width: Math.round(rect.width), height: Math.round(rect.height) };
      if (Math.abs(next.width - box.width) < 1) return;
      box.width = next.width;
      box.height = Math.max(56, next.height);
      for (const card of grid.children) {
        const dial = card.children[0];
        if (!dial) continue;
        const index = [...grid.children].indexOf(card);
        const { value } = kept[index];
        const state = thresholdState(value, steps);
        const max = maxFor(value);
        dial.replaceWith(
          gaugeSvg({
            width: single
              ? Math.round(Math.min(box.height, box.width * 0.44))
              : Math.round(box.width / 2 - 12),
            height: single
              ? Math.min(box.height, Math.round(Math.min(box.height, box.width * 0.44)))
              : Math.max(56, Math.round(box.height / 2 - 12)),
            value,
            state,
            format,
            steps,
            max,
            warn,
            text: !single,
          }),
        );
      }
    });
    observer.observe(wrapper);
  }

  return wrapper;
}
