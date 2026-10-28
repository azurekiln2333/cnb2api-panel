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
      assert.equal(result.rules[3].outcome, "applied");
      assert.equal(result.rules[3].count, 1);
    }
    const user = rewriteRequest({ messages: [{ role: "user", content: text }] },
      { dshCompat: false, requestOverrides }, "/v1/chat/completions");
    assert.equal(user.payload.messages[0].content, text);
    assert.equal(user.rules[3].outcome, "unmatched");
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
  t.after(async () => {
    app.pool.stop();
    for (const server of [app.server, ...servers]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { ...app, base, directory, call, worker, send };
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
  const log = app.store.state.logs.find((entry) => entry.kind === "request");
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
  const log = app.store.state.logs.find((entry) => entry.kind === "request");
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
  const log = app.store.state.logs.find((entry) => entry.kind === "request");
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
  const log = app.store.state.logs.find((entry) => entry.kind === "request");
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
  const details = app.store.state.logs.find((entry) => entry.kind === "request").requestDiagnostics;
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
