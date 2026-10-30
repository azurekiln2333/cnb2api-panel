import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { createPanelServer } from "../src/app.mjs";
import { emptyTokenUsage, TokenUsageCapture } from "../src/token-usage.mjs";

const ADMIN = "usage-test-admin-key";
const GATEWAY = "usage-test-gateway-key";
const PROXY = "usage-test-proxy-key";
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
};

function capture(
  value,
  { sse = false, path = "/v1/chat/completions", complete = true } = {},
) {
  const collector = new TokenUsageCapture(
    sse ? "text/event-stream" : "application/json",
    path,
  );
  const bytes = Buffer.from(value);
  for (let i = 0; i < bytes.length; i += 7)
    collector.push(bytes.subarray(i, i + 7));
  return collector.finish(complete);
}

test("JSON usage counts input/output/cache once and rejects invalid numeric counters", () => {
  assert.deepEqual(
    capture(
      JSON.stringify({
        choices: [{ message: { content: "多字节内容" } }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 70 },
        },
      }),
    ),
    {
      ...emptyTokenUsage(),
      input: 120,
      output: 30,
      cacheRead: 70,
      total: 150,
      reportedRequests: 1,
    },
  );
  assert.deepEqual(
    capture('{"usage":{"prompt_tokens":-1,"completion_tokens":"123"}}'),
    {
      ...emptyTokenUsage(),
      missingRequests: 1,
    },
  );
});

test("estimated zero fallbacks are missing usage while measured zero remains reported", () => {
  const zero = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const sse of [false, true]) {
    const body = JSON.stringify({ usage: { ...zero, usage_estimated: true } });
    assert.deepEqual(capture(sse ? `data: ${body}\n\n` : body, { sse }), {
      ...emptyTokenUsage(),
      missingRequests: 1,
    });
  }
  assert.deepEqual(capture(JSON.stringify({ usage: zero })), {
    ...emptyTokenUsage(),
    reportedRequests: 1,
  });
});

test("SSE handles arbitrary byte boundaries, CRLF and terminal events without double counting", () => {
  const stream = [
    'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\n',
    'data: {"usage":{"prompt_tokens":100,"completion_tokens":8,"prompt_cache_hit_tokens":60}}\r\n\r\n',
    'data: {"usage":{"prompt_tokens":100,"completion_tokens":12,"prompt_cache_hit_tokens":60}}\r\n\r\n',
    "data: [DONE]",
  ].join("");
  assert.deepEqual(capture(stream, { sse: true }), {
    ...emptyTokenUsage(),
    input: 100,
    output: 12,
    cacheRead: 60,
    total: 112,
    reportedRequests: 1,
  });
});

test("Anthropic input includes cache read/write and legacy zero placeholders remain partial", () => {
  const full = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":40,"cache_creation_input_tokens":20}}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n',
  ].join("");
  assert.deepEqual(capture(full, { sse: true, path: "/v1/messages" }), {
    ...emptyTokenUsage(),
    input: 70,
    output: 15,
    cacheRead: 40,
    cacheWrite: 20,
    total: 85,
    reportedRequests: 1,
  });
  const old =
    'data: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
    'data: {"type":"message_delta","usage":{"output_tokens":15}}\n\n';
  const partial = capture(old, { sse: true, path: "/v1/messages" });
  assert.equal(partial.output, 15);
  assert.equal(partial.reportedRequests, 1);
  assert.equal(partial.partialRequests, 1);
  assert.equal(
    capture(full, { sse: true, path: "/v1/messages", complete: false })
      .partialRequests,
    1,
  );
});

test("large content events remain bounded and do not hide later small usage events", () => {
  const collector = new TokenUsageCapture("text/event-stream");
  collector.push(Buffer.from('data: {"choices":[{"delta":{"content":"'));
  for (let i = 0; i < 40; i++) collector.push(Buffer.alloc(16384, 120));
  assert.ok(collector.buffer.length <= 256 * 1024);
  collector.push(Buffer.from('"}}]}\n\n'));
  collector.push(
    Buffer.from(
      'data: {"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\n',
    ),
  );
  assert.equal(collector.finish().total, 12);
  const largeJSON = new TokenUsageCapture("application/json");
  for (let i = 0; i < 160; i++) largeJSON.push(Buffer.alloc(16384, 120));
  assert.equal(largeJSON.buffer.length, 0);
  assert.equal(largeJSON.finish().missingRequests, 1);
});

async function fixture(t, { reportUsage = true } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cnb-panel-usage-"));
  const directory = join(fixtureRoot, "data");
  const content = 'data: {"choices":[{"delta":{"content":"秘密回复"}}]}\n\n';
  const usageEvent =
    'data: {"usage":{"prompt_tokens":80,"completion_tokens":20,"prompt_cache_hit_tokens":50}}\n\n';
  const sse = content + (reportUsage ? usageEvent : "") + "data: [DONE]\n\n";
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${PROXY}`);
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
      return;
    }
    if (req.url === "/usage") {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    calls.push({ path: req.url, payload });
    // CNB workers always stream upstream, even for non-streaming clients.
    // A compliant upstream may omit usage unless include_usage is requested.
    const hasUsage =
      reportUsage && payload.stream_options?.include_usage === true;
    if (payload.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      const wire = content + (hasUsage ? usageEvent : "") + "data: [DONE]\n\n";
      for (let i = 0; i < wire.length; i += 13)
        res.write(wire.slice(i, i + 13));
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "秘密回复" } }],
        usage: hasUsage
          ? {
              prompt_tokens: 100,
              completion_tokens: 25,
              prompt_cache_hit_tokens: 60,
            }
          : {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
              usage_estimated: true,
            },
      }),
    );
  });
  const endpoint = await listen(upstream);
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: GATEWAY,
    dataDir: directory,
    allowLocal: true,
  });
  app.store.settings({ quotaProtection: { enabled: false } });
  const base = await listen(app.server);
  const session = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const call = (path, method = "GET", data) =>
    fetch(`${base}${path}`, {
      method,
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const created = await (
    await call("/api/accounts", "POST", {
      name: "usage-workspace",
      endpoint,
      proxyKey: PROXY,
      pat: "private-test-pat",
    })
  ).json();
  await app.pool.probe(created.account.id);
  const generate = (path, extra = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GATEWAY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [
          { role: "system", content: "不记录系统提示词" },
          { role: "user", content: "首条用户测试消息" },
          { role: "assistant", content: "不记录历史回复" },
          { role: "tool", content: "不记录工具正文" },
          { role: "user", content: "不记录后续消息" },
        ],
        ...extra,
      }),
    });
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(upstream);
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  return {
    ...app,
    directory,
    base,
    call,
    generate,
    id: created.account.id,
    sse,
    calls,
  };
}

test("gateway enables upstream usage for both OpenAI modes while preserving other options", async (t) => {
  const app = await fixture(t);
  const extra = {
    stream: true,
    stream_options: { include_usage: false, include_obfuscation: false },
    temperature: 0.7,
  };
  const response = await app.generate("/v1/chat/completions", extra);
  assert.equal(await response.text(), app.sse);
  assert.deepEqual(app.calls[0].payload.stream_options, {
    include_usage: true,
    include_obfuscation: false,
  });
  assert.equal(app.calls[0].payload.temperature, 0.7);
  assert.equal(extra.stream_options.include_usage, false);
  await (await app.generate("/v1/chat/completions", { stream: false })).text();
  assert.deepEqual(app.calls[1].payload.stream_options, {
    include_usage: true,
  });
  await (await app.generate("/v1/messages/count_tokens")).text();
  assert.equal(app.calls[2].payload.stream_options, undefined);
  assert.equal(app.store.state.tokenUsage.total, 225);
});

test("unreported upstream usage remains missing in local totals and account counters", async (t) => {
  const app = await fixture(t, { reportUsage: false });
  await (await app.generate("/v1/chat/completions", { stream: true })).text();
  await (await app.generate("/v1/chat/completions", { stream: false })).text();
  const expected = { ...emptyTokenUsage(), missingRequests: 2 };
  const overview = await (await app.call("/api/overview")).json();
  assert.deepEqual(overview.stats.tokenUsage.today, expected);
  assert.deepEqual(overview.stats.tokenUsage.total, expected);
  assert.deepEqual(overview.accounts[0].tokenUsage, expected);
  assert.deepEqual(
    new Store(app.directory, { allowLocal: true }).state.tokenUsage,
    expected,
  );
});

test("gateway persists local totals, preserves SSE bytes, and excludes count_tokens consumption", async (t) => {
  const app = await fixture(t);
  const response = await app.generate("/v1/chat/completions");
  assert.equal(response.status, 200);
  await response.text();
  const stream = await app.generate("/v1/chat/completions", { stream: true });
  assert.equal(await stream.text(), app.sse);
  await (await app.generate("/v1/messages/count_tokens")).text();
  const overview = await (await app.call("/api/overview")).json();
  const expected = {
    ...emptyTokenUsage(),
    input: 180,
    output: 45,
    cacheRead: 110,
    total: 225,
    reportedRequests: 2,
  };
  assert.deepEqual(overview.stats.tokenUsage.today, expected);
  assert.deepEqual(overview.stats.tokenUsage.total, expected);
  assert.deepEqual(overview.accounts[0].tokenUsage, expected);
  assert.equal(overview.stats.requests, 3);
  const disk = readFileSync(app.store.logFiles.requests, "utf8");
  const requestLogs = disk
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(requestLogs.length, 3);
  for (const log of requestLogs)
    assert.deepEqual(log.initialMessage, {
      role: "user",
      text: "首条用户测试消息",
      truncated: false,
    });
  for (const content of [
    "不记录系统提示词",
    "不记录历史回复",
    "不记录工具正文",
    "不记录后续消息",
  ])
    assert.ok(!disk.includes(content));
  assert.ok(!disk.includes("秘密回复"));
  assert.deepEqual(
    new Store(app.directory, { allowLocal: true }).state.tokenUsage,
    expected,
  );
});

test("legacy version 1 data receives empty usage and lifetime totals survive hourly pruning", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cnb-panel-legacy-usage-"));
  const directory = join(fixtureRoot, "data");
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  const store = new Store(directory, { allowLocal: true });
  const saved = {
    ...store.state,
    version: 1,
    sso: { ...store.state.sso, clientSecret: store.encrypt("") },
  };
  delete saved.tokenUsage;
  delete saved.tokenUsageStartedAt;
  writeFileSync(store.file, JSON.stringify(saved));
  const restored = new Store(directory, { allowLocal: true });
  assert.deepEqual(restored.state.tokenUsage, emptyTokenUsage());
  restored.commit((s) => {
    s.tokenUsage = {
      ...emptyTokenUsage(),
      input: 1000,
      total: 1000,
      reportedRequests: 1,
    };
    s.hourly = [
      {
        at: "2020-01-01T00:00:00.000Z",
        requests: 1,
        errors: 0,
        durationMs: 0,
        accounts: {},
        tokenUsage: structuredClone(s.tokenUsage),
      },
    ];
  });
  restored.record({
    kind: "request",
    status: 200,
    tokenUsage: {
      ...emptyTokenUsage(),
      input: 7,
      output: 3,
      total: 10,
      reportedRequests: 1,
    },
  });
  assert.equal(restored.state.hourly.length, 1);
  assert.equal(restored.state.hourly[0].tokenUsage.total, 10);
  assert.equal(restored.state.tokenUsage.total, 1010);
  assert.equal(new Store(directory).state.tokenUsage.total, 1010);
});

test("personal token requires an explicit authenticated reveal and stays absent from normal reads/logs", async (t) => {
  const app = await fixture(t);
  const route = `/api/accounts/${app.id}/pat`;
  assert.equal(
    (await fetch(`${app.base}${route}`, { method: "POST" })).status,
    401,
  );
  const revealed = await app.call(route, "POST", {});
  assert.equal(revealed.headers.get("cache-control"), "no-store");
  assert.deepEqual(await revealed.json(), { pat: "private-test-pat" });
  for (const path of [
    "/api/accounts",
    "/api/overview",
    "/api/logs",
    "/api/usage/comparison",
  ])
    assert.ok(
      !(await (await app.call(path)).text()).includes("private-test-pat"),
    );
  const comparison = await app.call("/api/usage/comparison", "POST", {});
  assert.equal(comparison.status, 200);
  assert.ok(!JSON.stringify(await comparison.json()).includes(PROXY));
});
