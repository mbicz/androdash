export const RENDERER_VERSION = "androdash/0.1.0";
export const MAX_DIAGNOSTIC_EVENTS = 50;
export const MAX_REQUESTS = 50;

export function truncate(value, limit) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
}

/** Keep scheme + host + path. This is the only URL form diagnostics may expose. */
export function redactUrl(value) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "[invalid-url]";
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

export function redactConfig(config) {
  if (!config) return null;
  return {
    ...config,
    dashboardUrl: redactUrl(config.dashboardUrl),
    prometheusUrl: redactUrl(config.prometheusUrl),
  };
}

export function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function makeEvent(code, message, panelId = null, detail = null, at = Date.now()) {
  return {
    at: iso(at),
    code,
    message: truncate(message, 300) || "",
    panelId: panelId === null ? null : truncate(panelId, 256),
    detail: detail === null ? null : truncate(detail, 500),
  };
}

export class DiagnosticsStore {
  constructor({ config, startedAt = Date.now() }) {
    this.config = config;
    this.startedAt = startedAt;
    this.requests = [];
    this.errors = [];
    this.warnings = [];
    this.dashboard = null;
    this.capabilities = { advertised: [], unknown: [], probed: [] };
    this.panels = { total: 0, rendered: 0, hidden: 0, errors: 0, hiddenReasons: [] };
    this.lastRefresh = null;
    this.nextRefreshAt = null;
  }

  request({ url, status = null, durationMs = 0, at = Date.now(), method = "GET" }) {
    this.requests.push({
      at: iso(at),
      method,
      url: redactUrl(url) || "http://invalid/",
      status: Number.isInteger(status) ? status : null,
      durationMs: Math.max(0, Number(durationMs) || 0),
    });
    if (this.requests.length > MAX_REQUESTS) {
      this.requests.splice(0, this.requests.length - MAX_REQUESTS);
    }
  }

  error(code, message, panelId = null, detail = null, at = Date.now()) {
    this.errors.push(makeEvent(code, message, panelId, detail, at));
    if (this.errors.length > MAX_DIAGNOSTIC_EVENTS) {
      this.errors.splice(0, this.errors.length - MAX_DIAGNOSTIC_EVENTS);
    }
  }

  warn(code, message, panelId = null, detail = null, at = Date.now()) {
    this.warnings.push(makeEvent(code, message, panelId, detail, at));
    if (this.warnings.length > MAX_DIAGNOSTIC_EVENTS) {
      this.warnings.splice(0, this.warnings.length - MAX_DIAGNOSTIC_EVENTS);
    }
  }

  setDashboard(dashboard) {
    this.dashboard = dashboard;
  }

  setCapabilities(capabilities) {
    this.capabilities = capabilities;
  }

  setPanels(panels) {
    this.panels = panels;
  }

  setLastRefresh(lastRefresh) {
    this.lastRefresh = lastRefresh;
  }

  setNextRefreshAt(nextRefreshAt) {
    this.nextRefreshAt = nextRefreshAt;
  }

  snapshot() {
    return {
      schemaVersion: 1,
      renderer: RENDERER_VERSION,
      generatedAt: iso(),
      startedAt: iso(this.startedAt),
      config: redactConfig(this.config),
      capabilities: this.capabilities,
      dashboard: this.dashboard,
      panels: this.panels,
      lastRefresh: this.lastRefresh,
      nextRefreshAt: this.nextRefreshAt,
      requests: this.requests,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}

/** Convert fetch-level failures into the stable C-003/C-009 codes. */
export function prometheusErrorFrom(error, { panelId = null, baseUrl = null } = {}) {
  if (error?.name === "AbortError" || error?.code === "ABORTED") {
    return {
      code: "E_PROM_NETWORK",
      message: "Prometheus request was cancelled",
      detail: null,
    };
  }
  if (error?.code === "E_TIMEOUT") {
    return {
      code: "E_PROM_NETWORK",
      message: "Prometheus timed out",
      detail: baseUrl ? `base ${redactUrl(baseUrl)}` : null,
    };
  }
  if (error?.code === "E_NETWORK") {
    return {
      code: "E_PROM_NETWORK",
      message: "Prometheus unreachable; check network/CORS/cleartext",
      detail: baseUrl ? `base ${redactUrl(baseUrl)}` : null,
    };
  }
  if (error?.code === "E_HTTP") {
    return {
      code: "E_PROM_HTTP",
      message: `Prometheus returned HTTP ${error.status}`,
      detail: truncate(error.body || null, 200),
    };
  }
  if (error?.code === "E_PARSE" || error?.code === "E_SIZE") {
    return {
      code: "E_PROM_RESPONSE",
      message: "Prometheus returned an unreadable response",
      detail: truncate(error.message, 200),
    };
  }
  return {
    code: "E_PROM_RESPONSE",
    message: error?.message || "Prometheus request failed",
    detail: panelId ? `panel ${panelId}` : null,
  };
}

export function statusLabel(state) {
  switch (state) {
    case "live":
      return "Live";
    case "degraded":
      return "Degraded";
    case "stale":
      return "Stale";
    case "error":
      return "Error";
    default:
      return "Loading";
  }
}

/**
 * C-009 on-screen state machine. `succeeded`/`failed` are the current cycle's
 * data-panel counts; `hasLastGood` is whether any panel retained data.
 */
export function deriveStatus({ phase = "running", fatal = false, total = 0, succeeded = 0, failed = 0, hasLastGood = false }) {
  if (fatal) return "error";
  if (phase === "loading") return "loading";
  if (total === 0) return "live";
  if (failed === 0) return "live";
  if (succeeded > 0) return "degraded";
  if (hasLastGood) return "stale";
  return "error";
}
