import test from "node:test";
import assert from "node:assert/strict";
import { formatTarget, parseTarget, targetKey } from "../../app/src/collector-targets.js";

test("C-001 collector target host:port defaults job node and instance to the address", () => {
  assert.deepEqual(parseTarget("192.168.1.20:9100"), {
    job: "node",
    instance: "192.168.1.20:9100",
    address: "192.168.1.20:9100",
  });
  assert.deepEqual(parseTarget("  mac.local:9100 "), {
    job: "node",
    instance: "mac.local:9100",
    address: "mac.local:9100",
  });
});

test("C-001 collector target labels: instance=address and job:instance=address", () => {
  assert.deepEqual(parseTarget("mac=192.168.1.20:9100"), {
    job: "node",
    instance: "mac",
    address: "192.168.1.20:9100",
  });
  assert.deepEqual(parseTarget("agenticmac:mac=192.168.1.20:9106"), {
    job: "agenticmac",
    instance: "mac",
    address: "192.168.1.20:9106",
  });
});

test("C-001 collector target canonical form round-trips", () => {
  for (const entry of [
    "192.168.1.20:9100",
    "localhost:9100",
    "node:mac=192.168.1.20:9100",
    "spark:gx10.local=gx10.local:9200",
    "[::1]:9100",
    "v6:box=[fe80::1:2]:9100",
    "edge:a_b-c.d=[::ffff:192.168.1.20]:65535",
  ]) {
    const target = parseTarget(entry);
    assert.deepEqual(parseTarget(formatTarget(target)), target, entry);
  }
  assert.equal(formatTarget(parseTarget("node:mac=192.168.1.20:9100")), "node:mac=192.168.1.20:9100");
  assert.equal(formatTarget(parseTarget("mac=192.168.1.20:9100")), "node:mac=192.168.1.20:9100");
  assert.equal(formatTarget({ job: "node", instance: "h:1", address: "h:1" }), "h:1");
  assert.equal(formatTarget({ job: "spark", instance: "gx", address: "h:1" }), "spark:gx=h:1");
});

test("C-001 collector target IPv6 addresses need brackets and valid groups", () => {
  assert.equal(parseTarget("[2001:db8::1]:9100").address, "[2001:db8::1]:9100");
  assert.equal(parseTarget("[1:2:3:4:5:6:7:8]:9100").address, "[1:2:3:4:5:6:7:8]:9100");
  for (const entry of ["[::1]", "[::1]9100", "[1:2:3:4:5:6:7]:9100", "[1::2::3]:9100", "[gggg::1]:9100", "::1:9100"]) {
    assert.throws(() => parseTarget(entry), Error, entry);
  }
});

test("C-001 collector target rejects invalid hosts and ports", () => {
  for (const entry of [
    "",
    "host",
    ":9100",
    "host:",
    "host:0",
    "host:65536",
    "host:09100",
    "host:91a",
    "-host:9100",
    "host-.local:9100",
    "ho_st:9100",
    "a..b:9100",
    "256.1.1.1:9100",
    "1.2.3:9100",
    "01.2.3.4:9100",
    `${"a".repeat(64)}:9100`,
  ]) {
    assert.throws(() => parseTarget(entry), Error, entry);
  }
});

test("C-001 collector target rejects invalid job and instance labels", () => {
  for (const entry of [
    "=host:9100",
    ":mac=host:9100",
    "job:=host:9100",
    "jo b:mac=host:9100",
    "job:m/c=host:9100",
    "job:a:b=host:9100",
    `${"j".repeat(65)}:mac=host:9100`,
    `job:${"i".repeat(65)}=host:9100`,
  ]) {
    assert.throws(() => parseTarget(entry), Error, entry);
  }
});

test("C-001 collector target identity is job and instance", () => {
  const a = parseTarget("mac=192.168.1.20:9100");
  const b = parseTarget("node:mac=192.168.1.21:9100");
  const c = parseTarget("other:mac=192.168.1.20:9100");
  assert.equal(targetKey(a), targetKey(b));
  assert.notEqual(targetKey(a), targetKey(c));
});
