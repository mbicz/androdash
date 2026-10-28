import { renderGauge } from "./gauge.js";
import { renderMarkdown } from "./markdown.js";
import { renderStat } from "./stat.js";
import { renderTable } from "./table.js";
import { renderTimeSeries } from "./time-series.js";

export const PANEL_RENDERERS = Object.freeze({
  TimeSeriesChart: renderTimeSeries,
  StatChart: renderStat,
  GaugeChart: renderGauge,
  Table: renderTable,
  Markdown: renderMarkdown,
});

export function renderPanelBody(
  panel,
  series = [],
  { warn = null, displayMode = "standard", size = null } = {},
) {
  const renderer = PANEL_RENDERERS[panel.panelKind];
  if (!renderer) return null;
  if (panel.panelKind === "Markdown") return renderer(panel, { warn, displayMode });
  return renderer(panel, series, { warn, displayMode, size });
}
