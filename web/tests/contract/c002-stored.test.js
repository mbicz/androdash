import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { isLocalDashboard, loadDashboard, updateStoredDashboard } from "../../app/src/dashboard/load.js";

const fixture = JSON.parse(
  await fs.readFile(new URL("../../../contracts/fixtures/demo-dashboard.json", import.meta.url)),
);
const URL_A = "http://192.168.1.20:8099/contracts/fixtures/demo-dashboard.json";
const title = fixture.spec.display?.name || fixture.metadata.name;

function memoryStore(initial = null) {
  const store = {
    saved: initial,
    writes: 0,
    async read() {
      return store.saved;
    },
    write(sourceUrl, json) {
      store.writes += 1;
      store.saved = { meta: { sourceUrl, storedAt: 42 }, data: JSON.parse(json) };
      return true;
    },
  };
  return store;
}

function withFetch(handler, body) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls += 1;
    return handler(url);
  };
  return body(() => calls).finally(() => {
    globalThis.fetch = original;
  });
}

const ok = (url, data) => ({
  ok: true,
  status: 200,
  url,
  headers: new Map([["content-type", "application/json"]]),
  text: async () => JSON.stringify(data),
});
const down = async () => {
  throw new TypeError("Failed to fetch");
};

const config = (overrides = {}) => ({
  dashboardUrl: URL_A,
  dashboardName: null,
  dashboardSource: "stored",
  ...overrides,
});

test("C-002 stored source fetches once, stores, then starts with the server down", async () => {
  const store = memoryStore();
  await withFetch(async (url) => ok(url, fixture), async () => {
    const first = await loadDashboard(config(), { store, now: () => 7 });
    assert.equal(first.source.kind, "stored");
    assert.equal(first.source.storedAt, 7);
    assert.equal(store.writes, 1);
    assert.equal(store.saved.meta.sourceUrl, URL_A);
  });
  await withFetch(down, async (calls) => {
    const second = await loadDashboard(config(), { store });
    assert.equal(calls(), 0);
    assert.equal(second.source.kind, "stored");
    assert.equal(second.title, title);
  });
});

test("C-002 a stored copy from another URL is replaced, not used", async () => {
  const store = memoryStore({ meta: { sourceUrl: "http://old/x.json", storedAt: 1 }, data: fixture });
  await withFetch(async (url) => ok(url, fixture), async (calls) => {
    const dashboard = await loadDashboard(config(), { store });
    assert.equal(calls(), 1);
    assert.equal(store.saved.meta.sourceUrl, URL_A);
    assert.equal(dashboard.source.kind, "stored");
  });
});

test("C-002 url source always fetches and never stores", async () => {
  const store = memoryStore({ meta: { sourceUrl: URL_A, storedAt: 1 }, data: fixture });
  await withFetch(async (url) => ok(url, fixture), async (calls) => {
    const dashboard = await loadDashboard(config({ dashboardSource: "url" }), { store });
    assert.equal(calls(), 1);
    assert.equal(store.writes, 0);
    assert.equal(dashboard.source.kind, "url");
  });
});

test("C-002 an unusable stored copy warns and falls back to the URL", async () => {
  const store = memoryStore({ meta: { sourceUrl: URL_A, storedAt: 1 }, data: { kind: "Nope" } });
  const warnings = [];
  await withFetch(async (url) => ok(url, fixture), async (calls) => {
    await loadDashboard(config(), { store, warn: (code) => warnings.push(code) });
    assert.equal(calls(), 1);
  });
  assert.ok(warnings.includes("W_STORED_DASHBOARD_INVALID"));
});

test("C-002 local dashboard URLs are bundled or inline on androdash.local", () => {
  assert.equal(isLocalDashboard("http://androdash.local/dashboards/demo-dashboard.json"), true);
  assert.equal(isLocalDashboard("http://androdash.local/inline/0123456789abcdef.json"), true);
  assert.equal(isLocalDashboard(URL_A), false);
  assert.equal(isLocalDashboard("http://androdash.local/stored/0/dashboard.json"), false);
  assert.equal(isLocalDashboard("http://androdash.local/index.html"), false);
  assert.equal(isLocalDashboard("https://androdash.local/dashboards/demo-dashboard.json"), false);
  assert.equal(isLocalDashboard("http://example.com/dashboards/demo-dashboard.json"), false);
  assert.equal(isLocalDashboard("http://example.com/inline/0123456789abcdef.json"), false);
  assert.equal(isLocalDashboard("not a url"), false);
});

test("C-002 bundled dashboards are local and never stored", async () => {
  const bundled = "http://androdash.local/dashboards/demo-dashboard.json";
  const store = memoryStore();
  await withFetch(async (url) => ok(url, fixture), async () => {
    const dashboard = await loadDashboard(config({ dashboardUrl: bundled }), { store });
    assert.equal(dashboard.source.kind, "bundled");
    assert.equal(store.writes, 0);
  });
});

test("C-002 inline dashboards are local and never stored", async () => {
  const inline = "http://androdash.local/inline/0123456789abcdef.json";
  const store = memoryStore({ meta: { sourceUrl: inline, storedAt: 1 }, data: fixture });
  await withFetch(async (url) => ok(url, fixture), async (calls) => {
    const dashboard = await loadDashboard(config({ dashboardUrl: inline }), { store });
    assert.equal(calls(), 1);
    assert.equal(dashboard.source.kind, "inline");
    assert.equal(store.writes, 0);
    assert.equal(await updateStoredDashboard(config({ dashboardUrl: inline }), { store }), false);
    assert.equal(store.writes, 0);
  });
});

test("C-002 updating keeps the old copy when the new definition is invalid", async () => {
  const store = memoryStore({ meta: { sourceUrl: URL_A, storedAt: 1 }, data: fixture });
  await withFetch(async (url) => ok(url, { kind: "Nope" }), async () => {
    await assert.rejects(updateStoredDashboard(config(), { store }));
    assert.equal(store.writes, 0);
  });
});
