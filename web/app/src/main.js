import { ConfigError, parseConfig } from "./config.js";
import { loadDashboard } from "./dashboard/load.js";
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
import { FIT_EXCLUDED_KINDS, planFit } from "./fit.js";
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
  statusTextEl: null,
  rangeText: null,
  panelWindows: new Map(),
  locked: false,
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

  state.variables = await resolveVariables(dashboard, {
    config: state.config,
    advertisedCapabilities: state.advertised,
    labelValues: ({ baseUrl, labelName, matchers }) =>
      prometheusLabelValues(baseUrl, labelName, matchers, { onRequest: recordRequest }),
    warn,
  });
  applyDisplayVariables(dashboard, state.variables, warn);

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
  state.fitCounts = null;
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
    // Sections snap under the sticky header; keep the snap offset equal to it.
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(([entry]) => {
        const height = Math.round(entry.target.getBoundingClientRect().height);
        document.documentElement.style.setProperty("--header-h", `${height}px`);
      }).observe(header);
    }
  }
  app.setAttribute("aria-busy", "false");
  document.title = `${state.dashboard.title} · AndroDash`;

  for (const entry of state.filtered.visible.values()) {
    if (entry.panel.panelKind === "Markdown") renderMarkdownPanel(entry.panel.id);
  }
  restorePanels();
  updateStatus();
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
      if (FIT_EXCLUDED_KINDS.has(item.panel.panelKind)) continue;
      items.push({
        id: String(items.length),
        kind: item.panel.panelKind,
        count: displayCount(item.panel),
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
  main.style.gridTemplateRows = plan.rows
    .map((row) => {
      const min = Math.round(row.minHeight * plan.scale);
      return row.maxHeight
        ? `minmax(${min}px, ${Math.round(row.maxHeight * plan.scale)}px)`
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
  const text = document.createElement("span");
  text.className = "status-text";
  status.append(dot, text);
  state.statusEl = status;
  state.statusTextEl = text;

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
  header.append(heading, actions);
  return header;
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
function openSettings() {
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

function settingsKeydown(event) {
  if (event.key === "Escape") closeSettings();
}

function closeSettings() {
  if (!state.sheet) return;
  state.sheet.remove();
  state.sheet = null;
  document.removeEventListener("keydown", settingsKeydown);
}

/** Ask the shell to persist one launch option (C-007 `setOption`). */
function persistOption(name, value) {
  try {
    bridge()?.setOption?.(name, String(value));
  } catch {
    // The browser has no shell; the choice still applies for this session.
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
        fit: state.mode === "fit",
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
  if (state.statusEl && state.statusTextEl) {
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
    state.statusTextEl.textContent = text;
    state.statusEl.setAttribute("aria-label", `${statusLabel(status)}. ${text}`);
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
