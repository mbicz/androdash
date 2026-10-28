import test from "node:test";
import assert from "node:assert/strict";
import { buildQuery, ConfigError, parseConfig } from "../../app/src/config.js";

const base =
  "?dashboard_url=http%3A%2F%2Flocalhost%3A8099%2Fcontracts%2Ffixtures%2Fdemo-dashboard.json";

test("C-001 requires an absolute http(s) dashboard URL", () => {
  assert.throws(() => parseConfig(""), ConfigError);
  assert.throws(() => parseConfig("?dashboard_url="), ConfigError);
  assert.throws(() => parseConfig("?dashboard_url=file%3A%2F%2F%2Ftmp%2Fd.json"), ConfigError);
  assert.throws(
    () => parseConfig("?dashboard_url=http%3A%2F%2Fuser%3Apass%40host%2Fd.json"),
    ConfigError,
  );
});

test("C-001 parses defaults and canonical optional values", () => {
  const { config, warnings } = parseConfig(
    `${base}&prometheus_url=http%3A%2F%2Flocalhost%3A9091&refresh_seconds=10&time_range=15m&debug=true&layout_mode=stack&capabilities=Prometheus%2C%20tempo%2Cprometheus`,
  );
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.prometheusUrl, "http://localhost:9091");
  assert.equal(config.refreshSeconds, 10);
  assert.equal(config.timeRange, "15m");
  assert.equal(config.kiosk, true);
  assert.equal(config.debug, true);
  assert.equal(config.showUnsupported, false);
  assert.equal(config.layoutMode, "stack");
  assert.equal(config.displayMode, "standard");
  assert.deepEqual(config.capabilities, ["prometheus", "tempo"]);
  assert.equal(warnings.length, 0);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.capabilities));
});

test("C-001 treats empty optional wire values as unset", () => {
  const { config } = parseConfig(
    `${base}&prometheus_url=&refresh_seconds=&time_range=&step_seconds=&dashboard_name=&capabilities=&layout_mode=&show_unsupported=`,
  );
  assert.equal(config.prometheusUrl, null);
  assert.equal(config.refreshSeconds, null);
  assert.equal(config.timeRange, null);
  assert.equal(config.stepSeconds, null);
  assert.equal(config.dashboardName, null);
  assert.equal(config.capabilities, null);
  assert.equal(config.layoutMode, "auto");
  assert.equal(config.displayMode, "standard");
  assert.equal(config.showUnsupported, false);
});

test("C-001 accepts display modes and rejects unknown ones", () => {
  assert.equal(parseConfig(`${base}&display_mode=amoled`).config.displayMode, "amoled");
  assert.equal(
    parseConfig(`${base}&display_mode=monochrome`).config.displayMode,
    "monochrome",
  );
  assert.throws(() => parseConfig(`${base}&display_mode=light`), ConfigError);
});

test("C-001 clamps refresh 1..4 to 5 and validates ranges", () => {
  const { config, warnings } = parseConfig(`${base}&refresh_seconds=3`);
  assert.equal(config.refreshSeconds, 5);
  assert.equal(warnings[0].code, "W_REFRESH_CLAMPED");
  assert.equal(parseConfig(`${base}&refresh_seconds=0`).config.refreshSeconds, 0);
  assert.equal(parseConfig(`${base}&refresh_seconds=3600`).config.refreshSeconds, 3600);
  assert.throws(() => parseConfig(`${base}&refresh_seconds=3601`), ConfigError);
  assert.throws(() => parseConfig(`${base}&refresh_seconds=1.5`), ConfigError);
  assert.throws(() => parseConfig(`${base}&step_seconds=0`), ConfigError);
  assert.throws(() => parseConfig(`${base}&time_range=500ms`), ConfigError);
  assert.throws(() => parseConfig(`${base}&time_range=31d`), ConfigError);
});

test("C-001 normalizes capabilities: trim, lowercase, dedupe, sort, max 16", () => {
  const { config } = parseConfig(`${base}&capabilities=%20B%2Ca%2Cb%20`);
  assert.deepEqual(config.capabilities, ["a", "b"]);
  assert.equal(parseConfig(`${base}&capabilities=%2C%20%2C`).config.capabilities, null);
  assert.throws(() => parseConfig(`${base}&capabilities=bad%20id`), ConfigError);
  assert.throws(
    () => parseConfig(`${base}&capabilities=${Array.from({ length: 17 }, (_, i) => `c${i}`).join(",")}`),
    ConfigError,
  );
});

test("C-001 rejects oversized query strings and invalid booleans/layouts", () => {
  assert.throws(() => parseConfig(`${base}&x=${"a".repeat(2100)}`), ConfigError);
  assert.throws(() => parseConfig(`${base}&debug=yes`), ConfigError);
  assert.throws(() => parseConfig(`${base}&layout_mode=wide`), ConfigError);
  assert.throws(() => parseConfig(`${base}&lock_style=sepia`), ConfigError);
  assert.throws(() => parseConfig(`${base}&dashboard_source=cache`), ConfigError);
});

test("C-001 fit layout, lock style, and dashboard source defaults and values", () => {
  const defaults = parseConfig(base).config;
  assert.equal(defaults.lockStyle, "monochrome");
  assert.equal(defaults.dashboardSource, "stored");
  const { config } = parseConfig(`${base}&layout_mode=fit&lock_style=color&dashboard_source=url`);
  assert.equal(config.layoutMode, "fit");
  assert.equal(config.lockStyle, "color");
  assert.equal(config.dashboardSource, "url");
});

test("C-001 canonical query round-trips", () => {
  const { config } = parseConfig(
    `${base}&prometheus_url=http%3A%2F%2Flocalhost%3A9091&refresh_seconds=10&time_range=15m&step_seconds=15&kiosk=false&debug=true&layout_mode=grid&display_mode=monochrome&dashboard_name=Main&capabilities=prometheus&show_unsupported=true&lock_style=color&dashboard_source=url`,
  );
  const round = parseConfig(buildQuery(config)).config;
  assert.deepEqual(round, config);
});
