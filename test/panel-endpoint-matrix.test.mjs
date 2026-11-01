import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const ADMIN = "matrix-test-admin-key";
const GATEWAY = "matrix-test-gateway-key";
const WORKER = "matrix-test-worker-key";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const json = (res, body, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const parseEvents = (text) =>
  text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => JSON.parse(block.split("\ndata: ")[1]));

const chatFields = new Set([
  "model", "messages", "stream", "stream_options", "tools", "tool_choice",
  "parallel_tool_calls", "max_tokens", "max_completion_tokens", "temperature",
  "top_p", "response_format", "reasoning_effort", "verbosity", "metadata",
  "user", "safety_identifier", "prompt_cache_key", "service_tier", "store",
  "seed", "stop", "logprobs", "top_logprobs", "logit_bias", "frequency_penalty",
  "presence_penalty", "n",
]);
const chatCompletion = (content = "hello", extra = {}) => ({
  model: "test-model",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } },
  ...extra,
});
const chatSse = (content = "streamed") =>
  frame({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }) +
  frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
  frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }) +
  "data: [DONE]\n\n";
const anthropicBody = (text = "anthropic answer") => ({
  id: "msg_mock",
  type: "message",
  role: "assistant",
  model: "test-model",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 15, output_tokens: 6 },
});
const anthropicSse =
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":15}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

// One mock CNB worker that records every request and answers per endpoint.
// Chat stays strict: any Responses-only root field produces an upstream 400,
// so a passing Responses test proves the bridge produced a Chat payload.
async function fixture(t, handler) {
  const directory = mkdtempSync(join(tmpdir(), "panel-matrix-"));
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: GATEWAY,
    dataDir: join(directory, "data"),
    allowLocal: true,
  });
  app.store.settings({ quotaProtection: { enabled: false } });
  const calls = [];
  const worker = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      json(res, { object: "list", data: [{ id: "test-model" }] });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const payload = JSON.parse(raw);
    calls.push({
      path: req.url,
      payload,
      raw,
      headers: req.headers,
      bytes: Buffer.byteLength(raw),
    });
    assert.equal(req.headers.authorization, `Bearer ${WORKER}`);
    if (req.url === "/v1/chat/completions")
      assert.ok(
        Object.keys(payload).every((key) => chatFields.has(key)),
        `unsupported Chat field: ${Object.keys(payload).filter((key) => !chatFields.has(key)).join(",")}`,
      );
    await handler(req, res, payload, req.url);
  });
  const endpoint = await listen(worker);
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(worker);
    rmSync(directory, { recursive: true, force: true });
  });
  const account = app.store.create({ name: "matrix-worker", endpoint, proxyKey: WORKER });
  await app.pool.probe(account.id);
  const post = (path, body, headers = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GATEWAY}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  // Store prepends new records, so the oldest request log is last.
  const requestLogs = () =>
    app.store.state.logs.filter((entry) => entry.kind === "request").reverse();
  return { ...app, base, endpoint, calls, post, requestLogs, accountId: account.id };
}

const codexSession = (overrides = {}) => ({
  model: "test-model",
  instructions: "You are Codex, a coding agent.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "fix the failing test" }] },
  ],
  stream: true,
  store: false,
  reasoning: { effort: "medium", summary: "auto" },
  include: ["reasoning.encrypted_content"],
  tools: [
    { type: "function", name: "shell", description: "Run a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { type: "web_search_preview" },
    { type: "function", name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  ...overrides,
});

// Every gateway route, the upstream path the panel must use, and the auth style
// the corresponding official client sends.
const MATRIX = [
  {
    name: "Chat Completions",
    path: "/v1/chat/completions",
    upstream: "/v1/chat/completions",
    headers: {},
    body: {
      model: "test-model",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.2,
      stream_options: { include_usage: false },
    },
  },
  {
    name: "Responses",
    path: "/v1/responses",
    upstream: "/v1/chat/completions",
    headers: {},
    body: {
      model: "test-model",
      input: "hello",
      instructions: "be brief",
      max_output_tokens: 32,
      store: false,
    },
  },
  {
    name: "Messages",
    path: "/v1/messages",
    upstream: "/v1/messages",
    headers: { "x-api-key": GATEWAY, "anthropic-version": "2023-06-01", "anthropic-beta": "prompt-caching-2024-07-31" },
    body: {
      model: "test-model",
      max_tokens: 64,
      system: [{ type: "text", text: "be brief" }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
  },
];

test("the three gateway endpoints reach their documented upstream path with client auth", async (t) => {
  const app = await fixture(t, (req, res, payload, path) => {
    if (path === "/v1/chat/completions") return json(res, chatCompletion());
    if (payload.stream === true) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end(anthropicSse);
    }
    return json(res, anthropicBody());
  });
  for (const route of MATRIX) {
    const response = await app.post(route.path, route.body, route.headers);
    assert.equal(response.status, 200, `${route.name} status`);
    assert.ok(response.headers.get("x-request-id"), `${route.name} request id`);
    await response.text();
  }
  assert.deepEqual(
    app.calls.map((call) => call.path),
    MATRIX.map((route) => route.upstream),
  );
  // Forwarding always replaces client credentials with the worker proxy key.
  for (const call of app.calls) {
    assert.equal(call.headers.authorization, `Bearer ${WORKER}`);
    assert.equal(call.headers["x-api-key"], undefined);
  }
  // Anthropic version headers follow the native Messages request upstream.
  assert.equal(app.calls[2].headers["anthropic-version"], "2023-06-01");
  // Chat and Responses both request usage; a client cannot disable it.
  assert.deepEqual(app.calls[0].payload.stream_options, { include_usage: true });
  assert.deepEqual(app.calls[1].payload.stream_options, { include_usage: true });
  // Native Messages payload keeps its Anthropic shape, including max_tokens.
  assert.equal(app.calls[2].payload.max_tokens, 64);
  assert.deepEqual(app.calls[2].payload.system, [{ type: "text", text: "be brief" }]);
  // Chat and Messages never grow a Responses system/instructions field.
  assert.equal(app.calls[0].payload.instructions, undefined);
  assert.equal(app.calls[2].payload.instructions, undefined);
  const logs = app.requestLogs();
  assert.deepEqual(
    logs.map((entry) => entry.path),
    MATRIX.map((route) => route.path),
  );
  assert.ok(logs.every((entry) => entry.status === 200 && entry.attempts === 1));
});

test("the three gateway endpoints stream client formats without conversion of native routes", async (t) => {
  const app = await fixture(t, (_req, res, _payload, path) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (path === "/v1/messages") return res.end(anthropicSse);
    return res.end(chatSse());
  });
  const chat = await app.post("/v1/chat/completions", {
    model: "test-model",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(chat.status, 200);
  assert.equal(await chat.text(), chatSse());

  const messages = await app.post(
    "/v1/messages",
    { model: "test-model", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hello" }] },
    { "anthropic-version": "2023-06-01" },
  );
  assert.equal(messages.status, 200);
  assert.equal(await messages.text(), anthropicSse);

  const responses = await app.post("/v1/responses", {
    model: "test-model",
    stream: true,
    input: "hello",
  });
  assert.equal(responses.status, 200);
  assert.match(responses.headers.get("content-type"), /text\/event-stream/);
  const events = parseEvents(await responses.text());
  assert.equal(events[0].type, "response.created");
  assert.equal(events.find((event) => event.type === "response.output_text.delta").delta, "streamed");
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.usage.total_tokens, 11);

  // Native streams pass through byte-for-byte; Responses emits Responses events.
  assert.equal(app.calls[0].payload.stream, true);
  assert.equal(app.calls[1].payload.stream, true);
  assert.equal(app.calls[2].payload.stream, true);
  const logs = app.requestLogs();
  assert.deepEqual(logs.map((entry) => [entry.path, entry.stream]), [
    ["/v1/chat/completions", true],
    ["/v1/messages", true],
    ["/v1/responses", true],
  ]);
  assert.deepEqual(
    logs.map((entry) => entry.responseBytes > 0),
    [true, true, true],
  );
});

test("count_tokens reaches the worker and stays out of consumption accounting", async (t) => {
  const app = await fixture(t, (req, res, _payload, path) => {
    if (path === "/v1/chat/completions") return json(res, chatCompletion());
    json(res, { input_tokens: 42 });
  });
  const counted = await app.post(
    "/v1/messages/count_tokens",
    { model: "test-model", messages: [{ role: "user", content: "hello" }] },
    { "anthropic-version": "2023-06-01" },
  );
  assert.equal(counted.status, 200);
  assert.deepEqual(await counted.json(), { input_tokens: 42 });
  assert.equal(app.calls[0].path, "/v1/messages/count_tokens");
  const countedLog = app.requestLogs()[0];
  assert.equal(countedLog.path, "/v1/messages/count_tokens");
  assert.equal(countedLog.tokenUsage, undefined);

  await (await app.post("/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  })).text();
  const consumed = app.requestLogs()[1];
  assert.deepEqual(
    { input: consumed.tokenUsage.input, output: consumed.tokenUsage.output },
    { input: 11, output: 4 },
  );
});

test("a Codex request with a hosted web_search tool reaches Chat only with function tools", async (t) => {
  const app = await fixture(t, (_req, res) => json(res, chatCompletion("done")));
  const response = await app.post("/v1/responses", codexSession({ stream: false }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.object, "response");
  assert.equal(body.output[0].content[0].text, "done");
  assert.equal(app.calls.length, 1);
  const forwarded = app.calls[0].payload;
  assert.ok(Array.isArray(forwarded.tools));
  assert.ok(forwarded.tools.every((tool) => tool.type === "function"));
  // Function tools survive in order; the hosted web_search tool is dropped.
  assert.deepEqual(
    forwarded.tools.map((tool) => tool.function.name),
    ["shell", "read_file"],
  );
  const readFile = forwarded.tools.find((tool) => tool.function.name === "read_file");
  assert.equal(forwarded.tool_choice, "auto");
  assert.equal(forwarded.parallel_tool_calls, true);
  // Responses storage is meaningless to Chat workers and must not reach them.
  assert.equal("store" in forwarded, false);
  assert.equal("include" in forwarded, false);
  assert.equal(forwarded.instructions, undefined);
  assert.deepEqual(readFile.function.parameters.properties.path, { type: "string" });
  const log = app.requestLogs()[0];
  assert.equal(log.path, "/v1/responses");
  assert.equal(log.status, 200);
  assert.equal(log.tokenUsage.input, 11);
  assert.equal(log.tokenUsage.cacheRead, 3);
});

test("a Codex streaming turn with a hosted web_search tool keeps tool-call events", async (t) => {
  const app = await fixture(t, async (_req, res, payload) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const index = payload.tools.findIndex((tool) => tool.function.name === "read_file");
    const args = '{"path":"src/app.mjs"}';
    res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "call_read", type: "function", function: { name: payload.tools[index].function.name, arguments: args.slice(0, 5) } },
    ] }, finish_reason: null }] }));
    res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: args.slice(5) } },
    ] }, finish_reason: "tool_calls" }] }));
    res.end(frame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 8 } }) + "data: [DONE]\n\n");
  });
  const response = await app.post("/v1/responses", codexSession({ tools: [
    { type: "web_search" },
    { type: "function", name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } },
  ] }));
  assert.equal(response.status, 200);
  const events = parseEvents(await response.text());
  assert.equal(events.at(-1).type, "response.completed");
  const item = events.at(-1).response.output[0];
  assert.equal(item.type, "function_call");
  assert.equal(item.name, "read_file");
  assert.equal(item.call_id, "call_read");
  assert.equal(item.arguments, '{"path":"src/app.mjs"}');
  // The remaining function tool keeps index 0 in the Chat request.
  assert.equal(app.calls[0].payload.tools.length, 1);
  assert.equal(app.calls[0].payload.tools[0].function.name, "read_file");
  assert.equal(app.requestLogs()[0].path, "/v1/responses");
});

test("endpoint error shapes follow the calling client protocol", async (t) => {
  const app = await fixture(t, (_req, res, _payload, path) => {
    if (path === "/v1/messages")
      return json(res, { type: "error", error: { type: "invalid_request_error", message: "upstream rejected messages" } }, 400);
    json(res, { error: { type: "invalid_request_error", message: "upstream rejected chat" } }, 400);
  });
  const chat = await app.post("/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(chat.status, 400);
  assert.equal((await chat.json()).error.message, "upstream rejected chat");

  const responses = await app.post("/v1/responses", { model: "test-model", input: "hello" });
  assert.equal(responses.status, 400);
  assert.equal((await responses.json()).error.message, "upstream rejected chat");

  const messages = await app.post(
    "/v1/messages",
    { model: "test-model", max_tokens: 8, messages: [{ role: "user", content: "hello" }] },
    { "anthropic-version": "2023-06-01" },
  );
  assert.equal(messages.status, 400);
  const body = await messages.json();
  assert.equal(body.type, "error");
  assert.equal(body.error.message, "upstream rejected messages");

  // Client errors never cool or switch the healthy workspace.
  assert.equal(app.store.get(app.accountId).status, "healthy");
  assert.ok(app.requestLogs().every((entry) => entry.status === 400));
  assert.ok(!JSON.stringify(app.store.state.logs).includes("upstream rejected chat"));
});

test("pool exhaustion returns the protocol-shaped public 503 on all three endpoints", async (t) => {
  const app = await fixture(t, (_req, res) => json(res, chatCompletion()));
  app.store.settings({ quotaProtection: { enabled: false } });
  app.store.update(app.accountId, { enabled: false });
  const before = app.requestLogs().length;
  const results = {};
  for (const route of MATRIX) {
    const response = await app.post(route.path, route.body, route.headers);
    assert.equal(response.status, 503, route.name);
    assert.equal(response.headers.get("retry-after"), "15");
    results[route.path] = await response.json();
  }
  assert.equal(results["/v1/chat/completions"].error.message, "服务暂时不可用，请稍后重试");
  assert.equal(results["/v1/responses"].error.message, "服务暂时不可用，请稍后重试");
  assert.equal(results["/v1/messages"].type, "error");
  assert.equal(results["/v1/messages"].error.message, "服务暂时不可用，请稍后重试");
  for (const route of MATRIX) {
    assert.ok(!/账号|工作区|冷却|模型范围/.test(JSON.stringify(results[route.path])));
  }
  const logs = app.requestLogs().slice(before);
  assert.deepEqual(logs.map((entry) => entry.path), MATRIX.map((route) => route.path));
  assert.ok(logs.every((entry) => entry.status === 503 && entry.attempts === 0));
});
