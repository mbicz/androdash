import { fetchJson } from "../fetch-json.js";
import { DashboardError, normalizeDashboard } from "./normalize.js";

export const LOCAL_HOST = "androdash.local";
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Where a local dashboard URL is served from: `"bundled"` for a dashboard in
 * the APK (`http://androdash.local/dashboards/…`), `"inline"` for one pasted on
 * the phone (`http://androdash.local/inline/…`), otherwise null.
 */
export function localDashboardKind(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.host !== LOCAL_HOST) return null;
    if (parsed.pathname.startsWith("/dashboards/")) return "bundled";
    if (parsed.pathname.startsWith("/inline/")) return "inline";
    return null;
  } catch {
    return null;
  }
}

/** A dashboard served by the shell itself; never stored, always fetched locally. */
export function isLocalDashboard(url) {
  return localDashboardKind(url) !== null;
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
 * The shell's dashboard store (C-002 "Dashboard sources", C-007
 * `storeDashboard`): one slot per entry of `dashboard_urls`. Reads go through
 * the virtual origin; writes through the bridge, which picks the slot from the
 * source URL. Returns null outside the Android shell.
 */
export function shellDashboardStore(shell, { slot = 0, fetch = fetchJson } = {}) {
  if (typeof shell?.storeDashboard !== "function") return null;
  const base = `http://${LOCAL_HOST}/stored/${Math.max(0, Math.min(7, slot | 0))}`;
  return {
    async read() {
      let meta;
      try {
        meta = (await fetch(`${base}/meta.json`, { timeoutMs: 3000 })).data;
      } catch (error) {
        if (error?.code === "E_HTTP" && error.status === 404) return null;
        throw error;
      }
      const document = await fetch(`${base}/dashboard.json`, {
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

/** Normalize a fetched dashboard document and record its URL (C-002). */
export function normalizeFrom(data, url, config, warn = () => {}) {
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
 * - A local `http://androdash.local/dashboards/…` (bundled) or
 *   `http://androdash.local/inline/…` (pasted) URL is always fetched from the
 *   shell and never stored.
 *
 * `dashboard.source` records where the definition came from.
 */
export async function loadDashboard(
  config,
  { signal = null, onRequest = null, warn = () => {}, store = null, now = () => Date.now() } = {},
) {
  const local = localDashboardKind(config.dashboardUrl);
  const useStore = config.dashboardSource === "stored" && store && !local;

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
    dashboard.source = { kind: local || "url", storedAt: null };
  }
  return dashboard;
}

/**
 * Re-fetch `dashboard_url` and replace the stored copy, only if the new
 * definition normalizes. Returns true when the store was updated.
 */
export async function updateStoredDashboard(config, { store, onRequest = null, warn = () => {} }) {
  if (!store || isLocalDashboard(config.dashboardUrl)) return false;
  const { data, url } = await fetchDashboardDocument(config.dashboardUrl, { onRequest });
  normalizeFrom(data, url, config, warn);
  return store.write(config.dashboardUrl, JSON.stringify(data));
}

/**
 * Dashboards built into the APK (`/dashboards/index.json`, C-007). Returns
 * `[{url, title}]`, or `[]` outside the shell.
 */
export async function bundledDashboards({ fetch = fetchJson } = {}) {
  try {
    const { data } = await fetch(`http://${LOCAL_HOST}/dashboards/index.json`, { timeoutMs: 3000 });
    return (Array.isArray(data?.dashboards) ? data.dashboards : [])
      .filter((item) => typeof item?.file === "string" && /^[A-Za-z0-9_.-]+\.json$/.test(item.file))
      .map((item) => ({
        url: `http://${LOCAL_HOST}/dashboards/${item.file}`,
        title: typeof item.title === "string" ? item.title.slice(0, 80) : item.file,
      }));
  } catch {
    return [];
  }
}
