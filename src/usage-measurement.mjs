// Shared numeric-only usage capture for gateway accounting and Responses output.
// Retain protocol families until projection: a later billing envelope must not
// reinterpret an inclusive Chat input as exclusive Messages input.
export const tokenCounter = (value) =>
  Number.isSafeInteger(value) && value >= 0 ? value : null;
const maximum = (...values) => {
  const valid = values.map(tokenCounter).filter((value) => value !== null);
  return valid.length ? Math.max(...valid) : null;
};
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const emptyFamily = () => ({ input: null, output: null });
const hasCounters = (family) => family.input !== null || family.output !== null;
const measured = (family, cached = false) => family.input > 0 || family.output > 0 ||
  (family.input !== null && cached);

export class UsageMeasurement {
  constructor() {
    this.primary = { chat: emptyFamily(), messages: emptyFamily() };
    this.billing = { chat: emptyFamily(), messages: emptyFamily() };
    this.cacheRead = null;
    this.cacheWrite = null;
    this.reasoning = null;
    this.sawInputAfterStart = false;
  }

  source(value, billing = false, afterStart = true) {
    if (!object(value) || value.usage_estimated === true) return;
    const target = billing ? this.billing : this.primary;
    const read = maximum(value.cache_read_input_tokens, value.prompt_cache_hit_tokens,
      value.prompt_tokens_details?.cached_tokens, value.input_tokens_details?.cached_tokens);
    const write = maximum(value.cache_creation_input_tokens, value.prompt_cache_creation_tokens,
      value.prompt_cache_write_tokens, value.prompt_tokens_details?.cache_creation_tokens,
      value.prompt_tokens_details?.cache_write_tokens);
    this.cacheRead = maximum(this.cacheRead, read);
    this.cacheWrite = maximum(this.cacheWrite, write);
    this.reasoning = maximum(this.reasoning, value.completion_tokens_details?.reasoning_tokens,
      value.output_tokens_details?.reasoning_tokens);
    // Responses-shaped input details identify inclusive input too. Messages
    // usage has no input_tokens_details object.
    const inclusive = object(value.input_tokens_details);
    const families = {
      chat: [maximum(value.prompt_tokens, inclusive ? value.input_tokens : null),
        maximum(value.completion_tokens, inclusive ? value.output_tokens : null)],
      messages: [inclusive ? null : tokenCounter(value.input_tokens),
        inclusive ? null : tokenCounter(value.output_tokens)],
    };
    for (const [name, [input, output]] of Object.entries(families)) {
      target[name].input = maximum(target[name].input, input);
      target[name].output = maximum(target[name].output, output);
      if (afterStart && input !== null) this.sawInputAfterStart = true;
    }
  }

  accept(value) {
    if (!object(value)) return this.value();
    const primary = value.usage ?? value.message?.usage;
    const afterStart = value.type !== "message_start";
    this.source(primary, false, afterStart);
    this.source(primary?.billing_usage, true, afterStart);
    this.source(value.billing_usage, true, afterStart);
    return this.value();
  }

  value() {
    let family;
    // A measured primary family outranks any billing envelope. Zero-only
    // placeholders may defer to measured counters from the other family.
    for (const source of [this.primary, this.billing]) {
      family = measured(source.chat) ? "chat"
        : measured(source.messages, this.cacheRead > 0 || this.cacheWrite > 0) ? "messages" : null;
      if (family) break;
    }
    if (!family) {
      for (const source of [this.primary, this.billing]) {
        family = hasCounters(source.chat) ? "chat" : hasCounters(source.messages) ? "messages" : null;
        if (family) break;
      }
    }
    const selected = family ? [this.primary[family], this.billing[family]] : [];
    const rawInput = maximum(...selected.map((value) => value.input));
    let output = maximum(...selected.map((value) => value.output));
    if (output === null) output = maximum(this.primary.chat.output, this.primary.messages.output,
      this.billing.chat.output, this.billing.messages.output);
    const input = rawInput === null ? null : tokenCounter(rawInput +
      (family === "messages" ? (this.cacheRead ?? 0) + (this.cacheWrite ?? 0) : 0));
    const cacheRead = this.cacheRead === null ? null : input === null
      ? this.cacheRead : Math.min(input, this.cacheRead);
    const cacheWrite = this.cacheWrite === null ? null : input === null
      ? this.cacheWrite : Math.min(input, this.cacheWrite);
    if ([input, output, cacheRead, cacheWrite].every((value) => value === null)) return null;
    return { input, rawInput, output, cacheRead, cacheWrite,
      anthropic: family === "messages", reasoning: this.reasoning };
  }
}
