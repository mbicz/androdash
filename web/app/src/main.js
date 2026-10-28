import { ConfigError, parseConfig } from "./config.js";
import { loadDashboard } from "./dashboard/load.js";
import {
  DashboardError,
  collectPrometheusBaseUrls,
  resolveVariables,
} from "./dashboard/normalize.js";
import { parseDuration, formatDuration } from "./dashboard/duration.js";
import {
  capabilityDocument,
  probePrometheus,
  resolveAdvertisedCapabilities,
} from "./capabilities.js";
import { fetchJson } from "./fetch-json.js";
import { filterDashboard } from "./eligibility.js";
import {
  DiagnosticsStore,
  deriveStatus,
  iso,
  redactConfig,
  redactUrl,
  statusLabel,
} from "./diagnostics.js";
import { renderRows, resolveLayoutMode } from "./layout.js";
import { renderPanelBody } from "./panels/index.js";
import { labelValues as prometheusLabelValues, queryInstant, queryRange, stepFor } from "./prometheus.js";
import { Scheduler } from "./scheduler.js";

const app = document.getElementById("app");
const toastEl = document.getElementById("toast");

const state = {
  config: null,
  diagnostics: null,
  dashboard: null,
  filtered: null,
  advertised: [],
  capabilityInfo: null,
  probes: [],
  variables: new Map(),
  scheduler: null,
  statusTicker: null,
  panelElements: new Map(),
  lastSeries: new Map(),
  panelErrors: new Map(),
  hasLastGood: false,
  lastRefresh: null,
  phase: "loading",
  fatal: false,
  currentAbort: null,
  rangeMs: 3600000,
  intervalSeconds: 30,
  mode: "stack",
  statusBar: null,
  statusStateEl: null,
  statusDetailEl: null,
  liveChip: null,
  liveChipText: null,
  debugOverlay: null,
};

let toastTimer = null;

function bridge() {
  return window.AndroDash || null;
}

function bridgeLog(level, message) {
  try {
    const target = bridge();
    if (target?.log) target.log(String(level).slice(0, 16), String(message).slice(0, 300));
  } catch {
    // Browser dev has no bridge; never let logging fail a render.
  }
}

function warn(code, message, panelId = null, detail = null) {
  state.diagnostics?.warn(code, message, panelId, detail);
}

function recordError(code, message, panelId = null, detail = null) {
  state.diagnostics?.error(code, message, panelId, detail);
}

function recordRequest(request) {
  state.diagnostics?.request(request);
}

function safeText(value, limit = 300) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function safeDetail(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value);
  if (/^https?:\/\//i.test(text)) return redactUrl(text);
  return safeText(text, 500);
}

function formatClock(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatClockShort(ms) {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCountdown(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${minutes}m ${rest.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}

function refreshLabel(seconds) {
  return seconds === 0 ? "Manual" : `Every ${formatDuration(seconds * 1000)}`;
}

function makeIcon(pathData, viewBox = "0 0 24 24") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

function makeButton(label, { className = "icon-button", icon = null, onClick = null } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  if (icon) button.append(icon);
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
    toastTimer = null;
  }, 2600);
}

function bootFatal(error, isConfig = false) {
  state.fatal = true;
  if (state.scheduler) state.scheduler.stop();
  if (state.statusTicker) {
    clearInterval(state.statusTicker);
    state.statusTicker = null;
  }
  const code = error?.code || (isConfig ? "E_CONFIG" : "E_INTERNAL");
  const message =
    error?.message ||
    (isConfig ? "The launch configuration is invalid" : "The renderer could not start");
  const detail = safeDetail(error?.detail);

  const card = document.createElement("div");
  card.className = "fatal-card";
  card.setAttribute("role", "alert");
  const mark = document.createElement("div");
  mark.className = "brand-mark brand-mark-large";
  const eyebrow = document.createElement("p");
  eyebrow.className = "fatal-eyebrow";
  eyebrow.textContent = "AndroDash";
  const heading = document.createElement("h1");
  heading.textContent = "Cannot start";
  const codeEl = document.createElement("div");
  codeEl.className = "fatal-code";
  codeEl.textContent = code;
  const messageEl = document.createElement("p");
  messageEl.className = "fatal-message";
  messageEl.textContent = message;
  const command = document.createElement("pre");
  command.className = "fatal-command";
  command.textContent =
    'adb shell am start -n com.mbicz.androdash/.MainActivity \\\n  --es dashboard_url "https://example.com/dashboard.json" \\\n  --es prometheus_url "https://prometheus.example.com"';
  const actions = document.createElement("div");
  actions.className = "fatal-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "button primary";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => window.location.reload());
  actions.append(retry);
  card.append(mark, eyebrow, heading, codeEl, messageEl);
  if (detail) {
    const detailEl = document.createElement("p");
    detailEl.className = "fatal-message";
    detailEl.textContent = detail;
    card.append(detailEl);
  }
  card.append(command, actions);

  const screen = document.createElement("div");
  screen.className = "fatal-screen";
  screen.append(card);
  app.replaceChildren(screen);
  app.setAttribute("aria-busy", "false");
  document.title = "Cannot start · AndroDash";
  if (state.diagnostics) recordError(code, message, null, detail);
  bridgeLog("error", `${code}: ${message}`);
}

async function loadApp() {
  if (state.scheduler) {
    state.scheduler.stop();
    state.scheduler = null;
  }
  if (state.statusTicker) {
    clearInterval(state.statusTicker);
    state.statusTicker = null;
  }
  state.currentAbort?.abort();
  state.currentAbort = null;
  state.fatal = false;
  state.phase = "loading";
  state.hasLastGood = false;
  state.lastRefresh = null;
  state.panelErrors = new Map();
  state.lastSeries = new Map();
  state.panelElements = new Map();
  state.filtered = null;
  state.diagnostics?.setLastRefresh(null);
  state.diagnostics?.setNextRefreshAt(null);
  state.diagnostics?.setDashboard(null);
  app.setAttribute("aria-busy", "true");
  updateStatus();

  const dashboard = await loadDashboard(state.config, {
    onRequest: recordRequest,
    warn,
  });
  state.dashboard = dashboard;
  state.rangeMs = state.config.timeRange
    ? parseDuration(state.config.timeRange)
    : dashboard.durationMs;
  state.intervalSeconds =
    state.config.refreshSeconds ?? dashboard.refreshSeconds ?? 30;

  const capabilityInfo = resolveAdvertisedCapabilities(state.config);
  state.capabilityInfo = capabilityInfo;
  state.advertised = capabilityInfo.advertised;
  for (const id of capabilityInfo.unknown) {
    warn("W_CAPABILITY_UNKNOWN", `Unknown advertised capability ${id}`, null, id);
  }

  const baseUrls = collectPrometheusBaseUrls(dashboard, state.config);
  state.probes =
    baseUrls.length > 0 && state.advertised.includes("prometheus")
      ? await probePrometheus(baseUrls, { fetchJson, onRequest: recordRequest })
      : [];

  state.variables = await resolveVariables(dashboard, {
    config: state.config,
    advertisedCapabilities: state.advertised,
    labelValues: ({ baseUrl, labelName, matchers }) =>
      prometheusLabelValues(baseUrl, labelName, matchers, { onRequest: recordRequest }),
    warn,
  });

  state.filtered = filterDashboard(dashboard, {
    config: state.config,
    advertised: state.advertised,
    variables: state.variables,
    probes: state.probes,
    warn,
  });

  state.diagnostics.setCapabilities({
    advertised: state.advertised,
    unknown: capabilityInfo.unknown,
    probed: state.probes.map((probe) => ({
      baseUrl: redactUrl(probe.baseUrl),
      ok: probe.ok,
      version: probe.version,
      latencyMs: probe.latencyMs,
      error: probe.error,
    })),
  });
  state.diagnostics.setDashboard({
    url: redactUrl(dashboard.url),
    name: dashboard.name,
    duration: dashboard.durationText,
    refreshInterval: dashboard.refreshText,
    panelsTotal: dashboard.panelsTotal,
    rowsTotal: dashboard.rowsTotal,
  });
  state.diagnostics.setPanels({
    ...state.filtered.counts,
    errors: 0,
  });
  state.mode = resolveLayoutMode(state.config.layoutMode, window.innerWidth);
  renderDashboard();
  installScheduler();
  updateStatus();
}

function installScheduler() {
  state.scheduler = new Scheduler({
    intervalSeconds: state.intervalSeconds,
    run: runCycle,
    onState: () => {
      syncDiagnostics();
      updateStatus();
    },
  });
  state.scheduler.start();
  if (state.statusTicker) clearInterval(state.statusTicker);
  state.statusTicker = setInterval(updateStatus, 1000);
}

function renderDashboard() {
  const header = createHeader();
  const main = document.createElement("main");
  main.className = "rows";
  main.setAttribute("aria-label", state.dashboard.title);
  const rows = renderRows(state.filtered.rows, {
    mode: state.mode,
    createPanel: createPanel,
  });
  main.append(rows);
  if (state.filtered.rows.length === 0) {
    main.append(createNoPanels());
  }

  const status = createStatusBar();
  state.statusBar = status;
  app.replaceChildren(header, main, status);
  app.dataset.layoutMode = state.mode;
  app.setAttribute("aria-busy", "false");
  document.title = `${state.dashboard.title} · AndroDash`;

  for (const entry of state.filtered.visible.values()) {
    if (entry.panel.panelKind === "Markdown") renderMarkdownPanel(entry.panel.id);
  }
  updateStatus();
}

function createHeader() {
  const header = document.createElement("header");
  header.className = "app-header";

  const brand = document.createElement("div");
  brand.className = "brand";
  const mark = document.createElement("div");
  mark.className = "brand-mark";
  mark.setAttribute("aria-hidden", "true");
  const wordmark = document.createElement("span");
  wordmark.textContent = "AndroDash";
  brand.append(mark, wordmark);

  const main = document.createElement("div");
  main.className = "header-main";
  const title = document.createElement("h1");
  title.textContent = state.dashboard.title;
  main.append(title);
  const description = document.createElement("p");
  description.textContent =
    state.dashboard.description ||
    `${state.filtered.counts.rendered} panels · ${state.dashboard.name}`;
  main.append(description);

  const meta = document.createElement("div");
  meta.className = "header-meta";
  const duration = document.createElement("span");
  duration.className = "chip";
  duration.textContent = `Last ${formatDuration(state.rangeMs)}`;
  const refresh = document.createElement("span");
  refresh.className = "chip";
  refresh.textContent = refreshLabel(state.intervalSeconds);
  const live = document.createElement("span");
  live.className = "chip";
  const dot = document.createElement("span");
  dot.className = "live-dot";
  const liveText = document.createElement("span");
  liveText.textContent = "Loading";
  live.append(dot, liveText);
  meta.append(duration, refresh, live);
  state.liveChip = live;
  state.liveChipText = liveText;

  header.append(brand, main, meta);
  return header;
}

function createStatusBar() {
  const bar = document.createElement("footer");
  bar.className = "status-bar";
  bar.id = "status-bar";
  bar.dataset.status = "loading";
  bar.setAttribute("aria-live", "polite");
  bar.setAttribute("aria-label", "Dashboard status");

  const stateEl = document.createElement("span");
  stateEl.className = "status-state";
  const dot = document.createElement("span");
  dot.className = "live-dot";
  const stateText = document.createElement("span");
  stateText.textContent = "Loading";
  stateEl.append(dot, stateText);
  const detail = document.createElement("span");
  detail.className = "status-detail";
  detail.textContent = "Contacting dashboard and metrics";

  const actions = document.createElement("div");
  actions.className = "status-actions";
  const refresh = makeButton("Refresh now", {
    icon: makeIcon("M20 11a8.1 8.1 0 0 0-14.9-4.6L3 9m0 0V4m0 5h5M4 13a8.1 8.1 0 0 0 14.9 4.6L21 15m0 0v5m0-5h-5"),
    onClick: () => {
      state.scheduler?.refresh("manual");
    },
  });
  actions.append(refresh);
  if (state.config.debug) {
    const debug = makeButton("Open diagnostics", {
      icon: makeIcon("M12 7h.01M12 11v6M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"),
      onClick: openDebug,
    });
    actions.append(debug);
  }
  bar.append(stateEl, detail, actions);
  state.statusStateEl = stateText;
  state.statusDetailEl = detail;
  return bar;
}

function createPanel(item) {
  if (item.state === "unsupported") return createUnsupportedPanel(item);
  return createPanelShell(item.panel);
}

function registerPanelElement(panelId, section) {
  const list = state.panelElements.get(panelId) || [];
  list.push(section);
  state.panelElements.set(panelId, list);
}

function createPanelShell(panel) {
  const section = document.createElement("section");
  section.className = "panel";
  section.dataset.panelId = panel.id;
  section.dataset.panelKind = panel.panelKind;
  section.dataset.panelState = "loading";
  section.setAttribute("aria-label", panel.description ? `${panel.title}: ${panel.description}` : panel.title);
  section.setAttribute("aria-busy", "true");

  const header = document.createElement("header");
  header.className = "panel-header";
  const heading = document.createElement("div");
  heading.className = "panel-heading";
  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = panel.title;
  heading.append(title);
  const description = document.createElement("p");
  description.className = "panel-description";
  description.textContent = panel.description || "";
  heading.append(description);
  const badge = document.createElement("span");
  badge.className = "panel-badge";
  badge.textContent = "Loading";
  header.append(heading, badge);

  const body = document.createElement("div");
  body.className = "panel-body";
  const skeleton = document.createElement("div");
  skeleton.className = "skeleton";
  for (const className of ["skeleton-line", "skeleton-line", "skeleton-block"]) {
    const line = document.createElement("div");
    line.className = className;
    skeleton.append(line);
  }
  body.append(skeleton);
  section.append(header, body);
  registerPanelElement(panel.id, section);
  return section;
}

function createUnsupportedPanel(item) {
  const section = document.createElement("section");
  section.className = "panel panel-placeholder";
  section.dataset.panelId = item.panel.id;
  section.dataset.panelKind = item.panel.panelKind;
  section.dataset.panelState = "unsupported";
  section.setAttribute("aria-label", `${item.panel.title}: hidden, ${item.hidden.reason}`);
  const header = document.createElement("header");
  header.className = "panel-header";
  const heading = document.createElement("div");
  heading.className = "panel-heading";
  const title = document.createElement("h2");
  title.className = "panel-title";
  title.textContent = item.panel.title;
  heading.append(title);
  const badge = document.createElement("span");
  badge.className = "panel-badge";
  badge.textContent = "Hidden";
  header.append(heading, badge);
  const body = document.createElement("div");
  body.className = "panel-body";
  const content = document.createElement("div");
  content.className = "unsupported-content";
  const reason = document.createElement("span");
  reason.className = "unsupported-reason";
  reason.textContent = item.hidden.reason;
  const detail = document.createElement("p");
  detail.className = "panel-error-message";
  detail.textContent = item.hidden.detail || "This panel needs a capability this renderer does not advertise.";
  content.append(reason, detail);
  body.append(content);
  section.append(header, body);
  return section;
}

function createNoPanels() {
  const empty = document.createElement("div");
  empty.className = "empty-dashboard";
  const title = document.createElement("h2");
  title.textContent = "No supported panels";
  const text = document.createElement("p");
  text.textContent = "Every panel was filtered out by capability or datasource checks. Open diagnostics for the reasons.";
  empty.append(title, text);
  return empty;
}

function panelElements(panelId) {
  return state.panelElements.get(panelId) || [];
}

/**
 * Content-box size of a panel body in CSS pixels. Renderers that draw SVG use
 * it so their viewBox matches the real box and text keeps its CSS size.
 */
function panelBodySize(body) {
  if (!body || typeof body.getBoundingClientRect !== "function") return null;
  const rect = body.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const style = typeof window.getComputedStyle === "function" ? window.getComputedStyle(body) : null;
  const padX = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0;
  const padY = style ? parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) : 0;
  const width = rect.width - (Number.isFinite(padX) ? padX : 0);
  const height = rect.height - (Number.isFinite(padY) ? padY : 0);
  if (!(width > 0) || !(height > 0)) return null;
  return { width: Math.round(width), height: Math.round(height) };
}

function renderMarkdownPanel(panelId) {
  const panel = state.dashboard.panels.get(panelId);
  if (!panel) return;
  for (const section of panelElements(panelId)) {
    try {
      const body = renderPanelBody(panel, [], {
        warn: (code, message, _panelId, detail) => warn(code, message, panelId, detail),
        displayMode: state.config.displayMode,
      });
      const empty = body.dataset.empty === "true";
      section.querySelector(".panel-body").replaceChildren(body);
      section.dataset.panelState = empty ? "empty" : "ready";
      section.setAttribute("aria-busy", "false");
      section.querySelector(".panel-badge").textContent = empty ? "No data" : "Static";
    } catch (error) {
      showRenderError(section, panel, error);
    }
  }
}

function setPanelSubtitle(section, panel, text, stale = false) {
  const description = section.querySelector(".panel-description");
  if (!description) return;
  description.textContent = text || panel.description || "";
  description.classList.toggle("is-stale", stale);
}

function applyDataPanel(panelId, series, staleError = null) {
  const panel = state.dashboard.panels.get(panelId);
  if (!panel) return;
  for (const section of panelElements(panelId)) {
    const body = section.querySelector(".panel-body");
    try {
      const content = renderPanelBody(panel, series, {
        warn: (code, message, _panelId, detail) => warn(code, message, panelId, detail),
        displayMode: state.config.displayMode,
        size: panelBodySize(body),
      });
      if (!content) throw new Error(`No renderer for ${panel.panelKind}`);
      const empty = content.dataset.empty === "true";
      body.replaceChildren(content);
      if (staleError) {
        section.dataset.panelState = "stale";
        section.querySelector(".panel-badge").textContent = "Stale";
        setPanelSubtitle(
          section,
          panel,
          `${staleError.code} · showing last good data`,
          true,
        );
      } else {
        section.dataset.panelState = empty ? "empty" : "ready";
        section.querySelector(".panel-badge").textContent = empty ? "No data" : "Live";
        setPanelSubtitle(section, panel, panel.description, false);
      }
      section.setAttribute("aria-busy", "false");
    } catch (error) {
      showRenderError(section, panel, error, staleError);
    }
  }
}

function showRenderError(section, panel, error, staleError = null) {
  const body = section.querySelector(".panel-body");
  const code = error?.code || "E_RENDER";
  const message = error?.message || "Panel renderer failed";
  recordError(code, message, panel.id, safeDetail(error?.detail));
  state.panelErrors.set(panel.id, { code, message, detail: safeDetail(error?.detail) });
  section.dataset.panelState = "error";
  section.setAttribute("aria-busy", "false");
  section.querySelector(".panel-badge").textContent = "Error";
  const content = document.createElement("div");
  content.className = "panel-error";
  const codeEl = document.createElement("span");
  codeEl.className = "panel-error-code";
  codeEl.textContent = code;
  const messageEl = document.createElement("p");
  messageEl.className = "panel-error-message";
  messageEl.textContent = safeText(message, 300);
  const hintEl = document.createElement("p");
  hintEl.className = "panel-error-hint";
  hintEl.textContent = staleError
    ? `Last good data could not be shown (${staleError.code}).`
    : "The panel will retry on the next refresh.";
  content.append(codeEl, messageEl, hintEl);
  body.replaceChildren(content);
}

function errorHint(code) {
  switch (code) {
    case "E_PROM_NETWORK":
      return "Check that Prometheus is reachable and allows CORS from this origin.";
    case "E_PROM_HTTP":
      return "Prometheus returned an error status. Check the endpoint and credentials.";
    case "E_PROM_QUERY":
      return "Prometheus rejected the query. Check the PromQL expression.";
    case "E_PROM_RESPONSE":
      return "Prometheus returned a shape this renderer does not understand.";
    case "E_DATASOURCE":
    case "E_CAPABILITY":
      return "Open diagnostics for capability and datasource details.";
    default:
      return "The panel will retry on the next refresh.";
  }
}

function applyPanelError(panelId, error) {
  const panel = state.dashboard.panels.get(panelId);
  if (!panel) return;
  const code = error?.code || "E_INTERNAL";
  const message = error?.message || "Panel request failed";
  const detail = safeDetail(error?.detail);
  recordError(code, message, panelId, detail);
  state.panelErrors.set(panelId, { code, message, detail });
  const previous = state.lastSeries.get(panelId);
  if (previous) {
    applyDataPanel(panelId, previous, { code, message, detail });
    return;
  }
  for (const section of panelElements(panelId)) {
    const body = section.querySelector(".panel-body");
    section.dataset.panelState = "error";
    section.setAttribute("aria-busy", "false");
    section.querySelector(".panel-badge").textContent = "Error";
    const content = document.createElement("div");
    content.className = "panel-error";
    const codeEl = document.createElement("span");
    codeEl.className = "panel-error-code";
    codeEl.textContent = code;
    const messageEl = document.createElement("p");
    messageEl.className = "panel-error-message";
    messageEl.textContent = safeText(message, 300);
    const hintEl = document.createElement("p");
    hintEl.className = "panel-error-hint";
    hintEl.textContent = errorHint(code);
    content.append(codeEl, messageEl, hintEl);
    if (detail) {
      const detailEl = document.createElement("p");
      detailEl.className = "panel-error-hint";
      detailEl.textContent = safeText(detail, 300);
      content.append(detailEl);
    }
    body.replaceChildren(content);
  }
}

async function executePanel(entry, { startMs, endMs, signal }) {
  const panel = entry.panel;
  const stepSeconds = stepFor((endMs - startMs) / 1000, state.config.stepSeconds);
  const allSeries = [];
  for (const query of entry.queries) {
    const result =
      panel.panelKind === "Table"
        ? await queryInstant(query.baseUrl, query.query, {
            timeMs: endMs,
            signal,
            onRequest: recordRequest,
            maxSeries: 100,
          })
        : await queryRange(query.baseUrl, query.query, {
            startMs,
            endMs,
            stepSeconds,
            signal,
            onRequest: recordRequest,
            maxSeries: 12,
          });
    for (const warning of result.warnings) {
      warn(warning.code, warning.message, panel.id, warning.detail);
    }
    for (const item of result.series) {
      allSeries.push({ ...item, queryIndex: query.index });
    }
  }
  const maxSeries = panel.panelKind === "Table" ? 100 : 12;
  if (allSeries.length > maxSeries) {
    warn("W_SERIES_TRUNCATED", `Panel kept the first ${maxSeries} series`, panel.id, null);
    return allSeries.slice(0, maxSeries);
  }
  return allSeries;
}

async function runCycle({ reason }) {
  const startedMs = Date.now();
  state.phase = "running";
  updateStatus();
  const entries = [...state.filtered.dataPanelIds]
    .map((id) => state.filtered.visible.get(id))
    .filter(Boolean);
  if (entries.length === 0) {
    const finished = Date.now();
    const lastRefresh = {
      startedAt: iso(startedMs),
      endedAt: iso(finished),
      ok: true,
      durationMs: finished - startedMs,
      succeeded: 0,
      failed: 0,
    };
    state.lastRefresh = lastRefresh;
    state.diagnostics.setLastRefresh(lastRefresh);
    state.diagnostics.setPanels({ ...state.filtered.counts, errors: 0 });
    state.phase = "idle";
    updateStatus();
    return { ok: true, succeeded: 0, failed: 0, total: 0, reason };
  }

  const controller = new AbortController();
  state.currentAbort = controller;
  const endMs = Date.now();
  const startMs = endMs - state.rangeMs;
  const results = await Promise.all(
    entries.map(async (entry) => {
      try {
        const series = await executePanel(entry, { startMs, endMs, signal: controller.signal });
        if (controller.signal.aborted) return { ok: false, aborted: true };
        state.lastSeries.set(entry.panel.id, series);
        state.panelErrors.delete(entry.panel.id);
        state.hasLastGood = true;
        applyDataPanel(entry.panel.id, series);
        return { ok: true };
      } catch (error) {
        if (controller.signal.aborted || error?.code === "ABORTED") {
          return { ok: false, aborted: true };
        }
        applyPanelError(entry.panel.id, error);
        return { ok: false, error };
      }
    }),
  );

  const succeeded = results.filter((result) => result.ok).length;
  const failed = results.length - succeeded;
  const finished = Date.now();
  const lastRefresh = {
    startedAt: iso(startedMs),
    endedAt: iso(finished),
    ok: failed === 0,
    durationMs: finished - startedMs,
    succeeded,
    failed,
  };
  state.lastRefresh = lastRefresh;
  state.diagnostics.setLastRefresh(lastRefresh);
  state.diagnostics.setPanels({ ...state.filtered.counts, errors: state.panelErrors.size });
  state.phase = "idle";
  state.currentAbort = null;
  updateStatus();
  bridgeLog(
    failed === 0 ? "info" : "warn",
    `refresh ${reason}: ${succeeded}/${entries.length} panels succeeded`,
  );
  return { ok: failed === 0, succeeded, failed, total: entries.length, reason };
}

function currentStatus() {
  if (state.fatal) return "error";
  if (!state.filtered) return "loading";
  const schedulerState = state.scheduler?.state();
  const result = schedulerState?.lastResult || null;
  if (!result) return "loading";
  return deriveStatus({
    phase: "idle",
    fatal: false,
    total: result.total ?? state.filtered.dataPanelIds.length,
    succeeded: result.succeeded ?? 0,
    failed: result.failed ?? 0,
    hasLastGood: state.hasLastGood,
  });
}

function syncDiagnostics() {
  if (!state.diagnostics) return;
  const schedulerState = state.scheduler?.state();
  state.diagnostics.setNextRefreshAt(
    schedulerState?.nextRefreshAt ? iso(schedulerState.nextRefreshAt) : null,
  );
  if (state.filtered) {
    state.diagnostics.setPanels({
      ...state.filtered.counts,
      errors: state.panelErrors.size,
    });
  }
}

function updateStatus() {
  if (!state.statusBar) {
    if (state.liveChip && state.liveChipText) {
      const status = currentStatus();
      state.liveChipText.textContent = statusLabel(status);
      state.liveChip.className = status === "live" ? "chip chip-live" : "chip";
    }
    return;
  }
  const status = currentStatus();
  const schedulerState = state.scheduler?.state();
  const counts = state.filtered?.counts;
  const hidden = counts?.hidden || 0;
  const errors = state.panelErrors.size;
  const parts = [];

  if (status === "loading") {
    parts.push("Contacting dashboard and metrics");
  } else {
    const lastSuccess = schedulerState?.lastSuccessAt;
    if (lastSuccess) parts.push(`Updated ${formatClockShort(lastSuccess)}`);
    else parts.push("No successful update");
    if (state.intervalSeconds === 0) {
      parts.push("Manual refresh");
    } else if (schedulerState?.running) {
      parts.push("Refreshing…");
    } else if (schedulerState?.nextRefreshAt) {
      parts.push(`Next ${formatCountdown(schedulerState.nextRefreshAt - Date.now())}`);
    }
  }
  if (hidden > 0) parts.push(`${hidden} hidden`);
  if (errors > 0) parts.push(`${errors} failing`);
  if (status === "stale") parts.push("last good data retained");

  state.statusBar.dataset.status = status;
  state.statusStateEl.textContent = statusLabel(status);
  state.statusDetailEl.textContent = parts.join(" · ");
  state.statusBar.setAttribute("aria-label", `Status: ${statusLabel(status)}. ${parts.join(". ")}`);
  if (state.liveChip && state.liveChipText) {
    state.liveChipText.textContent = statusLabel(status);
    state.liveChip.className =
      status === "live"
        ? "chip chip-live"
        : status === "degraded" || status === "stale"
          ? "chip chip-warn"
          : status === "error"
            ? "chip chip-danger"
            : "chip";
  }
  syncDiagnostics();
}

function debugSection(title, content) {
  const section = document.createElement("section");
  section.className = "debug-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading, content);
  return section;
}

function debugGrid(values) {
  const grid = document.createElement("div");
  grid.className = "debug-grid";
  for (const [key, value] of values) {
    const keyEl = document.createElement("div");
    keyEl.className = "debug-key";
    keyEl.textContent = key;
    const valueEl = document.createElement("div");
    valueEl.className = "debug-value";
    valueEl.textContent = value === null || value === undefined ? "—" : String(value);
    grid.append(keyEl, valueEl);
  }
  return grid;
}

function debugChips(values, statusFor = null) {
  const chips = document.createElement("div");
  chips.className = "debug-chips";
  if (values.length === 0) {
    const empty = document.createElement("span");
    empty.className = "debug-empty";
    empty.textContent = "None";
    chips.append(empty);
    return chips;
  }
  for (const value of values) {
    const chip = document.createElement("span");
    chip.className = "debug-chip";
    if (statusFor) {
      const result = statusFor(value);
      if (result === "ok") chip.classList.add("ok");
      if (result === "bad") chip.classList.add("bad");
    }
    chip.textContent = typeof value === "string" ? value : value.label;
    chips.append(chip);
  }
  return chips;
}

function eventList(events, emptyText) {
  const list = document.createElement("ul");
  list.className = "debug-list";
  if (!events || events.length === 0) {
    const item = document.createElement("li");
    item.className = "debug-empty";
    item.textContent = emptyText;
    list.append(item);
    return list;
  }
  for (const event of [...events].reverse()) {
    const item = document.createElement("li");
    const code = document.createElement("span");
    code.className = "debug-code";
    code.textContent =
      event.code || (event.status ? `HTTP ${event.status}` : event.url || "event");
    const when = document.createElement("span");
    when.className = "debug-when";
    when.textContent = ` · ${event.at || ""}`;
    const message = document.createElement("div");
    const suffix =
      event.durationMs !== null && event.durationMs !== undefined
        ? ` · ${event.durationMs}ms`
        : "";
    message.textContent = event.message || `${event.url || ""}${suffix}`;
    item.append(code, when, message);
    list.append(item);
  }
  return list;
}

function openDebug() {
  if (!state.config?.debug || state.debugOverlay) return;
  syncDiagnostics();
  const snapshot = state.diagnostics?.snapshot();
  if (!snapshot) return;
  const overlay = document.createElement("div");
  overlay.className = "debug-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Diagnostics");
  const panel = document.createElement("div");
  panel.className = "debug-panel";

  const header = document.createElement("header");
  header.className = "debug-header";
  const title = document.createElement("h2");
  title.textContent = "Diagnostics";
  const close = makeButton("Close diagnostics", {
    icon: makeIcon("M6 6l12 12M18 6L6 18"),
    onClick: closeDebug,
  });
  header.append(title, close);

  const body = document.createElement("div");
  body.className = "debug-body";
  body.append(
    debugSection(
      "Config",
      debugGrid([
        ["dashboard", snapshot.config?.dashboardUrl],
        ["prometheus", snapshot.config?.prometheusUrl],
        ["refresh", snapshot.config?.refreshSeconds === null ? "dashboard" : snapshot.config?.refreshSeconds === 0 ? "manual" : `${snapshot.config.refreshSeconds}s`],
        ["time range", snapshot.config?.timeRange || snapshot.dashboard?.duration],
        ["layout", snapshot.config?.layoutMode],
        ["display", snapshot.config?.displayMode],
        ["debug", snapshot.config?.debug ? "true" : "false"],
        ["show hidden", snapshot.config?.showUnsupported ? "true" : "false"],
      ]),
    ),
    debugSection(
      "Capabilities",
      debugChips(snapshot.capabilities.advertised, (id) => (snapshot.capabilities.probed.some((probe) => probe.ok) && id === "prometheus" ? "ok" : null)),
    ),
    debugSection(
      "Probes",
      snapshot.capabilities.probed.length
        ? debugGrid(
            snapshot.capabilities.probed.map((probe) => [
              probe.baseUrl,
              `${probe.ok ? "ok" : "failed"}${probe.version ? ` · ${probe.version}` : ""}${probe.latencyMs !== null ? ` · ${probe.latencyMs}ms` : ""}${probe.error ? ` · ${probe.error}` : ""}`,
            ]),
          )
        : (() => {
            const empty = document.createElement("div");
            empty.className = "debug-empty";
            empty.textContent = "No Prometheus base URL was probed.";
            return empty;
          })(),
    ),
    debugSection(
      "Model",
      debugGrid([
        ["dashboard", snapshot.dashboard?.name],
        ["panels", `${snapshot.panels.rendered} rendered / ${snapshot.panels.total} total`],
        ["hidden", snapshot.panels.hidden],
        ["panel errors", snapshot.panels.errors],
        ["rows", snapshot.dashboard?.rowsTotal],
      ]),
    ),
  );

  if (snapshot.panels.hiddenReasons.length) {
    const list = document.createElement("ul");
    list.className = "debug-list";
    for (const hidden of snapshot.panels.hiddenReasons) {
      const item = document.createElement("li");
      const code = document.createElement("span");
      code.className = "debug-code";
      code.textContent = hidden.panelId;
      const message = document.createElement("div");
      message.textContent = `${hidden.reason}${hidden.detail ? ` · ${hidden.detail}` : ""}`;
      item.append(code, message);
      list.append(item);
    }
    body.append(debugSection("Hidden panels", list));
  }

  const refresh = snapshot.lastRefresh;
  body.append(
    debugSection(
      "Last refresh",
      refresh
        ? debugGrid([
            ["started", refresh.startedAt],
            ["ended", refresh.endedAt],
            ["result", refresh.ok ? "ok" : "partial"],
            ["panels", `${refresh.succeeded} succeeded / ${refresh.failed} failed`],
            ["duration", `${refresh.durationMs}ms`],
            ["next", snapshot.nextRefreshAt || "manual"],
          ])
        : (() => {
            const empty = document.createElement("div");
            empty.className = "debug-empty";
            empty.textContent = "No refresh has completed yet.";
            return empty;
          })(),
    ),
    debugSection("Requests", eventList(snapshot.requests, "No requests recorded.")),
    debugSection("Warnings", eventList(snapshot.warnings, "No warnings.")),
    debugSection("Errors", eventList(snapshot.errors, "No errors.")),
  );

  const actions = document.createElement("div");
  actions.className = "debug-actions";
  const addAction = (label, className, handler) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `debug-action ${className}`.trim();
    button.textContent = label;
    button.addEventListener("click", handler);
    actions.append(button);
  };
  addAction("Refresh now", "primary", () => {
    closeDebug();
    state.scheduler?.refresh("debug");
  });
  addAction("Reload dashboard", "", () => {
    closeDebug();
    reloadDashboard();
  });
  addAction("Reload page", "", () => window.location.reload());
  addAction("Exit kiosk", "danger", () => {
    const target = bridge();
    if (!target?.exitKiosk) {
      showToast("Android bridge is not available in browser mode");
      return;
    }
    if (window.confirm("Exit kiosk and close AndroDash?")) {
      closeDebug();
      try {
        target.exitKiosk();
      } catch (error) {
        showToast(`Could not exit: ${safeText(error.message, 80)}`);
      }
    }
  });
  body.append(debugSection("Actions", actions));
  panel.append(header, body);
  overlay.append(panel);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDebug();
  });
  document.addEventListener("keydown", debugKeydown);
  document.body.append(overlay);
  state.debugOverlay = overlay;
  close.focus();
}

function debugKeydown(event) {
  if (event.key === "Escape") closeDebug();
}

function closeDebug() {
  if (!state.debugOverlay) return;
  state.debugOverlay.remove();
  state.debugOverlay = null;
  document.removeEventListener("keydown", debugKeydown);
}

async function reloadDashboard() {
  try {
    const old = state.scheduler;
    if (old) old.stop();
    state.scheduler = null;
    if (state.statusTicker) clearInterval(state.statusTicker);
    state.statusTicker = null;
    state.currentAbort?.abort();
    await loadApp();
    return { ok: true };
  } catch (error) {
    bootFatal(error, false);
    return { ok: false, code: error?.code || "E_INTERNAL", message: error?.message || "reload failed" };
  }
}

function installApi() {
  const api = {
    getConfig() {
      try {
        return redactConfig(state.config);
      } catch {
        return null;
      }
    },
    getCapabilities() {
      try {
        return capabilityDocument(state.advertised);
      } catch {
        return null;
      }
    },
    getDiagnostics() {
      try {
        syncDiagnostics();
        return state.diagnostics?.snapshot() || null;
      } catch (error) {
        return {
          error: "E_INTERNAL",
          message: safeText(error?.message || "diagnostics unavailable", 300),
        };
      }
    },
    refresh() {
      try {
        state.scheduler?.refresh("api");
      } catch {
        // API calls never throw to callers (C-009).
      }
    },
    reloadDashboard() {
      return reloadDashboard().catch((error) => ({
        ok: false,
        code: error?.code || "E_INTERNAL",
        message: safeText(error?.message || "reload failed", 300),
      }));
    },
  };
  window.androdash = Object.freeze(api);
}

function applyDisplayMode() {
  const mode = state.config?.displayMode || "standard";
  document.documentElement.dataset.displayMode = mode;
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) theme.setAttribute("content", mode === "standard" ? "#080b12" : "#000000");
}

function updateMode() {
  if (!state.config) return;
  const mode = resolveLayoutMode(state.config.layoutMode, window.innerWidth);
  if (mode === state.mode) return;
  state.mode = mode;
  app.dataset.layoutMode = mode;
}

async function init() {
  installApi();
  if (window.location.protocol === "file:") {
    bootFatal({
      code: "E_ASSET_LOAD",
      message: "Open the renderer from the local HTTP demo server, not file://",
      detail: "python3 tools/serve_demo.py --port 8099",
    });
    return;
  }
  try {
    const parsed = parseConfig(window.location.search);
    state.config = parsed.config;
    applyDisplayMode();
    state.diagnostics = new DiagnosticsStore({ config: parsed.config, startedAt: Date.now() });
    for (const item of parsed.warnings) {
      warn(item.code, item.message, null, item.detail);
    }
    if (state.config.kiosk) document.body.dataset.kiosk = "true";
    await loadApp();
  } catch (error) {
    bootFatal(error, !state.config);
  }
}

window.addEventListener("resize", () => {
  window.requestAnimationFrame(updateMode);
});

document.addEventListener("visibilitychange", () => {
  state.scheduler?.setVisible(!document.hidden);
});

window.addEventListener("pagehide", () => {
  state.currentAbort?.abort();
  state.scheduler?.stop();
});

window.addEventListener("error", (event) => {
  if (!state.diagnostics) return;
  recordError("E_INTERNAL", safeText(event.message || "Unexpected renderer error", 300));
});

window.addEventListener("unhandledrejection", (event) => {
  if (!state.diagnostics) return;
  recordError(
    "E_INTERNAL",
    safeText(event.reason?.message || "Unhandled promise rejection", 300),
  );
});

init();
