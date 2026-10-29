import { randomUUID } from "node:crypto";
import { InputError } from "./store.mjs";

const EVENT_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const ITEM_LIMIT = 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (field) => { throw new InputError(`Invalid Responses field: ${field}`); };
const unsupported = (field) => { throw new InputError(`Responses compatibility does not support ${field}`); };
const upstreamError = () => new Error("Invalid or interrupted upstream Chat response");
const string = (value, field) => {
  if (typeof value !== "string") invalid(field);
  return value;
};
const identifier = (value, field) => {
  if (typeof value !== "string" || !value) invalid(field);
  return value;
};

function content(value, field, role) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) invalid(field);
  return value.map((part, index) => {
    const name = `${field}.${index}`;
    if (!object(part)) invalid(name);
    if (["input_text", "output_text"].includes(part.type))
      return { type: "text", text: string(part.text, `${name}.text`) };
    if (part.type === "input_image") {
      if (role !== "user") unsupported(`${name}.input_image`);
      if (part.file_id !== undefined) unsupported(`${name}.file_id`);
      const url = identifier(part.image_url, `${name}.image_url`);
      if (!/^(?:https?:\/\/|data:image\/)/i.test(url)) invalid(`${name}.image_url`);
      if (part.detail !== undefined && !["auto", "low", "high", "original"].includes(part.detail))
        invalid(`${name}.detail`);
      return { type: "image_url", image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } };
    }
    if (part.type === "refusal" && role === "assistant")
      return { type: "text", text: string(part.refusal, `${name}.refusal`) };
    unsupported(`${name}.content_type`);
  });
}

function mapTools(tools) {
  if (!Array.isArray(tools)) invalid("tools");
  return tools.map((tool, index) => {
    if (!object(tool)) invalid(`tools.${index}`);
    if (tool.type !== "function") unsupported(`tools.${index}.tool_type`);
    const fn = { name: identifier(tool.name, `tools.${index}.name`) };
    if (tool.description !== undefined && tool.description !== null)
      fn.description = string(tool.description, `tools.${index}.description`);
    if (tool.parameters !== undefined && tool.parameters !== null) {
      if (!object(tool.parameters)) invalid(`tools.${index}.parameters`);
      fn.parameters = tool.parameters;
    }
    if (tool.strict !== undefined && tool.strict !== null) {
      if (typeof tool.strict !== "boolean") invalid(`tools.${index}.strict`);
      fn.strict = tool.strict;
    }
    return { type: "function", function: fn };
  });
}

export function toChatRequest(payload) {
  if (!object(payload)) invalid("request");
  for (const field of ["previous_response_id", "conversation", "prompt", "context_management"])
    if (payload[field] !== undefined && payload[field] !== null) unsupported(field);
  for (const field of ["background", "store"])
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== false) unsupported(field);
  if (payload.truncation !== undefined && payload.truncation !== "disabled") unsupported("truncation");
  const known = new Set([
    "model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
    "max_output_tokens", "temperature", "top_p", "stream", "stream_options", "text", "reasoning",
    "metadata", "user", "safety_identifier", "prompt_cache_key", "service_tier", "include",
    "previous_response_id", "conversation", "prompt", "context_management", "background", "store", "truncation",
  ]);
  for (const field of Object.keys(payload)) if (!known.has(field)) unsupported("request field");
  if (payload.include !== undefined && (!Array.isArray(payload.include) ||
    payload.include.some((field) => field !== "reasoning.encrypted_content"))) unsupported("include");
  const messages = [];
  if (payload.instructions !== undefined && payload.instructions !== null)
    messages.push({ role: "system", content: string(payload.instructions, "instructions") });
  if (typeof payload.input === "string") messages.push({ role: "user", content: payload.input });
  else if (Array.isArray(payload.input)) {
    for (let index = 0; index < payload.input.length; index++) {
      const item = payload.input[index];
      const field = `input.${index}`;
      if (!object(item)) invalid(field);
      if (item.type === "function_call") {
        const call = {
          id: identifier(item.call_id, `${field}.call_id`), type: "function",
          function: { name: identifier(item.name, `${field}.name`), arguments: string(item.arguments, `${field}.arguments`) },
        };
        let previous = messages.at(-1);
        if (previous?.role !== "assistant") {
          previous = { role: "assistant", content: null, tool_calls: [] };
          messages.push(previous);
        }
        (previous.tool_calls ??= []).push(call);
      } else if (item.type === "function_call_output") {
        const mapped = content(item.output, `${field}.output`, "tool");
        messages.push({ role: "tool", tool_call_id: identifier(item.call_id, `${field}.call_id`), content: mapped });
      } else if (item.type === undefined || item.type === "message") {
        if (!["user", "assistant", "system", "developer"].includes(item.role)) invalid(`${field}.role`);
        messages.push({ role: item.role, content: content(item.content, `${field}.content`, item.role) });
      } else unsupported(`${field}.item_type`);
    }
  } else invalid("input");
  if (!messages.length) invalid("input");
  const result = { messages };
  for (const field of ["model", "metadata", "user", "safety_identifier", "prompt_cache_key", "service_tier"])
    if (payload[field] !== undefined && payload[field] !== null) result[field] = payload[field];
  for (const field of ["temperature", "top_p"])
    if (payload[field] !== undefined && payload[field] !== null) {
      if (typeof payload[field] !== "number" || !Number.isFinite(payload[field])) invalid(field);
      result[field] = payload[field];
    }
  for (const field of ["stream", "parallel_tool_calls"])
    if (payload[field] !== undefined && payload[field] !== null) {
      if (typeof payload[field] !== "boolean") invalid(field);
      result[field] = payload[field];
    }
  if (payload.stream_options !== undefined) {
    if (!object(payload.stream_options) || Object.keys(payload.stream_options).some((key) => key !== "include_obfuscation"))
      unsupported("stream_options");
  }
  if (payload.max_output_tokens !== undefined && payload.max_output_tokens !== null) {
    if (!Number.isSafeInteger(payload.max_output_tokens) || payload.max_output_tokens < 1) invalid("max_output_tokens");
    result.max_tokens = payload.max_output_tokens;
  }
  if (payload.tools !== undefined) result.tools = mapTools(payload.tools);
  if (payload.tool_choice !== undefined && payload.tool_choice !== null) {
    const choice = payload.tool_choice;
    if (["auto", "none", "required"].includes(choice)) result.tool_choice = choice;
    else if (object(choice) && choice.type === "function")
      result.tool_choice = { type: "function", function: { name: identifier(choice.name, "tool_choice.name") } };
    else unsupported("tool_choice");
  }
  if (payload.reasoning !== undefined && payload.reasoning !== null) {
    if (!object(payload.reasoning)) invalid("reasoning");
    if (Object.keys(payload.reasoning).some((key) => !["effort", "summary"].includes(key))) unsupported("reasoning field");
    if (payload.reasoning.effort !== undefined) {
      if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(payload.reasoning.effort)) invalid("reasoning.effort");
      result.reasoning_effort = payload.reasoning.effort;
    }
    // Summary is an optional projection. Chat cannot provide opaque reasoning state.
    if (payload.reasoning.summary !== undefined && payload.reasoning.summary !== null &&
      !["auto", "concise", "detailed"].includes(payload.reasoning.summary)) invalid("reasoning.summary");
  }
  if (payload.text !== undefined && payload.text !== null) {
    if (!object(payload.text) || Object.keys(payload.text).some((key) => !["format", "verbosity"].includes(key))) invalid("text");
    if (payload.text.verbosity !== undefined) {
      if (!["low", "medium", "high"].includes(payload.text.verbosity)) invalid("text.verbosity");
      result.verbosity = payload.text.verbosity;
    }
    const format = payload.text.format;
    if (format !== undefined && format !== null) {
      if (!object(format)) invalid("text.format");
      if (["text", "json_object"].includes(format.type)) result.response_format = { type: format.type };
      else if (format.type === "json_schema") {
        if (!object(format.schema)) invalid("text.format.schema");
        const schema = { name: identifier(format.name, "text.format.name"), schema: format.schema };
        if (format.description !== undefined) schema.description = string(format.description, "text.format.description");
        if (format.strict !== undefined && format.strict !== null) {
          if (typeof format.strict !== "boolean") invalid("text.format.strict");
          schema.strict = format.strict;
        }
        result.response_format = { type: "json_schema", json_schema: schema };
      } else unsupported("text.format.type");
    }
  }
  return result;
}

const count = (value) => Number.isSafeInteger(value) && value >= 0;
function usage(value) {
  if (!object(value) || value.usage_estimated === true || !count(value.prompt_tokens) || !count(value.completion_tokens)) return null;
  const total = value.prompt_tokens + value.completion_tokens;
  if (!count(total)) return null;
  const cached = [value.cache_read_input_tokens, value.prompt_cache_hit_tokens,
    value.prompt_tokens_details?.cached_tokens].find(count);
  return {
    input_tokens: value.prompt_tokens,
    input_tokens_details: { cached_tokens: cached === undefined ? 0 : Math.min(value.prompt_tokens, cached) },
    output_tokens: value.completion_tokens,
    output_tokens_details: { reasoning_tokens: count(value.completion_tokens_details?.reasoning_tokens) ? Math.min(value.completion_tokens, value.completion_tokens_details.reasoning_tokens) : 0 },
    total_tokens: total,
  };
}

function baseResponse({ model = "", requestId } = {}) {
  return {
    id: `resp_${requestId || randomUUID()}`, object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "in_progress", error: null, incomplete_details: null, model,
    output: [], usage: null, store: false,
  };
}

function completionStatus(reason) {
  if (!["stop", "tool_calls", "function_call", "length", "content_filter"].includes(reason)) throw upstreamError();
  return ["length", "content_filter"].includes(reason)
    ? { status: "incomplete", incomplete_details: { reason: reason === "length" ? "max_output_tokens" : "content_filter" } }
    : { status: "completed", incomplete_details: null };
}

export function toResponsesResponse(body, options = {}) {
  if (!object(body) || body.error || !Array.isArray(body.choices) || body.choices.length !== 1 ||
    Buffer.byteLength(JSON.stringify(body)) > RESPONSE_LIMIT) throw upstreamError();
  const choice = body.choices[0];
  if (!object(choice) || !object(choice.message)) throw upstreamError();
  const response = baseResponse({ ...options, model: body.model || options.model || "" });
  Object.assign(response, completionStatus(choice.finish_reason));
  const message = choice.message;
  if (message.function_call || (message.role !== undefined && message.role !== "assistant")) throw upstreamError();
  const parts = [];
  if (message.content !== undefined && message.content !== null) {
    if (typeof message.content !== "string") throw upstreamError();
    parts.push({ type: "output_text", text: message.content, annotations: [], logprobs: [] });
  }
  if (message.refusal !== undefined && message.refusal !== null) {
    if (typeof message.refusal !== "string") throw upstreamError();
    parts.push({ type: "refusal", refusal: message.refusal });
  }
  if (parts.length) response.output.push({ id: `msg_${randomUUID()}`, type: "message", status: response.status, role: "assistant", content: parts });
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > ITEM_LIMIT) throw upstreamError();
    for (const call of message.tool_calls) {
      if (!object(call) || call.type !== "function" || typeof call.id !== "string" || !call.id ||
        !object(call.function) || typeof call.function.name !== "string" || !call.function.name ||
        typeof call.function.arguments !== "string") throw upstreamError();
      response.output.push({ id: `fc_${randomUUID()}`, type: "function_call", status: response.status,
        call_id: call.id, name: call.function.name, arguments: call.function.arguments });
    }
  }
  if (["tool_calls", "function_call"].includes(choice.finish_reason) && !message.tool_calls?.length) throw upstreamError();
  if (!response.output.length) response.output.push({ id: `msg_${randomUUID()}`, type: "message", status: response.status, role: "assistant", content: [] });
  response.usage = usage(body.usage);
  return response;
}

// Transport owns cancellation and backpressure. This adapter holds only bounded
// per-response state and emits Buffers for the existing response writer.
export class ResponsesStream {
  constructor(options = {}) {
    this.response = baseResponse(options);
    this.decoder = new TextDecoder("utf-8", { fatal: true });
    this.buffer = "";
    this.data = [];
    this.dataBytes = 0;
    this.totalBytes = 0;
    this.sequence = 0;
    this.started = false;
    this.finished = false;
    this.sawDone = false;
    this.finishReason = null;
    this.message = null;
    this.tools = new Map();
  }

  event(type, fields) {
    return Buffer.from(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...fields })}\n\n`);
  }

  start(events) {
    if (this.started) return;
    this.started = true;
    events.push(this.event("response.created", { response: this.response }));
    events.push(this.event("response.in_progress", { response: this.response }));
  }

  addItem(item, events) {
    if (this.response.output.length >= ITEM_LIMIT) throw upstreamError();
    const outputIndex = this.response.output.length;
    this.response.output.push(item);
    events.push(this.event("response.output_item.added", { output_index: outputIndex, item }));
    return outputIndex;
  }

  textDelta(kind, delta, events) {
    if (typeof delta !== "string") throw upstreamError();
    if (!delta) return;
    if (!this.message) {
      const item = { id: `msg_${randomUUID()}`, type: "message", status: "in_progress", role: "assistant", content: [] };
      this.message = { item, index: this.addItem(item, events), parts: new Map() };
    }
    const { item, index, parts } = this.message;
    if (!parts.has(kind)) {
      const part = kind === "output_text" ? { type: kind, text: "", annotations: [], logprobs: [] } : { type: kind, refusal: "" };
      const contentIndex = item.content.length;
      item.content.push(part);
      parts.set(kind, contentIndex);
      events.push(this.event("response.content_part.added", { item_id: item.id, output_index: index, content_index: contentIndex, part }));
    }
    const contentIndex = parts.get(kind);
    item.content[contentIndex][kind === "output_text" ? "text" : "refusal"] += delta;
    events.push(this.event(kind === "output_text" ? "response.output_text.delta" : "response.refusal.delta", {
      item_id: item.id, output_index: index, content_index: contentIndex, delta,
      ...(kind === "output_text" ? { logprobs: [] } : {}),
    }));
  }

  openTool(tool, events) {
    if (tool.item) return;
    if (!tool.callId || !tool.name) throw upstreamError();
    tool.item = { id: `fc_${randomUUID()}`, type: "function_call", status: "in_progress", call_id: tool.callId, name: tool.name, arguments: "" };
    tool.index = this.addItem(tool.item, events);
  }

  accept(value, events) {
    if (!object(value) || value.error || this.sawDone) throw upstreamError();
    if (typeof value.model === "string") this.response.model = value.model;
    const reported = usage(value.usage);
    if (reported) this.response.usage = reported;
    if (!Array.isArray(value.choices)) throw upstreamError();
    for (const choice of value.choices) {
      if (!object(choice) || (choice.index !== undefined && choice.index !== 0) || this.finishReason) throw upstreamError();
      const delta = choice.delta;
      if (!object(delta)) throw upstreamError();
      if (delta.function_call || (delta.role !== undefined && delta.role !== "assistant")) throw upstreamError();
      if (delta.content !== undefined && delta.content !== null) this.textDelta("output_text", delta.content, events);
      if (delta.refusal !== undefined && delta.refusal !== null) this.textDelta("refusal", delta.refusal, events);
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) throw upstreamError();
        for (const call of delta.tool_calls) {
          if (!object(call) || !Number.isSafeInteger(call.index) || call.index < 0 || call.index >= ITEM_LIMIT ||
            (call.type !== undefined && call.type !== "function")) throw upstreamError();
          if (!this.tools.has(call.index)) this.tools.set(call.index, { callId: "", name: "", item: null });
          const tool = this.tools.get(call.index);
          if (call.id !== undefined && call.id !== null) {
            if (typeof call.id !== "string") throw upstreamError();
            if (call.id && call.id !== tool.callId) {
              if (tool.item) throw upstreamError();
              tool.callId += call.id;
            }
          }
          if (call.function !== undefined) {
            if (!object(call.function)) throw upstreamError();
            if (call.function.name !== undefined && call.function.name !== null) {
              if (typeof call.function.name !== "string") throw upstreamError();
              if (call.function.name && call.function.name !== tool.name) {
                if (tool.item) throw upstreamError();
                tool.name += call.function.name;
              }
            }
            if (call.function.arguments !== undefined && call.function.arguments !== null) {
              if (typeof call.function.arguments !== "string") throw upstreamError();
              if (call.function.arguments) {
                this.openTool(tool, events);
                tool.item.arguments += call.function.arguments;
                events.push(this.event("response.function_call_arguments.delta", {
                  item_id: tool.item.id, output_index: tool.index, delta: call.function.arguments,
                }));
              }
            }
          }
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        completionStatus(choice.finish_reason);
        this.finishReason = choice.finish_reason;
      }
    }
  }

  flushEvent(events) {
    if (!this.data.length) return;
    const data = this.data.join("\n");
    this.data = [];
    this.dataBytes = 0;
    if (data.trim() === "[DONE]") {
      if (this.sawDone || !this.finishReason) throw upstreamError();
      this.sawDone = true;
      return;
    }
    let value;
    try { value = JSON.parse(data); } catch { throw upstreamError(); }
    this.accept(value, events);
  }

  line(line, events) {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) return this.flushEvent(events);
    if (!line.startsWith("data:")) return;
    const value = line.slice(5).replace(/^ /, "");
    this.dataBytes += Buffer.byteLength(value);
    if (this.dataBytes > EVENT_LIMIT) throw upstreamError();
    this.data.push(value);
  }

  push(chunk) {
    if (this.finished) throw upstreamError();
    this.totalBytes += chunk.byteLength;
    if (this.totalBytes > RESPONSE_LIMIT) throw upstreamError();
    const events = [];
    this.start(events);
    try { this.buffer += this.decoder.decode(chunk, { stream: true }); } catch { throw upstreamError(); }
    let end;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      this.line(this.buffer.slice(0, end), events);
      this.buffer = this.buffer.slice(end + 1);
    }
    if (Buffer.byteLength(this.buffer) > EVENT_LIMIT) throw upstreamError();
    return events;
  }

  finish() {
    if (this.finished) throw upstreamError();
    this.finished = true;
    const events = [];
    this.start(events);
    try { this.buffer += this.decoder.decode(); } catch { throw upstreamError(); }
    if (this.buffer) this.line(this.buffer, events);
    this.flushEvent(events);
    this.buffer = "";
    if (!this.finishReason) throw upstreamError();
    if (["tool_calls", "function_call"].includes(this.finishReason) && !this.tools.size) throw upstreamError();
    Object.assign(this.response, completionStatus(this.finishReason));
    for (const tool of this.tools.values()) this.openTool(tool, events);
    if (!this.response.output.length) {
      this.addItem({ id: `msg_${randomUUID()}`, type: "message", status: "in_progress", role: "assistant", content: [] }, events);
    }
    for (let outputIndex = 0; outputIndex < this.response.output.length; outputIndex++) {
      const item = this.response.output[outputIndex];
      item.status = this.response.status;
      if (item.type === "message") {
        for (let contentIndex = 0; contentIndex < item.content.length; contentIndex++) {
          const part = item.content[contentIndex];
          const fields = { item_id: item.id, output_index: outputIndex, content_index: contentIndex };
          events.push(this.event(part.type === "output_text" ? "response.output_text.done" : "response.refusal.done", {
            ...fields, ...(part.type === "output_text" ? { text: part.text, logprobs: [] } : { refusal: part.refusal }),
          }));
          events.push(this.event("response.content_part.done", { ...fields, part }));
        }
      } else events.push(this.event("response.function_call_arguments.done", {
        item_id: item.id, output_index: outputIndex, name: item.name, arguments: item.arguments,
      }));
      events.push(this.event("response.output_item.done", { output_index: outputIndex, item }));
    }
    events.push(this.event(this.response.status === "completed" ? "response.completed" : "response.incomplete", { response: this.response }));
    return events;
  }
}
