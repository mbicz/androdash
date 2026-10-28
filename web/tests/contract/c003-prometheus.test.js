import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  buildInstantUrl,
  buildLabelValuesUrl,
  buildRangeUrl,
  normalizeEnvelope,
  PrometheusError,
  queryRange,
  seriesDisplayName,
  seriesLabel,
  stepFor,
} from "../../app/src/prometheus.js";

const readFixture = async (name) =>
  JSON.parse(await fs.readFile(new URL(`../../../contracts/fixtures/prometheus/${name}`, import.meta.url)));

test("C-003 builds range, instant, and label-values URLs with encoded params", () => {
  const range = new URL(
    buildRangeUrl("http://localhost:9091/", 'up{job="a b"}', {
      startMs: 1793016900123,
      endMs: 1793017800456,
      stepSeconds: 15,
    }),
  );
  assert.equal(range.origin + range.pathname, "http://localhost:9091/api/v1/query_range");
  assert.equal(range.searchParams.get("query"), 'up{job="a b"}');
  assert.equal(range.searchParams.get("start"), "1793016900.123");
  assert.equal(range.searchParams.get("end"), "1793017800.456");
  assert.equal(range.searchParams.get("step"), "15");
  assert.equal(range.searchParams.get("timeout"), "10s");

  const instant = new URL(buildInstantUrl("http://localhost:9091", "up", 1793016900123));
  assert.equal(instant.pathname, "/api/v1/query");
  assert.equal(instant.searchParams.get("time"), "1793016900.123");

  const labels = new URL(
    buildLabelValuesUrl("http://localhost:9091/", "job/name", ['up{job="a"}', 'up{job="b"}']),
  );
  assert.equal(labels.pathname, "/api/v1/label/job%2Fname/values");
  assert.deepEqual(labels.searchParams.getAll("match[]"), ['up{job="a"}', 'up{job="b"}']);
});

test("C-003 step formula and edges", () => {
  assert.equal(stepFor(900), 15);
  assert.equal(stepFor(36000), 150);
  assert.equal(stepFor(900, 30), 30);
  assert.equal(stepFor(0), 15);
});

test("C-003 normalizes the CPU matrix fixture", async () => {
  const envelope = await readFixture("query-range-cpu.json");
  const result = normalizeEnvelope(envelope);
  assert.equal(result.resultType, "matrix");
  assert.equal(result.series.length, 2);
  const labels = result.series.map((item) => item.labels.mode).sort();
  assert.deepEqual(labels, ["system", "user"]);
  assert.ok(result.series[0].points.length > 1);
  assert.equal(typeof result.series[0].points[0].t, "number");
  assert.equal(typeof result.series[0].points[0].v, "number");
});

test("C-003 normalizes vector and scalar results and skips malformed points", () => {
  const vector = normalizeEnvelope({
    status: "success",
    data: {
      resultType: "vector",
      result: [
        { metric: { __name__: "x", job: "demo" }, value: [1, "2.5"] },
        { metric: { __name__: "y" }, value: [1, "NaN"] },
      ],
    },
  });
  assert.equal(vector.series.length, 2);
  assert.equal(vector.series.find((item) => item.labels.__name__ === "y").points[0].v, null);
  const scalar = normalizeEnvelope({
    status: "success",
    data: { resultType: "scalar", result: [1, "3"] },
  });
  assert.equal(scalar.series[0].points[0].v, 3);
});

test("C-003 maps Prometheus error envelopes to E_PROM_QUERY", async () => {
  const envelope = await readFixture("query-error.json");
  assert.throws(
    () => normalizeEnvelope(envelope),
    (error) => error instanceof PrometheusError && error.code === "E_PROM_QUERY",
  );
});

test("C-003 sorts series and enforces series/point limits", () => {
  const values = Array.from({ length: 14 }, (_, i) => ({
    metric: { __name__: "z", instance: String(13 - i) },
    values: Array.from({ length: 700 }, (_, j) => [j, String(j)]),
  }));
  const result = normalizeEnvelope({
    status: "success",
    data: { resultType: "matrix", result: values },
  });
  assert.equal(result.series.length, 12);
  assert.equal(result.series[0].labels.instance, "0");
  assert.ok(result.series[0].points.length <= 600);
  assert.ok(result.warnings.some((item) => item.code === "W_SERIES_TRUNCATED"));
  assert.ok(result.warnings.some((item) => item.code === "W_POINTS_TRUNCATED"));
});

test("C-003 formats deterministic label strings", () => {
  assert.equal(
    seriesLabel({ __name__: "demo_requests_total", code: "200", job: "demo" }),
    'demo_requests_total{code="200", job="demo"}',
  );
  assert.equal(
    seriesDisplayName({
      __name__: "spark_engine_tokens_per_second",
      direction: "input",
      engine: "vllm",
      model: "qwen3-coder-30b",
    }),
    "direction=input · engine=vllm",
  );
  assert.equal(seriesDisplayName({ __name__: "node_load1" }), "node_load1");
});

test("C-003 maps HTTP and network failures without leaking query strings", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response('{"status":"error","error":"nope"}', {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    await assert.rejects(
      queryRange("http://localhost:9091", "up", {
        startMs: 1,
        endMs: 2,
        stepSeconds: 1,
      }),
      (error) => error.code === "E_PROM_HTTP" && error.status === 500,
    );

    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    await assert.rejects(
      queryRange("http://localhost:9091", "up", {
        startMs: 1,
        endMs: 2,
        stepSeconds: 1,
      }),
      (error) => error.code === "E_PROM_NETWORK" && !String(error.detail).includes("?"),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
