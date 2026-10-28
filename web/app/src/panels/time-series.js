import { seriesColor, seriesDisplayName, seriesKey } from "../prometheus.js";
import { formatAxis, formatValue, sortedThresholds } from "./format.js";
import { linePath, svgEl, svgText } from "./svg.js";

const DEFAULT_SIZE = { width: 720, height: 280 };

function timeLabel(seconds, rangeSeconds) {
  const date = new Date(seconds * 1000);
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    ...(rangeSeconds < 300 ? { second: "2-digit" } : {}),
  });
}

function finitePoints(series) {
  return (series.points || []).filter((point) => Number.isFinite(point.t));
}

const MONOCHROME_DASHES = [
  null,
  "7 4",
  "2 4",
  "10 4 2 4",
  "4 3",
  "12 5",
  "3 3",
  "9 3 2 3",
  "5 4",
  "2 3",
  "8 3",
  "4 2 8 2",
];

function measure(element) {
  if (typeof element?.getBoundingClientRect !== "function") return null;
  const rect = element.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return { width: Math.round(rect.width), height: Math.round(rect.height) };
}

export function renderTimeSeries(
  panel,
  series,
  { warn = null, displayMode = "standard", size = null } = {},
) {
  const monochrome = displayMode === "monochrome";
  const wrapper = document.createElement("div");
  wrapper.className = "chart-wrap";
  if (panel.panelSpec?.legend?.position === "right") wrapper.classList.add("legend-right");

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
  const thresholds = sortedThresholds(panel.panelSpec?.thresholds?.steps);
  const allPoints = present.flatMap(finitePoints);
  const timestamps = allPoints.map((point) => point.t);
  const values = allPoints.map((point) => point.v).filter((value) => value !== null);
  const minT = Math.min(...timestamps);
  const maxT = Math.max(...timestamps);
  const rangeT = maxT - minT || 1;
  let minY = values.length ? Math.min(...values) : 0;
  let maxY = values.length ? Math.max(...values) : 1;
  for (const threshold of thresholds) {
    minY = Math.min(minY, threshold.value);
    maxY = Math.max(maxY, threshold.value);
  }
  if (minY === maxY) {
    const pad = Math.abs(minY) > 0 ? Math.abs(minY) * 0.2 : 1;
    minY -= pad;
    maxY += pad;
  } else {
    const pad = (maxY - minY) * 0.1;
    minY -= pad;
    maxY += pad;
  }
  if (values.length > 0 && values.every((value) => value >= 0)) {
    minY = Math.max(0, minY);
  }
  const rangeY = maxY - minY || 1;

  const lineWidth = Math.min(4, Math.max(1, Number(panel.panelSpec?.visual?.lineWidth) || 2));
  const areaOpacity =
    panel.panelSpec?.visual?.areaOpacity === undefined
      ? monochrome
        ? 0.1
        : 0.14
      : Math.min(1, Math.max(0, Number(panel.panelSpec.visual.areaOpacity)));
  const showPoints = panel.panelSpec?.visual?.showPoints === true;

  /**
   * Draw one chart at an exact CSS-pixel geometry. The viewBox equals the
   * rendered box, so SVG text keeps its CSS font size instead of being scaled
   * down with the drawing (a 9.5px axis label stays 9.5px on a 338px phone).
   */
  function draw(box) {
    const width = Math.max(96, Math.round(box.width));
    const height = Math.max(64, Math.round(box.height));
    const ySteps = height >= 150 ? 4 : 3;
    const tickValues = Array.from(
      { length: ySteps + 1 },
      (_, index) => minY + (rangeY * index) / ySteps,
    );
    const tickLabels = tickValues.map((value) => formatAxis(value, format));
    const leftPad = Math.min(
      72,
      Math.max(26, Math.max(...tickLabels.map((label) => label.length)) * 5.8 + 12),
    );
    const padding = {
      left: leftPad,
      right: 10,
      top: 10,
      bottom: height < 150 ? 22 : 28,
    };
    const plotW = Math.max(40, width - padding.left - padding.right);
    const plotH = Math.max(24, height - padding.top - padding.bottom);

    const x = (t) => padding.left + ((t - minT) / rangeT) * plotW;
    const y = (value) => padding.top + plotH - ((value - minY) / rangeY) * plotH;
    const baseline = y(Math.max(minY, Math.min(0, maxY)));

    const svg = svgEl("svg", {
      class: "chart-svg",
      viewBox: `0 0 ${width} ${height}`,
      role: "img",
      "aria-label": `${panel.title}: ${present.length} series, ${new Date(minT * 1000).toLocaleTimeString()} to ${new Date(maxT * 1000).toLocaleTimeString()}`,
    });

    const grid = svgEl("g", { class: "chart-grid" });
    tickValues.forEach((value, index) => {
      const yy = y(value);
      grid.append(svgEl("line", { x1: padding.left, x2: width - padding.right, y1: yy, y2: yy }));
      grid.append(
        svgText(tickLabels[index], {
          x: padding.left - 8,
          y: yy + 3.5,
          "text-anchor": "end",
          class: "axis-label",
        }),
      );
    });
    const xSteps = plotW >= 240 ? 4 : 3;
    for (let i = 0; i < xSteps; i += 1) {
      const t = minT + (rangeT * i) / (xSteps - 1);
      const xx = x(t);
      grid.append(
        svgEl("line", {
          x1: xx,
          x2: xx,
          y1: padding.top,
          y2: height - padding.bottom,
          class: "x-grid",
        }),
      );
      grid.append(
        svgText(timeLabel(t, rangeT), {
          x: xx,
          y: height - padding.bottom + 12,
          "text-anchor": i === 0 ? "start" : i === xSteps - 1 ? "end" : "middle",
          class: "axis-label",
        }),
      );
    }
    svg.append(grid);

    const thresholdLayer = svgEl("g", { class: "chart-thresholds" });
    for (const threshold of thresholds) {
      const yy = y(threshold.value);
      thresholdLayer.append(
        svgEl("line", {
          x1: padding.left,
          x2: width - padding.right,
          y1: yy,
          y2: yy,
          class: "threshold-line",
        }),
      );
      thresholdLayer.append(
        svgText(threshold.name || formatValue(threshold.value, format), {
          x: width - padding.right - 2,
          y: Math.max(9, yy - 4),
          "text-anchor": "end",
          class: "threshold-label",
        }),
      );
    }
    svg.append(thresholdLayer);

    const seriesLayer = svgEl("g", { class: "chart-series" });

    present.forEach((item, index) => {
      const key = seriesKey(item.labels, item.queryIndex || 0);
      const color = seriesColor(key, { monochrome });
      const dash = monochrome ? MONOCHROME_DASHES[index % MONOCHROME_DASHES.length] : null;
      const points = finitePoints(item).sort((a, b) => a.t - b.t);
      const segments = [];
      let segment = [];
      for (const point of points) {
        if (point.v === null) {
          if (segment.length) segments.push(segment);
          segment = [];
        } else {
          segment.push({ x: x(point.t), y: y(point.v), value: point.v, t: point.t });
        }
      }
      if (segment.length) segments.push(segment);

      for (const part of segments) {
        if (part.length === 0) continue;
        if (part.length > 1) {
          const area = [
            `M ${part[0].x.toFixed(2)} ${baseline.toFixed(2)}`,
            ...part.map((point) => `L ${point.x.toFixed(2)} ${point.y.toFixed(2)}`),
            `L ${part[part.length - 1].x.toFixed(2)} ${baseline.toFixed(2)} Z`,
          ].join(" ");
          seriesLayer.append(
            svgEl("path", {
              d: area,
              fill: color,
              "fill-opacity": areaOpacity,
              class: "series-area",
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
            ...(dash ? { "stroke-dasharray": dash } : {}),
            class: "series-line",
          }),
        );
        if (showPoints || part.length <= 12) {
          for (const point of part) {
            seriesLayer.append(
              svgEl("circle", { cx: point.x, cy: point.y, r: 2.4, fill: color, class: "series-dot" }),
            );
          }
        }
      }
      const last = points.filter((point) => point.v !== null).at(-1);
      if (last) {
        seriesLayer.append(
          svgEl("circle", {
            cx: x(last.t),
            cy: y(last.v),
            r: 4,
            fill: color,
            stroke: "var(--panel)",
            "stroke-width": 2,
            class: "series-last",
          }),
        );
      }
      item._displayColor = color;
      item._displayIndex = index;
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
  for (const item of present.slice(0, maxLegend)) {
    const entry = document.createElement("div");
    entry.className = "legend-entry";
    const dot = document.createElement("span");
    dot.className = "legend-dot";
    dot.style.background = item._displayColor;
    const label = document.createElement("span");
    label.className = "legend-label";
    label.textContent = seriesDisplayName(item.labels);
    const value = document.createElement("span");
    value.className = "legend-value";
    const last = item.points.filter((point) => point.v !== null).at(-1);
    value.textContent = last ? formatValue(last.v, format, { warn }) : "—";
    entry.append(dot, label, value);
    legend.append(entry);
  }
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
