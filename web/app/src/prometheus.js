import { fetchJson } from "./fetch-json.js";

export class PrometheusError extends Error {
  constructor(code, message, detail = null, { status = null } = {}) {
    super(message);
    this.name = "PrometheusError";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).replace(/\/+$/, "");
}

export function stepFor(rangeSeconds, configured) {
  if (Number.isInteger(configured) && configured > 0) return configured;
  if (!Number.isFinite(rangeSeconds) || rangeSeconds <= 0) return 15;
  return Math.max(15, Math.ceil(rangeSeconds / 240));
}

export function buildRangeUrl(baseUrl, query, { startMs, endMs, stepSeconds }) {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("start", (startMs / 1000).toFixed(3));
  params.set("end", (endMs / 1000).toFixed(3));
  params.set("step", String(stepSeconds));
  params.set("timeout", "10s");
  return `${normalizeBaseUrl(baseUrl)}/api/v1/query_range?${params.toString()}`;
}

export function buildInstantUrl(baseUrl, query, timeMs) {
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("time", (timeMs / 1000).toFixed(3));
  params.set("timeout", "10s");
  return `${normalizeBaseUrl(baseUrl)}/api/v1/query?${params.toString()}`;
}

export function buildLabelValuesUrl(baseUrl, labelName, matchers = []) {
  const params = new URLSearchParams();
  for (const matcher of matchers.slice(0, 20)) {
    if (typeof matcher === "string") params.append("match[]", matcher);
  }
  const encodedLabel = encodeURIComponent(labelName);
  const suffix = params.toString();
  return `${normalizeBaseUrl(baseUrl)}/api/v1/label/${encodedLabel}/values${suffix ? `?${suffix}` : ""}`;
}

function parseSample(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLabels(metric) {
  if (!metric || typeof metric !== "object" || Array.isArray(metric)) return {};
  const labels = {};
  for (const [key, value] of Object.entries(metric)) {
    labels[String(key)] = String(value);
  }
  return labels;
}

export function seriesKey(labels, queryIndex = 0) {
  const parts = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${JSON.stringify(labels[key])}`);
  return `${parts.join(",")}|q${queryIndex}`;
}

export function seriesLabel(labels, { includeName = true } = {}) {
  const name = labels.__name__ || "";
  const rest = Object.keys(labels)
    .filter((key) => key !== "__name__")
    .sort()
    .map((key) => `${key}=${JSON.stringify(labels[key])}`);
  if (!includeName) return rest.join(", ") || name || "series";
  return `${name}${rest.length ? `{${rest.join(", ")}}` : ""}`;
}

export function seriesDisplayName(labels) {
  const name = labels.__name__ || "series";
  // A grouped panel labels each query with a synthetic `reading` value. The
  // value alone is the tile label; prefixing `reading=` on a 168px tile costs
  // a third of the width for nothing.
  if (typeof labels.reading === "string" && labels.reading.length > 0) {
    return labels.reading;
  }
  const important = [
    "mode",
    "code",
    "status",
    "handler",
    "path",
    "quantile",
    "direction",
    "engine",
    "stage",
    "state",
    "device",
    "counter",
    "gpu",
    "reason",
    "collector",
  ];
  const parts = important
    .filter((key) => labels[key] !== undefined)
    .map((key) => `${key}=${labels[key]}`);
  if (parts.length > 0) return parts.join(" · ");
  const fallback = Object.keys(labels)
    .filter((key) => !["__name__", "job", "instance"].includes(key))
    .sort()
    .slice(0, 2)
    .map((key) => `${key}=${labels[key]}`);
  return fallback.length ? `${name} · ${fallback.join(" · ")}` : name;
}

export const SERIES_COLORS = 8;

/**
 * Series colours are assigned by position within a panel, never by hashing
 * labels, so two series in one chart can never share a colour. The value is a
 * CSS variable: display modes (standard, AMOLED, monochrome, locked) restyle
 * charts without re-rendering them.
 */
export function seriesColor(index) {
  const slot = ((Number(index) || 0) % SERIES_COLORS + SERIES_COLORS) % SERIES_COLORS;
  return `var(--series-${slot})`;
}

function downsample(points, maxPoints, warnings) {
  if (points.length <= maxPoints) return points;
  const result = [];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i += 1) {
    result.push(points[Math.round(i * step)]);
  }
  warnings.push({
    code: "W_POINTS_TRUNCATED",
    message: `Series downsampled to ${maxPoints} points`,
    panelId: null,
    detail: null,
  });
  return result;
}

export function normalizeEnvelope(envelope, { maxSeries = 12, maxPoints = 600 } = {}) {
  if (!envelope || typeof envelope !== "object") {
    throw new PrometheusError("E_PROM_RESPONSE", "Prometheus response is not an object");
  }
  if (envelope.status === "error") {
    throw new PrometheusError(
      "E_PROM_QUERY",
      typeof envelope.error === "string" ? envelope.error : "Prometheus query failed",
      envelope.errorType ? String(envelope.errorType) : null,
    );
  }
  if (envelope.status !== "success" || !envelope.data || typeof envelope.data !== "object") {
    throw new PrometheusError("E_PROM_RESPONSE", "Prometheus response envelope is malformed");
  }
  const { resultType, result } = envelope.data;
  const warnings = [];
  let series = [];

  if (resultType === "matrix") {
    if (!Array.isArray(result)) {
      throw new PrometheusError("E_PROM_RESPONSE", "Prometheus matrix result is missing");
    }
    series = result
      .map((item) => {
        if (!item || typeof item !== "object" || !Array.isArray(item.values)) return null;
        const points = item.values
          .map((sample) => {
            if (!Array.isArray(sample) || sample.length < 2) return null;
            const t = Number(sample[0]);
            const v = parseSample(sample[1]);
            return Number.isFinite(t) ? { t, v } : null;
          })
          .filter(Boolean)
          .sort((a, b) => a.t - b.t);
        if (points.length === 0) return null;
        return {
          labels: normalizeLabels(item.metric),
          points: downsample(points, maxPoints, warnings),
        };
      })
      .filter(Boolean);
  } else if (resultType === "vector") {
    if (!Array.isArray(result)) {
      throw new PrometheusError("E_PROM_RESPONSE", "Prometheus vector result is missing");
    }
    series = result
      .map((item) => {
        if (!item || typeof item !== "object" || !Array.isArray(item.value) || item.value.length < 2) {
          return null;
        }
        const t = Number(item.value[0]);
        const v = parseSample(item.value[1]);
        if (!Number.isFinite(t)) return null;
        return {
          labels: normalizeLabels(item.metric),
          points: downsample([{ t, v }], maxPoints, warnings),
        };
      })
      .filter(Boolean);
  } else if (resultType === "scalar") {
    if (!Array.isArray(result) || result.length < 2) {
      throw new PrometheusError("E_PROM_RESPONSE", "Prometheus scalar result is malformed");
    }
    const t = Number(result[0]);
    const v = parseSample(result[1]);
    if (!Number.isFinite(t)) {
      throw new PrometheusError("E_PROM_RESPONSE", "Prometheus scalar timestamp is invalid");
    }
    series = [{ labels: {}, points: [{ t, v }] }];
  } else {
    throw new PrometheusError(
      "E_PROM_RESPONSE",
      `Unsupported Prometheus result type: ${String(resultType)}`,
    );
  }

  series.sort((a, b) => seriesKey(a.labels).localeCompare(seriesKey(b.labels)));
  if (series.length > maxSeries) {
    series = series.slice(0, maxSeries);
    warnings.push({
      code: "W_SERIES_TRUNCATED",
      message: `Panel kept the first ${maxSeries} series`,
      panelId: null,
      detail: null,
    });
  }
  return { series, warnings, resultType };
}

function mapFetchError(error, baseUrl) {
  if (error?.code === "E_TIMEOUT" || error?.code === "ABORTED") {
    return new PrometheusError(
      "E_PROM_NETWORK",
      error.code === "E_TIMEOUT" ? "Prometheus timed out" : "Prometheus request was cancelled",
      baseUrl,
    );
  }
  if (error?.code === "E_NETWORK") {
    return new PrometheusError(
      "E_PROM_NETWORK",
      "Prometheus unreachable; check network, CORS, and cleartext HTTP",
      baseUrl,
    );
  }
  if (error?.code === "E_HTTP") {
    return new PrometheusError(
      "E_PROM_HTTP",
      `Prometheus returned HTTP ${error.status}`,
      error.body || null,
      { status: error.status },
    );
  }
  if (error?.code === "E_PARSE" || error?.code === "E_SIZE") {
    return new PrometheusError("E_PROM_RESPONSE", "Prometheus returned an unreadable response", error.message);
  }
  return new PrometheusError("E_PROM_NETWORK", error?.message || "Prometheus request failed", baseUrl);
}

async function request(url, baseUrl, { signal, onRequest }) {
  try {
    return await fetchJson(url, { timeoutMs: 10_000, maxBytes: 5 * 1024 * 1024, signal, onRequest });
  } catch (error) {
    throw mapFetchError(error, baseUrl);
  }
}

export async function queryRange(
  baseUrl,
  query,
  { startMs, endMs, stepSeconds, signal, onRequest, maxSeries = 12 },
) {
  const url = buildRangeUrl(baseUrl, query, { startMs, endMs, stepSeconds });
  const result = await request(url, baseUrl, { signal, onRequest });
  try {
    return normalizeEnvelope(result.data, { maxSeries });
  } catch (error) {
    if (error instanceof PrometheusError) throw error;
    throw new PrometheusError("E_PROM_RESPONSE", "Prometheus response could not be normalized", error.message);
  }
}

export async function queryInstant(
  baseUrl,
  query,
  { timeMs, signal, onRequest, maxSeries = 12 },
) {
  const url = buildInstantUrl(baseUrl, query, timeMs);
  const result = await request(url, baseUrl, { signal, onRequest });
  try {
    return normalizeEnvelope(result.data, { maxSeries, maxPoints: 1 });
  } catch (error) {
    if (error instanceof PrometheusError) throw error;
    throw new PrometheusError("E_PROM_RESPONSE", "Prometheus response could not be normalized", error.message);
  }
}

export async function labelValues(baseUrl, labelName, matchers, { signal, onRequest } = {}) {
  const result = await request(buildLabelValuesUrl(baseUrl, labelName, matchers), baseUrl, {
    signal,
    onRequest,
  });
  if (result.data?.status !== "success" || !Array.isArray(result.data.data)) {
    throw new PrometheusError("E_PROM_RESPONSE", "Prometheus label values response is malformed");
  }
  return result.data.data.map(String);
}
