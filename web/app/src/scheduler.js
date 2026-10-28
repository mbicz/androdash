/**
 * Refresh orchestration: one request cycle at a time, coalesced manual
 * refreshes, no interval before the previous cycle settles, and no timer work
 * while the document is hidden.
 */
export class Scheduler {
  constructor({
    intervalSeconds,
    run,
    now = () => Date.now(),
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (id) => clearTimeout(id),
    onState = null,
  }) {
    this.intervalMs = Math.max(0, Number(intervalSeconds) || 0) * 1000;
    this.run = run;
    this.now = now;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.onState = onState;
    this.active = false;
    this.visible = true;
    this.running = false;
    this.rerunAfter = false;
    this.timer = null;
    this.currentPromise = null;
    this.nextRefreshAt = null;
    this.lastStartedAt = null;
    this.lastFinishedAt = null;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastResult = null;
    this.lastReason = null;
    this.generation = 0;
  }

  get intervalLabelSeconds() {
    return this.intervalMs / 1000;
  }

  state() {
    return {
      running: this.running,
      active: this.active,
      visible: this.visible,
      nextRefreshAt: this.nextRefreshAt,
      lastStartedAt: this.lastStartedAt,
      lastFinishedAt: this.lastFinishedAt,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      lastResult: this.lastResult,
      lastReason: this.lastReason,
      intervalSeconds: this.intervalLabelSeconds,
    };
  }

  notify() {
    this.onState?.(this.state());
  }

  start() {
    if (this.active) return this.currentPromise;
    this.active = true;
    this.generation += 1;
    this.notify();
    if (this.visible) return this.request("initial");
    return null;
  }

  stop() {
    this.active = false;
    this.generation += 1;
    this.running = false;
    this.rerunAfter = false;
    this.currentPromise = null;
    this.clearTimer();
    this.nextRefreshAt = null;
    this.notify();
  }

  clearTimer() {
    if (this.timer !== null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
  }

  schedule(delayMs = this.intervalMs) {
    this.clearTimer();
    if (!this.active || !this.visible || this.intervalMs === 0) {
      this.nextRefreshAt = null;
      this.notify();
      return;
    }
    const delay = Math.max(0, delayMs);
    this.nextRefreshAt = this.now() + delay;
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      this.nextRefreshAt = null;
      this.request("interval");
    }, delay);
    this.notify();
  }

  refresh(reason = "manual") {
    if (!this.active) return null;
    return this.request(reason);
  }

  request(reason) {
    if (this.running) {
      this.rerunAfter = true;
      this.notify();
      return this.currentPromise;
    }
    this.clearTimer();
    this.nextRefreshAt = null;
    this.currentPromise = this.execute(reason);
    return this.currentPromise;
  }

  async execute(reason) {
    const generatedAt = this.generation;
    this.running = true;
    this.lastReason = reason;
    this.lastStartedAt = this.now();
    this.notify();
    let result = null;
    try {
      result = await this.run({ reason, startedAt: this.lastStartedAt });
    } catch (error) {
      result = { ok: false, failed: 1, total: 1, error };
    }
    if (generatedAt !== this.generation) {
      return result;
    }
    this.running = false;
    this.currentPromise = null;
    this.lastFinishedAt = this.now();
    this.lastResult = result;
    if (result?.ok === false) {
      this.lastFailureAt = this.lastFinishedAt;
    } else {
      this.lastSuccessAt = this.lastFinishedAt;
    }
    this.notify();

    if (this.active && this.visible) {
      if (this.rerunAfter) {
        this.rerunAfter = false;
        this.schedule(0);
      } else {
        this.schedule(this.intervalMs);
      }
    } else {
      this.nextRefreshAt = null;
      this.notify();
    }
    return result;
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!this.active) {
      this.notify();
      return;
    }
    if (!visible) {
      this.clearTimer();
      this.nextRefreshAt = null;
      this.notify();
      return;
    }
    if (this.running) {
      this.notify();
      return;
    }
    if (this.lastSuccessAt === null) {
      this.request("visible");
      return;
    }
    const elapsed = this.now() - this.lastSuccessAt;
    if (elapsed >= this.intervalMs || this.intervalMs === 0) {
      this.request("visible");
    } else {
      this.schedule(this.intervalMs - elapsed);
    }
  }
}
