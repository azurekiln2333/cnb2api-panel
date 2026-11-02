import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const GATEWAY = "long-stream-gateway-key";
const WORKER = "long-stream-worker-key";

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

const parseEvents = (text) => text.split("\n\n")
  .filter((block) => block.startsWith("event:"))
  .map((block) => JSON.parse(block.split("\ndata: ")[1]));

async function fixture(t, handler) {
  const directory = mkdtempSync(join(tmpdir(), "panel-long-stream-"));
  const app = createPanelServer({
    adminKey: "long-stream-admin-key",
    gatewayKey: GATEWAY,
    dataDir: join(directory, "data"),
    allowLocal: true,
  });
  app.store.settings({ quotaProtection: { enabled: false } });
  const worker = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
      return;
    }
    for await (const _ of req);
    await handler(req, res);
  });
  const endpoint = await listen(worker);
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(worker);
    rmSync(directory, { recursive: true, force: true });
  });
  const created = app.store.create({ name: "long-stream-worker", endpoint, proxyKey: WORKER });
  await app.pool.probe(created.id);
  const send = () => fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-model", input: "hello", stream: true }),
  });
  const requestLog = async () => {
    for (let i = 0; i < 400; i++) {
      const found = app.store.state.logs.find((entry) => entry.kind === "request");
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  };
  return { ...app, send, requestLog };
}

test("a slow first byte within the idle budget reaches the client", async (t) => {
  const app = await fixture(t, async (_req, res) => {
    // Long-context prefill sends no bytes until generation starts.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(frame({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] }) + "data: [DONE]\n\n");
  });
  assert.equal(app.store.state.settings.idleTimeoutSeconds, 300);
  const response = await app.send();
  assert.equal(response.status, 200);
  const events = parseEvents(await response.text());
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].content[0].text, "hi");
  const log = await app.requestLog();
  assert.ok(log.firstByteMs >= 1000, `first byte ${log.firstByteMs}ms`);
  assert.equal(log.streamFailure, undefined);
});

test("a long quiet gap between chunks does not kill the stream", async (t) => {
  const app = await fixture(t, async (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(frame({ choices: [{ index: 0, delta: { content: "first" } }] }));
    await new Promise((resolve) => setTimeout(resolve, 900));
    res.write(frame({ choices: [{ index: 0, delta: { content: " second" }, finish_reason: "stop" }] }));
    res.end(frame({ choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } }) + "data: [DONE]\n\n");
  });
  const response = await app.send();
  assert.equal(response.status, 200);
  const events = parseEvents(await response.text());
  assert.equal(events.at(-1).type, "response.completed");
  assert.equal(events.at(-1).response.output[0].content[0].text, "first second");
});

test("a stalled upstream ends with response.failed and a classified log", async (t) => {
  const app = await fixture(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(frame({ choices: [{ index: 0, delta: { content: "partial" } }] }));
    // Never finishes: the panel watchdog must end the stream.
  });
  app.store.state.settings.idleTimeoutSeconds = 0.3;
  const response = await app.send();
  assert.equal(response.status, 200);
  const events = parseEvents(await response.text());
  assert.equal(events.at(-1).type, "response.failed");
  assert.equal(events.at(-1).response.error.code, "upstream_stream_error");
  const log = await app.requestLog();
  assert.equal(log.status, 502);
  assert.equal(log.streamFailure.kind, "idle_timeout");
  assert.equal(log.streamFailure.stage, "stream");
  assert.equal(log.streamFailure.bytesRead > 0, true);
  assert.equal(log.streamFailure.clientDisconnected, false);
});
