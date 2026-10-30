import { calculations, formatValue, sortedThresholds, splitUnit, thresholdState } from "./format.js";
import { seriesDisplayName } from "../prometheus.js";
import { bestCellGrid } from "../fit.js";

const TILE_GAP = 6;
const TILE_ASPECT = 2.2;
/** Smallest stat number in the fit layout before the panel scrolls instead. */
const MIN_VALUE_PX = 18;

/**
 * Fit layout: the tiles fill the panel box. Columns follow the box shape and
 * the number size follows the cell, bounded by the longest value so every
 * tile in a panel uses one type size.
 */
function fitTiles(grid, count, longest, box, single, reserved = 0, zoom = false) {
  const layout = single
    ? { columns: 1, rows: 1 }
    : bestCellGrid(count, box.width, box.height, { aspect: TILE_ASPECT, gap: TILE_GAP });
  const cellW = (box.width - TILE_GAP * (layout.columns - 1)) / layout.columns;
  const cellH = (box.height - TILE_GAP * (layout.rows - 1)) / layout.rows;
  // Label row, plus the state word and meter when the panel shows them.
  const label = (single ? 0 : zoom ? Math.max(15, cellH * 0.18) : 15) + reserved;
  const byHeight = (cellH - label) * 0.78;
  const byWidth = (cellW - 14) / Math.max(3, longest * 0.58);
  // A zoomed panel lets numbers grow to fill it (C-005 "Panel zoom").
  const cap = zoom ? 160 : single ? 56 : 44;
  const fitted = Math.min(cap, byHeight, byWidth);
  grid.style.setProperty("--label-size", `${Math.max(11, Math.min(26, fitted * 0.32)).toFixed(1)}px`);
  grid.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
  if (fitted >= MIN_VALUE_PX || single) {
    grid.style.gridTemplateRows = `repeat(${layout.rows}, minmax(0, 1fr))`;
    grid.style.setProperty("--value-size", `${Math.max(MIN_VALUE_PX, fitted).toFixed(1)}px`);
    return;
  }
  // Too many tiles for the box: keep a legible size and let the panel scroll
  // (C-005 "Panel scrolling") rather than shrink numbers below the floor.
  const size = MIN_VALUE_PX;
  const tileHeight = Math.ceil(size / 0.78 + label + 4);
  grid.style.gridTemplateRows = `repeat(${layout.rows}, ${tileHeight}px)`;
  grid.style.setProperty("--value-size", `${size.toFixed(1)}px`);
}

/**
 * Stat tiles: label, number, quieter unit. State is carried by a coloured edge
 * on the tile (green / amber / red); a word appears only when something needs
 * attention (the threshold's name, e.g. "High"). A panel without thresholds
 * makes no judgement, so its tiles have a neutral edge and no meter.
 */
export function renderStat(panel, series, { warn = null, size = null, fit = false, zoom = false } = {}) {
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
  let longest = 0;
  let attention = false;

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
    longest = Math.max(longest, number.length + unit.length * 0.55);
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
      attention = true;
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

  if (fit) {
    const count = Math.min(tiles.length, maxTiles);
    const reserved = (attention ? 15 : 0) + (steps.length > 0 ? 7 : 0);
    if (size?.width > 0 && size?.height > 0) fitTiles(grid, count, longest, size, single, reserved, zoom);
    if (typeof ResizeObserver === "function") {
      let last = size ? `${size.width}x${size.height}` : "";
      const observer = new ResizeObserver(() => {
        if (!wrapper.isConnected) {
          observer.disconnect();
          return;
        }
        const rect = wrapper.getBoundingClientRect();
        const key = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
        if (key === last || !(rect.width > 0) || !(rect.height > 0)) return;
        last = key;
        fitTiles(grid, count, longest, { width: rect.width, height: rect.height }, single, reserved, zoom);
      });
      observer.observe(wrapper);
    }
  }
  return wrapper;
}
