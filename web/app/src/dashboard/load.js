import { fetchJson } from "../fetch-json.js";
import { DashboardError, normalizeDashboard } from "./normalize.js";

/**
 * Fetch and normalize a dashboard. Fetch failures use C-002/C-009 codes.
 */
export async function loadDashboard(
  config,
  { signal = null, onRequest = null, warn = () => {} } = {},
) {
  let result;
  try {
    result = await fetchJson(config.dashboardUrl, {
      timeoutMs: 10_000,
      maxBytes: 5 * 1024 * 1024,
      signal,
      onRequest,
    });
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

  const dashboard = normalizeDashboard(result.data, finalUrl.toString(), config.dashboardName, warn);
  dashboard.url = finalUrl.toString();
  return dashboard;
}
