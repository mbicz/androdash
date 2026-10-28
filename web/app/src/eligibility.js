import { defaultPrometheusDatasource, interpolate } from "./dashboard/normalize.js";

export const SUPPORTED_PANELS = new Set([
  "TimeSeriesChart",
  "StatChart",
  "GaugeChart",
  "Table",
  "Markdown",
]);

export const QUERY_CAPABILITIES = Object.freeze({
  PrometheusTimeSeriesQuery: "prometheus",
});

export const RECOGNIZED_UNSUPPORTED_QUERIES = Object.freeze([
  "TempoTraceQuery",
  "LokiLogQuery",
]);

const PRECEDENCE = [
  "invalid_panel",
  "unsupported_query",
  "capability_unavailable",
  "missing_datasource",
  "probe_failed",
  "no_queries",
  "unsupported_panel",
];

function firstReason(reasons) {
  for (const reason of PRECEDENCE) {
    if (reasons.has(reason)) return reason;
  }
  return null;
}

function detailFor(reason, panel, reasons) {
  return reasons.get(reason) ?? panel.invalidDetail ?? null;
}

function normalizeBase(base) {
  return String(base).replace(/\/+$/, "");
}

function resolveDatasourceName(datasource, variables) {
  if (datasource && typeof datasource === "object") {
    return typeof datasource.name === "string" ? datasource.name : null;
  }
  if (typeof datasource !== "string" || datasource.length === 0) return null;
  return interpolate(datasource, variables);
}

/**
 * Resolve the Prometheus base URL for a single query.
 * `config.prometheusUrl` overrides every dashboard datasource (C-003).
 */
export function resolveQueryBaseUrl(panel, dashboard, query, config, variables) {
  if (config.prometheusUrl) {
    return { baseUrl: normalizeBase(config.prometheusUrl), reason: null };
  }
  let datasource = null;
  const name = resolveDatasourceName(query.datasource, variables);
  if (name) {
    datasource = dashboard.datasources.get(name) || null;
    if (!datasource) {
      return { baseUrl: null, reason: "missing_datasource", detail: `datasource ${name}` };
    }
  } else if (query.datasource && typeof query.datasource === "object") {
    return { baseUrl: null, reason: "missing_datasource", detail: "datasource name missing" };
  } else {
    datasource = defaultPrometheusDatasource(dashboard);
  }

  if (!datasource || datasource.pluginKind !== "PrometheusDatasource" || !datasource.url) {
    return {
      baseUrl: null,
      reason: "missing_datasource",
      detail: datasource ? `${datasource.name} has no usable URL` : `panel ${panel.id}`,
    };
  }
  return { baseUrl: normalizeBase(datasource.url), reason: null };
}

/**
 * Evaluate one normalized panel against the advertised capabilities and
 * Prometheus health. `probes` is an array from capabilities.probePrometheus;
 * pass null in focused unit tests to skip health gating.
 */
export function evaluatePanel(
  panel,
  dashboard,
  { config, advertised, variables, probes = null, warn = () => {} },
) {
  const reasons = new Map();
  if (panel.invalid) reasons.set("invalid_panel", panel.invalidDetail || "Malformed panel");

  if (panel.panelKind === "Markdown") {
    if (!panel.invalid && panel.panelKind && !SUPPORTED_PANELS.has(panel.panelKind)) {
      reasons.set("unsupported_panel", panel.panelKind);
    }
    const reason = firstReason(reasons);
    return {
      eligible: reason === null,
      reason,
      detail: reason ? detailFor(reason, panel, reasons) : null,
      queries: [],
      baseUrls: [],
    };
  }

  const resolved = [];
  for (const query of panel.queries) {
    if (query.invalid) {
      reasons.set("invalid_panel", "Query plugin is malformed");
      continue;
    }
    const capability = QUERY_CAPABILITIES[query.kind] || null;
    if (!capability) {
      if (!reasons.has("unsupported_query")) {
        reasons.set("unsupported_query", query.kind || "unknown");
      }
      continue;
    }
    if (!advertised.includes(capability)) {
      if (!reasons.has("capability_unavailable")) {
        reasons.set("capability_unavailable", capability);
      }
      continue;
    }
    const base = resolveQueryBaseUrl(panel, dashboard, query, config, variables);
    if (base.reason) {
      if (!reasons.has("missing_datasource")) {
        reasons.set("missing_datasource", base.detail || base.reason);
      }
      continue;
    }
    resolved.push({
      ...query,
      query: interpolate(query.query, variables, warn),
      baseUrl: base.baseUrl,
    });
  }

  if (panel.queries.length === 0) {
    reasons.set("no_queries", "Data panel has no queries");
  }

  if (probes && resolved.length > 0) {
    const health = new Map();
    for (const probe of probes) health.set(normalizeBase(probe.baseUrl), probe);
    for (const query of resolved) {
      const probe = health.get(normalizeBase(query.baseUrl));
      if (probe && probe.ok === false && !reasons.has("probe_failed")) {
        reasons.set("probe_failed", probe.error || normalizeBase(query.baseUrl));
      }
    }
  }

  if (!SUPPORTED_PANELS.has(panel.panelKind)) {
    reasons.set("unsupported_panel", panel.panelKind);
  }

  const reason = firstReason(reasons);
  return {
    eligible: reason === null,
    reason,
    detail: reason ? detailFor(reason, panel, reasons) : null,
    queries: reason === null ? resolved : [],
    baseUrls: reason === null ? [...new Set(resolved.map((query) => query.baseUrl))] : [],
  };
}

/**
 * Filter panels and layout rows. Returns the rendered model and stable hidden
 * reasons for diagnostics.
 */
export function filterDashboard(
  dashboard,
  { config, advertised, variables, probes = null, warn = () => {} },
) {
  const visible = new Map();
  const hidden = new Map();
  for (const panel of dashboard.panels.values()) {
    const result = evaluatePanel(panel, dashboard, { config, advertised, variables, probes, warn });
    if (result.eligible) visible.set(panel.id, { panel, ...result });
    else hidden.set(panel.id, { panel, reason: result.reason, detail: result.detail });
  }

  const rows = [];
  for (const row of dashboard.rows) {
    const items = [];
    for (const item of row.items) {
      if (visible.has(item.panelId)) {
        items.push({ ...item, state: "data", panel: visible.get(item.panelId).panel });
      } else if (config.showUnsupported && hidden.has(item.panelId)) {
        const hiddenPanel = hidden.get(item.panelId);
        items.push({ ...item, state: "unsupported", panel: hiddenPanel.panel, hidden: hiddenPanel });
      }
    }
    if (items.length > 0) {
      rows.push({ ...row, items });
    }
  }

  const hiddenReasons = [...hidden.values()]
    .map(({ panel, reason, detail }) => ({
      panelId: panel.id,
      panelKind: panel.panelKind,
      reason,
      detail: detail === null ? null : String(detail).slice(0, 300),
    }))
    .sort((a, b) => a.panelId.localeCompare(b.panelId));

  const dataPanelIds = [...visible.values()]
    .filter((entry) => entry.panel.panelKind !== "Markdown")
    .map((entry) => entry.panel.id);

  return {
    visible,
    hidden,
    rows,
    hiddenReasons,
    dataPanelIds,
    counts: {
      total: dashboard.panels.size,
      rendered: visible.size,
      hidden: hidden.size,
      hiddenReasons,
    },
  };
}
