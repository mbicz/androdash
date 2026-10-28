import { calculations, formatValue, sortedThresholds, thresholdState } from "./format.js";
import { seriesDisplayName } from "../prometheus.js";

/**
 * Stat tiles are deliberately dense: label, value, state word, and a 3px meter
 * on the tile's bottom edge. A single-series panel drops the label because the
 * panel header already names it.
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
    const state = thresholdState(value, steps);
    const label = seriesDisplayName(item.labels);
    const tile = document.createElement("div");
    tile.className = `stat-tile state-${state.state}${single ? " single" : ""}`;
    tile.setAttribute("data-series-label", label);

    if (!single) {
      const labelEl = document.createElement("div");
      labelEl.className = "stat-label";
      labelEl.textContent = label;
      tile.append(labelEl);
    }

    const valueRow = document.createElement("div");
    valueRow.className = "stat-value-row";
    const valueEl = document.createElement("span");
    valueEl.className = "stat-value";
    valueEl.textContent = formatValue(value, format, { warn });
    valueRow.append(valueEl);

    const stateRow = document.createElement("div");
    stateRow.className = "stat-state";
    const dot = document.createElement("span");
    dot.className = "state-dot";
    const stateText = document.createElement("span");
    stateText.textContent = state.label;
    stateRow.append(dot, stateText);

    // The meter is a position against the panel's threshold scale. With no
    // thresholds there is no scale, and a bar pinned at 100% would read as
    // "maximum" for any value; omit it instead.
    if (steps.length > 0) {
      const meter = document.createElement("div");
      meter.className = "stat-meter";
      const bar = document.createElement("span");
      const thresholdMax = Math.max(1, ...steps.map((step) => Number(step.value) || 0));
      bar.style.width = `${Math.max(2, Math.min(100, (Number(value) / thresholdMax) * 100))}%`;
      meter.append(bar);
      tile.append(meter);
    }

    tile.append(valueRow, stateRow);
    grid.append(tile);
  }

  wrapper.append(grid);
  return wrapper;
}
