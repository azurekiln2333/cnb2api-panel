import { UsageMeasurement } from "./usage-measurement.mjs";

// Capture only numeric usage while the original response bytes pass through.
// Neither request prompts nor generated content are retained in the store.
// `cacheReadReported`/`cacheWriteReported` count requests that actually carried
// a cache counter. Zero with no reporter means "unknown", not "measured zero".
export const emptyTokenUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  reportedRequests: 0,
  missingRequests: 0,
  partialRequests: 0,
  cacheReadReported: 0,
  cacheWriteReported: 0,
});

// Derive a miss only for a fully measured, matching attempt population.
// An omitted cache counter cannot prove the whole input missed the cache.
export function deriveCacheMiss(usage) {
  if (!usage || typeof usage !== "object") return null;
  const attempts = (usage.reportedRequests || 0) + (usage.missingRequests || 0);
  if (!Number.isSafeInteger(attempts) || attempts <= 0 || usage.missingRequests > 0 ||
      usage.partialRequests > 0 || usage.cacheReadReported !== attempts ||
      !Number.isSafeInteger(usage.input) || usage.input < 0 ||
      !Number.isSafeInteger(usage.cacheRead) || usage.cacheRead < 0) return null;
  return { cacheMiss: Math.max(0, usage.input - usage.cacheRead), cacheMissReported: attempts };
}

export function addTokenUsage(target, value) {
  for (const key of Object.keys(emptyTokenUsage()))
    target[key] = (target[key] || 0) + (value?.[key] || 0);
  return target;
}

export function normalizeTokenUsage(usage) {
  const measurement = new UsageMeasurement();
  measurement.accept({ usage });
  return measurement.value();
}

// The JSON body and any single SSE event have caps. Huge content events may be
// skipped while a later small usage event is still captured, without buffering
// the whole stream or changing what the client receives.
const JSON_LIMIT = 2 * 1024 * 1024;
const EVENT_LIMIT = 256 * 1024;

export class TokenUsageCapture {
  constructor(contentType = "", path = "") {
    this.sse = /text\/event-stream/i.test(contentType);
    this.anthropicStream = this.sse && path === "/v1/messages";
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.eventData = "";
    this.skippingLine = false;
    this.skippingEvent = false;
    this.overflow = false;
    this.jsonBytes = 0;
    this.measurement = new UsageMeasurement();
    this.sawUsage = false;
    this.finished = false;
  }

  accept(value) {
    this.sawUsage = this.measurement.accept(value) !== null;
  }

  parse(text) {
    if (!text || text.trim() === "[DONE]") return;
    try {
      this.accept(JSON.parse(text));
    } catch {
      // Invalid/missing usage never breaks a valid response relay.
    }
  }

  line(value) {
    const line = value.endsWith("\r") ? value.slice(0, -1) : value;
    if (!line) {
      if (!this.skippingEvent) this.parse(this.eventData);
      this.eventData = "";
      this.skippingEvent = false;
      return;
    }
    if (this.skippingEvent || !line.startsWith("data:")) return;
    const data = line.slice(5).replace(/^ /, "");
    if (this.eventData.length + data.length > EVENT_LIMIT) {
      this.eventData = "";
      this.skippingEvent = true;
      return;
    }
    this.eventData += `${this.eventData ? "\n" : ""}${data}`;
  }

  push(chunk) {
    if (this.finished) return;
    const text = this.decoder.decode(chunk, { stream: true });
    if (!this.sse) {
      if (this.overflow) return;
      this.jsonBytes += chunk.byteLength;
      if (this.jsonBytes > JSON_LIMIT) {
        this.buffer = "";
        this.overflow = true;
      } else this.buffer += text;
      return;
    }
    let start = 0;
    for (
      let end = text.indexOf("\n");
      end !== -1;
      end = text.indexOf("\n", start)
    ) {
      if (!this.skippingLine) {
        if (this.buffer.length + end - start <= EVENT_LIMIT)
          this.line(this.buffer + text.slice(start, end));
        else this.skippingEvent = true;
      }
      this.buffer = "";
      this.skippingLine = false;
      start = end + 1;
    }
    if (this.skippingLine) return;
    if (this.buffer.length + text.length - start > EVENT_LIMIT) {
      this.buffer = "";
      this.skippingLine = true;
      this.skippingEvent = true;
    } else this.buffer += text.slice(start);
  }

  finish(complete = true, { partial = false } = {}) {
    if (!this.finished) {
      const tail = this.decoder.decode();
      if (this.sse) {
        if (
          !this.skippingLine &&
          this.buffer.length + tail.length <= EVENT_LIMIT
        )
          this.line(this.buffer + tail);
        if (!this.skippingEvent) this.parse(this.eventData);
      } else if (!this.overflow && complete) this.parse(this.buffer + tail);
      this.buffer = "";
      this.eventData = "";
      this.finished = true;
    }
    const result = emptyTokenUsage();
    if (!this.sawUsage) {
      result.missingRequests = 1;
      return result;
    }
    const { input, rawInput, output, cacheRead, cacheWrite } = this.measurement.value();
    result.input = input ?? 0;
    result.output = output ?? 0;
    result.cacheRead = cacheRead ?? 0;
    result.cacheWrite = cacheWrite ?? 0;
    result.total = result.input + result.output;
    result.reportedRequests = 1;
    result.cacheReadReported = Number(cacheRead !== null);
    result.cacheWriteReported = Number(cacheWrite !== null);
    // Older CNB Anthropic adapters emit a zero placeholder at message_start and
    // only output_tokens at message_delta. That zero cannot prove true input.
    result.partialRequests = Number(
      !complete || partial ||
        input === null ||
        output === null ||
        (this.anthropicStream && rawInput === 0 && !this.measurement.sawInputAfterStart),
    );
    return result;
  }
}
