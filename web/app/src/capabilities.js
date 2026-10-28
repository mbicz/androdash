export const RENDERER_VERSION = "androdash/0.1.0";

export const CAPABILITY_REGISTRY = Object.freeze({
  capabilities: ["prometheus", "tempo", "loki", "opentelemetry"],
  implementedCapabilities: ["prometheus"],
  panels: ["TimeSeriesChart", "StatChart", "GaugeChart", "Table", "Markdown"],
  queries: ["PrometheusTimeSeriesQuery"],
  datasources: ["PrometheusDatasource"],
  features: ["refresh", "kiosk", "capability-filter", "diagnostics"],
  limits: Object.freeze({
    panels: 200,
    seriesPerPanel: 12,
    pointsPerSeries: 600,
    tableRows: 100,
    gaugesPerPanel: 4,
  }),
});

export function resolveAdvertisedCapabilities(config) {
  const inherited = config.capabilities === null ? [...CAPABILITY_REGISTRY.implementedCapabilities] : [...config.capabilities];
  const advertised = [...new Set(inherited.map((id) => id.toLowerCase()))].sort();
  const known = new Set(CAPABILITY_REGISTRY.capabilities);
  return {
    advertised,
    unknown: advertised.filter((id) => !known.has(id)),
  };
}

export function capabilityDocument(advertised) {
  return {
    renderer: RENDERER_VERSION,
    dashboardContract: 1,
    capabilities: [...advertised].sort(),
    panels: [...CAPABILITY_REGISTRY.panels],
    queries: [...CAPABILITY_REGISTRY.queries],
    datasources: [...CAPABILITY_REGISTRY.datasources],
    features: [...CAPABILITY_REGISTRY.features],
    limits: { ...CAPABILITY_REGISTRY.limits },
  };
}

export function buildInfoUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1/status/buildinfo`;
}

/**
 * Probe up to four unique Prometheus base URLs in parallel.
 * Probe failures are health inputs, not panel errors.
 */
export async function probePrometheus(
  baseUrls,
  { fetchJson, onRequest = null } = {},
) {
  const unique = [...new Set(baseUrls.filter(Boolean))].slice(0, 4);
  return Promise.all(
    unique.map(async (baseUrl) => {
      const started = Date.now();
      try {
        const result = await fetchJson(buildInfoUrl(baseUrl), {
          timeoutMs: 5000,
          maxBytes: 1024 * 1024,
          onRequest,
        });
        if (result.data?.status !== "success" || typeof result.data?.data !== "object") {
          throw new Error("Probe response envelope was not successful");
        }
        return {
          baseUrl,
          ok: true,
          version: typeof result.data.data.version === "string" ? result.data.data.version.slice(0, 128) : null,
          latencyMs: Date.now() - started,
          error: null,
        };
      } catch (error) {
        const message =
          error?.code === "E_TIMEOUT"
            ? "probe timed out"
            : error?.code === "E_HTTP"
              ? `probe returned HTTP ${error.status}`
              : error?.code === "E_NETWORK"
                ? "probe unreachable (network/CORS)"
                : error?.message || "probe failed";
        return {
          baseUrl,
          ok: false,
          version: null,
          latencyMs: Date.now() - started,
          error: String(message).slice(0, 300),
        };
      }
    }),
  );
}

export function healthMap(probed) {
  const map = new Map();
  for (const entry of probed) map.set(entry.baseUrl, entry);
  return map;
}
