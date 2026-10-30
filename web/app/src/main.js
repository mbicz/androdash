import { ConfigError, parseConfig } from "./config.js";
import {
  bundledDashboards,
  fetchDashboardDocument,
  loadDashboard,
  localDashboardKind,
  normalizeFrom,
  shellDashboardStore,
  updateStoredDashboard,
} from "./dashboard/load.js";
import { MAX_TARGETS, formatTarget, parseTarget, targetKey } from "./collector-targets.js";
import {
  DashboardError,
  collectPrometheusBaseUrls,
  resolveVariables,
  applyDisplayVariables,
} from "./dashboard/normalize.js";
import { parseDuration } from "./dashboard/duration.js";
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
import { orderedItems, renderRows, resolveLayoutMode } from "./layout.js";
import { planFit } from "./fit.js";
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
  statusEl: null,
  rangeText: null,
  panelWindows: new Map(),
  locked: false,
  zoomedPanel: null,
  titles: new Map(),
  rotateTimer: null,
  lastTouchAt: 0,
  switching: false,
  pendingVariables: [],
  variablesCheckedAt: 0,
  probesCheckedAt: 0,
  retryingGaps: false,
  fitCounts: null,
  relayoutTimer: null,
  sheet: null,
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
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** In-app view presets (C-006). The launch config may add one more. */
const RANGE_PRESETS = ["5m", "15m", "1h", "6h", "24h", "7d"];
const REFRESH_PRESETS = [0, 5, 10, 30, 60, 300];

function refreshLabel(seconds) {
  if (seconds === 0) return "Off";
  return seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
}

/** Fit layout is on when chosen, and always on the lock screen (C-005). */
function fitActive() {
  return state.locked || state.config?.layoutMode === "fit";
}

function scrollMode() {
  const configured = state.config.layoutMode === "fit" ? "auto" : state.config.layoutMode;
  return resolveLayoutMode(configured, window.innerWidth);
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
  state.currentAbort?.abort();
  state.currentAbort = null;
  state.fatal = false;
  state.phase = "loading";
  state.hasLastGood = false;
  state.lastRefresh = null;
  state.panelErrors = new Map();
  state.lastSeries = new Map();
  state.panelWindows = new Map();
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
    store: dashboardStore(),
  });
  state.dashboard = dashboard;
  state.rangeText = state.config.timeRange || dashboard.durationText;
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

  state.variables = await resolveVariablesFor(dashboard, warn);
  state.pendingVariables = dashboard.variables
    .filter((variable) => variable.pluginKind === "PrometheusLabelValuesVariable")
    .map((variable) => variable.name)
    .filter((name) => !state.variables.get(name));
  state.variablesCheckedAt = Date.now();
  state.probesCheckedAt = Date.now();
  applyDisplayVariables(dashboard, state.variables, warn);
  state.titles.set(state.config.dashboardUrl, dashboard.title);

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
    source: dashboard.source?.kind || "url",
    storedAt: dashboard.source?.storedAt ? iso(dashboard.source.storedAt) : null,
  });
  state.diagnostics.setPanels({
    ...state.filtered.counts,
    errors: 0,
  });
  state.fitCounts = null;
  renderDashboard();
  installScheduler();
  updateStatus();
}

function resolveVariablesFor(dashboard, warnFn) {
  return resolveVariables(dashboard, {
    config: state.config,
    advertisedCapabilities: state.advertised,
    labelValues: ({ baseUrl, labelName, matchers }) =>
      prometheusLabelValues(baseUrl, labelName, matchers, { onRequest: recordRequest }),
    warn: warnFn,
  });
}

/**
 * Boot-time gaps that heal by themselves: a Prometheus probe that failed (the
 * phone came up before Wi-Fi, or the on-phone collector was still starting)
 * hides its panels, and a label-values variable can resolve empty before the
 * first scrape. Both are re-checked at the start of refresh cycles — probes
 * every 15 s, variables every 60 s — and the dashboard reloads once the gap
 * closes (C-004, C-002 "Variables").
 */
async function retryBootGaps() {
  if (state.fatal || !state.dashboard || state.retryingGaps) return;
  const now = Date.now();
  const failedProbes = state.probes.filter((probe) => probe.ok === false).map((probe) => probe.baseUrl);
  const probesDue = failedProbes.length > 0 && now - (state.probesCheckedAt || 0) >= 15_000;
  const variablesDue = state.pendingVariables.length > 0 && now - (state.variablesCheckedAt || 0) >= 60_000;
  if (!probesDue && !variablesDue) return;
  state.retryingGaps = true;
  try {
    let healed = false;
    if (probesDue) {
      state.probesCheckedAt = now;
      const probes = await probePrometheus(failedProbes, { fetchJson, onRequest: recordRequest });
      healed = probes.some((probe) => probe.ok);
    }
    if (!healed && variablesDue) {
      state.variablesCheckedAt = now;
      const values = await resolveVariablesFor(state.dashboard, () => {});
      healed = state.pendingVariables.some((name) => values.get(name));
    }
    if (healed) {
      bridgeLog("info", "boot gap closed (Prometheus reachable or variable resolved); reloading dashboard");
      reloadDashboard();
    }
  } catch {
    // Still unreachable; the next cycle tries again.
  } finally {
    state.retryingGaps = false;
  }
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
}

/**
 * Build the page for the current layout. Rebuilding is cheap and idempotent:
 * panel shells are recreated and every panel's last data (or error) is
 * painted again, so layout switches, rotation, and lock/unlock never wait for
 * the next refresh.
 */
function renderDashboard() {
  state.panelElements = new Map();
  const fit = fitActive();
  state.mode = fit ? "fit" : scrollMode();
  app.dataset.layoutMode = state.mode;
  document.documentElement.dataset.layout = fit ? "fit" : "scroll";

  const header = createHeader();
  const main = document.createElement("main");
  main.setAttribute("aria-label", state.dashboard.title);
  if (fit) {
    main.className = "fit-grid";
    app.replaceChildren(header, main);
    buildFit(main);
  } else {
    main.className = "rows";
    main.append(renderRows(state.filtered.rows, { createPanel }));
    if (state.filtered.rows.length === 0) main.append(createNoPanels());
    app.replaceChildren(header, main);
  }
  // Sections snap under the header and a zoomed panel starts below it; keep
  // the offset equal to the header's height.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(([entry]) => {
      const height = Math.round(entry.target.getBoundingClientRect().height);
      document.documentElement.style.setProperty("--header-h", `${height}px`);
    }).observe(header);
  }
  app.setAttribute("aria-busy", "false");
  document.title = `${state.dashboard.title} · AndroDash`;

  for (const entry of state.filtered.visible.values()) {
    if (entry.panel.panelKind === "Markdown") renderMarkdownPanel(entry.panel.id);
  }
  restorePanels();
  setZoom(state.zoomedPanel);
  updateStatus();
}

/**
 * Panel zoom (C-005 "Panel zoom"): a double tap on a panel makes it fill the
 * screen below the header; a double tap (or Escape) returns it. The panel is
 * redrawn at its new size; other panels keep refreshing underneath.
 */
function setZoom(panelId) {
  const previous = document.querySelector(".panel.is-zoomed");
  previous?.classList.remove("is-zoomed");
  previous?.removeAttribute("aria-expanded");
  const section = panelId ? panelElements(panelId)[0] : null;
  state.zoomedPanel = section ? panelId : null;
  document.documentElement.dataset.zoom = String(Boolean(section));
  if (section) {
    section.classList.add("is-zoomed");
    section.setAttribute("aria-expanded", "true");
  }
  const redraw = [previous?.dataset.panelId, state.zoomedPanel].filter(Boolean);
  requestAnimationFrame(() => {
    for (const id of new Set(redraw)) {
      const series = state.lastSeries.get(id);
      if (series) applyDataPanel(id, series, state.panelErrors.get(id) || null);
      else if (state.dashboard?.panels.get(id)?.panelKind === "Markdown") renderMarkdownPanel(id);
    }
  });
  scheduleRotation();
}

function toggleZoom(target) {
  const section = target instanceof Element ? target.closest(".panel[data-panel-id]") : null;
  if (state.zoomedPanel) setZoom(null);
  else if (section) setZoom(section.dataset.panelId);
}

/** Repaint every panel from retained data after a rebuild. */
function restorePanels() {
  for (const [panelId, series] of state.lastSeries) {
    applyDataPanel(panelId, series, state.panelErrors.get(panelId) || null);
  }
  for (const [panelId, error] of state.panelErrors) {
    if (!state.lastSeries.has(panelId)) paintPanelError(panelId, error);
  }
}

/** How many tiles, rings, lines, or rows a panel shows (estimated until data). */
function displayCount(panel) {
  const series = state.lastSeries.get(panel.id);
  if (series) {
    if (panel.panelKind === "GaugeChart") return Math.max(1, Math.min(4, series.length));
    return Math.max(1, series.length);
  }
  if (panel.panelKind === "Table") return 6;
  return Math.max(1, panel.queries?.length || 1);
}

function fitItems() {
  const items = [];
  for (const row of state.filtered.rows) {
    for (const item of orderedItems(row.items)) {
      if (item.state === "unsupported" || !item.panel) continue;
      items.push({
        id: String(items.length),
        kind: item.panel.panelKind,
        count: displayCount(item.panel),
        thresholds: (item.panel.panelSpec?.thresholds?.steps?.length || 0) > 0,
        item,
      });
    }
  }
  return items;
}

/**
 * Fit layout (C-005): one screen, no scrolling. The planner turns the screen
 * size and what each panel shows into rows and column spans; CSS grid gives
 * left-over height to the rows that benefit, and renderers size their content
 * to the box they get.
 */
function buildFit(main) {
  const items = fitItems();
  state.fitCounts = items.map((item) => `${item.item.panel.id}:${item.count}`).join(",");
  if (items.length === 0) {
    main.append(createNoPanels());
    return;
  }
  const rect = main.getBoundingClientRect();
  const viewport = window.visualViewport?.height || window.innerHeight;
  const bottom = parseFloat(getComputedStyle(main).marginBottom) || 0;
  const width = Math.max(120, Math.floor(rect.width));
  const height = Math.max(160, Math.floor(viewport - rect.top - bottom));
  const plan = planFit(items, { width, height });
  if (plan.overflow) {
    warn("W_FIT_OVERFLOW", "Panels do not fit on one screen at the smallest legible size; scrolling", null, `${items.length} panels`);
  }
  main.style.height = `${height}px`;
  main.style.setProperty("--fit-scale", plan.scale.toFixed(3));
  main.classList.toggle("overflow", plan.overflow);
  // When space is short, only charts give up height — down to half their
  // minimum, and never below the numbers, rings, or text sharing their row.
  // Anything beyond that scrolls (C-005 "Fit layout").
  const gaps = 8 * Math.max(0, plan.rows.length - 1);
  const rigid = (row) => Math.max(row.rigidHeight || 0, 0);
  const fixedTotal = plan.rows.reduce((sum, row) => sum + rigid(row), 0);
  const giveable = plan.rows.reduce((sum, row) => sum + (row.minHeight - rigid(row)), 0);
  const spare = height - gaps - fixedTotal;
  const flexScale = giveable > 0 ? Math.max(0, Math.min(1, spare / giveable)) : 1;
  const rowMin = (row) => Math.max(rigid(row), Math.round(rigid(row) + (row.minHeight - rigid(row)) * flexScale), Math.round(row.minHeight * 0.5));
  if (plan.rows.reduce((sum, row) => sum + rowMin(row), 0) + gaps > height + 1) main.classList.add("overflow");
  main.style.gridTemplateRows = plan.rows
    .map((row) => {
      const min = rowMin(row);
      return row.maxHeight
        ? `minmax(${min}px, ${Math.max(min, row.maxHeight)}px)`
        : `minmax(${min}px, ${row.weight}fr)`;
    })
    .join(" ");
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const row of plan.rows) {
    const rowEl = document.createElement("div");
    rowEl.className = "fit-row";
    rowEl.style.gridTemplateColumns = row.cells.map((cell) => `minmax(0, ${cell.span}fr)`).join(" ");
    for (const cell of row.cells) {
      const slot = document.createElement("div");
      slot.className = "panel-slot";
      const panel = createPanel(byId.get(cell.id).item);
      if (panel) slot.append(panel);
      rowEl.append(slot);
    }
    main.append(rowEl);
  }
}

/** Re-plan after rotation/resize or when panels show a different count. */
function scheduleRelayout() {
  if (state.relayoutTimer) clearTimeout(state.relayoutTimer);
  state.relayoutTimer = setTimeout(() => {
    state.relayoutTimer = null;
    if (state.dashboard && state.filtered && !state.fatal) renderDashboard();
  }, 120);
}

/**
 * Sticky title bar: the dashboard title (variables interpolated, e.g. the
 * host name), one dashboard-wide status, and icon actions. The data is one
 * source refreshed together, so status lives here once, not on every panel.
 */
function createHeader() {
  const header = document.createElement("header");
  header.className = "app-header";

  const title = document.createElement("h1");
  title.className = "app-title";
  title.textContent = state.dashboard.title;

  const status = document.createElement("div");
  status.className = "app-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const dot = document.createElement("span");
  dot.className = "status-dot";
  dot.setAttribute("aria-hidden", "true");
  status.append(dot);
  state.statusEl = status;

  const actions = document.createElement("div");
  actions.className = "header-actions";
  actions.append(
    makeButton("Refresh now", {
      icon: makeIcon("M20 11a8 8 0 1 0-2.3 5.6M20 4v7h-7"),
      onClick: () => state.scheduler?.refresh("manual"),
    }),
    makeButton("View settings", {
      icon: makeIcon("M4 7h10M18 7h2M4 17h2M10 17h10M16 4v6M8 14v6"),
      onClick: openSettings,
    }),
  );
  if (state.config.debug) {
    actions.append(
      makeButton("Open diagnostics", {
        icon: makeIcon("M12 16v-5M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"),
        onClick: openDebug,
      }),
    );
  }

  const heading = document.createElement("div");
  heading.className = "app-heading";
  heading.append(title, status);
  // The dots sit in a fixed slot left of the actions, so switching between
  // dashboards with titles of different widths moves only the title text.
  const pager = dashboardDots();
  if (pager) header.append(heading, pager, actions);
  else header.append(heading, actions);
  return header;
}

/** One dot per dashboard in `dashboard_urls`; the current one is filled. */
function dashboardDots() {
  const urls = state.config.dashboardUrls;
  if (urls.length < 2) return null;
  const nav = document.createElement("nav");
  nav.className = "dashboard-dots";
  nav.setAttribute("aria-label", "Dashboards");
  urls.forEach((url, index) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = "dashboard-dot";
    dot.setAttribute("aria-label", `Show ${state.titles.get(url) || dashboardLabel(url)}`);
    dot.setAttribute("aria-current", String(url === state.config.dashboardUrl));
    dot.addEventListener("click", () => showDashboard(index));
    nav.append(dot);
  });
  return nav;
}

function dashboardStore() {
  const slot = Math.max(0, state.config.dashboardUrls.indexOf(state.config.dashboardUrl));
  return shellDashboardStore(bridge(), { slot });
}

function dashboardLabel(url) {
  if (localDashboardKind(url) === "inline") return "Pasted dashboard";
  try {
    const name = new URL(url).pathname.split("/").pop() || url;
    return name.replace(/\.json$/i, "").replace(/-dashboard$/i, "").replace(/[-_]+/g, " ");
  } catch {
    return url;
  }
}

/**
 * Show dashboard `index` of `dashboard_urls` (wrapping). Only one dashboard is
 * live at a time: the others are not queried. The choice is persisted, so a
 * relaunch shows the last dashboard viewed (C-001 `dashboard_url`).
 */
async function showDashboard(index, { direction = 0 } = {}) {
  const urls = state.config.dashboardUrls;
  if (urls.length < 2 || state.switching) return;
  const next = urls[((index % urls.length) + urls.length) % urls.length];
  if (next === state.config.dashboardUrl && state.dashboard) return;
  state.switching = true;
  state.zoomedPanel = null;
  closeSettings();
  closeDebug();
  state.config = { ...state.config, dashboardUrl: next };
  persistOption("dashboard_url", next);
  app.dataset.enter = direction > 0 ? "next" : direction < 0 ? "prev" : "";
  try {
    await reloadDashboard();
  } finally {
    state.switching = false;
    setTimeout(() => {
      app.dataset.enter = "";
    }, 260);
    scheduleRotation();
  }
}

function stepDashboard(delta) {
  const urls = state.config.dashboardUrls;
  showDashboard(urls.indexOf(state.config.dashboardUrl) + delta, { direction: delta });
}

/**
 * Rotation (C-001 `rotate_seconds`): advance to the next dashboard on a timer,
 * for an unattended screen. Any touch pauses it for two minutes.
 */
function scheduleRotation() {
  if (state.rotateTimer) clearTimeout(state.rotateTimer);
  state.rotateTimer = null;
  const seconds = state.config.rotateSeconds;
  if (!seconds || state.config.dashboardUrls.length < 2) return;
  const idleFor = Date.now() - state.lastTouchAt;
  const delay = Math.max(seconds * 1000, 120_000 - idleFor);
  state.rotateTimer = setTimeout(() => {
    state.rotateTimer = null;
    if (document.hidden || state.sheet || state.debugOverlay || state.zoomedPanel) {
      scheduleRotation();
      return;
    }
    if (Date.now() - state.lastTouchAt < 120_000) {
      scheduleRotation();
      return;
    }
    stepDashboard(1);
  }, delay);
}

/** Can `element` (or an ancestor up to the app) scroll further along `axis`? */
function canScroll(element, axis, delta) {
  for (let node = element; node && node !== app && node !== document.body; node = node.parentElement) {
    const style = getComputedStyle(node);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    const max = axis === "x" ? node.scrollWidth - node.clientWidth : node.scrollHeight - node.clientHeight;
    if (max <= 1) continue;
    const position = axis === "x" ? node.scrollLeft : node.scrollTop;
    if (delta < 0 ? position < max - 1 : position > 1) return true;
  }
  return false;
}

/**
 * Gestures (C-005 "Gestures"): a horizontal swipe pages between dashboards —
 * anywhere in the fit layout, on the header in the scroll layout (where
 * horizontal strips own the page). Content that can still scroll sideways
 * gets the swipe first. Vertical drags only ever scroll content.
 */
function installGestures() {
  // Touch events, not pointer events: once the WebView starts panning a
  // scrollable panel it cancels the pointer stream, but touchend still fires.
  let start = null;
  const begin = (x, y, t, target) => {
    state.lastTouchAt = Date.now();
    start = { x, y, t, target };
  };
  let lastTap = null;
  const finish = (x, y, t) => {
    const origin = start;
    start = null;
    scheduleRotation();
    if (!origin || state.sheet || state.debugOverlay) return;
    const dx = x - origin.x;
    const dy = y - origin.y;
    // Double tap: two short taps within 320 ms and 32 px toggle panel zoom.
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12 && t - origin.t < 250) {
      const target = origin.target instanceof Element ? origin.target : null;
      if (lastTap && t - lastTap.t < 320 && Math.hypot(x - lastTap.x, y - lastTap.y) < 32) {
        lastTap = null;
        if (!target?.closest("button, input, select, textarea, .app-header")) toggleZoom(target);
      } else {
        lastTap = { x, y, t };
      }
      return;
    }
    lastTap = null;
    if (state.zoomedPanel || (state.config?.dashboardUrls.length ?? 0) < 2) return;
    if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.8 || t - origin.t > 700) return;
    const target = origin.target instanceof Element ? origin.target : null;
    if (target?.closest(".sheet-overlay, .debug-overlay, input, select, textarea")) return;
    if (state.mode !== "fit" && !state.fatal && !target?.closest(".app-header")) return;
    if (target && canScroll(target, "x", dx)) return;
    stepDashboard(dx < 0 ? 1 : -1);
  };
  window.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 1) {
        start = null;
        return;
      }
      const touch = event.touches[0];
      begin(touch.clientX, touch.clientY, event.timeStamp, event.target);
    },
    { passive: true },
  );
  window.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches[0];
      if (touch) finish(touch.clientX, touch.clientY, event.timeStamp);
    },
    { passive: true },
  );
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "touch") return;
      if (!event.isPrimary || event.button > 0) return;
      begin(event.clientX, event.clientY, event.timeStamp, event.target);
    },
    { passive: true },
  );
  window.addEventListener(
    "pointerup",
    (event) => {
      if (event.pointerType === "touch" || !event.isPrimary) return;
      finish(event.clientX, event.clientY, event.timeStamp);
    },
    { passive: true },
  );
  document.addEventListener("keydown", (event) => {
    if (state.sheet || state.debugOverlay || isTextField(event.target)) return;
    if (event.key === "Escape" && state.zoomedPanel) setZoom(null);
    if (state.zoomedPanel) return;
    if (event.key === "ArrowRight") stepDashboard(1);
    if (event.key === "ArrowLeft") stepDashboard(-1);
  });
}

/** Typing in a field never pages dashboards or toggles zoom. */
function isTextField(target) {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]"));
}

/** Most dashboards in `dashboard_urls` (C-001). */
const MAX_DASHBOARDS = 8;
/** Largest pasted dashboard, in characters (C-007 `addInlineDashboard`). */
const MAX_INLINE_CHARS = 5 * 1024 * 1024;

/**
 * Dashboards to page through: the configured list, dashboards built into the
 * app, any http(s) dashboard URL, and (in the shell) pasted dashboard JSON.
 * Adding or removing persists `dashboard_urls` (C-007 `setOption`).
 */
async function dashboardsGroup() {
  const wrap = document.createElement("div");
  wrap.className = "sheet-stack";
  const list = document.createElement("ul");
  list.className = "dashboard-list";
  const urls = state.config.dashboardUrls;
  const [bundled, inlineTitles] = await Promise.all([bundledDashboards(), pastedTitles(urls)]);
  const titleOf = (url) =>
    state.titles.get(url) ||
    inlineTitles.get(url) ||
    bundled.find((item) => item.url === url)?.title ||
    dashboardLabel(url);
  const listError = sheetError();
  for (const url of urls) {
    const item = document.createElement("li");
    item.className = "dashboard-item";
    item.setAttribute("aria-current", String(url === state.config.dashboardUrl));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "dashboard-open";
    open.textContent = safeText(titleOf(url), 80);
    open.addEventListener("click", () => showDashboard(urls.indexOf(url)));
    item.append(open);
    if (urls.length > 1) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "dashboard-remove";
      remove.setAttribute("aria-label", `Remove ${safeText(titleOf(url), 80)}`);
      remove.textContent = "Remove";
      remove.addEventListener("click", () =>
        setError(listError, setDashboardList(urls.filter((other) => other !== url))),
      );
      item.append(remove);
    }
    list.append(item);
  }
  wrap.append(list, listError);

  const full = urls.length >= MAX_DASHBOARDS;
  const addable = bundled.filter((item) => !urls.includes(item.url));
  if (addable.length > 0 && !full) {
    const add = document.createElement("div");
    add.className = "dashboard-add";
    for (const item of addable) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sheet-action";
      button.textContent = `+ ${safeText(item.title, 60)}`;
      button.addEventListener("click", () => setError(listError, setDashboardList([...urls, item.url])));
      add.append(button);
    }
    wrap.append(add);
  }

  const urlInput = sheetInput({
    label: "Dashboard URL",
    placeholder: "https://host/dashboard.json",
    type: "url",
    inputMode: "url",
  });
  const urlError = sheetError();
  wrap.append(
    sheetForm("sheet-form", [urlInput], "Add", async () => {
      setError(urlError, "");
      setError(urlError, await addDashboardUrl(urlInput.value, urls));
    }),
    urlError,
  );

  const controls = [urlInput];
  if (typeof bridge()?.addInlineDashboard === "function") {
    const textarea = document.createElement("textarea");
    configureField(textarea, { label: "Dashboard JSON", placeholder: "Paste dashboard JSON" });
    textarea.rows = 4;
    const pasteError = sheetError();
    const form = sheetForm("sheet-form sheet-form-stack", [textarea], "Add", async () => {
      setError(pasteError, "");
      setError(pasteError, addPastedDashboard(textarea.value, urls));
    });
    // Enter types a newline in pasted JSON; Ctrl/Cmd+Enter adds it.
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    wrap.append(form, pasteError);
    controls.push(textarea);
  }
  if (full) {
    for (const control of controls) {
      control.disabled = true;
      control.form?.querySelector("button[type=submit]")?.setAttribute("disabled", "");
    }
    const note = document.createElement("p");
    note.className = "sheet-note";
    note.textContent = `${MAX_DASHBOARDS} dashboards is the most; remove one to add another`;
    wrap.append(note);
  }

  if (urls.length > 1) {
    wrap.append(
      segmented(
        "Rotate",
        [
          { value: 0, label: "Stay" },
          { value: 30, label: "30s" },
          { value: 60, label: "1m" },
          { value: 300, label: "5m" },
        ],
        state.config.rotateSeconds,
        (seconds) => {
          state.config = { ...state.config, rotateSeconds: seconds };
          persistOption("rotate_seconds", seconds);
          scheduleRotation();
          return true;
        },
      ),
    );
  }
  return settingsGroup(urls.length > 1 ? "Dashboards · swipe to switch" : "Dashboards", wrap);
}

/** Titles of pasted dashboards in `urls`, read from the shell (they are local). */
async function pastedTitles(urls) {
  const titles = new Map();
  const pasted = urls.filter((url) => localDashboardKind(url) === "inline" && !state.titles.has(url));
  await Promise.all(
    pasted.map(async (url) => {
      try {
        const { data } = await fetchJson(url, { timeoutMs: 3000, maxBytes: MAX_INLINE_CHARS });
        const title = data?.spec?.display?.name || data?.metadata?.name;
        if (typeof title === "string" && title.trim()) titles.set(url, title.trim());
      } catch {
        // The list falls back to a generic label.
      }
    }),
  );
  return titles;
}

/**
 * Add a dashboard by URL after checking it loads and normalizes (C-002).
 * Returns "" on success, otherwise a short reason for the sheet.
 */
async function addDashboardUrl(raw, urls) {
  const text = String(raw ?? "").trim();
  if (!text) return "Enter a dashboard URL";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return "Enter a full http:// or https:// URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "The URL must use http or https";
  if (parsed.username || parsed.password) return "The URL must not contain a user name or password";
  if (text.includes(",")) return "Write a comma in the URL as %2C";
  if (text.length > 2048) return "The URL is too long";
  if (urls.includes(text)) return "This dashboard is already in the list";
  let dashboard;
  try {
    const { data, url } = await fetchDashboardDocument(text, { onRequest: recordRequest });
    dashboard = normalizeFrom(data, url, state.config);
  } catch (error) {
    return safeText(error?.message || "The dashboard could not be loaded", 120);
  }
  const message = setDashboardList([...urls, text]);
  if (!message) state.titles.set(text, dashboard.title);
  return message;
}

/**
 * Store pasted dashboard JSON in the shell (C-007 `addInlineDashboard`) after
 * checking it normalizes, then add its local URL. Returns "" on success.
 */
function addPastedDashboard(raw, urls) {
  const text = String(raw ?? "").trim();
  if (!text) return "Paste a dashboard JSON document";
  if (text.length > MAX_INLINE_CHARS) return "The dashboard is larger than 5 MiB";
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return "This is not valid JSON";
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Paste a single dashboard object";
  let dashboard;
  try {
    dashboard = normalizeFrom(data, `http://androdash.local/inline/pasted.json`, state.config);
  } catch (error) {
    return safeText(error?.message || "This is not a usable dashboard", 120);
  }
  let url = "";
  try {
    url = bridge()?.addInlineDashboard?.(text);
  } catch {
    url = "";
  }
  if (typeof url !== "string" || localDashboardKind(url) !== "inline") {
    return "The dashboard could not be saved on this phone";
  }
  if (urls.includes(url)) return "This dashboard is already in the list";
  const message = setDashboardList([...urls, url]);
  if (!message) state.titles.set(url, dashboard.title);
  return message;
}

/**
 * Replace `dashboard_urls`, keeping the current dashboard when it stays
 * listed. Returns "" when applied, otherwise the shell's reason.
 */
function setDashboardList(urls) {
  if (urls.length === 0 || urls.length > MAX_DASHBOARDS) {
    return `A dashboard list holds 1–${MAX_DASHBOARDS} dashboards`;
  }
  const current = urls.includes(state.config.dashboardUrl) ? state.config.dashboardUrl : urls[0];
  // Switch first: `current` is in the old list, and the new list contains it,
  // so the shell accepts both updates in this order (C-007 `setOption`).
  if (current !== state.config.dashboardUrl) {
    const message = persistOption("dashboard_url", current);
    if (message) return safeText(message, 120);
  }
  const message = persistOption("dashboard_urls", urls.join(","));
  if (message) return safeText(message, 120);
  state.config = { ...state.config, dashboardUrls: Object.freeze([...urls]), dashboardUrl: current };
  closeSettings();
  scheduleRotation();
  reloadDashboard();
  return "";
}

function configureField(field, { label, placeholder = "", inputMode = null }) {
  field.className = "sheet-input";
  field.setAttribute("aria-label", label);
  field.placeholder = placeholder;
  field.autocomplete = "off";
  field.setAttribute("autocapitalize", "off");
  field.setAttribute("autocorrect", "off");
  field.spellcheck = false;
  if (inputMode) field.setAttribute("inputmode", inputMode);
  return field;
}

function sheetInput({ label, placeholder = "", type = "text", inputMode = null }) {
  const input = document.createElement("input");
  input.type = type;
  return configureField(input, { label, placeholder, inputMode });
}

/** A form whose submit button (and the keyboard's Enter) runs `onSubmit` once at a time. */
function sheetForm(className, fields, label, onSubmit) {
  const form = document.createElement("form");
  form.className = className;
  form.noValidate = true;
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "sheet-action";
  submit.textContent = label;
  form.append(...fields, submit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    submit.disabled = true;
    try {
      await onSubmit();
    } finally {
      submit.disabled = false;
    }
  });
  return form;
}

function sheetError() {
  const error = document.createElement("p");
  error.className = "sheet-error";
  error.setAttribute("role", "alert");
  error.hidden = true;
  return error;
}

function setError(element, message) {
  element.textContent = message ? safeText(message, 160) : "";
  element.hidden = !message;
}

/** A segmented control: one choice of several, applied on tap. */
function segmented(label, options, current, onSelect) {
  const group = document.createElement("div");
  group.className = "segmented";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  const buttons = options.map((option) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "segment";
    button.setAttribute("role", "radio");
    button.textContent = option.label;
    if (option.aria) button.setAttribute("aria-label", option.aria);
    button.setAttribute("aria-checked", String(option.value === current));
    button.addEventListener("click", () => {
      if (onSelect(option.value) === false) return;
      for (const other of buttons) other.setAttribute("aria-checked", String(other === button));
    });
    return button;
  });
  group.append(...buttons);
  return group;
}

function settingsGroup(title, control) {
  const section = document.createElement("section");
  section.className = "sheet-group";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading, control);
  return section;
}

function lockSupport() {
  const shell = bridge();
  return typeof shell?.lockScreenEnabled === "function" && typeof shell?.setLockScreen === "function"
    ? shell
    : null;
}

function lockChoice() {
  const shell = lockSupport();
  try {
    return shell?.lockScreenEnabled() === true ? state.config.lockStyle : "off";
  } catch {
    return "off";
  }
}

/**
 * View settings sheet (C-006, C-005): time range, refresh, layout, and the
 * lock-screen view. Every choice applies at once and is persisted by the
 * shell when present; the page itself carries no controls.
 */
async function openSettings() {
  closeSettings();
  const overlay = document.createElement("div");
  overlay.className = "sheet-overlay";
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeSettings();
  });
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "View settings");

  const header = document.createElement("header");
  header.className = "sheet-header";
  const title = document.createElement("h2");
  title.textContent = "View";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "sheet-done";
  done.textContent = "Done";
  done.addEventListener("click", closeSettings);
  header.append(title, done);

  const ranges = [...RANGE_PRESETS];
  if (state.rangeText && !ranges.some((item) => parseDuration(item) === state.rangeMs)) {
    ranges.push(state.rangeText);
    ranges.sort((a, b) => parseDuration(a) - parseDuration(b));
  }
  const currentRange = ranges.find((item) => parseDuration(item) === state.rangeMs);
  const refreshes = [...new Set([...REFRESH_PRESETS, state.intervalSeconds])].sort((a, b) => a - b);

  sheet.append(
    header,
    settingsGroup(
      "Time range",
      segmented(
        "Time range",
        ranges.map((range) => ({ value: range, label: range, aria: `Last ${range}` })),
        currentRange,
        (range) => setView({ range }),
      ),
    ),
    settingsGroup(
      "Refresh",
      segmented(
        "Refresh interval",
        refreshes.map((seconds) => ({ value: seconds, label: refreshLabel(seconds) })),
        state.intervalSeconds,
        (seconds) => setView({ refreshSeconds: seconds }),
      ),
    ),
    settingsGroup(
      "Layout",
      segmented(
        "Layout",
        [
          { value: "scroll", label: "Scroll" },
          { value: "fit", label: "Fit to screen" },
        ],
        state.config.layoutMode === "fit" ? "fit" : "scroll",
        (layout) => setLayout(layout),
      ),
    ),
  );
  sheet.append(await dashboardsGroup());
  if (dashboardStore()) sheet.append(dashboardGroup());
  const collector = collectorStatus();
  if (collector) sheet.append(collectorGroup(collector));
  if (lockSupport()) {
    sheet.append(
      settingsGroup(
        "On the lock screen",
        segmented(
          "On the lock screen",
          [
            { value: "off", label: "Off" },
            { value: "monochrome", label: "Grayscale" },
            { value: "color", label: "Color" },
          ],
          lockChoice(),
          (choice) => setLockView(choice),
        ),
      ),
    );
  }
  overlay.append(sheet);
  document.body.append(overlay);
  state.sheet = overlay;
  document.addEventListener("keydown", settingsKeydown);
  done.focus();
}

/**
 * Where the dashboard definition comes from (C-002): the copy stored on the
 * phone (default; starts without the dashboard server) or live from the URL
 * on every load. "Update" re-fetches the URL into the store.
 */
function dashboardGroup() {
  const kind = state.dashboard?.source?.kind;
  const wrap = document.createElement("div");
  wrap.className = "sheet-stack";
  if (kind === "bundled" || kind === "inline") {
    const note = document.createElement("p");
    note.className = "sheet-note";
    note.textContent = kind === "bundled" ? "Built into the app" : "Pasted on this phone";
    wrap.append(note);
    return settingsGroup("Dashboard", wrap);
  }
  wrap.append(
    segmented(
      "Dashboard source",
      [
        { value: "stored", label: "Saved on phone" },
        { value: "url", label: "Live from URL" },
      ],
      state.config.dashboardSource,
      (source) => setDashboardSource(source),
    ),
  );
  if (state.config.dashboardSource === "stored") {
    const row = document.createElement("div");
    row.className = "sheet-row";
    const note = document.createElement("p");
    note.className = "sheet-note";
    const storedAt = state.dashboard?.source?.storedAt;
    note.textContent = storedAt
      ? `Saved ${new Date(storedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
      : "Not saved yet";
    const update = document.createElement("button");
    update.type = "button";
    update.className = "sheet-action";
    update.textContent = "Update from URL";
    update.addEventListener("click", async () => {
      update.disabled = true;
      try {
        const ok = await updateStoredDashboard(state.config, {
          store: dashboardStore(),
          onRequest: recordRequest,
          warn,
        });
        if (!ok) throw new Error("not stored");
        closeSettings();
        showToast("Dashboard updated");
        await reloadDashboard();
      } catch (error) {
        update.disabled = false;
        showToast(`Update failed: ${safeText(error?.message || "unknown error", 120)}`);
      }
    });
    row.append(note, update);
    wrap.append(row);
  }
  return settingsGroup("Dashboard", wrap);
}

/** The shell's on-phone Prometheus (C-007 `collectorStatus`), or null. */
function collectorStatus() {
  const shell = bridge();
  if (typeof shell?.collectorStatus !== "function") return null;
  try {
    const status = JSON.parse(shell.collectorStatus());
    return status && typeof status === "object" ? status : null;
  } catch {
    return null;
  }
}

/** The phone's own exporter job, which `collector_phone` controls (C-008). */
function isPhoneTarget(target) {
  return target.job === "phone" && target.instance === "phone";
}

/**
 * The on-phone Prometheus (C-007 `collectorStatus`, `setOption`): on/off,
 * scrape targets with whether their last scrape succeeded (`up`), and adding
 * or removing user targets (`collector_targets`). The shell restarts the
 * collector, and reloads the page when the data source changes.
 */
function collectorGroup(status) {
  const wrap = document.createElement("div");
  wrap.className = "sheet-stack";
  const error = sheetError();
  const enabled = status.enabled === true;
  const apply = (name, value, toast) => {
    const message = persistOption(name, value);
    if (message !== "") {
      setError(error, message ?? "This app cannot change the collector");
      return false;
    }
    closeSettings();
    showToast(toast);
    return true;
  };
  wrap.append(
    segmented(
      "Collector",
      [
        { value: true, label: "On" },
        { value: false, label: "Off" },
      ],
      enabled,
      (on) => on === enabled || apply("collector", String(on), on ? "Collector on" : "Collector off"),
    ),
  );
  if (enabled) {
    const summary = document.createElement("p");
    summary.className = "sheet-note";
    const restarts = Number(status.restarts) || 0;
    summary.textContent = status.running
      ? `Running on this phone${restarts > 0 ? ` · restarted ${restarts}×` : ""}`
      : `Not running${status.lastExit ? ` · ${safeText(status.lastExit, 80)}` : ""}`;
    wrap.append(summary);
  }

  const targets = (Array.isArray(status.targets) ? status.targets : [])
    .filter(
      (target) =>
        typeof target?.job === "string" &&
        typeof target.instance === "string" &&
        typeof target.address === "string",
    )
    .slice(0, MAX_TARGETS + 1);
  const userTargets = targets.filter((target) => !isPhoneTarget(target));
  const saveTargets = (next) =>
    apply("collector_targets", next.map(formatTarget).join(","), "Collector updated");

  const list = document.createElement("ul");
  list.className = "target-list";
  const rows = new Map();
  for (const target of targets) {
    const item = document.createElement("li");
    item.className = "target";
    item.dataset.up = "unknown";
    const dot = document.createElement("span");
    dot.className = "status-dot";
    dot.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "target-name";
    name.textContent = `${safeText(target.instance, 64)} · ${safeText(target.job, 64)}`;
    const address = document.createElement("span");
    address.className = "target-address";
    address.textContent = safeText(target.address, 80);
    item.append(dot, name, address);
    if (!isPhoneTarget(target)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "dashboard-remove";
      remove.setAttribute("aria-label", `Remove ${safeText(target.instance, 64)}`);
      remove.textContent = "Remove";
      remove.addEventListener("click", () => saveTargets(userTargets.filter((other) => other !== target)));
      item.classList.add("target-editable");
      item.append(remove);
    }
    list.append(item);
    rows.set(targetKey(target), item);
  }
  if (targets.length > 0) wrap.append(list);

  const addressInput = sheetInput({ label: "Target address", placeholder: "host:port", inputMode: "url" });
  addressInput.classList.add("target-form-address");
  const jobInput = sheetInput({ label: "Job", placeholder: "node" });
  const nameInput = sheetInput({ label: "Name", placeholder: "Name" });
  const form = sheetForm("target-form", [addressInput, jobInput, nameInput], "Add", () => {
    setError(error, "");
    let target;
    try {
      target = parseTarget(targetEntry(addressInput.value, jobInput.value, nameInput.value));
    } catch (problem) {
      setError(error, problem.message);
      return;
    }
    if (targets.some((other) => targetKey(other) === targetKey(target))) {
      setError(error, `${target.job} · ${target.instance} is already listed`);
      return;
    }
    saveTargets([...userTargets, target]);
  });
  if (userTargets.length >= MAX_TARGETS) {
    for (const field of form.elements) field.disabled = true;
  }
  wrap.append(form, error);

  if (status.running && typeof status.url === "string") {
    queryInstant(status.url, "up", { timeMs: Date.now(), onRequest: recordRequest, maxSeries: 64 })
      .then((result) => {
        for (const series of result.series) {
          const row = rows.get(targetKey(series.labels));
          const value = series.points.at(-1)?.v;
          if (row) row.dataset.up = value === 1 ? "up" : "down";
        }
      })
      .catch(() => {
        for (const row of rows.values()) row.dataset.up = "down";
      });
  }
  return settingsGroup("Collector", wrap);
}

/**
 * The `collector_targets` entry for the add form: just the address for the
 * default job, otherwise `job:name=address` (a non-default job needs a name,
 * since an address is not a valid instance label there).
 */
function targetEntry(address, job, name) {
  const host = address.trim();
  const jobName = job.trim();
  const instance = name.trim();
  if (!host) throw new Error("Enter the exporter's host:port");
  if (!instance && (!jobName || jobName === "node")) return host;
  if (!instance) throw new Error(`Enter a name for job ${safeText(jobName, 64)}`);
  return `${jobName || "node"}:${instance}=${host}`;
}

function setDashboardSource(source) {
  if (source === state.config.dashboardSource) return true;
  state.config = { ...state.config, dashboardSource: source };
  persistOption("dashboard_source", source);
  closeSettings();
  reloadDashboard();
  return true;
}

function settingsKeydown(event) {
  if (event.key === "Escape") closeSettings();
}

function closeSettings() {
  if (!state.sheet) return;
  state.sheet.remove();
  state.sheet = null;
  document.removeEventListener("keydown", settingsKeydown);
}

/**
 * Ask the shell to persist one launch option (C-007 `setOption`). Returns ""
 * when accepted, the shell's reason when rejected, or null without a shell
 * (the choice then applies for this session only).
 */
function persistOption(name, value) {
  const shell = bridge();
  if (typeof shell?.setOption !== "function") return null;
  try {
    const result = shell.setOption(name, String(value));
    return typeof result === "string" ? safeText(result, 120) : "";
  } catch {
    return "The app could not save this setting";
  }
}

/** Apply an in-app range/refresh choice now and ask the shell to persist it. */
function setView({ range = null, refreshSeconds = null }) {
  if (range !== null) {
    const ms = parseDuration(range);
    if (!ms) return false;
    if (ms === state.rangeMs) return true;
    state.rangeMs = ms;
    state.rangeText = range;
    state.config = { ...state.config, timeRange: range };
    persistOption("time_range", range);
    state.scheduler?.refresh("range");
  }
  if (refreshSeconds !== null) {
    if (!Number.isInteger(refreshSeconds)) return false;
    if (refreshSeconds === state.intervalSeconds) return true;
    state.intervalSeconds = refreshSeconds;
    state.config = { ...state.config, refreshSeconds };
    state.scheduler?.setIntervalSeconds(refreshSeconds);
    persistOption("refresh_seconds", refreshSeconds);
  }
  updateStatus();
  return true;
}

/** Switch between scroll and fit layout; the scroll variant keeps auto/grid/stack. */
function setLayout(layout) {
  const current = state.config.layoutMode === "fit" ? "fit" : "scroll";
  if (layout === current) return true;
  const next = layout === "fit" ? "fit" : state.scrollLayout || "auto";
  if (state.config.layoutMode !== "fit") state.scrollLayout = state.config.layoutMode;
  state.config = { ...state.config, layoutMode: next };
  persistOption("layout_mode", next);
  renderDashboard();
  return true;
}

/** Lock-screen view: off, grayscale, or colour (C-007 + `lock_style`). */
function setLockView(choice) {
  const shell = lockSupport();
  if (!shell) return false;
  try {
    if (choice === "off") {
      shell.setLockScreen(false);
    } else {
      state.config = { ...state.config, lockStyle: choice };
      persistOption("lock_style", choice);
      shell.setLockScreen(true);
      applyDisplayMode();
    }
    return shell.lockScreenEnabled() === (choice !== "off");
  } catch {
    showToast("Lock-screen view is unavailable");
    return false;
  }
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
 * A zoomed table or text panel sets its type as large as still fits the panel
 * with nothing cut off (12–44 px, binary search on `--zoom-font`; table labels
 * wrap), so zooming makes text bigger
 * rather than leaving it small in a large empty panel (C-005 "Panel zoom").
 */
function fillText(section) {
  const body = section.querySelector(".panel-body");
  if (!body) return;
  const target = body.querySelector(".table-wrap, .markdown-body");
  if (!section.classList.contains("is-zoomed") || !target) {
    body.style.removeProperty("--zoom-font");
    return;
  }
  const fits = (size) => {
    body.style.setProperty("--zoom-font", `${size}px`);
    if (body.scrollHeight > body.clientHeight + 1 || target.scrollWidth > target.clientWidth + 1) return false;
    // No cell may be cut off: labels wrap, so a clipped cell means a value
    // or a single long word is wider than its column.
    return [...target.querySelectorAll("td, th")].every((cell) => cell.scrollWidth <= cell.clientWidth + 1);
  };
  let low = 12;
  let high = 44;
  if (fits(high)) return;
  for (let step = 0; step < 7; step += 1) {
    const middle = (low + high) / 2;
    if (fits(middle)) low = middle;
    else high = middle;
  }
  body.style.setProperty("--zoom-font", `${Math.floor(low * 2) / 2}px`);
}

/**
 * Panel content can always scroll inside its panel (C-005 "Panel scrolling");
 * in the fit layout the panel itself never moves. `data-overflow` marks which
 * edges hide more content so CSS can fade them. Updated on scroll and resize
 * only — nothing runs while the panel is still.
 */
function trackOverflow(element) {
  if (!element || element.dataset.overflowTracked === "true") {
    if (element) updateOverflow(element);
    return;
  }
  element.dataset.overflowTracked = "true";
  element.addEventListener("scroll", () => updateOverflow(element), { passive: true });
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => updateOverflow(element)).observe(element);
  }
  updateOverflow(element);
}

function updateOverflow(element) {
  const below = element.scrollHeight - element.clientHeight - element.scrollTop > 2;
  const above = element.scrollTop > 2;
  const value = `${above ? "above " : ""}${below ? "below" : ""}`.trim();
  if (element.dataset.overflow !== value) element.dataset.overflow = value;
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
      });
      const empty = body.dataset.empty === "true";
      section.querySelector(".panel-body").replaceChildren(body);
      fillText(section);
      trackOverflow(section.querySelector(".panel-body"));
      section.dataset.panelState = empty ? "empty" : "ready";
      section.setAttribute("aria-busy", "false");
      section.querySelector(".panel-badge").textContent = "";
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
        size: panelBodySize(body),
        timeWindow: state.panelWindows.get(panelId) || null,
        fit: state.mode === "fit" || section.classList.contains("is-zoomed"),
        zoom: section.classList.contains("is-zoomed"),
      });
      if (!content) throw new Error(`No renderer for ${panel.panelKind}`);
      const empty = content.dataset.empty === "true";
      const scrolled = body.scrollTop;
      body.replaceChildren(content);
      // Keep the reader's place in a scrolled panel across refreshes.
      if (scrolled > 0) body.scrollTop = scrolled;
      fillText(section);
      trackOverflow(body);
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
        section.querySelector(".panel-badge").textContent = "";
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
  paintPanelError(panelId, { code, message, detail });
}

function paintPanelError(panelId, { code, message, detail }) {
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
  retryBootGaps();
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
        state.panelWindows.set(entry.panel.id, { startMs, endMs });
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
  if (state.mode === "fit") {
    const counts = fitItems().map((item) => `${item.item.panel.id}:${item.count}`).join(",");
    if (counts !== state.fitCounts) scheduleRelayout();
  }
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

/**
 * One dashboard-wide status, updated when a cycle settles or the scheduler
 * changes state. There is no per-second countdown: nothing here runs while the
 * dashboard is idle between refreshes.
 */
function updateStatus() {
  const status = currentStatus();
  if (state.statusEl) {
    const lastSuccess = state.scheduler?.state()?.lastSuccessAt;
    const total = state.filtered?.dataPanelIds?.length || 0;
    const errors = state.panelErrors.size;
    let text;
    if (status === "loading") text = "Loading";
    else if (status === "error") text = lastSuccess ? `Offline since ${formatClock(lastSuccess)}` : "Offline";
    else if (status === "stale") text = `Stale since ${formatClock(lastSuccess)}`;
    else if (status === "degraded") text = `${errors} of ${total} failing · ${formatClock(lastSuccess)}`;
    else text = lastSuccess ? formatClock(lastSuccess) : "Live";
    state.statusEl.dataset.status = status;
    // Only the dot is shown; the words are for assistive tech and hover.
    state.statusEl.setAttribute("aria-label", `${statusLabel(status)}. ${text}`);
    state.statusEl.title = text;
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
        ["source", snapshot.dashboard?.storedAt ? `${snapshot.dashboard.source} (${snapshot.dashboard.storedAt})` : snapshot.dashboard?.source],
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
    setLocked(locked) {
      try {
        const next = locked === true;
        if (next === state.locked) return;
        const wasFit = fitActive();
        state.locked = next;
        applyDisplayMode();
        // The locked view has no controls: an open sheet must not survive it.
        if (next) closeSettings();
        if (fitActive() !== wasFit && state.dashboard && state.filtered && !state.fatal) {
          renderDashboard();
        }
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

/**
 * Display mode is pure CSS: colours are variables, so switching to the locked
 * grayscale view (C-005/C-007) restyles everything without a re-render.
 */
function applyDisplayMode() {
  const lockMode = state.config?.lockStyle === "color" ? "amoled" : "monochrome";
  const mode = state.locked ? lockMode : state.config?.displayMode || "standard";
  document.documentElement.dataset.displayMode = mode;
  document.documentElement.dataset.locked = String(state.locked);
}

function updateMode() {
  if (!state.config || !state.dashboard || !state.filtered) return;
  if (state.mode === "fit") {
    scheduleRelayout();
    return;
  }
  const mode = scrollMode();
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
    installGestures();
    await loadApp();
    scheduleRotation();
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
