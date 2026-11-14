import { monitorEventLoopDelay } from "node:perf_hooks";

// A panel that is CPU bound shows up as a saturated event loop long before the
// request log does, so a sustained high utilization becomes one system entry.
export const SLOW_EVENT_LOOP_UTILIZATION = 0.8;
const SAMPLE_INTERVAL_MS = 30000;
const NOTICE_INTERVAL_MS = 300000;
// One spike must not be enough; two consecutive saturated samples is.
const CONSECUTIVE_SAMPLES = 2;
const NS_PER_MS = 1e6;

/**
 * Samples `performance.eventLoopUtilization()` and the event loop delay
 * histogram, and reports sustained saturation through the system log channel.
 * Every dependency is injectable so tests never wait for real time.
 */
export class RuntimeMetrics {
  constructor(
    store,
    {
      performance: perf = globalThis.performance,
      // `null` disables delay sampling; `undefined` creates the histogram.
      delay = undefined,
      clock = Date.now,
      intervalMs = SAMPLE_INTERVAL_MS,
      noticeIntervalMs = NOTICE_INTERVAL_MS,
      threshold = SLOW_EVENT_LOOP_UTILIZATION,
      consecutive = CONSECUTIVE_SAMPLES,
      schedule = setInterval,
      cancel = clearInterval,
    } = {},
  ) {
    this.store = store;
    this.performance = perf;
    this.delay = delay === undefined ? monitorEventLoopDelay({ resolution: 20 }) : delay;
    this.clock = clock;
    this.intervalMs = intervalMs;
    this.noticeIntervalMs = noticeIntervalMs;
    this.threshold = threshold;
    this.consecutive = consecutive;
    this.schedule = schedule;
    this.cancel = cancel;
    this.timer = null;
    this.previous = null;
    this.utilization = null;
    this.samples = 0;
    this.streak = 0;
    this.notices = 0;
    this.lastNoticeAt = null;
    this.delayP99Ms = null;
    this.delayMaxMs = null;
  }

  read() {
    const reading = this.performance.eventLoopUtilization();
    if (!this.delay) return reading;
    // Percentiles describe the interval that just ended, so the histogram is
    // cleared once per sample instead of reporting a lifetime maximum.
    const reset = typeof this.delay.reset === "function";
    this.delayP99Ms = Number(this.delay.percentile(99)) / NS_PER_MS;
    this.delayMaxMs = Number(this.delay.max) / NS_PER_MS;
    if (reset) this.delay.reset();
    return reading;
  }

  /** One measurement; returns the same shape as snapshot(). */
  sample() {
    const current = this.read();
    const previous = this.previous;
    this.previous = current;
    if (!previous) return this.snapshot();
    const delta = this.performance.eventLoopUtilization(previous, current);
    const utilization = Number(delta?.utilization);
    if (!Number.isFinite(utilization)) return this.snapshot();
    this.utilization = utilization;
    this.samples++;
    this.streak = utilization >= this.threshold ? this.streak + 1 : 0;
    if (this.streak >= this.consecutive) this.notice();
    return this.snapshot();
  }

  notice() {
    const now = this.clock();
    if (this.lastNoticeAt !== null && now - this.lastNoticeAt < this.noticeIntervalMs)
      return;
    this.lastNoticeAt = now;
    this.notices++;
    const percent = Math.round(this.utilization * 100);
    const delay =
      this.delayP99Ms === null
        ? ""
        : `，事件循环延迟 p99 ${Math.round(this.delayP99Ms)}ms`;
    try {
      this.store.record({
        kind: "system",
        status: 200,
        message:
          `事件循环利用率 ${percent}%（连续 ${this.streak} 次采样超过 ` +
          `${Math.round(this.threshold * 100)}%${delay}），` +
          `${Math.round(this.noticeIntervalMs / 60000)} 分钟内只记录一次`,
      });
    } catch {
      // Observing saturation must never take the process down with it.
    }
  }

  snapshot() {
    return {
      utilization: this.utilization,
      samples: this.samples,
      elevatedSamples: this.streak,
      notices: this.notices,
      lastNoticeAt:
        this.lastNoticeAt === null
          ? null
          : new Date(this.lastNoticeAt).toISOString(),
      delayP99Ms: this.delayP99Ms,
      delayMaxMs: this.delayMaxMs,
    };
  }

  start() {
    if (this.timer) return;
    this.delay?.enable?.();
    this.previous = this.read();
    this.timer = this.schedule(() => {
      try {
        this.sample();
      } catch {
        // A failed sample keeps the next one coming.
      }
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  stop() {
    if (this.timer) this.cancel(this.timer);
    this.timer = null;
    this.delay?.disable?.();
    this.previous = null;
  }
}
