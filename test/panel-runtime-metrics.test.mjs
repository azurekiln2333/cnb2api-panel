import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeMetrics } from "../src/runtime-metrics.mjs";
import { logChannel } from "../src/file-storage.mjs";

// Every clock, scheduler and measurement below is injected, so the test never
// waits for real time and never depends on the machine being idle or busy.
function fixture(t, options = {}) {
  let utilization = 0;
  let now = Date.parse("2026-11-14T00:00:00Z");
  const entries = [];
  const scheduled = [];
  const performance = {
    set(next) {
      utilization = next;
    },
    eventLoopUtilization: () => ({ utilization }),
  };
  const delay = {
    enabled: false,
    enable() {
      this.enabled = true;
    },
    disable() {
      this.enabled = false;
    },
    percentile: () => 12e6,
    get max() {
      return 30e6;
    },
    reset() {},
  };
  const store = {
    entries,
    record(entry) {
      entries.push(entry);
    },
  };
  const metrics = new RuntimeMetrics(store, {
    performance,
    delay,
    clock: () => now,
    schedule: (callback, intervalMs) => {
      const timer = {
        callback,
        intervalMs,
        unref: () => {
          timer.unrefed = true;
        },
      };
      scheduled.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
    ...options,
  });
  t.after(() => metrics.stop());
  return {
    metrics,
    entries,
    delay,
    scheduled,
    set: (next) => performance.set(next),
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

test("a saturated event loop becomes one system entry per notice window", (t) => {
  const f = fixture(t);
  f.set(0.9);
  assert.equal(f.metrics.sample().samples, 0);
  f.metrics.sample();
  assert.equal(f.entries.length, 0);
  f.metrics.sample();
  assert.equal(f.entries.length, 1);
  const [entry] = f.entries;
  assert.equal(entry.kind, "system");
  assert.equal(logChannel(entry), "system");
  assert.match(entry.message, /事件循环利用率 90%/);
  assert.match(entry.message, /连续 2 次采样超过 80%/);
  assert.match(entry.message, /事件循环延迟 p99 12ms/);
  assert.match(entry.message, /5 分钟内只记录一次/);
  // Further saturated samples inside the window stay silent.
  for (let sample = 0; sample < 5; sample++) f.metrics.sample();
  assert.equal(f.entries.length, 1);
  f.advance(300000);
  f.metrics.sample();
  assert.equal(f.entries.length, 2);
  assert.equal(f.metrics.snapshot().notices, 2);
});

test("a dip below the threshold needs two new saturated samples", (t) => {
  const f = fixture(t);
  f.set(0.95);
  f.metrics.sample();
  f.metrics.sample();
  f.metrics.sample();
  assert.equal(f.entries.length, 1);
  f.set(0.1);
  f.metrics.sample();
  assert.equal(f.metrics.snapshot().elevatedSamples, 0);
  f.advance(300000);
  f.set(0.95);
  f.metrics.sample();
  assert.equal(f.entries.length, 1);
  f.metrics.sample();
  assert.equal(f.entries.length, 2);
});

test("snapshot reports the last utilization and delay percentiles", (t) => {
  const f = fixture(t);
  assert.equal(f.metrics.snapshot().utilization, null);
  f.set(0.42);
  f.metrics.sample();
  const snapshot = f.metrics.sample();
  assert.equal(snapshot.utilization, 0.42);
  assert.equal(snapshot.samples, 1);
  assert.equal(snapshot.delayP99Ms, 12);
  assert.equal(snapshot.delayMaxMs, 30);
  assert.equal(snapshot.lastNoticeAt, null);
  assert.equal(snapshot.notices, 0);
});

test("start and stop use the injected scheduler and never double schedule", (t) => {
  const f = fixture(t);
  f.metrics.start();
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0].intervalMs, 30000);
  assert.equal(f.scheduled[0].unrefed, true);
  assert.equal(f.delay.enabled, true);
  f.metrics.start();
  assert.equal(f.scheduled.length, 1);
  f.set(0.9);
  f.scheduled[0].callback();
  assert.equal(f.entries.length, 0);
  f.scheduled[0].callback();
  assert.equal(f.entries.length, 1);
  f.scheduled[0].callback();
  assert.equal(f.entries.length, 1);
  f.metrics.stop();
  assert.equal(f.scheduled[0].cancelled, true);
  assert.equal(f.delay.enabled, false);
  assert.equal(f.metrics.timer, null);
});

test("a failing system log write never breaks sampling", (t) => {
  const f = fixture(t, {});
  f.metrics.store = {
    record() {
      throw new Error("storage unavailable");
    },
  };
  f.set(0.9);
  f.metrics.sample();
  f.metrics.sample();
  const snapshot = f.metrics.sample();
  assert.equal(snapshot.notices, 1);
  assert.equal(snapshot.samples, 2);
  assert.equal(snapshot.utilization, 0.9);
});
