import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../app/src/scheduler.js";

function fakeTimers(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  const setTimeoutFn = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, ms), fn });
    return id;
  };
  const clearTimeoutFn = (id) => timers.delete(id);
  const advance = (ms) => {
    now += ms;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= now)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      due[1].fn();
    }
  };
  return {
    setTimeoutFn,
    clearTimeoutFn,
    now: () => now,
    advance,
    pending: () => timers.size,
  };
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

test("C-006 runs immediately, schedules after settle, and respects manual mode", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const scheduler = new Scheduler({
    intervalSeconds: 10,
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    run: async () => {
      calls += 1;
      return { ok: true, succeeded: 1, failed: 0, total: 1 };
    },
  });
  await scheduler.start();
  await flush();
  assert.equal(calls, 1);
  assert.equal(timers.pending(), 1);
  timers.advance(10_000);
  await flush();
  assert.equal(calls, 2);
  scheduler.stop();
  assert.equal(timers.pending(), 0);

  const manual = new Scheduler({
    intervalSeconds: 0,
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    run: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  await manual.start();
  await flush();
  assert.equal(timers.pending(), 0);
  await manual.refresh("manual");
  await flush();
  assert.equal(calls, 4);
  manual.stop();
});

test("C-006 coalesces manual refresh while a cycle is running", async () => {
  const timers = fakeTimers();
  let calls = 0;
  let resolveRun;
  const scheduler = new Scheduler({
    intervalSeconds: 30,
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    run: async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve) => {
          resolveRun = () => resolve({ ok: true, succeeded: 1, failed: 0, total: 1 });
        });
      }
      return { ok: true, succeeded: 1, failed: 0, total: 1 };
    },
  });
  const first = scheduler.start();
  await flush();
  assert.equal(calls, 1);
  const second = scheduler.refresh("manual");
  assert.equal(second, first);
  assert.equal(scheduler.state().running, true);
  resolveRun();
  await first;
  await flush();
  assert.equal(calls, 1);
  timers.advance(0);
  await flush();
  assert.equal(calls, 2);
  assert.equal(timers.pending(), 1);
  scheduler.stop();
});

test("C-006 pauses timers while hidden and refreshes when stale on visible", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const scheduler = new Scheduler({
    intervalSeconds: 10,
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    run: async () => {
      calls += 1;
      return { ok: true, succeeded: 1, failed: 0, total: 1 };
    },
  });
  await scheduler.start();
  await flush();
  assert.equal(calls, 1);
  scheduler.setVisible(false);
  assert.equal(timers.pending(), 0);
  timers.advance(60_000);
  await flush();
  assert.equal(calls, 1);
  scheduler.setVisible(true);
  await flush();
  assert.equal(calls, 2);
  scheduler.stop();
});

test("C-006 records failure and success timestamps", async () => {
  const timers = fakeTimers();
  let fail = true;
  const scheduler = new Scheduler({
    intervalSeconds: 0,
    now: timers.now,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    run: async () => ({ ok: !fail, succeeded: fail ? 0 : 1, failed: fail ? 1 : 0, total: 1 }),
  });
  await scheduler.start();
  await flush();
  assert.equal(scheduler.state().lastFailureAt, timers.now());
  assert.equal(scheduler.state().lastSuccessAt, null);
  fail = false;
  await scheduler.refresh("manual");
  await flush();
  assert.equal(scheduler.state().lastSuccessAt, timers.now());
  scheduler.stop();
});
