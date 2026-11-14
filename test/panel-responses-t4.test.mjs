import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";
import { removeAll } from "./support/sqlite-fixture.mjs";

const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const choice = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const measuredUsage = { prompt_tokens: 7, completion_tokens: 3 };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(t, suffix) {
  const directory = mkdtempSync(join(tmpdir(), "panel-responses-t4-"));
  const gatewayKey = "local-t4-gateway-fixture";
  const app = createPanelServer({
    adminKey: "local-t4-admin-fixture", gatewayKey,
    dataDir: join(directory, "data"), allowLocal: true,
  });
  app.store.settings({ maxAttempts: 1, quotaProtection: { enabled: false } });
  const worker = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
      return;
    }
    for await (const _chunk of req);
    assert.equal(req.url, "/v1/chat/completions");
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (typeof suffix === "function") return suffix(res);
    res.end(Buffer.concat([
      Buffer.from(frame(choice({ content: "partial answer" })) + frame({ choices: [], usage: measuredUsage })),
      Buffer.isBuffer(suffix) ? suffix : Buffer.from(suffix),
    ]));
  });
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(worker);
    removeAll(directory);
  });
  const endpoint = await listen(worker);
  const account = app.store.create({ name: "local-t4-worker", endpoint, proxyKey: "local-t4-worker-fixture" });
  await app.pool.probe(account.id);
  const base = await listen(app.server);
  return async ({ raw = false } = {}) => {
    const response = await fetch(`${base}/v1/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${gatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", input: "hello", stream: true }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200);
    return raw ? response : response.text();
  };
}

test("T4: Responses comments keep a header-only upstream alive before its first data byte", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let release;
  const ready = new Promise((resolve) => { release = resolve; });
  const send = await fixture(t, async (res) => {
    res.flushHeaders();
    await ready;
    res.end(frame(choice({ content: "late answer" }, "stop")) + "data: [DONE]\n\n");
  });
  const response = await send({ raw: true });
  const reader = response.body.getReader();
  let body = "";
  try {
    const first = await reader.read();
    assert.equal(Buffer.from(first.value).toString(), ": keep-alive\n\n");
    body += Buffer.from(first.value).toString();
    t.mock.timers.tick(10_000);
    const heartbeat = await reader.read();
    assert.equal(Buffer.from(heartbeat.value).toString(), ": keep-alive\n\n");
    body += Buffer.from(heartbeat.value).toString();
  } finally {
    release();
  }
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    body += Buffer.from(value).toString();
  }
  const parsed = events(body);
  assert.equal(parsed.at(-1).type, "response.completed");
  assert.equal(parsed.at(-1).response.output[0].content[0].text, "late answer");
  assert.deepEqual(parsed.map((event) => event.sequence_number), parsed.map((_event, index) => index));
});

function events(body) {
  return body.split("\n\n")
    .filter((block) => block.startsWith("event:"))
    .map((block) => JSON.parse(block.split("\ndata: ")[1]));
}

for (const [name, suffix] of [
  ["malformed final JSON without an SSE delimiter", 'data: {"error":{"message":"private upstream detail"}'],
  ["an unfinished UTF-8 character at EOF", Buffer.from([0xe4, 0xb8])],
  ["a named error carrying a Chat-shaped body", 'event: error\ndata: {"choices":[],"message":"private upstream detail"}\n\n'],
]) {
  test(`T4: ${name} reaches Codex as one explicit failure`, async (t) => {
    const send = await fixture(t, suffix);
    const body = await send();
    const parsed = events(body);
    assert.deepEqual(parsed.slice(0, 2).map((event) => event.type), ["response.created", "response.in_progress"]);
    assert.deepEqual(parsed.map((event) => event.sequence_number), parsed.map((_event, index) => index));
    assert.deepEqual(parsed.filter((event) => ["response.completed", "response.incomplete", "response.failed"].includes(event.type))
      .map((event) => event.type), ["response.failed"]);
    const failed = parsed.at(-1).response;
    assert.equal(failed.status, "failed");
    assert.equal(failed.error.code, "upstream_stream_error");
    assert.equal(failed.output[0].content[0].text, "partial answer");
    assert.equal(failed.usage.input_tokens, 7);
    assert.equal(failed.usage.output_tokens, 3);
    assert.ok(!body.includes("private upstream detail"));
  });
}
