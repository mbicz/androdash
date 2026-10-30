/**
 * On-phone collector scrape targets (C-001 `collector_targets`). Mirrors the
 * shell's `CollectorConfig.parseTarget`/`canonicalTargets` so the settings
 * sheet can reject bad input before asking the shell to persist it.
 *
 * Entry grammar: `[job:]instance=host:port` or `host:port`. `job` defaults to
 * `node`, `instance` to the address. The host is a DNS name, an IPv4 address,
 * or a bracketed IPv6 address; the port is 1–65535.
 */

export const DEFAULT_JOB = "node";
export const MAX_TARGETS = 32;

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4_LIKE = /^[0-9.]+$/;
const PORT = /^[1-9][0-9]{0,4}$/;
const HEX_GROUP = /^[0-9A-Fa-f]{1,4}$/;
const MAX_HOST = 253;

/** Parse one target entry into `{job, instance, address}`; throws on invalid input. */
export function parseTarget(entry) {
  const text = String(entry ?? "").trim();
  const equals = text.indexOf("=");
  if (equals < 0) {
    const address = validateAddress(text);
    return { job: DEFAULT_JOB, instance: address, address };
  }
  const labels = text.slice(0, equals);
  const address = validateAddress(text.slice(equals + 1));
  const colon = labels.indexOf(":");
  const job = colon < 0 ? DEFAULT_JOB : labels.slice(0, colon);
  const instance = colon < 0 ? labels : labels.slice(colon + 1);
  if (!NAME.test(job)) throw new Error("Job must be 1–64 letters, digits, _ . or -");
  if (!NAME.test(instance)) throw new Error("Name must be 1–64 letters, digits, _ . or -");
  return { job, instance, address };
}

/** Canonical entry text, as the shell stores it. */
export function formatTarget({ job, instance, address }) {
  return job === DEFAULT_JOB && instance === address ? address : `${job}:${instance}=${address}`;
}

/** Identity of a target: Prometheus `job` + `instance`. */
export function targetKey({ job, instance }) {
  return `${job}\u0000${instance}`;
}

function validateAddress(address) {
  let host;
  let port;
  if (address.startsWith("[")) {
    const close = address.indexOf("]:");
    if (close < 0 || !isIpv6(address.slice(1, close))) throw new Error("Invalid IPv6 address");
    host = address.slice(0, close + 1);
    port = address.slice(close + 2);
  } else {
    const colon = address.lastIndexOf(":");
    if (colon <= 0) throw new Error("Address must be host:port");
    host = address.slice(0, colon);
    port = address.slice(colon + 1);
    if (!isHostName(host)) throw new Error("Invalid host");
  }
  const number = PORT.test(port) ? Number(port) : 0;
  if (number < 1 || number > 65535) throw new Error("Port must be 1–65535");
  return `${host}:${port}`;
}

function isHostName(host) {
  if (host.length === 0 || host.length > MAX_HOST) return false;
  if (IPV4_LIKE.test(host)) return isIpv4(host);
  return host.split(".").every((label) => DNS_LABEL.test(label));
}

function isIpv4(text) {
  const parts = text.split(".");
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        /^[0-9]{1,3}$/.test(part) && (part.length === 1 || part[0] !== "0") && Number(part) <= 255,
    )
  );
}

function isIpv6(text) {
  if (text.length === 0 || text.length > 45) return false;
  let body = text;
  const lastColon = body.lastIndexOf(":");
  if (lastColon < 0) return false;
  const tail = body.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIpv4(tail)) return false;
    body = `${body.slice(0, lastColon + 1)}0:0`;
  }
  const gap = body.indexOf("::");
  if (gap < 0) {
    const groups = body.split(":");
    return groups.length === 8 && groups.every((group) => HEX_GROUP.test(group));
  }
  if (body.indexOf("::", gap + 1) >= 0) return false;
  const leftText = body.slice(0, gap);
  const rightText = body.slice(gap + 2);
  const left = leftText === "" ? [] : leftText.split(":");
  const right = rightText === "" ? [] : rightText.split(":");
  return [...left, ...right].every((group) => HEX_GROUP.test(group)) && left.length + right.length <= 7;
}
