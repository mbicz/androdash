const UNIT_MS = Object.freeze({
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
});

/**
 * Parse a Go/Perses duration (`1h30m`, `15m`, `250ms`).
 * Returns milliseconds, or null when the string is malformed.
 */
export function parseDuration(value) {
  if (value === 0 || value === "0") return 0;
  if (typeof value !== "string" || value.length === 0) return null;

  const re = /(\d+)(ms|s|m|h|d|w)/g;
  let total = 0;
  let cursor = 0;
  let match;
  while ((match = re.exec(value)) !== null) {
    if (match.index !== cursor) return null;
    total += Number(match[1]) * UNIT_MS[match[2]];
    cursor = re.lastIndex;
    if (!Number.isSafeInteger(total)) return null;
  }
  return cursor === value.length ? total : null;
}

/** Render milliseconds compactly for status lines and diagnostics. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms === 0) return "manual";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const units = [
    ["w", UNIT_MS.w],
    ["d", UNIT_MS.d],
    ["h", UNIT_MS.h],
    ["m", UNIT_MS.m],
    ["s", UNIT_MS.s],
  ];
  const parts = [];
  let rest = Math.round(ms);
  for (const [suffix, size] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count}${suffix}`);
      rest -= count * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join("") || "0s";
}

export const DURATION_UNITS = UNIT_MS;
