import { seriesColor, seriesDisplayName } from "../prometheus.js";
import { formatAxis, formatValue, sortedThresholds, thresholdState } from "./format.js";
import { niceTicks, timeTickLabel, timeTicks } from "./scale.js";
import { linePath, svgEl, svgText } from "./svg.js";

const DEFAULT_SIZE = { width: 720, height: 280 };
const LABEL_CHAR_PX = 5.6;

function finitePoints(series) {
  return (series.points || []).filter((point) => Number.isFinite(point.t));
}

function measure(element) {
  if (typeof element?.getBoundingClientRect !== "function") return null;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { width: Math.round(rect.width), height: Math.round(rect.height) };
}

/**
 * Line chart drawn at exact CSS-pixel geometry (viewBox = rendered box), on the
 * cycle's time window, with round value and time ticks. Colours are CSS
 * variables so display modes restyle without a redraw.
 */
export function renderTimeSeries(panel, series, { warn = null, size = null, timeWindow = null } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "chart-wrap";

  const present = series.filter((item) => finitePoints(item).some((point) => point.v !== null));
  if (present.length === 0) {
    wrapper.classList.add("chart-empty");
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No data";
    wrapper.append(empty);
    return wrapper;
  }

  const format = panel.panelSpec?.yAxis?.format || panel.panelSpec?.format || {};
  const unit = format.unit ?? "none";
  const thresholds = sortedThresholds(panel.panelSpec?.thresholds?.steps);
  const allPoints = present.flatMap(finitePoints);
  const values = allPoints.map((point) => point.v).filter((value) => value !== null);
  const timestamps = allPoints.map((point) => point.t);
  const windowStart = Number(timeWindow?.startMs) / 1000;
  const windowEnd = Number(timeWindow?.endMs) / 1000;
  const minT = Number.isFinite(windowStart) ? windowStart : Math.min(...timestamps);
  const maxT = Number.isFinite(windowEnd) ? windowEnd : Math.max(...timestamps);
  const rangeT = maxT - minT || 1;

  let dataMin = Math.min(...values);
  let dataMax = Math.max(...values);
  for (const threshold of thresholds) {
    dataMin = Math.min(dataMin, threshold.value);
    dataMax = Math.max(dataMax, threshold.value);
  }

  const lineWidth = Math.min(4, Math.max(1, Number(panel.panelSpec?.visual?.lineWidth) || 2));
  const areaOpacity =
    panel.panelSpec?.visual?.areaOpacity === undefined
      ? null
      : Math.min(1, Math.max(0, Number(panel.panelSpec.visual.areaOpacity)));
  const showPoints = panel.panelSpec?.visual?.showPoints === true;

  function draw(box) {
    const width = Math.max(96, Math.round(box.width));
    const height = Math.max(64, Math.round(box.height));
    // One value label per ~22 px of plot so labels never touch on short charts.
    const scale = niceTicks(dataMin, dataMax, Math.max(1, Math.min(4, Math.floor((height - 25) / 22))), unit);
    const minY = scale.min;
    const rangeY = scale.max - scale.min || 1;
    const tickLabels = scale.ticks.map((value) => formatAxis(value, format));
    const gutter = Math.min(
      64,
      Math.max(22, Math.max(...tickLabels.map((label) => label.length)) * LABEL_CHAR_PX + 8),
    );
    const padding = { left: 0, right: gutter, top: 7, bottom: 18 };
    const plotW = Math.max(40, width - padding.left - padding.right);
    const plotH = Math.max(24, height - padding.top - padding.bottom);
    const x = (t) => padding.left + ((t - minT) / rangeT) * plotW;
    const y = (value) => padding.top + plotH - ((value - minY) / rangeY) * plotH;
    const baseline = y(Math.max(minY, Math.min(0, scale.max)));

    const svg = svgEl("svg", {
      class: "chart-svg",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `${panel.title}: ${present.length} series, ${new Date(minT * 1000).toLocaleTimeString()} to ${new Date(maxT * 1000).toLocaleTimeString()}`,
    });

    const grid = svgEl("g", { class: "chart-grid" });
    scale.ticks.forEach((value, index) => {
      const yy = y(value);
      grid.append(svgEl("line", { x1: padding.left, x2: padding.left + plotW, y1: yy, y2: yy }));
      grid.append(
        svgText(tickLabels[index], {
          x: width,
          y: yy + 3.5,
          "text-anchor": "end",
          class: "axis-label",
        }),
      );
    });
    const compact = plotW < 260;
    const time = timeTicks(minT, maxT, Math.max(2, Math.min(8, Math.floor(plotW / (compact ? 46 : 84)))));
    for (const t of time.ticks) {
      const xx = x(t);
      const anchor = xx - padding.left < 22 ? "start" : padding.left + plotW - xx < 22 ? "end" : "middle";
      grid.append(
        svgText(timeTickLabel(t, time.step, rangeT, { compact }), {
          x: xx,
          y: height - 4,
          "text-anchor": anchor,
          class: "axis-label",
        }),
      );
    }
    svg.append(grid);

    const thresholdLayer = svgEl("g", { class: "chart-thresholds" });
    for (const threshold of thresholds) {
      const yy = y(threshold.value);
      const state = thresholdState(threshold.value, thresholds).state;
      thresholdLayer.append(
        svgEl("line", {
          x1: padding.left,
          x2: padding.left + plotW,
          y1: yy,
          y2: yy,
          class: `threshold-line state-${state}`,
        }),
      );
    }
    svg.append(thresholdLayer);

    const seriesLayer = svgEl("g", { class: "chart-series" });
    present.forEach((item, index) => {
      const color = seriesColor(index);
      const points = finitePoints(item).sort((a, b) => a.t - b.t);
      const segments = [];
      let segment = [];
      for (const point of points) {
        if (point.v === null) {
          if (segment.length) segments.push(segment);
          segment = [];
        } else {
          segment.push({ x: x(point.t), y: y(point.v) });
        }
      }
      if (segment.length) segments.push(segment);

      for (const part of segments) {
        if (part.length > 1) {
          const area = [
            `M ${part[0].x.toFixed(2)} ${baseline.toFixed(2)}`,
            ...part.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
            `L ${part.at(-1).x.toFixed(2)} ${baseline.toFixed(2)} Z`,
          ].join(" ");
          seriesLayer.append(
            svgEl("path", {
              d: area,
              fill: color,
              class: "series-area",
              ...(areaOpacity === null ? {} : { "fill-opacity": areaOpacity }),
            }),
          );
        }
        seriesLayer.append(
          svgEl("path", {
            d: linePath(part),
            fill: "none",
            stroke: color,
            "stroke-width": lineWidth,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "data-series": index,
            class: "series-line",
          }),
        );
        if (showPoints || part.length === 1) {
          for (const point of part) {
            seriesLayer.append(svgEl("circle", { cx: point.x, cy: point.y, r: 2.2, fill: color, class: "series-dot" }));
          }
        }
      }
      const last = points.filter((point) => point.v !== null).at(-1);
      if (last) {
        seriesLayer.append(
          svgEl("circle", { cx: x(last.t), cy: y(last.v), r: 3.5, fill: color, class: "series-last" }),
        );
      }
    });
    svg.append(seriesLayer);
    return svg;
  }

  let box = {
    width: size?.width ?? DEFAULT_SIZE.width,
    height: size?.height ?? DEFAULT_SIZE.height,
  };
  let svg = draw(box);
  wrapper.append(svg);

  const legend = document.createElement("div");
  legend.className = "chart-legend";
  const maxLegend = 8;
  present.slice(0, maxLegend).forEach((item, index) => {
    const entry = document.createElement("div");
    entry.className = "legend-entry";
    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.dataset.series = String(index);
    dot.style.background = seriesColor(index);
    const label = document.createElement("span");
    label.className = "legend-label";
    label.textContent = seriesDisplayName(item.labels);
    const value = document.createElement("span");
    value.className = "legend-value";
    const last = item.points.filter((point) => point.v !== null).at(-1);
    value.textContent = last ? formatValue(last.v, format, { warn }) : "—";
    entry.append(dot, label, value);
    legend.append(entry);
  });
  if (present.length > maxLegend) {
    const more = document.createElement("div");
    more.className = "legend-more";
    more.textContent = `+${present.length - maxLegend} more`;
    legend.append(more);
  }
  wrapper.append(legend);

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (!svg.isConnected) {
        observer.disconnect();
        return;
      }
      const next = measure(svg);
      if (!next) return;
      if (Math.abs(next.width - box.width) < 1 && Math.abs(next.height - box.height) < 1) return;
      const replacement = draw(next);
      observer.unobserve(svg);
      svg.replaceWith(replacement);
      svg = replacement;
      box = next;
      observer.observe(svg);
    });
    observer.observe(svg);
  }

  return wrapper;
}
