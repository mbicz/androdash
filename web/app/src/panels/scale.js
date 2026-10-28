/**
 * Axis scales that land on numbers and times a person would choose: 0, 5, 10;
 * 20:30, 20:35, 20:40. C-005 "Axes".
 */

const BINARY_UNITS = new Set(["bytes"]);

function niceStep(rawStep) {
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const fraction = rawStep / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * Round value ticks covering [min, max] with at most `maxTicks` intervals.
 * Byte axes step in powers of 1024 so labels read 512 MiB, 1 GiB, 1.5 GiB.
 * Returns { min, max, ticks }, where min/max are the extended domain.
 */
export function niceTicks(min, max, maxTicks = 4, unit = "none") {
  let lo = Number(min);
  let hi = Number(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, ticks: [0, 1] };
  if (lo > hi) [lo, hi] = [hi, lo];
  const nonNegative = lo >= 0;
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.5;
    lo = nonNegative ? Math.max(0, lo - pad) : lo - pad;
    hi += pad;
  }
  let scale = 1;
  if (BINARY_UNITS.has(unit)) {
    const magnitude = Math.max(Math.abs(lo), Math.abs(hi));
    while (magnitude / scale >= 1024) scale *= 1024;
  }
  const intervals = Math.max(1, Math.floor(maxTicks));
  const step = niceStep((hi - lo) / scale / intervals) * scale;
  const start = Math.floor(lo / step + 1e-9) * step;
  const end = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let value = start; value <= end + step * 1e-6; value += step) {
    ticks.push(Math.abs(value) < step * 1e-9 ? 0 : Number(value.toPrecision(12)));
  }
  return { min: start, max: end, ticks };
}

const TIME_STEPS = [
  1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800,
  3600, 7200, 10800, 21600, 43200,
  86400, 172800, 604800,
];

/**
 * Round time ticks (seconds) inside [start, end]: at most `maxTicks` ticks,
 * aligned to local wall-clock boundaries (a 6 h step falls on 00:00, 06:00).
 */
export function timeTicks(start, end, maxTicks = 4, offsetSeconds = null) {
  const span = Math.max(1, end - start);
  const limit = Math.max(2, Math.floor(maxTicks));
  const offset =
    offsetSeconds ?? -new Date(start * 1000).getTimezoneOffset() * 60;
  const ticksFor = (step) => {
    const ticks = [];
    for (let t = Math.ceil((start + offset) / step) * step - offset; t <= end; t += step) ticks.push(t);
    return ticks;
  };
  let index = TIME_STEPS.findIndex((candidate) => span / candidate <= limit);
  if (index < 0) index = TIME_STEPS.length - 1;
  let ticks = ticksFor(TIME_STEPS[index]);
  // A round step can land only once in the window; take the next finer step
  // rather than leave the axis with a single time.
  if (ticks.length < 2 && index > 0 && ticksFor(TIME_STEPS[index - 1]).length <= limit + 1) {
    index -= 1;
    ticks = ticksFor(TIME_STEPS[index]);
  }
  return { step: TIME_STEPS[index], ticks };
}

/**
 * Label for a time tick, as short as the step allows. `compact` drops the
 * AM/PM marker for narrow plots; the header clock carries it.
 */
export function timeTickLabel(seconds, step, span, { compact = false } = {}) {
  const date = new Date(seconds * 1000);
  if (step >= 86400) {
    return date.toLocaleDateString([], span > 7 * 86400 ? { month: "short", day: "numeric" } : { weekday: "short" });
  }
  const parts = new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
    ...(step < 60 ? { second: "2-digit" } : {}),
  }).formatToParts(date);
  const time = parts
    .filter((part) => !compact || part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim();
  if (span > 86400 && date.getHours() === 0 && date.getMinutes() === 0) {
    return date.toLocaleDateString([], { weekday: "short" });
  }
  return time;
}
