import { createHash, randomUUID } from "node:crypto";
import { InputError } from "./store.mjs";

const EVENT_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const ITEM_LIMIT = 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (field) => { throw Object.assign(new InputError(`Invalid Responses field: ${field}`), { param: field, code: "invalid_field" }); };
const unsupported = (field, detail = "") => { throw Object.assign(new InputError(`Responses compatibility does not support ${field}${detail ? `: ${detail}` : ""}`), { param: field, code: "unsupported_parameter" }); };
const upstreamError = () => new Error("Invalid or interrupted upstream Chat response");
const string = (value, field) => {
  if (typeof value !== "string") invalid(field);
  return value;
};
const identifier = (value, field) => {
  if (typeof value !== "string" || !value) invalid(field);
  return value;
};
const optional = (value) => value !== undefined && value !== null;
function knownFields(value, fields, parent = "") {
  for (const field of Object.keys(value)) if (!fields.includes(field)) {
    const safe = /^[a-z][a-z0-9_]{0,63}$/.test(field);
    unsupported(safe ? `${parent ? `${parent}.` : ""}${field}` : parent || "request");
  }
}

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

const toolKey = ({ type, namespace, name }) => JSON.stringify([type, namespace ?? null, name]);
function toolReference(value, field, type = value.type) {
  const reference = { type, name: identifier(value.name, `${field}.name`) };
  if (optional(value.namespace)) reference.namespace = identifier(value.namespace, `${field}.namespace`);
  return reference;
}

function toolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length > ITEM_LIMIT) invalid("tools");
  const definitions = [];
  const add = (tool, field, namespace, namespaceDescription) => {
    if (!object(tool)) invalid(field);
    if (["web_search", "web_search_preview"].includes(tool.type))
      unsupported(`${field}.type`, 'Chat upstreams cannot run hosted web search. Set Codex web_search="disabled" to use this compatibility bridge');
    if (!["function", "custom"].includes(tool.type)) unsupported(`${field}.type`);
    knownFields(tool, tool.type === "function"
      ? ["type", "name", "description", "parameters", "strict", "defer_loading"]
      : ["type", "name", "description", "format", "defer_loading"], field);
    const reference = toolReference({ ...tool, namespace }, field);
    const fn = {};
    const descriptions = [];
    if (namespaceDescription) descriptions.push(namespaceDescription);
    if (optional(tool.description)) descriptions.push(string(tool.description, `${field}.description`));
    if (optional(tool.defer_loading) && typeof tool.defer_loading !== "boolean") invalid(`${field}.defer_loading`);
    if (tool.type === "custom") {
      if (optional(tool.format)) {
        if (!object(tool.format)) invalid(`${field}.format`);
        knownFields(tool.format, ["type", "syntax", "definition"], `${field}.format`);
        if (tool.format.type === "grammar") {
          if (!["lark", "regex"].includes(tool.format.syntax)) invalid(`${field}.format.syntax`);
          const definition = string(tool.format.definition, `${field}.format.definition`);
          descriptions.push(`Input grammar (${tool.format.syntax}; advisory, not enforced by Chat):\n${definition}`);
        } else if (tool.format.type !== "text") unsupported(`${field}.format.type`);
        else if (optional(tool.format.syntax) || optional(tool.format.definition)) invalid(`${field}.format`);
      }
      fn.parameters = { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false };
      fn.strict = true;
    } else {
      if (optional(tool.parameters)) {
        if (!object(tool.parameters)) invalid(`${field}.parameters`);
        fn.parameters = tool.parameters;
      }
      if (optional(tool.strict)) {
        if (typeof tool.strict !== "boolean") invalid(`${field}.strict`);
        fn.strict = tool.strict;
      }
    }
    if (descriptions.length) fn.description = descriptions.join("\n\n");
    definitions.push({ reference, fn, field });
    if (definitions.length > ITEM_LIMIT) invalid("tools");
  };
  for (let index = 0; index < tools.length; index++) {
    const tool = tools[index];
    const field = `tools.${index}`;
    if (!object(tool)) invalid(field);
    if (tool.type !== "namespace") { add(tool, field); continue; }
    knownFields(tool, ["type", "name", "description", "tools"], field);
    const namespace = identifier(tool.name, `${field}.name`);
    const description = optional(tool.description) ? string(tool.description, `${field}.description`) : "";
    if (!Array.isArray(tool.tools)) invalid(`${field}.tools`);
    for (let child = 0; child < tool.tools.length; child++)
      add(tool.tools[child], `${field}.tools.${child}`, namespace, description);
  }
  return definitions;
}

function buildToolContext(definitions, input) {
  const references = new Map();
  for (const { reference, field } of definitions) {
    const key = toolKey(reference);
    if (references.has(key)) invalid(`${field}.name`);
    references.set(key, reference);
  }
  if (Array.isArray(input)) for (let index = 0; index < input.length; index++) {
    const item = input[index];
    if (!object(item) || !["function_call", "custom_tool_call"].includes(item.type)) continue;
    const reference = toolReference(item, `input.${index}`, item.type === "function_call" ? "function" : "custom");
    references.set(toolKey(reference), reference);
  }
  const byTool = new Map();
  const byChatName = new Map();
  const ordered = [...references.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  // Reserve ordinary function names first so synthesized aliases cannot replace them.
  for (const [key, reference] of ordered) if (reference.type === "function" && !reference.namespace && /^[a-zA-Z0-9_-]{1,64}$/.test(reference.name)) {
    byTool.set(key, reference.name);
    byChatName.set(reference.name, reference);
  }
  for (const [key, reference] of ordered) {
    if (byTool.has(key)) continue;
    const stem = `${reference.namespace ? `${reference.namespace}__` : ""}${reference.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 38) || "tool";
    let attempt = 0;
    let alias;
    do {
      const hash = createHash("sha256").update(`${key}:${attempt++}`).digest("hex").slice(0, 24);
      alias = `${stem}__${hash}`;
    } while (byChatName.has(alias));
    byTool.set(key, alias);
    byChatName.set(alias, reference);
  }
  return { byTool, byChatName };
}

export function prepareResponsesRequest(payload) {
  if (!object(payload)) invalid("request");
  for (const field of ["previous_response_id", "conversation", "prompt", "context_management"])
    if (payload[field] !== undefined && payload[field] !== null) unsupported(field);
  for (const field of ["background", "store"])
    if (payload[field] !== undefined && payload[field] !== null && payload[field] !== false) unsupported(field);
  if (payload.truncation !== undefined && payload.truncation !== "disabled") unsupported("truncation");
  knownFields(payload, [
    "model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
    "max_output_tokens", "temperature", "top_p", "stream", "stream_options", "text", "reasoning",
    "metadata", "client_metadata", "access_programs", "user", "safety_identifier", "prompt_cache_key", "service_tier", "include",
    "previous_response_id", "conversation", "prompt", "context_management", "background", "store", "truncation",
  ]);
  if (optional(payload.client_metadata) && (!object(payload.client_metadata) || Object.values(payload.client_metadata).some((value) => typeof value !== "string"))) invalid("client_metadata");
  if (optional(payload.access_programs)) {
    if (!object(payload.access_programs)) invalid("access_programs");
    knownFields(payload.access_programs, ["cyber"], "access_programs");
    if (optional(payload.access_programs.cyber) && payload.access_programs.cyber !== "standard") {
      if (!["daybreak_blue", "daybreak_red"].includes(payload.access_programs.cyber)) invalid("access_programs.cyber");
      unsupported("access_programs.cyber");
    }
  }
  if (payload.include !== undefined && (!Array.isArray(payload.include) ||
    payload.include.some((field) => field !== "reasoning.encrypted_content"))) unsupported("include");
  const definitions = payload.tools === undefined ? [] : toolDefinitions(payload.tools);
  const toolContext = buildToolContext(definitions, payload.input);
  const messages = [];
  if (payload.instructions !== undefined && payload.instructions !== null)
    messages.push({ role: "system", content: string(payload.instructions, "instructions") });
  if (typeof payload.input === "string") messages.push({ role: "user", content: payload.input });
  else if (Array.isArray(payload.input)) {
    for (let index = 0; index < payload.input.length; index++) {
      const item = payload.input[index];
      const field = `input.${index}`;
      if (!object(item)) invalid(field);
      if (item.type === "function_call" || item.type === "custom_tool_call") {
        const reference = toolReference(item, field, item.type === "function_call" ? "function" : "custom");
        const call = {
          id: identifier(item.call_id, `${field}.call_id`), type: "function",
          function: { name: toolContext.byTool.get(toolKey(reference)), arguments: item.type === "function_call"
            ? string(item.arguments, `${field}.arguments`)
            : JSON.stringify({ input: string(item.input, `${field}.input`) }) },
        };
        let previous = messages.at(-1);
        if (previous?.role !== "assistant") {
          previous = { role: "assistant", content: null, tool_calls: [] };
          messages.push(previous);
        }
        (previous.tool_calls ??= []).push(call);
      } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
        const mapped = content(item.output, `${field}.output`, "tool");
        messages.push({ role: "tool", tool_call_id: identifier(item.call_id, `${field}.call_id`), content: mapped });
      } else if (item.type === "reasoning") {
        // Echoed reasoning is opaque/projection history, not executable state.
        if (optional(item.encrypted_content)) string(item.encrypted_content, `${field}.encrypted_content`);
        for (const name of ["summary", "content"]) if (optional(item[name])) {
          if (!Array.isArray(item[name])) invalid(`${field}.${name}`);
          for (let part = 0; part < item[name].length; part++) {
            const value = item[name][part];
            if (!object(value) || !["summary_text", "reasoning_text", "text"].includes(value.type)) invalid(`${field}.${name}.${part}`);
            string(value.text, `${field}.${name}.${part}.text`);
          }
        }
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
    if (!object(payload.stream_options)) invalid("stream_options");
    knownFields(payload.stream_options, ["include_obfuscation", "reasoning_summary_delivery"], "stream_options");
    if (optional(payload.stream_options.include_obfuscation) && typeof payload.stream_options.include_obfuscation !== "boolean") invalid("stream_options.include_obfuscation");
    if (optional(payload.stream_options.reasoning_summary_delivery) && payload.stream_options.reasoning_summary_delivery !== "sequential_cutoff") invalid("stream_options.reasoning_summary_delivery");
  }
  if (payload.max_output_tokens !== undefined && payload.max_output_tokens !== null) {
    if (!Number.isSafeInteger(payload.max_output_tokens) || payload.max_output_tokens < 1) invalid("max_output_tokens");
    result.max_tokens = payload.max_output_tokens;
  }
  if (payload.tools !== undefined) result.tools = definitions.map(({ reference, fn }) => ({ type: "function", function: { name: toolContext.byTool.get(toolKey(reference)), ...fn } }));
  if (payload.tool_choice !== undefined && payload.tool_choice !== null) {
    const choice = payload.tool_choice;
    if (["auto", "none", "required"].includes(choice)) result.tool_choice = choice;
    else if (object(choice) && ["function", "custom"].includes(choice.type)) {
      knownFields(choice, ["type", "name", "namespace"], "tool_choice");
      const reference = toolReference(choice, "tool_choice");
      const name = toolContext.byTool.get(toolKey(reference));
      if (!name) invalid("tool_choice.name");
      result.tool_choice = { type: "function", function: { name } };
    }
    else unsupported("tool_choice");
  }
  if (payload.reasoning !== undefined && payload.reasoning !== null) {
    if (!object(payload.reasoning)) invalid("reasoning");
    knownFields(payload.reasoning, ["effort", "summary", "context"], "reasoning");
    if (payload.reasoning.effort !== undefined) {
      if (!["none", "minimal", "low", "medium", "high", "xhigh"].includes(payload.reasoning.effort)) invalid("reasoning.effort");
      result.reasoning_effort = payload.reasoning.effort;
    }
    // Summary is an optional projection. Chat cannot provide opaque reasoning state.
    if (payload.reasoning.summary !== undefined && payload.reasoning.summary !== null &&
      !["auto", "concise", "detailed"].includes(payload.reasoning.summary)) invalid("reasoning.summary");
    if (optional(payload.reasoning.context) && !["auto", "current_turn", "all_turns"].includes(payload.reasoning.context)) invalid("reasoning.context");
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
  return { payload: result, toolContext };
}

export function toChatRequest(payload) {
  return prepareResponsesRequest(payload).payload;
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

function responseTool(name, toolContext, partial = false) {
  // An exact short name can still be a fragment of another declared tool.
  if (partial && toolContext && [...toolContext.byChatName.keys()].some((candidate) => candidate !== name && candidate.startsWith(name))) return null;
  const mapped = toolContext?.byChatName.get(name);
  if (mapped) return mapped;
  if (toolContext?.byChatName.size) {
    if (partial && [...toolContext.byChatName.keys()].some((candidate) => candidate.startsWith(name))) return null;
    throw upstreamError();
  }
  return { type: "function", name };
}

function customInput(argumentsText) {
  let value;
  try { value = JSON.parse(argumentsText); } catch { throw upstreamError(); }
  if (!object(value) || typeof value.input !== "string" || Object.keys(value).some((key) => key !== "input")) throw upstreamError();
  return value.input;
}

function responseToolItem(callId, reference, status, argumentsText = "") {
  return {
    id: `${reference.type === "custom" ? "ctc" : "fc"}_${randomUUID()}`,
    type: reference.type === "custom" ? "custom_tool_call" : "function_call", status,
    call_id: callId, name: reference.name,
    ...(reference.namespace ? { namespace: reference.namespace } : {}),
    ...(reference.type === "custom" ? { input: "" } : { arguments: argumentsText }),
  };
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
      const reference = responseTool(call.function.name, options.toolContext);
      const item = responseToolItem(call.id, reference, response.status, call.function.arguments);
      if (reference.type === "custom") item.input = customInput(call.function.arguments);
      response.output.push(item);
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
    this.toolContext = options.toolContext;
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

  openTool(tool, events, partial = false) {
    if (tool.item) return true;
    if (!tool.callId || !tool.name) {
      if (partial) return false;
      throw upstreamError();
    }
    const reference = responseTool(tool.name, this.toolContext, partial);
    if (!reference) return false;
    tool.item = responseToolItem(tool.callId, reference, "in_progress");
    tool.index = this.addItem(tool.item, events);
    return true;
  }

  toolArguments(tool, events) {
    if (!this.openTool(tool, events, true) || tool.item.type === "custom_tool_call") return;
    const delta = tool.arguments.slice(tool.item.arguments.length);
    if (!delta) return;
    tool.item.arguments += delta;
    events.push(this.event("response.function_call_arguments.delta", {
      item_id: tool.item.id, output_index: tool.index, delta,
    }));
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
          if (!this.tools.has(call.index)) this.tools.set(call.index, { callId: "", name: "", arguments: "", item: null });
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
                tool.arguments += call.function.arguments;
              }
            }
          }
          if (tool.arguments) this.toolArguments(tool, events);
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
    // Validate all buffered custom arguments before any terminal event is emitted.
    for (const tool of this.tools.values()) {
      this.openTool(tool, events);
      if (tool.item.type === "custom_tool_call") tool.item.input = customInput(tool.arguments);
      else this.toolArguments(tool, events);
    }
    Object.assign(this.response, completionStatus(this.finishReason));
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
      } else if (item.type === "custom_tool_call") {
        if (item.input) events.push(this.event("response.custom_tool_call_input.delta", {
          item_id: item.id, output_index: outputIndex, delta: item.input,
        }));
        events.push(this.event("response.custom_tool_call_input.done", {
          item_id: item.id, output_index: outputIndex, input: item.input,
        }));
      } else events.push(this.event("response.function_call_arguments.done", {
        item_id: item.id, output_index: outputIndex, name: item.name, arguments: item.arguments,
      }));
      events.push(this.event("response.output_item.done", { output_index: outputIndex, item }));
    }
    events.push(this.event(this.response.status === "completed" ? "response.completed" : "response.incomplete", { response: this.response }));
    return events;
  }
}
