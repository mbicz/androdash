import { parseDuration } from "./dashboard/duration.js";

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: 1,
  dashboardUrl: null,
  prometheusUrl: null,
  refreshSeconds: null,
  timeRange: null,
  stepSeconds: null,
  kiosk: true,
  debug: false,
  layoutMode: "auto",
  displayMode: "standard",
  dashboardName: null,
  capabilities: null,
  showUnsupported: false,
});

export class ConfigError extends Error {
  constructor(message, detail = null) {
    super(message);
    this.name = "ConfigError";
    this.code = "E_CONFIG";
    this.detail = detail;
  }
}

const MAX_URL = 8192;
const MAX_QUERY = 2000;
const MAX_CAPABILITIES = 16;
const CAPABILITY_RE = /^[a-z0-9][a-z0-9_-]*$/;
const DISPLAY_MODES = ["standard", "amoled", "monochrome"];
const DURATION_RE = /^\d+(?:ms|s|m|h|d|w)(?:\d+(?:ms|s|m|h|d|w))*$/;

function warning(code, message, detail = null) {
  return { code, message, detail };
}

function parseUrl(raw, name) {
  if (raw === null) return null;
  if (raw.length === 0) {
    throw new ConfigError(`${name} must not be empty`, name);
  }
  if (raw.length > MAX_URL) {
    throw new ConfigError(`${name} is too long`, name);
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${name} must be an absolute http(s) URL`, name);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError(`${name} must use http or https`, name);
  }
  if (url.username || url.password) {
    throw new ConfigError(`${name} must not contain userinfo`, name);
  }
  return raw;
}

function parseBoolean(params, name, fallback) {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const value = raw.toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigError(`${name} must be true or false`, name);
}

function parseInteger(params, name, { min, max }) {
  const raw = params.get(name);
  if (raw === null || raw === "") return null;
  if (!/^\d+$/.test(raw)) {
    throw new ConfigError(`${name} must be an integer`, name);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be between ${min} and ${max}`, name);
  }
  return value;
}

function parseCapabilities(raw) {
  if (raw === null || raw === "") return null;
  const ids = [];
  for (const part of raw.split(",")) {
    const id = part.trim().toLowerCase();
    if (id.length === 0) continue;
    if (!CAPABILITY_RE.test(id) || id.length > 64) {
      throw new ConfigError("capabilities contains an invalid ID", id);
    }
    if (!ids.includes(id)) ids.push(id);
  }
  if (ids.length === 0) return null;
  if (ids.length > MAX_CAPABILITIES) {
    throw new ConfigError(`capabilities must contain at most ${MAX_CAPABILITIES} IDs`);
  }
  return Object.freeze(ids.sort());
}

/**
 * Parse and validate the canonical launch configuration from a query string.
 *
 * @param {string} search `location.search`, with or without a leading `?`.
 * @returns {{config: Readonly<object>, warnings: Array<object>}}
 */
export function parseConfig(search = "") {
  const rawQuery = search.startsWith("?") ? search.slice(1) : search;
  if (rawQuery.length > MAX_QUERY) {
    throw new ConfigError("launch query string is too long");
  }

  const params = new URLSearchParams(rawQuery);
  const warnings = [];

  const dashboardUrl = parseUrl(params.get("dashboard_url"), "dashboard_url");
  if (!dashboardUrl) {
    throw new ConfigError("dashboard_url is required");
  }

  const rawPrometheusUrl = params.get("prometheus_url");
  const prometheusUrl =
    rawPrometheusUrl === null || rawPrometheusUrl === ""
      ? null
      : parseUrl(rawPrometheusUrl, "prometheus_url");

  let refreshSeconds = parseInteger(params, "refresh_seconds", { min: 0, max: 3600 });
  if (refreshSeconds !== null && refreshSeconds > 0 && refreshSeconds < 5) {
    refreshSeconds = 5;
    warnings.push(
      warning(
        "W_REFRESH_CLAMPED",
        "Refresh interval raised to the 5 second floor",
        "refresh_seconds",
      ),
    );
  }

  let timeRange = params.get("time_range");
  if (timeRange === null || timeRange === "") {
    timeRange = null;
  } else {
    if (!DURATION_RE.test(timeRange)) {
      throw new ConfigError("time_range must be a duration", "time_range");
    }
    const ms = parseDuration(timeRange);
    if (ms === null || ms < 1000 || ms > 30 * 86_400_000) {
      throw new ConfigError("time_range must be between 1s and 30d", "time_range");
    }
  }

  const stepSeconds = parseInteger(params, "step_seconds", { min: 1, max: 86_400 });

  let dashboardName = params.get("dashboard_name");
  if (dashboardName === null || dashboardName === "") {
    dashboardName = null;
  } else if (dashboardName.length > 256) {
    throw new ConfigError("dashboard_name is too long", "dashboard_name");
  }

  const layoutMode = params.get("layout_mode") || "auto";
  if (!["auto", "grid", "stack"].includes(layoutMode)) {
    throw new ConfigError("layout_mode must be auto, grid, or stack", "layout_mode");
  }

  const displayMode = params.get("display_mode") || "standard";
  if (!DISPLAY_MODES.includes(displayMode)) {
    throw new ConfigError(
      "display_mode must be standard, amoled, or monochrome",
      "display_mode",
    );
  }

  const config = Object.freeze({
    schemaVersion: 1,
    dashboardUrl,
    prometheusUrl,
    refreshSeconds,
    timeRange,
    stepSeconds,
    kiosk: parseBoolean(params, "kiosk", true),
    debug: parseBoolean(params, "debug", false),
    layoutMode,
    displayMode,
    dashboardName,
    capabilities: parseCapabilities(params.get("capabilities")),
    showUnsupported: parseBoolean(params, "show_unsupported", false),
  });

  return { config, warnings };
}

/** Serialize a canonical config back to a deterministic query string. */
export function buildQuery(config) {
  const params = new URLSearchParams();
  params.set("dashboard_url", config.dashboardUrl);
  if (config.prometheusUrl !== null) params.set("prometheus_url", config.prometheusUrl);
  if (config.refreshSeconds !== null) params.set("refresh_seconds", String(config.refreshSeconds));
  if (config.timeRange !== null) params.set("time_range", config.timeRange);
  if (config.stepSeconds !== null) params.set("step_seconds", String(config.stepSeconds));
  params.set("kiosk", String(config.kiosk));
  params.set("debug", String(config.debug));
  params.set("layout_mode", config.layoutMode);
  params.set("display_mode", config.displayMode);
  if (config.dashboardName !== null) params.set("dashboard_name", config.dashboardName);
  if (config.capabilities !== null) params.set("capabilities", config.capabilities.join(","));
  params.set("show_unsupported", String(config.showUnsupported));
  return params.toString();
}
