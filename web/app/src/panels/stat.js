import { calculations, formatValue, sortedThresholds, splitUnit, thresholdState } from "./format.js";
import { seriesDisplayName } from "../prometheus.js";

/**
 * Stat tiles: label, number, quieter unit. State is carried by a coloured edge
 * on the tile (green / amber / red); a word appears only when something needs
 * attention (the threshold's name, e.g. "High"). A panel without thresholds
 * makes no judgement, so its tiles have a neutral edge and no meter.
 */
export function renderStat(panel, series, { warn = null } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "stat-wrap";
  const calculation = panel.panelSpec?.calculation || "last-number";
  const format = panel.panelSpec?.format || {};
  const steps = sortedThresholds(panel.panelSpec?.thresholds?.steps);
  const tiles = [];

  for (const item of series) {
    const value = calculations(item, calculation, { warn });
    if (value === null) continue;
    tiles.push({ item, value });
  }

  if (tiles.length === 0) {
    wrapper.dataset.empty = "true";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No data";
    wrapper.append(empty);
    return wrapper;
  }

  const maxTiles = 12;
  if (tiles.length > maxTiles) {
    warn?.("W_VALUES_TRUNCATED", `Stat panel kept ${maxTiles} tiles`, panel.id, null);
  }
  wrapper.dataset.empty = "false";
  const single = tiles.length === 1;
  const grid = document.createElement("div");
  grid.className = `stat-grid${single ? " single" : ""}`;

  for (const { item, value } of tiles.slice(0, maxTiles)) {
    const state = steps.length > 0 ? thresholdState(value, steps) : { state: "none", label: "" };
    const label = seriesDisplayName(item.labels);
    const tile = document.createElement("div");
    tile.className = `stat-tile state-${state.state}${single ? " single" : ""}`;
    tile.setAttribute("data-series-label", label);
    const formatted = formatValue(value, format, { warn });
    tile.setAttribute(
      "aria-label",
      [single ? null : label, formatted, state.state === "warn" || state.state === "crit" ? state.label : null]
        .filter(Boolean)
        .join(", "),
    );

    if (!single) {
      const labelEl = document.createElement("div");
      labelEl.className = "metric-label";
      labelEl.textContent = label;
      tile.append(labelEl);
    }

    const { number, unit } = splitUnit(formatted);
    const valueEl = document.createElement("div");
    valueEl.className = "metric-value";
    valueEl.textContent = number;
    if (unit) {
      const unitEl = document.createElement("span");
      unitEl.className = "metric-unit";
      unitEl.textContent = unit;
      valueEl.append(unitEl);
    }
    tile.append(valueEl);

    if (state.state === "warn" || state.state === "crit") {
      const stateEl = document.createElement("div");
      stateEl.className = "metric-state";
      stateEl.textContent = state.label;
      tile.append(stateEl);
    }

    // The meter is a position on the threshold scale (value / highest step).
    // Without thresholds there is no scale, so there is no meter.
    if (steps.length > 0) {
      const meter = document.createElement("div");
      meter.className = "stat-meter";
      const bar = document.createElement("span");
      const thresholdMax = Math.max(1, ...steps.map((step) => Number(step.value) || 0));
      bar.style.width = `${Math.max(2, Math.min(100, (Number(value) / thresholdMax) * 100))}%`;
      meter.append(bar);
      tile.append(meter);
    }

    grid.append(tile);
  }

  wrapper.append(grid);
  return wrapper;
}
