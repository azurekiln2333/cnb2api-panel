import test from "node:test";
import assert from "node:assert/strict";
import { toChatRequest, toResponsesResponse, ResponsesStream } from "../src/responses.mjs";

const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const parsed = (frames) => frames.map((value) => JSON.parse(value.toString().split("\ndata: ")[1].trim()));
const chat = (message, finish_reason = "stop", extra = {}) => ({
  model: "upstream-model", choices: [{ message, finish_reason }], ...extra,
});

test("maps Responses generation controls and function schemas without changing input", () => {
  const input = {
    model: "chat-model", instructions: "Be concise", input: "Hello", stream: true,
    max_output_tokens: 120, temperature: 0.3, top_p: 0.9, parallel_tool_calls: false,
    tools: [{ type: "function", name: "weather", description: "Weather", strict: true, parameters: { type: "object", properties: {} } }],
    tool_choice: { type: "function", name: "weather" },
    reasoning: { effort: "high", summary: "auto" }, include: ["reasoning.encrypted_content"],
    text: { format: { type: "json_schema", name: "answer", strict: true, schema: { type: "object" } }, verbosity: "low" },
    store: false, background: false, metadata: { user_id: "test" },
  };
  const before = structuredClone(input);
  const result = toChatRequest(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.messages, [{ role: "system", content: "Be concise" }, { role: "user", content: "Hello" }]);
  assert.equal(result.max_tokens, 120);
  assert.equal(result.reasoning_effort, "high");
  assert.equal(result.verbosity, "low");
  assert.deepEqual(result.tools, [{ type: "function", function: { name: "weather", description: "Weather", strict: true, parameters: input.tools[0].parameters } }]);
  assert.deepEqual(result.tool_choice, { type: "function", function: { name: "weather" } });
  assert.deepEqual(result.response_format, { type: "json_schema", json_schema: { name: "answer", strict: true, schema: { type: "object" } } });
  for (const name of ["input", "store", "background", "include", "reasoning", "text"]) assert.equal(name in result, false);
});

test("maps full text/image history and groups parallel function calls with matching results", () => {
  const request = toChatRequest({ input: [
    { role: "developer", content: [{ type: "input_text", text: "instruction" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "What?" }, { type: "input_image", image_url: "data:image/png;base64,aA==", detail: "low" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Checking", annotations: [] }] },
    { type: "function_call", call_id: "call_1", name: "one", arguments: "{}" },
    { type: "function_call", call_id: "call_2", name: "two", arguments: '{"n":2}' },
    { type: "function_call_output", call_id: "call_1", output: "result one" },
    { type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "result two" }] },
  ] });
  assert.equal(request.messages.length, 5);
  assert.equal(request.messages[0].role, "developer");
  assert.deepEqual(request.messages[1].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,aA==", detail: "low" } });
  assert.deepEqual(request.messages[2].tool_calls.map((value) => value.id), ["call_1", "call_2"]);
  assert.deepEqual(request.messages[3], { role: "tool", tool_call_id: "call_1", content: "result one" });
  assert.deepEqual(request.messages[4], { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "result two" }] });
});

test("accepts nullable optional function tool metadata used by Responses clients", () => {
  const mapped = toChatRequest({ input: "hello", tools: [{ type: "function", name: "lookup",
    description: null, parameters: null, strict: null }] });
  assert.deepEqual(mapped.tools, [{ type: "function", function: { name: "lookup" } }]);
});

test("rejects state, hosted tools, unsupported media and malformed requests before dispatch", () => {
  const bad = [
    { previous_response_id: "resp_old" }, { conversation: "conv_old" }, { background: true }, { store: true },
    { tools: [{ type: "web_search" }] }, { truncation: "auto" }, { include: ["other"] },
    { input: [{ type: "reasoning", encrypted_content: "secret" }] },
    { input: [{ role: "user", content: [{ type: "input_file", file_id: "private" }] }] },
    { input: [{ role: "user", content: [{ type: "input_image", file_id: "private" }] }] },
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "file:///private" }] }] },
    { input: [{ type: "function_call_output", call_id: "", output: "x" }] },
    { input: [{ role: "unknown", content: "x" }] }, { max_output_tokens: 0 }, { stream: "true" },
    { text: { format: { type: "json_schema", name: "x", schema: "bad" } } },
    { tools: [{ type: "function", name: "x", strict: "yes" }] }, { unknown: true },
  ];
  for (const value of bad) assert.throws(() => toChatRequest({ input: "hello", ...value }), (error) => error.status === 400);
  for (const value of [null, [], "text", {}, { input: [] }]) assert.throws(() => toChatRequest(value), (error) => error.status === 400);
});

test("converts Chat JSON text, refusal, tools and real usage into Responses output", () => {
  const result = toResponsesResponse(chat({
    role: "assistant", content: "answer", refusal: "cannot do that",
    tool_calls: [{ type: "function", id: "call_w", function: { name: "weather", arguments: "{}" } }],
  }, "tool_calls", { usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } } }), { requestId: "request-id" });
  assert.equal(result.id, "resp_request-id");
  assert.equal(result.status, "completed");
  assert.equal(result.store, false);
  assert.equal(result.model, "upstream-model");
  assert.deepEqual(result.output[0].content, [{ type: "output_text", text: "answer", annotations: [], logprobs: [] }, { type: "refusal", refusal: "cannot do that" }]);
  assert.deepEqual({ ...result.output[1], id: "stable-item" }, { id: "stable-item", type: "function_call", status: "completed", call_id: "call_w", name: "weather", arguments: "{}" });
  assert.deepEqual(result.usage, { input_tokens: 12, input_tokens_details: { cached_tokens: 5 }, output_tokens: 8, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 20 });
});

test("preserves incomplete output and treats absent, estimated and partial usage as unknown", () => {
  for (const finish of ["length", "content_filter"]) {
    const result = toResponsesResponse(chat({ content: "partial" }, finish));
    assert.equal(result.status, "incomplete");
    assert.equal(result.output[0].status, "incomplete");
    assert.equal(result.incomplete_details.reason, finish === "length" ? "max_output_tokens" : finish);
    assert.equal(result.usage, null);
  }
  for (const report of [{ prompt_tokens: 0, completion_tokens: 0, usage_estimated: true }, { prompt_tokens: 12 }])
    assert.equal(toResponsesResponse(chat({ content: "ok" }, "stop", { usage: report })).usage, null);
  assert.equal(toResponsesResponse(chat({ content: "" }, "stop", { usage: { prompt_tokens: 0, completion_tokens: 0 } })).usage.total_tokens, 0);
});

test("preserves worker cache-hit aliases in both JSON and streaming Responses usage", () => {
  const report = { prompt_tokens: 12, completion_tokens: 3, prompt_cache_hit_tokens: 8 };
  const response = toResponsesResponse(chat({ content: "answer" }, "stop", { usage: report }));
  assert.equal(response.usage.input_tokens_details.cached_tokens, 8);
  assert.equal(response.usage.total_tokens, 15);
  const stream = new ResponsesStream();
  const frames = stream.push(Buffer.from(frame(chunk({ content: "answer" }, "stop")) +
    frame({ choices: [], usage: report })));
  frames.push(...stream.finish());
  assert.deepEqual(parsed(frames).at(-1).response.usage, response.usage);
});

test("rejects malformed successful Chat JSON rather than reporting false completion", () => {
  for (const value of [{}, { error: { message: "private" } }, chat({ content: "x" }, null), chat({ content: [] }), chat({ content: "x", role: "user" }), chat({}, "tool_calls"), chat({ function_call: { name: "legacy" } }, "function_call"), chat({ tool_calls: [{ type: "function", id: "missing-function" }] })])
    assert.throws(() => toResponsesResponse(value), /^Error: Invalid or interrupted upstream Chat response$/);
});

test("streams byte-split UTF-8 and CRLF with correct lifecycle and trailing usage", () => {
  const stream = new ResponsesStream({ model: "requested", requestId: "stream-id" });
  const source = Buffer.from(": heartbeat\r\n\r\n" + frame(chunk({ role: "assistant" })).replaceAll("\n", "\r\n") +
    frame(chunk({ content: "你😀" })) + frame(chunk({ content: "好" }, "stop")) +
    frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } }) + "data: [DONE]\n\n");
  const frames = [];
  for (const byte of source) frames.push(...stream.push(Uint8Array.of(byte)));
  assert.equal(parsed(frames).some((event) => event.type === "response.completed"), false);
  frames.push(...stream.finish());
  const events = parsed(frames);
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
  assert.deepEqual(events.slice(0, 4).map((event) => event.type), ["response.created", "response.in_progress", "response.output_item.added", "response.content_part.added"]);
  const final = events.at(-1);
  assert.equal(final.type, "response.completed");
  assert.equal(final.response.id, "resp_stream-id");
  assert.equal(final.response.output[0].content[0].text, "你😀好");
  assert.equal(final.response.usage.total_tokens, 14);
  const itemId = final.response.output[0].id;
  for (const event of events.filter((event) => event.item_id)) assert.equal(event.item_id, itemId);
});

test("streams parallel tools with fragmented identities and arguments, preserving call IDs", () => {
  const stream = new ResponsesStream();
  const values = [
    chunk({ tool_calls: [{ index: 0, id: "call_", type: "function", function: { name: "we", arguments: "" } }, { index: 1, id: "call_2", function: { name: "time", arguments: "{}" } }] }),
    chunk({ tool_calls: [{ index: 0, id: "1", function: { name: "ather", arguments: '{"city":' } }] }),
    chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "weather", arguments: '"Tokyo"}' } }] }),
    chunk({}, "tool_calls"), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } },
  ];
  const frames = values.flatMap((value) => stream.push(Buffer.from(frame(value))));
  frames.push(...stream.finish());
  const events = parsed(frames);
  const calls = events.at(-1).response.output;
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(({ call_id, name, arguments: args }) => [call_id, name, args]), [["call_2", "time", "{}"], ["call_1", "weather", '{"city":"Tokyo"}']]);
  assert.equal(events.filter((event) => event.type === "response.function_call_arguments.done").length, 2);
  for (const event of events.filter((value) => value.type === "response.function_call_arguments.done")) {
    assert.equal(event.name, calls[event.output_index].name);
    assert.equal(event.arguments, calls[event.output_index].arguments);
  }
  for (const event of events.filter((value) => value.type === "response.function_call_arguments.delta"))
    assert.equal(event.item_id, calls[event.output_index].id);
});

test("emits refusal and incomplete stream events and permits terminal EOF without DONE", () => {
  const stream = new ResponsesStream();
  const frames = stream.push(Buffer.from(frame(chunk({ refusal: "Cannot comply" }, "content_filter"))));
  frames.push(...stream.finish());
  const events = parsed(frames);
  assert.ok(events.some((event) => event.type === "response.refusal.delta" && event.delta === "Cannot comply"));
  assert.equal(events.at(-1).type, "response.incomplete");
  assert.equal(events.at(-1).response.incomplete_details.reason, "content_filter");
});

test("rejects truncated/malformed streams, upstream errors and oversized events", () => {
  for (const source of [frame(chunk({ content: "partial" })), frame(chunk({}, "tool_calls")), frame(chunk({ role: "user" }, "stop")), "data: [DONE]\n\n", "data: {bad}\n\n", frame({ error: { message: "private" } }), frame(chunk({}, "stop")) + "data: {truncated"]) {
    assert.throws(() => {
      const stream = new ResponsesStream();
      stream.push(Buffer.from(source));
      stream.finish();
    }, /^Error: Invalid or interrupted upstream Chat response$/);
  }
  assert.throws(() => new ResponsesStream().push(Buffer.from(`data: ${"x".repeat(1024 * 1024 + 1)}\n\n`)));
  const invalidUtf8 = new ResponsesStream();
  invalidUtf8.push(Buffer.from(frame(chunk({}, "stop"))));
  invalidUtf8.push(Uint8Array.of(0xe4));
  assert.throws(() => invalidUtf8.finish());
});
