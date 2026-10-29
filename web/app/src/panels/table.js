import { formatValue } from "./format.js";
import { seriesLabel } from "../prometheus.js";

const NOISE_LABELS = new Set(["job", "instance"]);

/**
 * Compact, deterministic series label for a table row. `job`/`instance`
 * identify the scrape target, not the series, so they are dropped; the metric
 * name is dropped too when every row in the table shares it. The full label
 * string stays available as the cell's `title` and in diagnostics.
 */
function compactLabel(labels, { includeName }) {
  const name = labels.__name__ || "";
  const rest = Object.keys(labels)
    .filter((key) => key !== "__name__" && !NOISE_LABELS.has(key))
    .sort()
    .map((key) => `${key}=${JSON.stringify(labels[key])}`);
  const body = rest.join(", ");
  if (!includeName) return body || name || "series";
  return `${name}${body ? `{${body}}` : ""}`;
}

/**
 * When every row is identified by the same single label (e.g. `collector`),
 * that key becomes the column heading and cells show only its value.
 */
function sharedKey(rows) {
  let key = null;
  for (const row of rows) {
    const keys = Object.keys(row.labels).filter((name) => name !== "__name__" && !NOISE_LABELS.has(name));
    if (keys.length !== 1 || (key !== null && keys[0] !== key)) return null;
    key = keys[0];
  }
  return key;
}

export function renderTable(panel, series, { warn = null } = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "table-wrap";
  const format = panel.panelSpec?.format || {};
  let rows = series
    .map((item) => {
      const last = [...(item.points || [])].reverse().find((point) => point.v !== undefined);
      return { labels: item.labels, full: seriesLabel(item.labels), value: last ? last.v : null };
    })
    .sort((a, b) => a.full.localeCompare(b.full) || (a.value ?? 0) - (b.value ?? 0));

  if (rows.length === 0) {
    wrapper.dataset.empty = "true";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No data";
    wrapper.append(empty);
    return wrapper;
  }

  const maxRows = 100;
  if (rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    warn?.("W_ROWS_TRUNCATED", `Table kept the first ${maxRows} rows`, panel.id, null);
  }
  wrapper.dataset.empty = "false";

  const names = new Set(rows.map((row) => row.labels.__name__ || ""));
  const includeName = names.size > 1;
  const key = includeName ? null : sharedKey(rows);

  const table = document.createElement("table");
  table.className = "data-table";
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const title of [key || "Series", "Value"]) {
    const th = document.createElement("th");
    th.textContent = title;
    headRow.append(th);
  }
  thead.append(headRow);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const label = document.createElement("td");
    label.className = "series-cell";
    label.textContent = key ? String(row.labels[key]) : compactLabel(row.labels, { includeName });
    label.title = row.full;
    const value = document.createElement("td");
    value.className = "value-cell";
    value.textContent =
      panel.panelSpec?.format && row.value !== null
        ? formatValue(row.value, format, { warn })
        : row.value === null
          ? "—"
          : String(row.value);
    tr.append(label, value);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrapper.append(table);

  return wrapper;
}
