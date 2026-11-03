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

// Cache miss is the input the provider could not serve from cache. It is derived
// on read so stored totals keep their original shape: OpenAI `prompt_tokens`
// already contains the hits, so the remainder is the miss; Anthropic
// `input_tokens` is the miss on its own. Unknown input yields null, never zero.
export function deriveCacheMiss(usage) {
  if (!usage || typeof usage !== "object") return null;
  if (!Number.isSafeInteger(usage.input) || usage.input <= 0) return null;
  const read = Number.isSafeInteger(usage.cacheRead) ? usage.cacheRead : 0;
  return { cacheMiss: Math.max(0, usage.input - read), cacheMissReported: 1 };
}

export function addTokenUsage(target, value) {
  for (const key of Object.keys(emptyTokenUsage()))
    target[key] = (target[key] || 0) + (value?.[key] || 0);
  return target;
}

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const first = (...values) => values.map(count).find((n) => n !== null) ?? null;

export function normalizeTokenUsage(usage) {
  if (
    !usage ||
    typeof usage !== "object" ||
    Array.isArray(usage) ||
    usage.usage_estimated === true
  )
    return null;
  // One usage object can carry both field families: New API enriches a native
  // payload with zero placeholders. Prefer the family that holds measured
  // counters instead of letting the mere presence of a name pick the protocol.
  const anthropicFields =
    "input_tokens" in usage ||
    "output_tokens" in usage ||
    "cache_read_input_tokens" in usage ||
    "cache_creation_input_tokens" in usage;
  const openaiFields = "prompt_tokens" in usage || "completion_tokens" in usage;
  const anthropic = anthropicFields && !openaiFields;
  const input = anthropic
    ? count(usage.input_tokens)
    : first(usage.prompt_tokens, usage.input_tokens);
  const output = anthropic
    ? count(usage.output_tokens)
    : first(usage.completion_tokens, usage.output_tokens);
  const cacheRead = first(
    usage.cache_read_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens,
  );
  const cacheWrite = first(
    usage.cache_creation_input_tokens,
    usage.prompt_cache_creation_tokens,
    usage.prompt_cache_write_tokens,
    usage.prompt_tokens_details?.cache_creation_tokens,
    usage.prompt_tokens_details?.cache_write_tokens,
  );
  if ([input, output, cacheRead, cacheWrite].every((n) => n === null))
    return null;
  // Only a pure Anthropic shape reports cache beside the input total. A mixed
  // object already carries an inclusive prompt total, so cache must not be added
  // to it again.
  return { input, output, cacheRead, cacheWrite, anthropic };
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
    this.usage = {
      input: null,
      output: null,
      cacheRead: null,
      cacheWrite: null,
    };
    this.anthropic = false;
    this.sawUsage = false;
    this.sawInputAfterStart = false;
    this.finished = false;
  }

  accept(value) {
    if (!value || typeof value !== "object") return;
    // Billing counters can be nested beside the plain usage. Read both so a
    // measured value inside billing_usage is not silently dropped. Each source
    // is normalized on its own, so a repeated counter merges by maximum instead
    // of being added twice.
    const sources = [
      value.usage ?? value.message?.usage,
      value.usage?.billing_usage,
      value.message?.usage?.billing_usage,
      value.billing_usage,
    ];
    // A billing envelope repeats Anthropic field names even for an OpenAI
    // payload, so the primary usage object keeps the final say. Only when the
    // primary object names no counter at all does the envelope become the sole
    // evidence of the shape.
    let shapeDecided = false;
    for (const source of sources) {
      const usage = normalizeTokenUsage(source);
      if (!usage) continue;
      this.sawUsage = true;
      if (!shapeDecided) {
        this.anthropic ||= usage.anthropic;
        if (source === sources[0] || this.anthropic) shapeDecided = true;
      }
      if (value.type !== "message_start" && usage.input !== null)
        this.sawInputAfterStart = true;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"])
        if (usage[key] !== null)
          this.usage[key] = Math.max(this.usage[key] ?? 0, usage[key]);
    }
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

  finish(complete = true) {
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
    const { input, output, cacheRead, cacheWrite } = this.usage;
    // Only the Anthropic shape reports cache counters beside the input total.
    // OpenAI prompt_tokens already includes them, so adding them again would
    // inflate the input. This must not depend on which source merged last.
    result.input =
      (input ?? 0) +
      (this.anthropic ? (cacheRead ?? 0) + (cacheWrite ?? 0) : 0);
    result.output = output ?? 0;    // A cache counter is a measured value on its own. Clamping it to an unknown
    // input total would report a real hit as zero, so only a known total bounds
    // it. An upstream that reports more cache than input is inconsistent, and
    // showing "cache read > input" is worse than clamping to the input total.
    result.cacheRead = input === null ? (cacheRead ?? 0) : Math.min(result.input, cacheRead ?? 0);
    result.cacheWrite = input === null ? (cacheWrite ?? 0) : Math.min(result.input, cacheWrite ?? 0);
    result.total = result.input + result.output;
    result.reportedRequests = 1;
    result.cacheReadReported = Number(cacheRead !== null);
    result.cacheWriteReported = Number(cacheWrite !== null);
    // Older CNB Anthropic adapters emit a zero placeholder at message_start and
    // only output_tokens at message_delta. That zero cannot prove true input.
    result.partialRequests = Number(
      !complete ||
        input === null ||
        output === null ||
        (this.anthropicStream && input === 0 && !this.sawInputAfterStart),
    );
    return result;
  }
}
