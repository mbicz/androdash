export class FetchError extends Error {
  constructor(message, { code = "E_NETWORK", status = null, url = null, body = null, cause = null } = {}) {
    super(message);
    this.name = "FetchError";
    this.code = code;
    this.status = status;
    this.url = url;
    this.body = body;
    this.cause = cause;
  }
}

function isAbort(error) {
  return error?.name === "AbortError" || error?.code === 20;
}

/**
 * A small fetch wrapper with timeout, size and JSON error handling.
 * One controller is used for both the caller's signal and the timeout.
 */
export async function fetchJson(
  url,
  {
    timeoutMs = 10_000,
    maxBytes = 5 * 1024 * 1024,
    signal = null,
    accept = "application/json",
    onRequest = null,
  } = {},
) {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;

  const onCallerAbort = () => {
    callerAborted = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: accept },
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
    if (callerAborted) {
      throw new FetchError("Request cancelled", { code: "ABORTED", url });
    }
    if (timedOut || isAbort(error)) {
      throw new FetchError("Request timed out", { code: "E_TIMEOUT", url, cause: error });
    }
    throw new FetchError(
      "Network request failed (reachability or CORS)",
      { code: "E_NETWORK", url, cause: error },
    );
  }

  clearTimeout(timer);
  signal?.removeEventListener("abort", onCallerAbort);

  let text;
  try {
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > maxBytes) {
      throw new FetchError("Response is too large", {
        code: "E_SIZE",
        status: response.status,
        url: response.url,
      });
    }
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new FetchError("Response is too large", {
        code: "E_SIZE",
        status: response.status,
        url: response.url,
      });
    }
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError("Could not read response body", {
      code: "E_NETWORK",
      status: response.status,
      url: response.url,
      cause: error,
    });
  }

  const durationMs = Date.now() - started;
  onRequest?.({
    method: "GET",
    url: response.url || url,
    status: response.status,
    durationMs,
    at: Date.now(),
  });

  if (!response.ok) {
    const body = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new FetchError(`HTTP ${response.status}`, {
      code: "E_HTTP",
      status: response.status,
      url: response.url || url,
      body,
    });
  }

  try {
    return {
      data: JSON.parse(text),
      response,
      url: response.url || url,
      bytes: text.length,
      durationMs,
    };
  } catch (error) {
    throw new FetchError("Response is not valid JSON", {
      code: "E_PARSE",
      status: response.status,
      url: response.url || url,
      cause: error,
    });
  }
}
