import { fetchJson } from "../fetch-json.js";
import { DashboardError, normalizeDashboard } from "./normalize.js";

export const LOCAL_HOST = "androdash.local";
const MAX_BYTES = 5 * 1024 * 1024;

/** A dashboard bundled in the APK (`http://androdash.local/dashboards/…`). */
export function isBundledDashboard(url) {
  try {
    const parsed = new URL(url);
    return parsed.host === LOCAL_HOST && parsed.pathname.startsWith("/dashboards/");
  } catch {
    return false;
  }
}

/**
 * Fetch a dashboard document. Fetch failures use C-002/C-009 codes. Returns
 * the parsed JSON and the final URL after redirects.
 */
export async function fetchDashboardDocument(url, { signal = null, onRequest = null } = {}) {
  let result;
  try {
    result = await fetchJson(url, { timeoutMs: 10_000, maxBytes: MAX_BYTES, signal, onRequest });
  } catch (error) {
    if (error.code === "E_SIZE") {
      throw new DashboardError("E_DASHBOARD_LIMIT", "Dashboard response is larger than 5 MiB");
    }
    if (error.code === "E_PARSE") {
      throw new DashboardError("E_DASHBOARD_PARSE", "Dashboard response is not valid JSON");
    }
    if (error.code === "E_HTTP") {
      throw new DashboardError(
        "E_DASHBOARD_FETCH",
        `Dashboard returned HTTP ${error.status}`,
        error.body || null,
      );
    }
    if (error.code === "E_TIMEOUT") {
      throw new DashboardError("E_DASHBOARD_FETCH", "Dashboard request timed out");
    }
    throw new DashboardError(
      "E_DASHBOARD_FETCH",
      "Dashboard unreachable; check the URL, network, and CORS from the renderer origin",
      error.message,
    );
  }

  let finalUrl;
  try {
    finalUrl = new URL(result.url);
  } catch {
    throw new DashboardError("E_DASHBOARD_FETCH", "Dashboard redirected to an invalid URL");
  }
  if (finalUrl.protocol !== "http:" && finalUrl.protocol !== "https:") {
    throw new DashboardError("E_DASHBOARD_FETCH", "Dashboard redirected to a non-http URL");
  }
  return { data: result.data, url: finalUrl.toString() };
}

/**
 * The shell's dashboard store (C-002 "Stored dashboards", C-007
 * `storeDashboard`). Reads go through the virtual origin; writes through the
 * bridge. Returns null outside the Android shell.
 */
export function shellDashboardStore(shell, { fetch = fetchJson } = {}) {
  if (typeof shell?.storeDashboard !== "function") return null;
  return {
    async read() {
      let meta;
      try {
        meta = (await fetch(`http://${LOCAL_HOST}/stored/meta.json`, { timeoutMs: 3000 })).data;
      } catch (error) {
        if (error?.code === "E_HTTP" && error.status === 404) return null;
        throw error;
      }
      const document = await fetch(`http://${LOCAL_HOST}/stored/dashboard.json`, {
        timeoutMs: 5000,
        maxBytes: MAX_BYTES,
      });
      return { meta, data: document.data };
    },
    write(sourceUrl, json) {
      try {
        return shell.storeDashboard(sourceUrl, json) === true;
      } catch {
        return false;
      }
    },
  };
}

function normalizeFrom(data, url, config, warn) {
  const dashboard = normalizeDashboard(data, url, config.dashboardName, warn);
  dashboard.url = url;
  return dashboard;
}

/**
 * Load and normalize the configured dashboard (C-002).
 *
 * - `dashboard_source=url`: fetch `dashboard_url` on every load.
 * - `dashboard_source=stored` with a store: use the stored copy when it came
 *   from this `dashboard_url`; otherwise fetch once and store it. The phone
 *   then starts without the dashboard server.
 * - A bundled `http://androdash.local/dashboards/…` URL is always local.
 *
 * `dashboard.source` records where the definition came from.
 */
export async function loadDashboard(
  config,
  { signal = null, onRequest = null, warn = () => {}, store = null, now = () => Date.now() } = {},
) {
  const bundled = isBundledDashboard(config.dashboardUrl);
  const useStore = config.dashboardSource === "stored" && store && !bundled;

  if (useStore) {
    let stored = null;
    try {
      stored = await store.read();
    } catch (error) {
      warn("W_STORED_DASHBOARD_INVALID", "Stored dashboard copy could not be read; fetching it again", null, error?.code || null);
    }
    if (stored && stored.meta?.sourceUrl === config.dashboardUrl) {
      try {
        const dashboard = normalizeFrom(stored.data, config.dashboardUrl, config, warn);
        dashboard.source = { kind: "stored", storedAt: Number(stored.meta.storedAt) || null };
        return dashboard;
      } catch (error) {
        warn("W_STORED_DASHBOARD_INVALID", "Stored dashboard copy is unusable; fetching it again", null, error?.code || null);
      }
    }
  }

  const { data, url } = await fetchDashboardDocument(config.dashboardUrl, { signal, onRequest });
  const dashboard = normalizeFrom(data, url, config, warn);
  if (useStore) {
    const saved = store.write(config.dashboardUrl, JSON.stringify(data));
    if (!saved) warn("W_DASHBOARD_NOT_STORED", "Dashboard could not be stored on the device", null, null);
    dashboard.source = { kind: saved ? "stored" : "url", storedAt: saved ? now() : null };
  } else {
    dashboard.source = { kind: bundled ? "bundled" : "url", storedAt: null };
  }
  return dashboard;
}

/**
 * Re-fetch `dashboard_url` and replace the stored copy, only if the new
 * definition normalizes. Returns true when the store was updated.
 */
export async function updateStoredDashboard(config, { store, onRequest = null, warn = () => {} }) {
  if (!store || isBundledDashboard(config.dashboardUrl)) return false;
  const { data, url } = await fetchDashboardDocument(config.dashboardUrl, { onRequest });
  normalizeFrom(data, url, config, warn);
  return store.write(config.dashboardUrl, JSON.stringify(data));
}
