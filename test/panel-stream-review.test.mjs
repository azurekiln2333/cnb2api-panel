import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const GATEWAY = "stream-review-gateway-key";
const WORKER = "stream-review-worker-key";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;

// Captures anything the panel logs as a server fault. A client disconnect is a
// normal end, so the global handler in app.mjs must stay silent.
async function fixture(t, handler) {
  const directory = mkdtempSync(join(tmpdir(), "panel-stream-review-"));
  const app = createPanelServer({
    adminKey: "stream-review-admin-key", gatewayKey: GATEWAY,
    dataDir: join(directory, "data"), allowLocal: true,
  });
  app.store.settings({ quotaProtection: { enabled: false } });
  const serverErrors = [];
  const originalError = console.error;
  console.error = (...args) => {
    serverErrors.push(args.map(String).join(" "));
    originalError(...args);
  };
  t.after(() => { console.error = originalError; });
  const worker = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await handler(req, res, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  });
  const endpoint = await listen(worker);
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(worker);
    rmSync(directory, { recursive: true, force: true });
  });
  const created = app.store.create({ name: "stream-review-worker", endpoint, proxyKey: WORKER });
  await app.pool.probe(created.id);
  const post = (path, payload, options = {}) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload), ...options,
  });
  const requestLog = async () => {
    for (let i = 0; i < 400; i++) {
      const found = app.store.state.logs.find((entry) => entry.kind === "request");
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  };
  return { ...app, id: created.id, base, post, requestLog, serverErrors };
}

// A non-streaming relay has no terminal event to emit. Dropping the client must
// end at 499 with no 500 in the server log and no worker cooldown.
for (const [label, path, body] of [
  ["/v1/messages", "/v1/messages", { model: "test-model", max_tokens: 32, messages: [{ role: "user", content: "hello" }] }],
  ["/v1/chat/completions", "/v1/chat/completions", { model: "test-model", messages: [{ role: "user", content: "hello" }] }],
]) {
  test(`a client disconnect on non-streaming ${label} ends at 499 without a server fault`, async (t) => {
    let upstreamClosed;
    const closed = new Promise((resolve) => { upstreamClosed = resolve; });
    const app = await fixture(t, (_req, res) => {
      // The worker answers only after the client has already gone away.
      res.on("close", upstreamClosed);
    });
    const controller = new AbortController();
    const request = app.post(path, body, { signal: controller.signal }).catch(() => null);
    for (let i = 0; i < 200 && !app.pool.active.get(app.id); i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();
    await request;
    let timer;
    try {
      await Promise.race([closed, new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("upstream request did not close")), 3000);
      })]);
    } finally {
      clearTimeout(timer);
    }
    const record = await app.requestLog();
    assert.equal(record.status, 499);
    assert.equal(record.streamFailure.kind, "client_disconnect");
    assert.equal(record.streamFailure.clientDisconnected, true);
    assert.deepEqual(app.serverErrors, []);
    assert.equal(app.store.get(app.id).cooldownUntil, null);
    assert.equal(app.pool.active.get(app.id), 0);
  });
}

test("gateway first frame and upstream first byte are reported separately", async (t) => {
  const app = await fixture(t, async (_req, res) => {
    // The worker flushes headers by writing early, then prefills a long answer.
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(frame({ choices: [{ index: 0, delta: { role: "assistant" } }] }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    res.end(frame({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  });
  const response = await app.post("/v1/responses", { model: "test-model", input: "hello", stream: true });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /response\.completed/);
  const record = await app.requestLog();
  // The gateway frame leaves as soon as the reply opens; the provider's real
  // first byte is the early role delta, so both stay far apart.
  assert.ok(record.firstByteMs < 600, `gateway frame ${record.firstByteMs}ms`);
  // Both leave within the same millisecond here, so their order is not stable.
  // The contract is that the provider's own first byte is a separate field.
  assert.ok(
    Number.isFinite(record.upstreamFirstByteMs) && record.upstreamFirstByteMs >= 0,
    `upstream ${record.upstreamFirstByteMs}ms`,
  );
  assert.ok(record.upstreamFirstByteMs < 600, `upstream ${record.upstreamFirstByteMs}ms`);
});

test("the keepalive comment arrives ahead of the upstream answer", async (t) => {
  const app = await fixture(t, async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(frame({ choices: [{ index: 0, delta: { role: "assistant" } }] }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    res.end(frame({ choices: [{ index: 0, delta: { content: "late" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  });
  const response = await app.post("/v1/responses", { model: "test-model", input: "hello", stream: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const started = Date.now();
  const first = await reader.read();
  const firstAt = Date.now() - started;
  const firstText = decoder.decode(first.value);
  // The comment is its own first chunk; the answer text arrives much later.
  assert.match(firstText, /: keep-alive/);
  assert.ok(firstAt < 600, `first chunk arrived at ${firstAt}ms`);
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
  }
  assert.match(rest, /response\.completed/);
});
