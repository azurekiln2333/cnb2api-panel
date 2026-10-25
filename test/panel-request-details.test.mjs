import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";
import { Store } from "../src/store.mjs";
import { initialUserMessage } from "../src/request-details.mjs";

test("initial user previews omit other roles and preserve supported text blocks", () => {
  for (const content of [
    "第一条用户消息",
    [
      { type: "text", text: "第一条" },
      { type: "input_text", text: "用户消息" },
    ],
  ]) {
    const result = initialUserMessage({
      messages: [
        { role: "system", content: "private system" },
        { role: "assistant", content: "private assistant" },
        { role: "tool", content: "private tool" },
        { role: "user", content },
        { role: "user", content: "private later message" },
      ],
    });
    assert.deepEqual(result, {
      role: "user",
      text: typeof content === "string" ? content : "第一条\n用户消息",
      truncated: false,
    });
  }
  for (const messages of [
    undefined,
    null,
    "invalid",
    [],
    [null],
    [{ role: "system", content: "private" }],
  ])
    assert.equal(initialUserMessage({ messages }), undefined);
});

test("multimodal previews retain type placeholders without media or tool payloads", () => {
  const result = initialUserMessage({
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "查看这些附件" },
          {
            type: "image_url",
            image_url: { url: "https://private.invalid/image?token=private" },
          },
          {
            type: "image",
            source: { type: "base64", data: "private-image-data" },
          },
          { type: "input_audio", input_audio: { data: "private-audio-data" } },
          { type: "document", source: { data: "private-document-data" } },
          { type: "tool_result", content: "private-tool-result" },
          { type: "unknown", text: "private-unknown-field" },
        ],
      },
    ],
  });
  assert.deepEqual(result, {
    role: "user",
    text: "查看这些附件\n[图片]\n[图片]\n[音频]\n[文件]\n[工具内容]\n[非文本内容]",
    truncated: false,
  });
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("preview truncation counts Unicode characters without cutting a surrogate pair", () => {
  const text = "你".repeat(3999) + "😀";
  assert.deepEqual(
    initialUserMessage({ messages: [{ role: "user", content: text }] }),
    {
      role: "user",
      text,
      truncated: false,
    },
  );
  const truncated = initialUserMessage({
    messages: [{ role: "user", content: text + "后续" }],
  });
  assert.equal(Array.from(truncated.text).length, 4000);
  assert.equal(truncated.text, text);
  assert.equal(truncated.truncated, true);
});

async function fixture(t, handler) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "panel-request-detail-"));
  const directory = join(fixtureRoot, "data");
  const listen = async (server) => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  };
  const upstream = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end('{"object":"list","data":[{"id":"test-model"}]}');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await handler(req, res, Buffer.concat(chunks).toString("utf8"));
  });
  const endpoint = await listen(upstream);
  const app = createPanelServer({
    adminKey: "detail-admin-key",
    gatewayKey: "detail-gateway-key",
    dataDir: directory,
    allowLocal: true,
  });
  const base = await listen(app.server);
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"key":"detail-admin-key"}',
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = (path, data) =>
    fetch(`${base}${path}`, {
      method: data === undefined ? "GET" : "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const created = await (
    await call("/api/accounts", {
      name: "details-workspace",
      endpoint,
      proxyKey: "detail-private-proxy-key",
    })
  ).json();
  await app.pool.probe(created.account.id);
  t.after(async () => {
    app.pool.stop();
    for (const server of [app.server, upstream]) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const send = (path, payload) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: "Bearer detail-gateway-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  return { ...app, directory, endpoint, call, send };
}

test("request details preserve streaming bytes and survive storage alongside legacy logs", async (t) => {
  const wire =
    'data: {"choices":[{"delta":{"content":"private-response-text"}}]}\n\ndata: {"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
  let forwarded;
  const app = await fixture(t, (_req, res, body) => {
    forwarded = body;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(wire);
  });
  const payload = {
    model: "test-model",
    stream: true,
    messages: [
      { role: "system", content: "private-system-text" },
      { role: "user", content: "你好😀" },
      { role: "assistant", content: "private-history-text" },
    ],
  };
  const response = await app.send("/v1/chat/completions", payload);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), wire);
  const upstreamPayload = {
    ...payload,
    stream_options: { include_usage: true },
  };
  assert.equal(forwarded, JSON.stringify(upstreamPayload));
  const logs = (await (await app.call("/api/logs")).json()).logs;
  const log = logs.find((entry) => entry.kind === "request");
  assert.equal(log.method, "POST");
  assert.equal(log.stream, true);
  assert.equal(
    log.requestBytes,
    Buffer.byteLength(JSON.stringify(upstreamPayload)),
  );
  assert.equal(log.responseBytes, Buffer.byteLength(wire));
  assert.equal(log.upstreamEndpoint, app.endpoint);
  assert.equal(typeof log.firstByteMs, "number");
  assert.ok(log.firstByteMs >= 0 && log.firstByteMs <= log.durationMs);
  assert.deepEqual(log.initialMessage, {
    role: "user",
    text: "你好😀",
    truncated: false,
  });
  assert.equal(log.tokenUsage.total, 15);
  assert.equal(log.requestId, response.headers.get("x-request-id"));
  for (const omitted of [
    "private-system-text",
    "private-history-text",
    "private-response-text",
    "detail-private-proxy-key",
    "detail-gateway-key",
  ])
    assert.ok(!JSON.stringify(log).includes(omitted));
  app.store.record({
    kind: "request",
    status: 200,
    message: "legacy entry",
    durationMs: 1,
  });
  const restored = new Store(app.directory, { allowLocal: true });
  assert.equal(restored.state.logs[0].initialMessage, undefined);
  assert.deepEqual(
    restored.state.logs.find((entry) => entry.id === log.id),
    log,
  );
});

test("Anthropic requests retain the first user text and HTTP failures provide a useful reason", async (t) => {
  const app = await fixture(t, (_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end('{"error":{"message":"private-error-body"}}');
  });
  const payload = {
    model: "test-model",
    system: "private-system",
    messages: [
      { role: "user", content: [{ type: "text", text: "测试 Claude 消息" }] },
    ],
  };
  const response = await app.send("/v1/messages", payload);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.message, "private-error-body");
  const log = app.store.state.logs.find((entry) => entry.kind === "request");
  assert.deepEqual(log.initialMessage, {
    role: "user",
    text: "测试 Claude 消息",
    truncated: false,
  });
  assert.equal(log.message, "工作区返回 HTTP 400");
  assert.equal(log.stream, false);
  assert.ok(
    !JSON.stringify(app.store.state.logs).includes("private-error-body"),
  );
});

test("empty upstream responses have no first-byte timing and system-only requests have no preview", async (t) => {
  const app = await fixture(t, (_req, res) => {
    res.writeHead(204);
    res.end();
  });
  const response = await app.send("/v1/chat/completions", {
    model: "test-model",
    messages: [{ role: "system", content: "private-system-only" }],
  });
  assert.equal(response.status, 204);
  await response.text();
  const log = app.store.state.logs.find((entry) => entry.kind === "request");
  assert.equal(log.firstByteMs, null);
  assert.equal(log.responseBytes, 0);
  assert.equal(log.initialMessage, undefined);
  assert.ok(!JSON.stringify(log).includes("private-system-only"));
});
