/**
 * Fit-to-screen layout (C-005 "Fit layout"). The screen dictates the layout:
 * every panel is placed on one screen, in dashboard reading order, at a size
 * that keeps its content legible. Pure functions; no DOM.
 *
 * Model: each panel has a minimum legible height for a given width (derived
 * from what it shows — tiles, rings, a plot and legend, table rows) and a
 * weight for how much it benefits from extra height. Panels are cut into rows
 * of up to C columns, keeping order (like breaking a paragraph into lines);
 * dynamic programming finds the row breaks and column splits with the
 * smallest total minimum height. The fewest columns that fit with room to
 * breathe wins, because wider panels read better. Left-over height goes to the
 * rows that benefit (charts first), so nothing is padded with empty space.
 */

export const FIT = Object.freeze({
  gap: 8,
  chrome: 36,
  minColumnWidth: 150,
  maxColumns: 6,
  minScale: 0.72,
  comfort: 1.12,
});

const TILE = { width: 76, height: 44, single: 34, gap: 6 };
const RING = { width: 70, height: 74, single: 64, gap: 6 };
const CHART = { minWidth: 150, plot: 56, axis: 14, legendEntry: 140, legendLine: 15 };
const TABLE = { minWidth: 140, row: 18, minRows: 3, more: 14 };

/** Columns × rows for `count` cells of at least `cellWidth` in `width`. */
export function cellGrid(count, width, cellWidth, gap) {
  const n = Math.max(1, count);
  const columns = Math.max(1, Math.min(n, Math.floor((width + gap) / (cellWidth + gap))));
  return { columns, rows: Math.ceil(n / columns) };
}

/**
 * Best columns for `count` cells in a `width` × `height` box: the split whose
 * cells come closest to `aspect` (width / height) while staying as large as
 * possible. Used by gauges and stat tiles so a panel's interior also follows
 * the shape it was given.
 */
export function bestCellGrid(count, width, height, { aspect = 1, gap = 8 } = {}) {
  const n = Math.max(1, count);
  let best = { columns: 1, rows: n, size: 0 };
  for (let columns = 1; columns <= n; columns += 1) {
    const rows = Math.ceil(n / columns);
    const cellW = (width - gap * (columns - 1)) / columns;
    const cellH = (height - gap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const size = Math.min(cellW / aspect, cellH);
    if (size > best.size + 0.5) best = { columns, rows, size };
  }
  return best;
}

/**
 * Minimum legible height (px) of a panel `width` px wide, its minimum width,
 * and its growth weight. `count` is the number of series (tiles, rings, lines,
 * or rows) the panel shows.
 */
export function panelDemand(kind, count, width, { thresholds = false } = {}) {
  const inner = Math.max(0, width - 20);
  const n = Math.max(1, count);
  if (kind === "StatChart") {
    // Thresholds add a meter and, when crossed, a state word under the value.
    const extra = thresholds ? 20 : 0;
    if (n === 1) return { minW: TILE.width + 20, minH: FIT.chrome + TILE.single + extra, weight: 1 };
    const grid = cellGrid(n, inner, TILE.width, TILE.gap);
    const body = grid.rows * (TILE.height + extra) + (grid.rows - 1) * TILE.gap;
    return { minW: TILE.width + 20, minH: FIT.chrome + body, weight: 1 };
  }
  if (kind === "GaugeChart") {
    if (n === 1) return { minW: RING.width + 20, minH: FIT.chrome + RING.single, weight: 2 };
    const grid = cellGrid(Math.min(n, 4), inner, RING.width, RING.gap);
    const body = grid.rows * RING.height + (grid.rows - 1) * RING.gap;
    return { minW: RING.width + 20, minH: FIT.chrome + body, weight: 2 };
  }
  if (kind === "TimeSeriesChart") {
    // Fit legends are a grid of one-line entries (label ellipsised, value kept).
    const perLine = Math.max(1, Math.floor(inner / CHART.legendEntry));
    const legendLines = Math.ceil(Math.min(n, 8) / perLine);
    const legend = legendLines * CHART.legendLine + 4;
    return {
      minW: CHART.minWidth,
      minH: FIT.chrome + CHART.plot + CHART.axis + legend,
      weight: 3,
    };
  }
  if (kind === "Table") {
    const shown = Math.min(n, TABLE.minRows);
    const more = n > shown ? TABLE.more : 0;
    return {
      minW: TABLE.minWidth,
      minH: FIT.chrome + shown * TABLE.row + more,
      weight: 1,
      maxH: FIT.chrome + n * TABLE.row,
    };
  }
  if (kind === "Markdown") {
    // Text scrolls inside its panel; it never claims more than a few lines.
    return { minW: 140, minH: FIT.chrome + 48, weight: 1, maxH: FIT.chrome + 132 };
  }
  return { minW: 120, minH: FIT.chrome + 40, weight: 1 };
}

/** All ways to split `total` columns into `parts` positive spans. */
function compositions(total, parts) {
  if (parts === 1) return [[total]];
  const out = [];
  for (let first = 1; first <= total - parts + 1; first += 1) {
    for (const rest of compositions(total - first, parts - 1)) out.push([first, ...rest]);
  }
  return out;
}

function spanWidth(span, columns, width, gap) {
  const column = (width - gap * (columns - 1)) / columns;
  return column * span + gap * (span - 1);
}

/** Best row breaks for a fixed column count, minimising total minimum height. */
function planColumns(items, columns, width, gap) {
  const n = items.length;
  const best = new Array(n + 1).fill(null);
  best[0] = { height: 0, rows: [] };
  for (let end = 1; end <= n; end += 1) {
    for (let start = Math.max(0, end - columns); start < end; start += 1) {
      if (!best[start]) continue;
      const group = items.slice(start, end);
      for (const spans of compositions(columns, group.length)) {
        let rowMin = 0;
        let rowMax = 0;
        let weight = 0;
        let capped = true;
        let ok = true;
        const cells = group.map((item, index) => {
          const w = spanWidth(spans[index], columns, width, gap);
          const demand = panelDemand(item.kind, item.count, w, item);
          if (w + 0.5 < demand.minW) ok = false;
          rowMin = Math.max(rowMin, demand.minH);
          weight = Math.max(weight, demand.weight);
          if (demand.maxH === undefined) capped = false;
          else rowMax = Math.max(rowMax, demand.maxH);
          return { id: item.id, span: spans[index] };
        });
        if (!ok) continue;
        const height = best[start].height + rowMin + (best[start].rows.length > 0 ? gap : 0);
        const candidate = best[end];
        // Equal height: prefer fewer, wider panels per row.
        const fewer = candidate && height === candidate.height && best[start].rows.length + 1 < candidate.rows.length;
        if (!candidate || height < candidate.height - 0.01 || fewer) {
          best[end] = {
            height,
            rows: [
              ...best[start].rows,
              { cells, minHeight: rowMin, weight, maxHeight: capped ? Math.max(rowMin, rowMax) : null },
            ],
          };
        }
      }
    }
  }
  return best[n];
}

/**
 * Plan a fit layout for `items` ({ id, kind, count }) in a `width` × `height`
 * box. Returns { columns, rows, scale, overflow }. `scale` < 1 means type and
 * minimums shrink to fit; `overflow` means even at FIT.minScale the content is
 * taller than the screen and the container must scroll.
 */
export function planFit(items, { width, height, gap = FIT.gap }) {
  if (items.length === 0) return { columns: 1, rows: [], scale: 1, overflow: false };
  const limit = Math.max(1, Math.min(FIT.maxColumns, Math.floor((width + gap) / (FIT.minColumnWidth + gap))));
  const plans = [];
  for (let columns = 1; columns <= limit; columns += 1) {
    const plan = planColumns(items, columns, width, gap);
    if (plan) plans.push({ columns, ...plan, room: height / plan.height });
  }
  if (plans.length === 0) {
    const plan = planColumns(items, 1, width, gap);
    plans.push({ columns: 1, ...plan, room: height / plan.height });
  }
  const chosen =
    plans.find((plan) => plan.room >= FIT.comfort) ||
    plans.reduce((a, b) => (b.room > a.room ? b : a));
  const scale = Math.min(1, chosen.room);
  return {
    columns: chosen.columns,
    rows: chosen.rows,
    scale: Math.max(FIT.minScale, scale),
    overflow: scale < FIT.minScale,
  };
}
