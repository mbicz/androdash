import { parseDuration } from "./duration.js";

export class DashboardError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "DashboardError";
    this.code = code;
    this.detail = detail;
  }
}

const MAX_PANELS = 200;
const MAX_ROWS = 50;
const MAX_LAYOUT_ITEMS = 2000;
const MAX_ROW_ITEMS = 50;
const MAX_QUERIES = 10;
const MAX_VARIABLES = 100;
const MAX_TIME_RANGE_MS = 30 * 86_400_000;

function warning(code, message, panelId = null, detail = null) {
  return { code, message, panelId, detail };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOr(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeUrl(raw, dashboardUrl) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim(), dashboardUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function normalizeDatasources(raw, dashboardUrl, warn) {
  const result = new Map();
  const entries = [];

  if (isObject(raw)) {
    for (const [name, value] of Object.entries(raw)) entries.push([name, value]);
  } else if (Array.isArray(raw)) {
    for (const value of raw) {
      if (isObject(value)) entries.push([value.name, value]);
    }
  } else if (raw !== undefined && raw !== null) {
    warn(
      "W_DATASOURCE_INVALID",
      "Datasources must be an object or array",
      null,
      String(raw).slice(0, 100),
    );
  }

  for (const [rawName, value] of entries) {
    const name = nonEmptyString(rawName);
    if (!name || !isObject(value)) {
      warn("W_DATASOURCE_INVALID", "Datasource is missing a name or object", null, null);
      continue;
    }
    if (result.has(name)) {
      warn("W_DATASOURCE_INVALID", "Duplicate datasource name skipped", null, name);
      continue;
    }
    const plugin = isObject(value.plugin) ? value.plugin : null;
    const pluginKind = nonEmptyString(plugin?.kind);
    if (!pluginKind) {
      warn("W_DATASOURCE_INVALID", "Datasource has no plugin kind", null, name);
      continue;
    }
    const spec = isObject(plugin.spec) ? plugin.spec : {};
    const candidates = [
      spec.directUrl,
      isObject(spec.proxy) && isObject(spec.proxy.spec) ? spec.proxy.spec.url : null,
      spec.url,
    ];
    const rawUrl = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
    const url = normalizeUrl(rawUrl, dashboardUrl);
    if (!url) {
      warn("W_DATASOURCE_INVALID", "Datasource URL is not usable", null, name);
    }
    result.set(name, {
      name,
      pluginKind,
      url,
      default: value.default === true,
    });
  }
  return result;
}

function normalizeQuery(rawQuery, index) {
  if (!isObject(rawQuery)) {
    return {
      index,
      kind: null,
      invalid: true,
      query: "",
      datasource: null,
      spec: {},
    };
  }
  const spec = isObject(rawQuery.spec) ? rawQuery.spec : {};
  const plugin = isObject(spec.plugin) ? spec.plugin : null;
  const kind = nonEmptyString(plugin?.kind);
  const pluginSpec = isObject(plugin?.spec) ? plugin.spec : {};
  return {
    index,
    kind,
    invalid: !kind,
    query: stringOr(pluginSpec.query, ""),
    datasource: pluginSpec.datasource ?? null,
    spec: pluginSpec,
  };
}

function normalizePanel(id, rawPanel, warn) {
  if (!isObject(rawPanel)) {
    return {
      id,
      title: id,
      description: "",
      panelKind: "Invalid",
      panelSpec: {},
      queries: [],
      invalid: true,
      invalidDetail: "Panel is not an object",
    };
  }

  const spec = isObject(rawPanel.spec) ? rawPanel.spec : null;
  const display = isObject(spec?.display) ? spec.display : {};
  const plugin = isObject(spec?.plugin) ? spec.plugin : null;
  const panelKind = nonEmptyString(plugin?.kind) || nonEmptyString(rawPanel.kind) || "Invalid";
  const panelSpec = isObject(plugin?.spec) ? plugin.spec : {};
  const queriesRaw = Array.isArray(spec?.queries) ? spec.queries : [];

  let invalid = rawPanel.kind !== "Panel" || !spec || !plugin;
  let invalidDetail = null;
  if (rawPanel.kind !== "Panel") invalidDetail = "Panel kind is not Panel";
  else if (!spec) invalidDetail = "Panel spec is missing";
  else if (!plugin) invalidDetail = "Panel plugin is missing";
  else if (plugin.spec !== undefined && !isObject(plugin.spec)) {
    invalid = true;
    invalidDetail = "Panel plugin spec is not an object";
  }

  if (queriesRaw.length > MAX_QUERIES) {
    throw new DashboardError("E_DASHBOARD_LIMIT", `Panel ${id} has more than ${MAX_QUERIES} queries`);
  }

  const queries = queriesRaw.map((query, index) => normalizeQuery(query, index));
  if (panelKind !== "Markdown" && queries.some((query) => query.invalid)) invalid = true;
  if (panelKind !== "Markdown" && !invalidDetail && queries.some((query) => query.invalid)) {
    invalidDetail = "Query plugin is malformed";
  }

  return {
    id,
    title: nonEmptyString(display.name) || id,
    description: stringOr(display.description, ""),
    panelKind,
    panelSpec,
    queries,
    invalid,
    invalidDetail,
  };
}

function decodeRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/spec/panels/")) return null;
  let value = ref.slice("#/spec/panels/".length);
  value = value.replace(/~1/g, "/").replace(/~0/g, "~");
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeLayouts(rawLayouts, panels, warn, dashboardUrl) {
  const rows = [];
  if (rawLayouts !== undefined && !Array.isArray(rawLayouts)) {
    warn("W_LAYOUT_FALLBACK", "Layouts must be an array; using a stacked fallback");
  }
  const layouts = Array.isArray(rawLayouts) ? rawLayouts : [];
  let totalItems = 0;

  for (let rowIndex = 0; rowIndex < layouts.length; rowIndex += 1) {
    const layout = layouts[rowIndex];
    if (!isObject(layout) || layout.kind !== "Grid") {
      warn(
        "W_LAYOUT_KIND_UNSUPPORTED",
        "Only Grid layouts are supported",
        null,
        isObject(layout) ? stringOr(layout.kind, "unknown") : "invalid",
      );
      continue;
    }
    const spec = isObject(layout.spec) ? layout.spec : {};
    const display = isObject(spec.display) ? spec.display : {};
    const rawItems = Array.isArray(spec.items) ? spec.items : [];
    const items = [];

    for (let itemIndex = 0; itemIndex < rawItems.length; itemIndex += 1) {
      if (items.length >= MAX_ROW_ITEMS) {
        warn("W_LAYOUT_TRUNCATED", "Layout row item limit reached", null, stringOr(display.title, ""));
        break;
      }
      const item = rawItems[itemIndex];
      if (!isObject(item)) {
        warn("W_LAYOUT_ITEM_SKIPPED", "Layout item is not an object", null, `row ${rowIndex}`);
        continue;
      }
      const { x, y, width, height } = item;
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        !Number.isInteger(width) ||
        width < 1 ||
        width > 24 ||
        !Number.isInteger(height) ||
        height < 1 ||
        height > 50
      ) {
        warn("W_LAYOUT_ITEM_SKIPPED", "Layout item has invalid coordinates", null, `row ${rowIndex}`);
        continue;
      }

      let panelId = null;
      if (isObject(item.content) && typeof item.content.$ref === "string") {
        panelId = decodeRef(item.content.$ref);
        if (!panelId || !panels.has(panelId)) {
          warn("W_LAYOUT_ITEM_SKIPPED", "Layout references a missing panel", null, item.content.$ref);
          continue;
        }
      } else if (isObject(item.content)) {
        panelId = `inline:${rowIndex}:${itemIndex}`;
        const inline = normalizePanel(panelId, item.content, warn);
        panels.set(panelId, inline);
      } else {
        warn("W_LAYOUT_ITEM_SKIPPED", "Layout item has no content", null, `row ${rowIndex}`);
        continue;
      }

      items.push({ panelId, x, y, width, height });
      totalItems += 1;
    }

    if (items.length > 0) {
      rows.push({
        index: rows.length,
        title: stringOr(display.title, ""),
        collapsed: isObject(display.collapse) && display.collapse.open === false,
        items,
      });
    }
  }

  if (totalItems > MAX_LAYOUT_ITEMS) {
    throw new DashboardError("E_DASHBOARD_LIMIT", `Dashboard has more than ${MAX_LAYOUT_ITEMS} layout items`);
  }
  if (rows.length > MAX_ROWS) {
    throw new DashboardError("E_DASHBOARD_LIMIT", `Dashboard has more than ${MAX_ROWS} layout rows`);
  }

  if (rows.length === 0) {
    warn("W_LAYOUT_FALLBACK", "No usable Grid layouts; panels are stacked");
    for (const panelId of panels.keys()) {
      rows.push({
        index: rows.length,
        title: "",
        collapsed: false,
        items: [{ panelId, x: 0, y: 0, width: 24, height: 6 }],
      });
    }
  }

  return rows;
}

function normalizeVariables(raw, warn) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warn("W_VARIABLE_UNKNOWN", "Variables must be an array");
    return [];
  }
  if (raw.length > MAX_VARIABLES) {
    throw new DashboardError("E_DASHBOARD_LIMIT", `Dashboard has more than ${MAX_VARIABLES} variables`);
  }
  const variables = [];
  const seen = new Set();
  for (const item of raw) {
    if (!isObject(item)) continue;
    const spec = isObject(item.spec) ? item.spec : {};
    const name = nonEmptyString(spec.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const plugin = isObject(spec.plugin) ? spec.plugin : null;
    variables.push({
      name,
      kind: stringOr(item.kind, "Unknown"),
      spec,
      pluginKind: nonEmptyString(plugin?.kind),
      pluginSpec: isObject(plugin?.spec) ? plugin.spec : {},
    });
  }
  return variables;
}

function normalizeTimeRange(raw, warn) {
  if (raw === undefined || raw === null) {
    return { ms: 3_600_000, text: "1h" };
  }
  const ms = parseDuration(raw);
  if (ms === null || ms < 1000 || ms > MAX_TIME_RANGE_MS) {
    warn("W_DURATION_INVALID", "Dashboard duration is invalid; using 1h", null, String(raw));
    return { ms: 3_600_000, text: "1h" };
  }
  return { ms, text: String(raw) };
}

function normalizeRefresh(raw, warn) {
  if (raw === undefined || raw === null) return { seconds: null, text: null };
  const ms = parseDuration(raw);
  if (ms === null) {
    warn("W_REFRESH_INVALID", "Dashboard refresh interval is invalid; using 30s", null, String(raw));
    return { seconds: 30, text: "30s" };
  }
  let seconds = Math.round(ms / 1000);
  if (seconds === 0) return { seconds: 0, text: String(raw) };
  if (seconds > 0 && seconds < 5) {
    seconds = 5;
    warn("W_REFRESH_CLAMPED", "Dashboard refresh interval raised to 5s", null, String(raw));
  } else if (seconds > 3600) {
    seconds = 3600;
    warn("W_REFRESH_CLAMPED", "Dashboard refresh interval clamped to 1h", null, String(raw));
  }
  return { seconds, text: String(raw) };
}

/**
 * Normalize a Perses dashboard JSON document into the renderer's model.
 *
 * @param {unknown} document
 * @param {string} url
 * @param {string|null} dashboardName
 * @param {(code:string,message:string,panelId?:string|null,detail?:string|null)=>void} warn
 */
export function normalizeDashboard(document, url, dashboardName = null, warn = () => {}) {
  let raw = document;
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new DashboardError("E_DASHBOARD_PARSE", "Dashboard array is empty");
    }
    if (dashboardName !== null) {
      raw = raw.find((candidate) => isObject(candidate) && candidate.metadata?.name === dashboardName);
      if (!raw) {
        throw new DashboardError("E_DASHBOARD_PARSE", `No dashboard named ${dashboardName}`);
      }
    } else {
      if (raw.length > 1) {
        warn("W_DASHBOARD_MULTIPLE", "Dashboard URL returned multiple dashboards; using the first");
      }
      raw = raw[0];
    }
  }

  if (!isObject(raw) || !["Dashboard", "EphemeralDashboard"].includes(raw.kind)) {
    throw new DashboardError("E_DASHBOARD_PARSE", "Not a Perses Dashboard or EphemeralDashboard");
  }
  const name = nonEmptyString(raw.metadata?.name);
  if (!name) throw new DashboardError("E_DASHBOARD_PARSE", "Dashboard metadata.name is missing");
  const spec = isObject(raw.spec) ? raw.spec : null;
  if (!spec) throw new DashboardError("E_DASHBOARD_PARSE", "Dashboard spec is missing");
  const rawPanels = spec.panels;
  if (!isObject(rawPanels)) {
    throw new DashboardError("E_DASHBOARD_PARSE", "Dashboard spec.panels must be an object");
  }
  const panelEntries = Object.entries(rawPanels);
  if (panelEntries.length === 0) {
    throw new DashboardError("E_DASHBOARD_EMPTY", "Dashboard has no panels");
  }
  if (panelEntries.length > MAX_PANELS) {
    throw new DashboardError("E_DASHBOARD_LIMIT", `Dashboard has more than ${MAX_PANELS} panels`);
  }

  const panels = new Map();
  for (const [panelId, rawPanel] of panelEntries) {
    panels.set(panelId, normalizePanel(panelId, rawPanel, warn));
  }

  const datasources = normalizeDatasources(spec.datasources, url, warn);
  const rows = normalizeLayouts(spec.layouts, panels, warn, url);
  const variables = normalizeVariables(spec.variables, warn);
  const duration = normalizeTimeRange(spec.duration, warn);
  const refresh = normalizeRefresh(spec.refreshInterval, warn);
  const display = isObject(spec.display) ? spec.display : {};

  return {
    url,
    name,
    project: nonEmptyString(raw.metadata?.project),
    title: nonEmptyString(display.name) || name,
    description: stringOr(display.description, ""),
    durationMs: duration.ms,
    durationText: duration.text,
    refreshSeconds: refresh.seconds,
    refreshText: refresh.text,
    datasources,
    variables,
    panels,
    rows,
    panelsTotal: panels.size,
    rowsTotal: rows.length,
  };
}

export function defaultPrometheusDatasource(dashboard) {
  const candidates = [...dashboard.datasources.values()].filter(
    (source) => source.pluginKind === "PrometheusDatasource" && source.url,
  );
  return candidates.find((source) => source.default) || candidates[0] || null;
}

export function collectPrometheusBaseUrls(dashboard, config) {
  if (config.prometheusUrl) return [config.prometheusUrl];
  const urls = [];
  for (const source of dashboard.datasources.values()) {
    if (source.pluginKind === "PrometheusDatasource" && source.url && !urls.includes(source.url)) {
      urls.push(source.url);
    }
    if (urls.length >= 4) break;
  }
  return urls;
}

function staticValues(pluginSpec) {
  const values = Array.isArray(pluginSpec.values) ? pluginSpec.values : [];
  return values.map((item) => (isObject(item) ? item.value : item)).filter((item) => item !== undefined);
}

function firstValue(value) {
  if (Array.isArray(value)) return value.length > 0 ? firstValue(value[0]) : "";
  if (isObject(value)) return value.value ?? value.label ?? "";
  return value ?? "";
}

export async function resolveVariables(
  dashboard,
  { config, advertisedCapabilities, labelValues, warn = () => {} },
) {
  const values = new Map();
  const defaultProm = defaultPrometheusDatasource(dashboard);
  const baseUrl = config.prometheusUrl || defaultProm?.url || null;
  const hasPrometheus = advertisedCapabilities.includes("prometheus");

  for (const variable of dashboard.variables) {
    const { name, kind, spec, pluginKind, pluginSpec } = variable;
    let value = "";
    if (kind === "TextVariable") {
      value = spec.value ?? spec.defaultValue ?? "";
    } else if (kind === "ListVariable" && pluginKind === "StaticListVariable") {
      value = spec.defaultValue ?? firstValue(staticValues(pluginSpec));
    } else if (kind === "ListVariable" && pluginKind === "PrometheusLabelValuesVariable") {
      if (!hasPrometheus || !baseUrl || typeof labelValues !== "function") {
        warn("W_VARIABLE_UNRESOLVED", `Variable ${name} has no Prometheus endpoint`, name, null);
      } else {
        const labelName = nonEmptyString(pluginSpec.labelName) || name;
        const matchers = Array.isArray(pluginSpec.matchers)
          ? pluginSpec.matchers.slice(0, 20).filter((item) => typeof item === "string")
          : [];
        try {
          const result = await labelValues({ baseUrl, labelName, matchers });
          const list = Array.isArray(result) ? result.map(String) : [];
          const preferred = spec.defaultValue !== undefined ? String(spec.defaultValue) : null;
          value = preferred !== null && list.includes(preferred) ? preferred : list[0] || "";
        } catch (error) {
          warn(
            "W_VARIABLE_UNRESOLVED",
            `Variable ${name} could not be resolved`,
            name,
            error?.message || String(error),
          );
          value = "";
        }
      }
    } else if (kind === "ListVariable" && pluginKind === "DatasourceVariable") {
      const wanted = nonEmptyString(pluginSpec.datasourcePluginKind);
      const candidates = [...dashboard.datasources.values()].filter(
        (source) => !wanted || source.pluginKind === wanted,
      );
      const preferred = nonEmptyString(spec.defaultValue);
      value =
        (preferred && dashboard.datasources.has(preferred) && preferred) ||
        candidates.find((source) => source.default)?.name ||
        candidates[0]?.name ||
        "";
    } else {
      warn("W_VARIABLE_UNKNOWN", `Unknown variable kind ${kind}`, name, pluginKind);
    }
    values.set(name, String(firstValue(value)));
  }
  return values;
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_BODY = /[A-Za-z0-9_]/;

export function interpolate(text, variables, warn = () => {}) {
  if (typeof text !== "string") return "";
  let output = "";
  const missing = new Set();
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char !== "$") {
      output += char;
      continue;
    }
    if (text[i + 1] === "$") {
      output += "$";
      i += 1;
      continue;
    }
    let name = "";
    if (text[i + 1] === "{") {
      const end = text.indexOf("}", i + 2);
      if (end > i + 2) {
        name = text.slice(i + 2, end);
        i = end;
      }
    } else if (text[i + 1] && IDENT_START.test(text[i + 1])) {
      let end = i + 2;
      while (end < text.length && IDENT_BODY.test(text[end])) end += 1;
      name = text.slice(i + 1, end);
      i = end - 1;
    }
    if (!name) {
      output += "$";
      continue;
    }
    if (variables.has(name)) {
      output += String(variables.get(name) ?? "");
    } else {
      if (!missing.has(name)) {
        missing.add(name);
        warn("W_VARIABLE_MISSING", `Variable ${name} is not defined`, null, name);
      }
    }
  }
  return output;
}

/**
 * Interpolate resolved variables into the dashboard, row, and panel titles
 * (C-002 "Display and metadata"), e.g. a `$host` title shows the machine name.
 * Titles are only ever written with textContent. A title that interpolates to
 * an empty string falls back to the dashboard name / panel id, so an
 * unresolved variable never leaves a blank or `$host` heading.
 */
export function applyDisplayVariables(dashboard, variables, warn = () => {}) {
  const resolve = (text, fallback) => {
    if (typeof text !== "string" || !text.includes("$")) return text;
    return interpolate(text, variables, warn).trim() || fallback;
  };
  dashboard.title = resolve(dashboard.title, dashboard.name);
  for (const panel of dashboard.panels.values()) panel.title = resolve(panel.title, panel.id);
  for (const row of dashboard.rows || []) row.title = resolve(row.title, "");
  return dashboard;
}
