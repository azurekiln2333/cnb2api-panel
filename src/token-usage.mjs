// Capture only numeric usage while the original response bytes pass through.
// Neither request prompts nor generated content are retained in the store.
export const emptyTokenUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  reportedRequests: 0,
  missingRequests: 0,
  partialRequests: 0,
});

export function addTokenUsage(target, value) {
  for (const key of Object.keys(emptyTokenUsage()))
    target[key] = (target[key] || 0) + (value?.[key] || 0);
  return target;
}

const count = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const first = (...values) => values.map(count).find((n) => n !== null) ?? null;

export function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const anthropic =
    "input_tokens" in usage ||
    "output_tokens" in usage ||
    "cache_read_input_tokens" in usage ||
    "cache_creation_input_tokens" in usage;
  const input = count(anthropic ? usage.input_tokens : usage.prompt_tokens);
  const output = count(
    anthropic ? usage.output_tokens : usage.completion_tokens,
  );
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
    const usage = normalizeTokenUsage(value.usage ?? value.message?.usage);
    if (!usage) return;
    this.sawUsage = true;
    this.anthropic ||= usage.anthropic;
    if (value.type !== "message_start" && usage.input !== null)
      this.sawInputAfterStart = true;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"])
      if (usage[key] !== null)
        this.usage[key] = Math.max(this.usage[key] ?? 0, usage[key]);
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
    result.input =
      (input ?? 0) +
      (this.anthropic ? (cacheRead ?? 0) + (cacheWrite ?? 0) : 0);
    result.output = output ?? 0;
    result.cacheRead = Math.min(result.input, cacheRead ?? 0);
    result.cacheWrite = Math.min(
      Math.max(0, result.input - result.cacheRead),
      cacheWrite ?? 0,
    );
    result.total = result.input + result.output;
    result.reportedRequests = 1;
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
