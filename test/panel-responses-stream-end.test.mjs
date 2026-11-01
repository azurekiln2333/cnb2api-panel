// W-C3: Responses streaming must always terminate with an explicit event.
// A Responses client reports a truncated body as an opaque transport failure
// ("stream closed before response.completed"). Every relay exit path therefore
// has to end with response.completed, response.incomplete, or response.failed.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const ADMIN = "stream-end-admin-key";
const GATEWAY = "stream-end-gateway-key";

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
const chatSse = (text = "hi") =>
  frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }) +
  frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
  frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }) +
  "data: [DONE]\n\n";

const TERMINAL = ["response.completed", "response.incomplete", "response.failed"];

// Parses the relayed event stream into event names. A body that stops before a
// terminal event leaves the client waiting forever.
function terminalEvent(body) {
  const names = [...body.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
  const terminal = names.filter((name) => TERMINAL.includes(name));
  return { names, terminal, last: terminal.at(-1) ?? null };
}

async function fixture(t, handlers) {
  const directory = mkdtempSync(join(tmpdir(), "panel-stream-end-"));
  const servers = [];
  const calls = [];
  const app = createPanelServer({
    adminKey: ADMIN, gatewayKey: GATEWAY,
    dataDir: join(directory, "data"), allowLocal: true,
  });
  app.store.settings({ quotaProtection: { enabled: false }, maxAttempts: 3 });
  for (const [index, handler] of handlers.entries()) {
    const worker = http.createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      calls.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      await handler(req, res, index);
    });
    servers.push(worker);
    const endpoint = await listen(worker);
    const account = app.store.create({
      name: `stream-end-${index}`, endpoint, proxyKey: `stream-end-worker-key-${index}`,
      priority: 10 - index,
    });
    await app.pool.probe(account.id);
  }
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    for (const server of servers) await close(server);
    rmSync(directory, { recursive: true, force: true });
  });
  const responses = (body) => fetch(`${base}/v1/responses`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const logs = () => app.store.state.logs.filter((entry) => entry.kind === "request");
  return { ...app, base, calls, responses, logs };
}

const codexTurn = (extra = {}) => ({
  model: "test-model", stream: true, input: "你好", ...extra,
});

test("a healthy Responses stream ends with response.completed", async (t) => {
  const app = await fixture(t, [(_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(chatSse());
  }]);
  const response = await app.responses(codexTurn());
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(terminalEvent(body).last, "response.completed");
  // One upstream call: a healthy stream is never retried.
  assert.equal(app.calls.length, 1);
  assert.equal(app.logs()[0].status, 200);
});

test("a worker that drops the socket mid-stream ends with response.failed", async (t) => {
  const app = await fixture(t, [(_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(frame({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }));
    setTimeout(() => res.socket.destroy(), 20);
  }]);
  const response = await app.responses(codexTurn());
  // Headers are already sent, so the status stays 200 and the failure travels
  // inside the event stream rather than as a transport error.
  assert.equal(response.status, 200);
  const body = await response.text();
  const { terminal } = terminalEvent(body);
  assert.deepEqual(terminal, ["response.failed"]);
  // The partial text arrives before the failure so the client keeps context.
  assert.match(body, /"delta":"partial"/);
  const failed = JSON.parse(body.split("event: response.failed\ndata: ")[1].split("\n\n")[0]);
  assert.equal(failed.response.status, "failed");
  assert.equal(typeof failed.response.error.message, "string");
  assert.ok(Number.isSafeInteger(failed.sequence_number));
  // A dropped upstream is an upstream failure, not a client disconnect.
  assert.equal(app.logs()[0].status, 502);
});

test("a worker that ends without a finish_reason still ends with a terminal event", async (t) => {
  const app = await fixture(t, [(_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(frame({ choices: [{ index: 0, delta: { content: "half" }, finish_reason: null }] }) + "data: [DONE]\n\n");
  }]);
  const response = await app.responses(codexTurn());
  assert.equal(response.status, 200);
  const body = await response.text();
  const { terminal, last } = terminalEvent(body);
  assert.equal(terminal.length, 1);
  assert.ok(["response.completed", "response.failed"].includes(last));
});

test("malformed upstream usage never truncates a Responses stream", async (t) => {
  const app = await fixture(t, [(_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      frame({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      frame({ choices: [], usage: { prompt_tokens: -1, completion_tokens: "x" } }) +
      "data: [DONE]\n\n",
    );
  }]);
  const response = await app.responses(codexTurn());
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(terminalEvent(body).last, "response.completed");
});

test("an upstream error frame ends the stream with response.failed", async (t) => {
  const app = await fixture(t, [(_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(
      frame({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) +
      frame({ error: { type: "server_error", message: "upstream exploded" } }) +
      "data: [DONE]\n\n",
    );
  }]);
  const response = await app.responses(codexTurn());
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(terminalEvent(body).last, "response.failed");
  // Upstream error text must not leak into the client-facing event.
  assert.ok(!body.includes("upstream exploded"));
});

test("a retryable failure before the first byte still yields a complete stream", async (t) => {
  const app = await fixture(t, [
    (_req, res) => { res.writeHead(503); res.end(); },
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(chatSse("after-retry"));
    },
  ]);
  const response = await app.responses(codexTurn());
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(terminalEvent(body).last, "response.completed");
  assert.match(body, /after-retry/);
  const log = app.logs()[0];
  assert.equal(log.attempts, 2);
  assert.equal(log.status, 200);
});

test("a mid-stream drop is not retried into a second client stream", async (t) => {
  const app = await fixture(t, [
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(frame({ choices: [{ index: 0, delta: { content: "first" }, finish_reason: null }] }));
      setTimeout(() => res.socket.destroy(), 20);
    },
    (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(chatSse("second"));
    },
  ]);
  const response = await app.responses(codexTurn());
  assert.equal(response.status, 200);
  const body = await response.text();
  // Exactly one terminal event: a partial relay cannot be re-issued in place.
  assert.deepEqual(terminalEvent(body).terminal, ["response.failed"]);
  assert.ok(!body.includes("second"));
  assert.equal(app.calls.length, 1);
});

test("every exhausted pool still answers a well-formed non-stream error", async (t) => {
  const app = await fixture(t, [
    (_req, res) => { res.writeHead(502); res.end("error code: 502"); },
    (_req, res) => { res.writeHead(502); res.end("error code: 502"); },
  ]);
  const response = await app.responses({ model: "test-model", input: "你好" });
  assert.equal(response.status, 503);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.error.type, "api_error");
  // The raw upstream text never reaches the client.
  assert.ok(!JSON.stringify(body).includes("error code: 502"));
});

test("stream_options.include_usage does not change the client stream shape", async (t) => {
  const app = await fixture(t, [(_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    // A worker that answers the usage request with a bare usage-only frame.
    res.end(
      frame({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 } }) +
      frame({ choices: [], usage: null }) +
      "data: [DONE]\n\n",
    );
  }]);
  const response = await app.responses(codexTurn());
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.equal(terminalEvent(body).last, "response.completed");
  // The relay always asks the worker for usage, regardless of the client body.
  assert.deepEqual(app.calls[0].stream_options, { include_usage: true });
  assert.equal(app.logs()[0].tokenUsage.input, 9);
  assert.equal(app.logs()[0].tokenUsage.output, 2);
  assert.equal(app.logs()[0].tokenUsage.reportedRequests, 1);
});
