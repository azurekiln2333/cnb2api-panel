import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const GATEWAY = "responses-test-gateway-key";
const WORKER = "responses-test-worker-key";
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
const completion = (content = "hello", extra = {}) => ({
  model: "test-model", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } }, ...extra,
});
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const parseEvents = (text) => text.split("\n\n").filter(Boolean).map((block) => JSON.parse(block.split("\ndata: ")[1]));
const CHAT_FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "tools", "tool_choice", "parallel_tool_calls",
  "max_tokens", "max_completion_tokens", "temperature", "top_p", "response_format", "reasoning_effort",
  "verbosity", "metadata", "user", "safety_identifier", "prompt_cache_key", "service_tier", "store",
  "seed", "stop", "logprobs", "top_logprobs", "logit_bias", "frequency_penalty", "presence_penalty", "n",
]);

async function fixture(t, handler, { account = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "panel-responses-"));
  const app = createPanelServer({
    adminKey: "responses-test-admin-key", gatewayKey: GATEWAY,
    dataDir: join(directory, "data"), allowLocal: true,
  });
  const calls = [];
  const worker = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      json(res, { object: "list", data: [{ id: "test-model" }] });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ path: req.url, payload, headers: req.headers });
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, `Bearer ${WORKER}`);
    if (Object.keys(payload).some((key) => !CHAT_FIELDS.has(key))) {
      json(res, { error: { message: "strict Chat upstream rejected unsupported request field" } }, 400);
      return;
    }
    await handler(req, res, payload);
  });
  const endpoint = await listen(worker);
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(worker);
    rmSync(directory, { recursive: true, force: true });
  });
  let id;
  if (account) {
    const created = app.store.create({ name: "response-worker", endpoint, proxyKey: WORKER });
    id = created.id;
    await app.pool.probe(id);
  }
  const send = (payload, options = {}) => fetch(`${base}/v1/responses`, {
    method: "POST", headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-model", input: "hello", ...payload }), ...options,
  });
  return { ...app, base, endpoint, worker, calls, send, id };
}

test("Responses JSON uses Chat upstream, existing rewrites and original Chat usage accounting", async (t) => {
  const app = await fixture(t, (_req, res) => json(res, completion("answer")));
  const response = await app.send({
    instructions: "system instruction", input: [{ role: "developer", content: "developer instruction" }, { role: "user", content: "hello" }],
    max_output_tokens: 50,
  });
  assert.equal(response.status, 200);
  assert.ok(response.headers.get("x-request-id"));
  const body = await response.json();
  assert.equal(body.object, "response");
  assert.equal(body.output[0].content[0].text, "answer");
  assert.equal(body.usage.input_tokens, 12);
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].payload.max_tokens, 50);
  assert.deepEqual(app.calls[0].payload.messages.map((message) => message.role), ["system", "system", "user"]);
  assert.equal(app.calls[0].payload.stream_options.include_usage, true);
  const record = app.store.state.logs.find((entry) => entry.kind === "request");
  assert.equal(record.path, "/v1/responses");
  assert.equal(record.initialMessage.text, "hello");
  assert.equal(record.tokenUsage.input, 12);
  assert.equal(record.tokenUsage.cacheRead, 5);
  assert.equal(record.tokenUsage.total, 15);
  assert.equal(record.responseBytes, Buffer.byteLength(JSON.stringify(body)));
});

test("Responses supports function history, tool selection and returned calls", async (t) => {
  const app = await fixture(t, (_req, res) => json(res, completion(null, {
    choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call_next", type: "function", function: { name: "lookup", arguments: '{"id":2}' } }] }, finish_reason: "tool_calls" }],
  })));
  const response = await app.send({
    input: [
      { role: "user", content: "lookup" },
      { type: "function_call", call_id: "call_previous", name: "lookup", arguments: '{"id":1}' },
      { type: "function_call_output", call_id: "call_previous", output: "one" },
    ],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    tool_choice: { type: "function", name: "lookup" },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].call_id, "call_next");
  assert.equal(app.calls[0].payload.messages[2].tool_call_id, "call_previous");
  assert.equal(app.calls[0].payload.tools[0].function.name, "lookup");
});

const codexRequest = (extra = {}) => ({
  instructions: "Inspect the project and apply the requested patch.",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "fix the project" }] }],
  client_metadata: { session_id: "client-session-secret", turn_id: "client-turn-secret" },
  metadata: { task: "preserved-standard-metadata" },
  reasoning: { effort: "high", summary: "auto", context: "current_turn" },
  stream_options: { include_obfuscation: true, reasoning_summary_delivery: "sequential_cutoff" },
  include: ["reasoning.encrypted_content"],
  store: false,
  text: { format: { type: "text" }, verbosity: "low" },
  tools: [{
    type: "namespace", name: "functions", description: "Project tools", tools: [
      { type: "function", name: "lookup", description: "Find a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, strict: true },
      { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark", definition: 'start: /[\\s\\S]+/' } },
    ],
  }],
  tool_choice: "auto",
  parallel_tool_calls: true,
  ...extra,
});

test("Codex JSON preserves namespace/custom calls and complete second-turn history through strict Chat", async (t) => {
  const patch = "*** Begin Patch\n*** End Patch";
  const app = await fixture(t, (_req, res, payload) => {
    if (app.calls.length === 1) {
      json(res, completion(null, {
        choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [
          { id: "call_lookup", type: "function", function: { name: payload.tools[0].function.name, arguments: '{"path":"src"}' } },
          { id: "call_patch", type: "function", function: { name: payload.tools[1].function.name, arguments: JSON.stringify({ input: patch }) } },
        ] }, finish_reason: "tool_calls" }],
      }));
    } else json(res, completion("Project fixed."));
  });
  const response = await app.send(codexRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].name, "lookup");
  assert.equal(body.output[0].namespace, "functions");
  assert.equal(body.output[0].call_id, "call_lookup");
  assert.equal(body.output[1].type, "custom_tool_call");
  assert.equal(body.output[1].name, "apply_patch");
  assert.equal(body.output[1].namespace, "functions");
  assert.equal(body.output[1].call_id, "call_patch");
  assert.equal(body.output[1].input, patch);
  assert.deepEqual(app.calls[0].payload.metadata, { task: "preserved-standard-metadata" });
  assert.deepEqual(app.calls[0].payload.stream_options, { include_usage: true });
  assert.equal(app.calls[0].payload.reasoning_effort, "high");
  assert.equal(app.calls[0].payload.tools[1].function.parameters.properties.input.type, "string");

  const followup = await app.send(codexRequest({
    input: [
      ...codexRequest().input,
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I found the file." }] },
      { type: "reasoning", id: "rs_prior", summary: [{ type: "summary_text", text: "Inspecting the project." }], encrypted_content: "opaque-reasoning-secret" },
      ...body.output,
      { type: "function_call_output", call_id: "call_lookup", output: "src/index.mjs" },
      { type: "custom_tool_call_output", call_id: "call_patch", output: [{ type: "input_text", text: "Patch applied" }] },
    ],
  }));
  assert.equal(followup.status, 200);
  assert.equal((await followup.json()).output[0].content[0].text, "Project fixed.");
  const messages = app.calls[1].payload.messages;
  const assistant = messages.find((message) => message.tool_calls);
  assert.ok(messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("I found the file.")));
  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ["call_lookup", "call_patch"]);
  assert.deepEqual(assistant.tool_calls.map((call) => call.function.name), app.calls[0].payload.tools.map((tool) => tool.function.name));
  assert.deepEqual(JSON.parse(assistant.tool_calls[1].function.arguments), { input: patch });
  assert.deepEqual(messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id), ["call_lookup", "call_patch"]);
  assert.ok(!JSON.stringify(app.calls).includes("opaque-reasoning-secret"));
  assert.ok(!JSON.stringify(app.calls).includes("client-session-secret"));
  const records = app.store.state.logs.filter((entry) => entry.kind === "request");
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.path === "/v1/responses" && record.tokenUsage.input === 12));
});

test("Codex SSE restores custom tool events and namespace through strict Chat", async (t) => {
  const patch = "*** Begin Patch\n*** End Patch";
  const app = await fixture(t, async (_req, res, payload) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const argumentsText = JSON.stringify({ input: patch });
    const cut = Math.floor(argumentsText.length / 2);
    res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "call_stream_patch", type: "function", function: { name: payload.tools[1].function.name, arguments: argumentsText.slice(0, cut) } },
    ] }, finish_reason: null }] }));
    res.write(frame({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: argumentsText.slice(cut) } },
    ] }, finish_reason: "tool_calls" }] }));
    res.end(frame({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } }) + "data: [DONE]\n\n");
  });
  const response = await app.send(codexRequest({ stream: true }));
  assert.equal(response.status, 200);
  const events = parseEvents(await response.text());
  assert.equal(events.at(-1).type, "response.completed");
  const item = events.at(-1).response.output[0];
  assert.equal(item.type, "custom_tool_call");
  assert.equal(item.namespace, "functions");
  assert.equal(item.name, "apply_patch");
  assert.equal(item.call_id, "call_stream_patch");
  assert.equal(item.input, patch);
  assert.equal(events.filter((event) => event.type === "response.custom_tool_call_input.delta").map((event) => event.delta).join(""), patch);
  assert.equal(events.find((event) => event.type === "response.custom_tool_call_input.done").input, patch);
  assert.ok(!events.some((event) => event.type === "response.function_call_arguments.delta"));
  const record = app.store.state.logs.find((entry) => entry.kind === "request");
  assert.equal(record.path, "/v1/responses");
  assert.equal(record.tokenUsage.input, 7);
  assert.equal(record.tokenUsage.output, 4);
});

test("native Chat removes client_metadata while preserving standard metadata", async (t) => {
  const app = await fixture(t, (_req, res) => json(res, completion("native reply")));
  const response = await fetch(`${app.base}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "native request" }], client_metadata: { session_id: "client-secret" }, metadata: { task: "preserved" } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "native reply");
  assert.equal(Object.hasOwn(app.calls[0].payload, "client_metadata"), false);
  assert.deepEqual(app.calls[0].payload.metadata, { task: "preserved" });
  assert.equal(app.store.state.logs.find((entry) => entry.kind === "request").path, "/v1/chat/completions");
});

test("Responses validation exposes safe field locations without request values", async (t) => {
  const app = await fixture(t, (_req, res) => json(res, completion()));
  const response = await app.send({ future_option: "private-field-value" });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.param, "future_option");
  assert.match(body.error.code, /^[a-z][a-z0-9_]{0,63}$/);
  assert.ok(!JSON.stringify(body).includes("private-field-value"));
  assert.equal(app.calls.length, 0);
  const unsafe = await app.send({ "untrusted/secret-field": "private-field-value" });
  assert.equal(unsafe.status, 400);
  assert.ok(!JSON.stringify(await unsafe.json()).includes("untrusted/secret-field"));
});

test("Responses SSE translates split Unicode/text/tool events and captures trailing usage", async (t) => {
  const app = await fixture(t, async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const wire = Buffer.from(
      frame({ choices: [{ index: 0, delta: { content: "你好" }, finish_reason: null }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "lookup", arguments: "{" } }] }, finish_reason: null }] }) +
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] }) +
      frame({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } }) + "data: [DONE]\n\n",
    );
    for (let start = 0; start < wire.length; start += 7) {
      res.write(wire.subarray(start, start + 7));
      await new Promise((resolve) => setImmediate(resolve));
    }
    res.end();
  });
  const response = await app.send({ stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const text = await response.text();
  const events = parseEvents(text);
  assert.equal(events[0].type, "response.created");
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.find((entry) => entry.type === "response.output_text.delta").delta, "你好");
  assert.equal(events.at(-1).response.output[1].arguments, "{}");
  assert.equal(events.at(-1).response.usage.total_tokens, 12);
  assert.deepEqual(events.map((entry) => entry.sequence_number), events.map((_entry, index) => index));
  const record = app.store.state.logs.find((entry) => entry.kind === "request");
  assert.equal(record.tokenUsage.input, 8);
  assert.equal(record.tokenUsage.output, 4);
  assert.equal(record.responseBytes, Buffer.byteLength(text));
});

test("Responses route requires gateway auth, supports preflight and rejects unsupported state before dispatch", async (t) => {
  const app = await fixture(t, (_req, res) => json(res, completion()));
  const unauthorized = await app.send({}, { headers: { "Content-Type": "application/json" } });
  assert.equal(unauthorized.status, 401);
  const preflight = await fetch(`${app.base}/v1/responses`, { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  for (const input of [{ previous_response_id: "resp_old" }, { tools: [{ type: "web_search" }] }]) {
    const result = await app.send(input);
    assert.equal(result.status, 400);
    assert.match((await result.json()).error.message, /does not support/);
  }
  assert.equal(app.calls.length, 0);
});

test("Responses transport preserves non-retryable upstream errors", async (t) => {
  const app = await fixture(t, (_req, res) => json(res, { error: { type: "invalid_request_error", message: "bad request" } }, 400));
  const response = await app.send({});
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.message, "bad request");
  assert.equal(app.store.get(app.id).status, "healthy");
});

test("Responses retries retryable HTTP failures using the existing pool", async (t) => {
  let count = 0;
  const app = await fixture(t, (_req, res) => {
    count++;
    json(res, count === 1 ? { error: { message: "private failure" } } : completion(), count === 1 ? 503 : 200);
  });
  const second = app.store.create({ name: "second", endpoint: app.endpoint, proxyKey: WORKER });
  await app.pool.probe(second.id);
  const response = await app.send({});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "completed");
  assert.equal(app.calls.length, 2);
  assert.equal(app.store.state.logs.find((entry) => entry.kind === "request").attempts, 2);
  assert.ok(!JSON.stringify(app.store.state.logs).includes("private failure"));
});

test("inference idle timeout confirms a reachable worker instead of marking it offline", async (t) => {
  const app = await fixture(t, () => {});
  app.store.state.settings.idleTimeoutSeconds = 0.04;
  const response = await app.send({});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.message, "服务暂时不可用，请稍后重试");
  assert.equal(app.store.get(app.id).status, "healthy");
  assert.equal(app.store.get(app.id).cooldownUntil, null);
});

test("public pool exhaustion does not expose accounts, workspaces or cooldown internals", async (t) => {
  const app = await fixture(t, () => {}, { account: false });
  const response = await app.send({});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "15");
  const body = await response.text();
  assert.ok(!/账号|工作区|冷却|模型范围/.test(body));
  assert.match(body, /服务暂时不可用/);
});

test("interrupted Chat SSE never emits a false Responses completed event", async (t) => {
  const app = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(frame({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }));
  });
  const response = await app.send({ stream: true });
  let wire = "";
  let interrupted = false;
  try {
    for await (const value of response.body) wire += Buffer.from(value).toString("utf8");
  } catch { interrupted = true; }
  assert.ok(interrupted);
  assert.ok(!wire.includes("response.completed"));
  assert.equal(app.store.get(app.id).status, "healthy");
});

test("a disconnected Responses stream cancels its Chat request without cooling the worker", async (t) => {
  let markClosed;
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const app = await fixture(t, (_req, res) => {
    res.on("close", markClosed);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(frame({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }));
  });
  const response = await app.send({ stream: true });
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
  let timeout;
  try {
    await Promise.race([closed, new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("Chat request did not cancel")), 3000);
    })]);
  } finally {
    clearTimeout(timeout);
  }
  for (let i = 0; i < 100 && !app.store.state.logs.some((entry) => entry.kind === "request"); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const record = app.store.state.logs.find((entry) => entry.kind === "request");
  assert.equal(record.status, 499);
  assert.equal(app.store.get(app.id).status, "healthy");
  assert.equal(app.store.get(app.id).cooldownUntil, null);
  assert.equal(app.pool.active.get(app.id), 0);
});
