import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPanelServer } from "../src/app.mjs";
import { Store } from "../src/store.mjs";
import { rewriteRequest, validateRequestOverrides } from "../src/request-overrides.mjs";
import { removeAll } from "./support/sqlite-fixture.mjs";

const ADMIN = "synthetic-panel-admin";
const GATEWAY = "synthetic-gateway-key";
const PROXY = "synthetic-workspace-key";

test("the supplied complete New API identity regex matches each alternative", () => {
  const from = String.raw`(?i)You are an AI agent powered by DeepSeek Harness\.?|You are a coding agent powered by the [^\r\n]+ model\.?|You are an AI assistant built on (?:the )?DeepSeek(?:-[a-z0-9._-]+ model)?\.?`;
  const requestOverrides = validateRequestOverrides({ operations: [{
    mode: "regex_replace", path: "messages.0.content", from,
    to: "You are a helpful coding assistant.",
    conditions: [{ path: "messages.0.role", mode: "regex", value: "^(system|developer)$" }],
  }] });
  for (const text of [
    "YOU ARE AN AI AGENT POWERED BY DEEPSEEK HARNESS.",
    "You are a coding agent powered by the deepseek-v4.1 model.",
    "You are an AI assistant built on the DeepSeek-v4.1 model.",
    "You are an AI assistant built on DeepSeek.",
  ]) {
    for (const role of ["system", "developer"]) {
      const result = rewriteRequest({ messages: [{ role, content: text }] },
        { dshCompat: false, requestOverrides }, "/v1/chat/completions");
      assert.equal(result.payload.messages[0].content, "You are a helpful coding assistant.");
      assert.equal(result.rules[6].outcome, "applied");
      assert.equal(result.rules[6].count, 1);
    }
    const user = rewriteRequest({ messages: [{ role: "user", content: text }] },
      { dshCompat: false, requestOverrides }, "/v1/chat/completions");
    assert.equal(user.payload.messages[0].content, text);
    assert.equal(user.rules[6].outcome, "unmatched");
    // The Claude Code preset stays inert for Chat Completions.
    assert.deepEqual(user.rules.slice(3, 6).map((rule) => rule.outcome), ["skipped", "skipped", "skipped"]);
  }
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "panel-overrides-"));
  const directory = join(root, "data");
  const servers = [];
  const app = createPanelServer({ adminKey: ADMIN, gatewayKey: GATEWAY, dataDir: directory, allowLocal: true });
  app.store.settings({ quotaProtection: { enabled: false } });
  const base = await listen(app.server);
  const login = await fetch(`${base}/api/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: ADMIN }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = (path, { method = "GET", body, headers = {} } = {}) => fetch(`${base}${path}`, {
    method, headers: { Cookie: cookie, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const worker = async (handler, priority = 0) => {
    const calls = [];
    const server = http.createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks));
      calls.push({ payload, headers: req.headers });
      await handler(req, res, payload);
    });
    servers.push(server);
    const endpoint = await listen(server);
    const created = await call("/api/accounts", {
      method: "POST", body: { name: `synthetic-${priority}`, endpoint, priority, proxyKey: PROXY },
    });
    assert.equal(created.status, 201);
    const account = (await created.json()).account;
    await app.pool.probe(account.id);
    return calls;
  };
  const send = (payload, headers = {}) => fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  const sendMessages = (payload, headers = {}) => fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": GATEWAY, "anthropic-version": "2023-06-01", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  t.after(async () => {
    app.pool.stop();
    for (const server of [app.server, ...servers]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    removeAll(root);
  });
  return { ...app, base, directory, call, worker, send, sendMessages };
}

test("DSH rewrites reach the workspace and diagnostics retain structure, not content", async (t) => {
  const app = await fixture(t);
  const calls = await app.worker((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "x-cnb2api-override-support": "1" });
    res.end('data: {"choices":[]}\n\ndata: [DONE]\n\n');
  });
  const overrides = { operations: [
    { mode: "copy", from: "max_completion_tokens", to: "max_tokens", conditions: [{ path: "max_completion_tokens", mode: "regex", value: "^[0-9]+$" }] },
    { mode: "delete", path: "max_completion_tokens" },
    { mode: "delete", path: "store" },
    { mode: "regex_replace", path: "messages.0.content", from: "(?i)You are an AI agent powered by DeepSeek Harness\\.?", to: "You are a helpful coding assistant.", description: "private-rule-description", conditions: [{ path: "messages.0.role", mode: "regex", value: "^(system|developer)$" }] },
  ] };
  const configured = await app.call("/api/settings", { method: "PATCH", body: {
    dshCompat: true, requestOverrides: overrides, upstreamHeaders: { "User-Agent": "SyntheticAgent/1.0" },
  } });
  assert.equal(configured.status, 200, await configured.text());
  const input = {
    model: "test-model", stream: true, max_completion_tokens: 123, store: false,
    messages: [
      { role: "developer", content: "You are an AI agent powered by DeepSeek Harness. private-system" },
      { role: "user", content: "visible-first-user" },
      { role: "developer", content: "private-later-developer" },
      { role: "assistant", content: "You are an AI agent powered by DeepSeek Harness. private-assistant" },
      { role: "tool", content: "private-tool" },
    ],
  };
  const response = await app.send(input, { "x-cnb2api-upstream-headers": "forged-carrier" });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\[DONE\]/);
  assert.equal(calls.length, 1);
  const outbound = calls[0].payload;
  assert.equal(outbound.messages[0].role, "system");
  assert.equal(outbound.messages[2].role, "system");
  assert.doesNotMatch(outbound.messages[0].content, /DeepSeek Harness/i);
  assert.doesNotMatch(outbound.messages[3].content, /You are an AI agent powered by DeepSeek Harness/i);
  assert.equal(outbound.messages[1].content, input.messages[1].content);
  assert.equal(outbound.messages[4].content, input.messages[4].content);
  assert.equal(outbound.max_tokens, 123);
  assert.equal(outbound.max_completion_tokens, undefined);
  assert.equal(outbound.store, undefined);
  assert.equal(outbound.stream_options.include_usage, true);
  assert.equal(calls[0].headers.authorization, `Bearer ${PROXY}`);
  const carrier = calls[0].headers["x-cnb2api-upstream-headers"];
  assert.notEqual(carrier, "forged-carrier");
  assert.deepEqual(JSON.parse(Buffer.from(carrier, "base64url")), { "user-agent": "SyntheticAgent/1.0" });
  const summaries = (await (await app.call("/api/logs/requests")).json()).logs;
  const summary = summaries.find((entry) => entry.kind === "request");
  assert.equal(summary.requestDiagnostics, undefined);
  assert.equal((await fetch(`${app.base}/api/logs/requests/${summary.id}`)).status, 401);
  const log = (await (await app.call(`/api/logs/requests/${summary.id}`)).json()).log;
  const diagnostics = log.requestDiagnostics;
  assert.equal(diagnostics.received.messages[0].role, "developer");
  assert.equal(diagnostics.forwarded.messages[0].role, "system");
  assert.equal(diagnostics.headers.supported, true);
  assert.deepEqual(diagnostics.headers.configured, ["user-agent"]);
  assert.ok(diagnostics.rules.some((rule) => rule.outcome === "applied"));
  for (const secret of ["private-system", "private-later-developer", "private-assistant", "private-tool", "private-rule-description", "SyntheticAgent/1.0", PROXY, GATEWAY])
    assert.ok(!JSON.stringify(log).includes(secret));
  const saved = (await (await app.call("/api/settings")).json()).settings;
  assert.equal(saved.requestOverrides.operations[3].description, "private-rule-description");
  const restarted = new Store(app.directory, { allowLocal: true });
  assert.equal(restarted.state.settings.dshCompat, true);
  assert.deepEqual(restarted.state.settings.upstreamHeaders, { "user-agent": "SyntheticAgent/1.0" });
  assert.equal(restarted.state.settings.requestOverrides.operations[3].description, "private-rule-description");
});

test("near-limit DSH requests retain rewrites and request bytes across failover", async (t) => {
  const app = await fixture(t);
  const first = await app.worker((_req, res) => { res.writeHead(503); res.end(); }, 10);
  const second = await app.worker((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"choices":[]}');
  });
  const identity = "You are an AI agent powered by DeepSeek Harness.";
  const payload = {
    model: "test-model", stream: false,
    messages: [
      { role: "developer", content: `${"x".repeat(4 * 1024 * 1024 - 2048)}\n${identity}` },
      { role: "assistant", content: identity },
      { role: "user", content: "visible" },
    ],
  };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 4 * 1024 * 1024);
  const response = await app.send(payload);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first[0].payload, second[0].payload);
  assert.ok(Buffer.byteLength(JSON.stringify(second[0].payload)) < 4 * 1024 * 1024);
  assert.equal(second[0].payload.messages[0].role, "system");
  assert.ok(second[0].payload.messages[0].content.endsWith("You are an AI assistant."));
  assert.equal(second[0].payload.messages[1].content, "You are an AI assistant.");
  assert.equal(second[0].payload.messages[2].content, "visible");
  const log = app.store.logs.all().find((entry) => entry.kind === "request");
  assert.equal(log.attempts, 2);
  assert.equal(log.requestDiagnostics.rules[0].outcome, "applied");
});

test("a forwarded body over the workspace limit returns 413 without cooling an account", async (t) => {
  const app = await fixture(t);
  const calls = await app.worker((_req, res) => { res.writeHead(200); res.end(); });
  const payload = { model: "test-model", messages: [{ role: "user", content: "hello" }], padding: "" };
  payload.padding = "x".repeat(4 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(payload)));
  assert.equal(Buffer.byteLength(JSON.stringify(payload)), 4 * 1024 * 1024);
  const response = await app.send(payload);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.type, "invalid_request_error");
  assert.equal(calls.length, 0);
  const log = app.store.logs.all().find((entry) => entry.kind === "request");
  assert.equal(log.status, 413);
  assert.equal(log.attempts, 0);
  assert.equal(app.store.state.accounts[0].status, "healthy");
});

test("deeply nested client JSON is forwarded without a 500", async (t) => {
  const app = await fixture(t);
  const calls = await app.worker((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"choices":[]}');
  });
  const nested = JSON.parse(`${"[".repeat(3000)}0${"]".repeat(3000)}`);
  const response = await app.send({
    model: "test-model", messages: [{ role: "user", content: "hello" }], nested,
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(JSON.stringify(calls[0].payload.nested), JSON.stringify(nested));
});

test("header support is tracked per retry and disabling DSH preserves the request", async (t) => {
  const app = await fixture(t);
  const first = await app.worker((_req, res) => { res.writeHead(503); res.end(); }, 10);
  const second = await app.worker((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"choices":[]}');
  });
  assert.equal((await app.call("/api/settings", { method: "PATCH", body: {
    dshCompat: false, upstreamHeaders: { accept: "application/json" },
  } })).status, 200);
  const payload = { model: "test-model", messages: [{ role: "developer", content: "You are an AI agent powered by DeepSeek Harness." }] };
  const response = await app.send(payload);
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  assert.deepEqual(first[0].payload, second[0].payload);
  assert.equal(second[0].payload.messages[0].role, "developer");
  const log = app.store.logs.all().find((entry) => entry.kind === "request");
  assert.equal(log.requestDiagnostics.headers.supported, null);
  assert.deepEqual(log.requestDiagnostics.headers.attempts.map((entry) => entry.status), [503, 200]);
});

test("a failed retry does not inherit the previous workspace's header acknowledgement", async (t) => {
  const app = await fixture(t);
  const first = await app.worker((_req, res) => {
    res.writeHead(503, { "x-cnb2api-override-support": "1" });
    res.end();
  }, 10);
  const second = await app.worker((req) => { req.socket.destroy(); });
  assert.equal((await app.call("/api/settings", { method: "PATCH", body: {
    upstreamHeaders: { accept: "application/json" },
  } })).status, 200);
  const response = await app.send({ model: "test-model", messages: [{ role: "user", content: "hello" }] });
  assert.equal(response.status, 503);
  await response.text();
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  const log = app.store.logs.all().find((entry) => entry.kind === "request");
  assert.equal(log.attempts, 2);
  assert.equal(log.requestDiagnostics.headers.supported, null);
  assert.deepEqual(log.requestDiagnostics.headers.attempts, [
    { attempt: 1, status: 503, supported: true },
  ]);
});

test("neutral developer roles at any position are converted when compatibility is enabled", async (t) => {
  const app = await fixture(t);
  const calls = await app.worker((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"choices":[]}');
  });
  const response = await app.send({
    model: "test-model",
    messages: [
      { role: "user", content: "first" },
      { role: "developer", content: "neutral instruction" },
      { role: "user", content: "second" },
      { role: "developer", content: "another instruction" },
    ],
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.deepEqual(calls[0].payload.messages.map((message) => message.role), ["user", "system", "user", "system"]);
  const details = app.store.logs.all().find((entry) => entry.kind === "request").requestDiagnostics;
  assert.equal(details.received.messages[1].role, "developer");
  assert.equal(details.forwarded.messages[1].role, "system");
});

test("management rejects malformed overrides and protected headers", async (t) => {
  const app = await fixture(t);
  for (const body of [
    { upstreamHeaders: { Authorization: "secret" } },
    { upstreamHeaders: { "Content-Type": "application/json" } },
    { requestOverrides: { operations: [{ mode: "set", path: "__proto__.polluted", value: true }] } },
    { requestOverrides: { operations: [{ mode: "regex_replace", path: "messages.0.content", from: "(", to: "x" }] } },
  ]) {
    const response = await app.call("/api/settings", { method: "PATCH", body });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(app.store.state.settings.upstreamHeaders, {});
  assert.equal({}.polluted, undefined);
});

const CLAUDE_BILLING = "x-anthropic-billing-header: cc_version=2.1.212.3f4; cc_entrypoint=sdk-cli;";
const CLAUDE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_FEEDBACK = "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues";
const claudeCodePayload = () => ({
  model: "test-model",
  max_tokens: 256,
  stream: false,
  thinking: { type: "enabled", budget_tokens: 64 },
  system: [{ type: "text", text: `${CLAUDE_BILLING}\n${CLAUDE_IDENTITY}\n${CLAUDE_FEEDBACK}` }],
  messages: [
    { role: "user", content: [{ type: "text", text: `${CLAUDE_FEEDBACK} private-user-request` }] },
    { role: "assistant", content: [{ type: "text", text: CLAUDE_IDENTITY }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: CLAUDE_IDENTITY }] },
  ],
  tools: [{ name: "Read", description: `${CLAUDE_BILLING} private-tool-description`, input_schema: { type: "object" } }],
});

test("Claude Code compatibility rewrites Messages fingerprints before forwarding", async (t) => {
  const app = await fixture(t);
  const calls = await app.worker((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "x-cnb2api-override-support": "1" });
    res.end(JSON.stringify({ choices: [] }));
  });
  const payload = claudeCodePayload();
  const response = await app.sendMessages(payload);
  assert.equal(response.status, 200, await response.text());
  assert.equal(calls.length, 1);
  const outbound = calls[0].payload;
  assert.equal(calls[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(outbound.thinking, undefined);
  assert.doesNotMatch(outbound.system[0].text, /x-anthropic-billing-header|official cli for claude|to give feedback/i);
  // The billing value is volatile per request, so it must be normalized away: a
  // random value inside the cached prefix forces an upstream cache miss.
  assert.match(outbound.system[0].text, /x-cc-billing-meta: cch=0/, "billing value normalized");
  assert.doesNotMatch(outbound.system[0].text, /cc_version=|cc_entrypoint=/, "volatile billing metadata removed");
  assert.ok(outbound.system[0].text.includes("https://github.com/anthropics/claude-code/issues"), "issue URL survives");
  assert.doesNotMatch(outbound.tools[0].description, /x-anthropic-billing-header/i);
  assert.match(outbound.tools[0].description, /private-tool-description/);
  // Tool results and the user request keep their original bytes.
  assert.equal(outbound.messages[0].content[0].text, payload.messages[0].content[0].text);
  assert.equal(outbound.messages[2].content[0].content, CLAUDE_IDENTITY);
  assert.doesNotMatch(outbound.messages[1].content[0].text, /official cli for claude/i);
  assert.deepEqual(payload, claudeCodePayload(), "the client payload is not mutated");
  const log = app.store.logs.all().find((entry) => entry.kind === "request");
  assert.equal(log.path, "/v1/messages");
  assert.deepEqual(
    log.requestDiagnostics.rules.slice(-3).map((rule) => [rule.name, rule.outcome]),
    [["claude_code_text", "applied"], ["claude_code_text", "applied"], ["claude_code_fields", "applied"]],
  );
  // The log never stores request text; only the existing first-user preview is kept.
  for (const secret of ["private-tool-description", CLAUDE_IDENTITY, GATEWAY])
    assert.ok(!JSON.stringify(log).includes(secret));
});

test("Claude Code compatibility is independent of DSH and stays off for Chat and Responses", async (t) => {
  const app = await fixture(t);
  const calls = await app.worker((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [] }));
  });
  assert.equal((await app.call("/api/settings", { method: "PATCH", body: { dshCompat: false } })).status, 200);
  const messages = await app.sendMessages(claudeCodePayload());
  assert.equal(messages.status, 200);
  await messages.text();
  assert.equal(calls.at(-1).payload.thinking, undefined);
  assert.doesNotMatch(calls.at(-1).payload.system[0].text, /official cli for claude/i);

  const chat = await app.send({ model: "test-model", messages: [{ role: "user", content: CLAUDE_IDENTITY }] });
  assert.equal(chat.status, 200);
  await chat.text();
  assert.equal(calls.at(-1).payload.messages[0].content, CLAUDE_IDENTITY);

  assert.equal((await app.call("/api/settings", { method: "PATCH", body: { claudeCodeCompat: false } })).status, 200);
  const disabled = await app.sendMessages(claudeCodePayload());
  assert.equal(disabled.status, 200);
  await disabled.text();
  // The forwards-boundary thinking strip and the preset drop are independent.
  const expected = claudeCodePayload();
  delete expected.thinking;
  assert.deepEqual(calls.at(-1).payload, expected);
  assert.match(calls.at(-1).payload.system[0].text, /x-anthropic-billing-header/);
  assert.match(calls.at(-1).payload.system[0].text, /official cli for claude/i);
  assert.equal(app.store.state.settings.claudeCodeCompat, false);
  const restarted = new Store(app.directory, { allowLocal: true });
  assert.equal(restarted.state.settings.claudeCodeCompat, false);
  assert.equal(restarted.state.settings.dshCompat, false);
  assert.equal((await app.call("/api/settings", { method: "PATCH", body: { claudeCodeCompat: "yes" } })).status, 400);
});
