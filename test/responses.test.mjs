import test from "node:test";
import assert from "node:assert/strict";
import { prepareResponsesRequest, toChatRequest, toResponsesResponse, ResponsesStream } from "../src/responses.mjs";

const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const parsed = (frames) => frames.map((value) => JSON.parse(value.toString().split("\ndata: ")[1].trim()));
const chat = (message, finish_reason = "stop", extra = {}) => ({
  model: "upstream-model", choices: [{ message, finish_reason }], ...extra,
});
const codexTools = () => [
  { type: "function", name: "lookup", parameters: { type: "object", properties: {} } },
  { type: "namespace", name: "workspace", description: "Workspace operations", tools: [
    { type: "function", name: "lookup", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } }, defer_loading: true },
    { type: "custom", name: "apply_patch", description: "Apply the patch", format: { type: "grammar", syntax: "lark", definition: 'start: "*** Begin Patch" /.+/ "*** End Patch"' } },
  ] },
];

test("accepts Codex transport metadata and reasoning projections without forwarding them to Chat", () => {
  const request = {
    model: "codex", input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Read the file" }] },
      { type: "reasoning", id: "rs_old", encrypted_content: "opaque", summary: [{ type: "summary_text", text: "Summary projection" }], content: [{ type: "reasoning_text", text: "Reasoning projection" }] },
    ],
    stream: true, store: false, client_metadata: { originator: "codex_cli_rs", session_id: "session" },
    access_programs: { cyber: "standard" }, metadata: { application: "test" },
    include: ["reasoning.encrypted_content"], reasoning: { effort: "high", summary: "auto", context: "current_turn" },
    stream_options: { include_obfuscation: false, reasoning_summary_delivery: "sequential_cutoff" },
    tools: codexTools(), tool_choice: "auto", parallel_tool_calls: true,
  };
  const before = structuredClone(request);
  const { payload } = prepareResponsesRequest(request);
  assert.deepEqual(request, before);
  assert.deepEqual(payload.messages, [{ role: "user", content: [{ type: "text", text: "Read the file" }] }]);
  assert.deepEqual(payload.metadata, { application: "test" });
  assert.equal(payload.reasoning_effort, "high");
  for (const field of ["client_metadata", "access_programs", "reasoning", "stream_options", "include", "store"]) assert.equal(field in payload, false);
  assert.equal(JSON.stringify(payload).includes("opaque"), false);
  for (const access_programs of [{}, { cyber: null }])
    assert.equal("access_programs" in toChatRequest({ input: "test", access_programs }), false);
});

test("flattens namespace and custom tools to deterministic collision-free Chat names", () => {
  const tools = codexTools();
  tools.push({ type: "namespace", name: "workspace__lookup", tools: [{ type: "function", name: "lookup" }] });
  tools.push({ type: "namespace", name: "workspace", tools: [{ type: "function", name: "x".repeat(200) }] });
  tools.push({ type: "function", name: "非 ASCII / function" });
  const { payload } = prepareResponsesRequest({ input: "test", tools });
  const reordered = prepareResponsesRequest({ input: "test", tools: [...tools].reverse() }).payload;
  const names = payload.tools.map((tool) => tool.function.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.every((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)));
  assert.equal(names[0], "lookup");
  assert.notEqual(names[1], "lookup");
  assert.deepEqual([...names].sort(), reordered.tools.map((tool) => tool.function.name).sort());
  const custom = payload.tools[2].function;
  assert.deepEqual(custom.parameters, { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false });
  assert.match(custom.description, /not enforced by Chat/);
  assert.match(custom.description, /Begin Patch/);
  assert.equal("defer_loading" in payload.tools[1].function, false);
  const functionChoice = toChatRequest({ input: "test", tools, tool_choice: { type: "function", namespace: "workspace", name: "lookup" } });
  assert.equal(functionChoice.tool_choice.function.name, names[1]);
  const customChoice = toChatRequest({ input: "test", tools, tool_choice: { type: "custom", namespace: "workspace", name: "apply_patch" } });
  assert.equal(customChoice.tool_choice.function.name, names[2]);
});

test("restores namespace and custom calls, then preserves their IDs and values in the next turn", () => {
  const tools = codexTools();
  const first = prepareResponsesRequest({ input: "edit", tools });
  const patch = "*** Begin Patch\n你😀\n*** End Patch";
  const output = toResponsesResponse(chat({ tool_calls: [
    { type: "function", id: "call_read", function: { name: first.payload.tools[1].function.name, arguments: '{"path":"file"}' } },
    { type: "function", id: "call_patch", function: { name: first.payload.tools[2].function.name, arguments: JSON.stringify({ input: patch }) } },
  ] }, "tool_calls"), { toolContext: first.toolContext }).output;
  assert.deepEqual(output.map(({ type, name, namespace, call_id, input, arguments: args }) => ({ type, name, namespace, call_id, input, arguments: args })), [
    { type: "function_call", name: "lookup", namespace: "workspace", call_id: "call_read", input: undefined, arguments: '{"path":"file"}' },
    { type: "custom_tool_call", name: "apply_patch", namespace: "workspace", call_id: "call_patch", input: patch, arguments: undefined },
  ]);
  const next = prepareResponsesRequest({ tools, input: [
    { role: "user", content: "edit" },
    { type: "reasoning", encrypted_content: "opaque", summary: [] },
    ...output.map((item) => ({ ...item, encrypted_content: "opaque", internal_chat_message_metadata_passthrough: { ignored: true } })),
    { type: "function_call_output", call_id: "call_read", output: "file text" },
    { type: "custom_tool_call_output", call_id: "call_patch", name: "apply_patch", output: [{ type: "input_text", text: "Applied" }] },
  ] });
  const calls = next.payload.messages[1].tool_calls;
  assert.deepEqual(calls.map((call) => call.id), ["call_read", "call_patch"]);
  assert.equal(calls[0].function.name, first.payload.tools[1].function.name);
  assert.equal(calls[1].function.name, first.payload.tools[2].function.name);
  assert.deepEqual(JSON.parse(calls[1].function.arguments), { input: patch });
  assert.deepEqual(next.payload.messages.slice(2), [
    { role: "tool", tool_call_id: "call_read", content: "file text" },
    { role: "tool", tool_call_id: "call_patch", content: [{ type: "text", text: "Applied" }] },
  ]);
});

test("keeps tool mappings local to each request", () => {
  const first = prepareResponsesRequest({ input: "test", tools: [{ type: "custom", name: "edit" }] });
  const second = prepareResponsesRequest({ input: "test", tools: [{ type: "function", name: "edit" }] });
  const response = toResponsesResponse(chat({ tool_calls: [{ type: "function", id: "call_1", function: { name: "edit", arguments: "{}" } }] }, "tool_calls"), { toolContext: second.toolContext });
  assert.equal(response.output[0].type, "function_call");
  assert.equal(first.toolContext.byChatName.has("edit"), false);
});

test("returns safe field paths and rejects malformed or unsupported semantic options", () => {
  const cases = [
    [{ client_metadata: { originator: 1 } }, "client_metadata", "invalid_field"],
    [{ access_programs: { cyber: "daybreak_blue" } }, "access_programs.cyber", "unsupported_parameter"],
    [{ reasoning: { context: "unknown" } }, "reasoning.context", "invalid_field"],
    [{ stream_options: { reasoning_summary_delivery: "unknown" } }, "stream_options.reasoning_summary_delivery", "invalid_field"],
    [{ future_option: "private-value" }, "future_option", "unsupported_parameter"],
    [{ "secret/key with spaces": true }, "request", "unsupported_parameter"],
    [{ input: [{ type: "compaction", encrypted_content: "private-value" }] }, "input.0.item_type", "unsupported_parameter"],
    [{ tools: [{ type: "web_search" }] }, "tools.0.type", "unsupported_parameter"],
    [{ tools: [{ type: "custom", name: "edit", format: { type: "grammar", syntax: "unknown", definition: "private-value" } }] }, "tools.0.format.syntax", "invalid_field"],
    [{ tools: [{ type: "function", name: "same" }, { type: "function", name: "same" }] }, "tools.1.name", "invalid_field"],
  ];
  for (const [extra, param, code] of cases) assert.throws(() => prepareResponsesRequest({ input: "test", ...extra }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.param, param);
    assert.equal(error.code, code);
    assert.equal(error.message.includes("private-value"), false);
    assert.equal(error.message.includes("secret/key"), false);
    return true;
  });
  assert.throws(() => toChatRequest({ input: "test", tools: [{ type: "web_search" }] }), /web_search="disabled"/);
});

test("rejects malformed custom Chat arguments in JSON and streaming output", () => {
  const { payload, toolContext } = prepareResponsesRequest({ input: "test", tools: [{ type: "custom", name: "edit" }] });
  const name = payload.tools[0].function.name;
  for (const args of ["", "{", "{}", "null", '"text"', '{"input":1}', '{"input":"x","other":true}']) {
    const call = { type: "function", id: "call_edit", function: { name, arguments: args } };
    assert.throws(() => toResponsesResponse(chat({ tool_calls: [call] }, "tool_calls"), { toolContext }), /^Error: Invalid or interrupted upstream Chat response$/);
    const stream = new ResponsesStream({ toolContext });
    const frames = stream.push(Buffer.from(frame(chunk({ tool_calls: [{ ...call, index: 0 }] }, "tool_calls"))));
    assert.throws(() => stream.finish(), /^Error: Invalid or interrupted upstream Chat response$/);
    assert.equal(parsed(frames).some((event) => event.type === "response.completed"), false);
  }
});

test("streams fragmented custom JSON as custom input events and complete executable items", () => {
  const { payload, toolContext } = prepareResponsesRequest({ input: "test", tools: codexTools() });
  const name = payload.tools[2].function.name;
  const stream = new ResponsesStream({ toolContext });
  const frames = [];
  frames.push(...stream.push(Buffer.from(frame(chunk({ tool_calls: [{ index: 0, id: "call_patch", type: "function", function: { name: name.slice(0, 5), arguments: '{"input":' } }] })))));
  frames.push(...stream.push(Buffer.from(frame(chunk({ tool_calls: [{ index: 0, function: { name: name.slice(5), arguments: '"line\\n你😀"}' } }] })))));
  frames.push(...stream.push(Buffer.from(frame(chunk({}, "tool_calls")))));
  assert.equal(parsed(frames).some((event) => event.type.endsWith(".done")), false);
  frames.push(...stream.finish());
  const events = parsed(frames);
  const done = events.find((event) => event.type === "response.custom_tool_call_input.done");
  const delta = events.find((event) => event.type === "response.custom_tool_call_input.delta");
  const item = events.find((event) => event.type === "response.output_item.done").item;
  assert.equal(delta.delta, "line\n你😀");
  assert.equal(done.input, delta.delta);
  assert.equal(done.item_id, item.id);
  assert.equal(item.type, "custom_tool_call");
  assert.equal(item.namespace, "workspace");
  assert.equal(item.name, "apply_patch");
  assert.equal(item.call_id, "call_patch");
  assert.equal(item.input, done.input);
  assert.equal("arguments" in item, false);
  assert.equal(events.some((event) => event.type.startsWith("response.function_call_arguments")), false);
  assert.equal(events.at(-1).type, "response.completed");
  assert.deepEqual(events.at(-1).response.output, [item]);
});

test("waits for ambiguous streamed tool names before selecting a declared function", () => {
  const { toolContext } = prepareResponsesRequest({ input: "test", tools: [
    { type: "function", name: "read" }, { type: "function", name: "read_file" },
  ] });
  for (const completeName of ["read", "read_file"]) {
    const stream = new ResponsesStream({ toolContext });
    const frames = stream.push(Buffer.from(frame(chunk({ tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "read", arguments: "{" } }] }))));
    assert.equal(parsed(frames).some((event) => event.type === "response.output_item.added"), false);
    frames.push(...stream.push(Buffer.from(frame(chunk({ tool_calls: [{ index: 0, function: { name: completeName.slice(4), arguments: "}" } }] }, "tool_calls")))));
    frames.push(...stream.finish());
    const item = parsed(frames).find((event) => event.type === "response.output_item.done").item;
    assert.equal(item.name, completeName);
    assert.equal(item.call_id, "call_read");
    assert.equal(item.arguments, "{}");
  }
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
