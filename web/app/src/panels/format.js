const UNITS = new Set([
  "none",
  "percent",
  "bytes",
  "decbytes",
  "seconds",
  "milliseconds",
  "short",
  "watts",
  "celsius",
  "hertz",
  "bits",
  "tokens",
]);

function decimalsFor(value, requested) {
  if (Number.isInteger(requested) && requested >= 0 && requested <= 4) return requested;
  return Number.isInteger(value) ? 0 : 2;
}

function fixed(value, decimals) {
  return Number(value).toFixed(decimals);
}

function stripZero(value) {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

export function isSupportedUnit(unit) {
  return unit === undefined || unit === null || UNITS.has(unit);
}

export function formatValue(value, format = {}, { warn = null } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  const unit = format?.unit ?? "none";
  const decimals = decimalsFor(number, format?.decimalPlaces);

  if (!UNITS.has(unit)) {
    warn?.("W_UNIT_UNKNOWN", `Unknown unit ${unit}; showing the raw value`, null, unit);
    return fixed(number, decimals);
  }

  if (unit === "percent") return `${fixed(number, decimals)}%`;
  if (unit === "bytes") return formatBytes(number, 1024, ["B", "KiB", "MiB", "GiB", "TiB"]);
  if (unit === "decbytes") return formatBytes(number, 1000, ["B", "KB", "MB", "GB", "TB"]);
  if (unit === "seconds") return `${fixed(number, decimals)} s`;
  if (unit === "milliseconds") return `${fixed(number, decimals)} ms`;
  if (unit === "watts") return formatScaled(number, 1000, ["W", "kW", "MW"]);
  if (unit === "celsius") return `${fixed(number, decimals)} °C`;
  if (unit === "hertz") return formatScaled(number, 1000, ["Hz", "kHz", "MHz", "GHz", "THz"]);
  if (unit === "bits") return formatScaled(number, 1000, ["b/s", "Kb/s", "Mb/s", "Gb/s", "Tb/s"]);
  if (unit === "tokens") return `${formatShort(number)} tok/s`;
  if (unit === "short") return formatShort(number);
  return fixed(number, decimals);
}

function formatScaled(value, base, units) {
  let number = value;
  let index = 0;
  while (Math.abs(number) >= base && index < units.length - 1) {
    number /= base;
    index += 1;
  }
  const decimals =
    index === 0
      ? Math.abs(number) >= 100
        ? 0
        : Math.abs(number) >= 10
          ? 1
          : 2
      : Math.abs(number) >= 10
        ? 1
        : 2;
  return `${stripZero(number.toFixed(decimals))} ${units[index]}`;
}

function formatBytes(value, base, units) {
  let number = value;
  let index = 0;
  while (Math.abs(number) >= base && index < units.length - 1) {
    number /= base;
    index += 1;
  }
  const decimals = index === 0 ? 0 : Math.abs(number) >= 10 ? 1 : 2;
  return `${stripZero(number.toFixed(decimals))} ${units[index]}`;
}

export function formatShort(value) {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${stripZero((abs / 1e12).toFixed(1))}T`;
  if (abs >= 1e9) return `${sign}${stripZero((abs / 1e9).toFixed(1))}B`;
  if (abs >= 1e6) return `${sign}${stripZero((abs / 1e6).toFixed(1))}M`;
  if (abs >= 1e3) return `${sign}${stripZero((abs / 1e3).toFixed(1))}K`;
  return `${sign}${stripZero(abs.toFixed(abs >= 100 ? 0 : 1))}`;
}

export function formatAxis(value, format = {}) {
  const unit = format?.unit ?? "none";
  if (unit === "short") return formatShort(value);
  if (unit === "percent") return `${stripZero(value.toFixed(0))}%`;
  if (unit === "bytes" || unit === "decbytes") {
    return formatValue(value, { ...format, decimalPlaces: 1 });
  }
  if (unit === "watts" || unit === "celsius" || unit === "hertz" || unit === "bits" || unit === "tokens") {
    return formatValue(value, {
      ...format,
      decimalPlaces: Math.abs(value) >= 10 ? 0 : 1,
    });
  }
  if (Math.abs(value) >= 1e6 || (Math.abs(value) < 0.01 && value !== 0)) {
    return formatShort(value);
  }
  return stripZero(value.toFixed(Math.abs(value) >= 10 ? 0 : 1));
}

export function calculations(series, calculation = "last-number", { warn = null } = {}) {
  const known = new Set(["last-number", "first-number", "mean", "sum", "min", "max", "count"]);
  let mode = calculation;
  if (!known.has(mode)) {
    warn?.("W_CALCULATION_UNKNOWN", `Unknown calculation ${mode}; using last-number`, null, mode);
    mode = "last-number";
  }
  const values = (series?.points || []).map((point) => point.v).filter((value) => value !== null);
  if (mode === "count") return values.length;
  if (values.length === 0) return null;
  if (mode === "first-number") return values[0];
  if (mode === "mean") return values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mode === "sum") return values.reduce((sum, value) => sum + value, 0);
  if (mode === "min") return Math.min(...values);
  if (mode === "max") return Math.max(...values);
  return values[values.length - 1];
}

export function sortedThresholds(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((step) => step && Number.isFinite(Number(step.value)))
    .map((step) => ({ value: Number(step.value), name: typeof step.name === "string" ? step.name : null }))
    .sort((a, b) => a.value - b.value);
}

export function thresholdState(value, steps) {
  const sorted = sortedThresholds(steps);
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return { state: "muted", label: "No data" };
  }
  const number = Number(value);
  if (sorted.length === 0) return { state: "ok", label: "Nominal" };
  if (sorted.length === 1) {
    return number >= sorted[0].value
      ? { state: "crit", label: sorted[0].name || "Critical" }
      : { state: "ok", label: "Nominal" };
  }
  if (number >= sorted[1].value) {
    return { state: "crit", label: sorted[1].name || "Critical" };
  }
  if (number >= sorted[0].value) {
    return { state: "warn", label: sorted[0].name || "Warning" };
  }
  return { state: "ok", label: "Nominal" };
}

export function formatSeriesValue(series, format = {}, warn = null) {
  const value = series?.points?.length ? series.points[series.points.length - 1].v : null;
  return formatValue(value, format, { warn });
}
