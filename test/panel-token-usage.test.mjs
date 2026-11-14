import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { createPanelServer } from "../src/app.mjs";
import { addTokenUsage, deriveCacheMiss, emptyTokenUsage, TokenUsageCapture } from "../src/token-usage.mjs";
import { editMeta, removeAll } from "./support/sqlite-fixture.mjs";

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
      cacheReadReported: 1,
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
    cacheReadReported: 1,
  });
});

test("measured OpenAI counters survive an Anthropic zero placeholder in the same usage object", () => {
  // New API can enrich one usage object with both field families. The zero
  // placeholders must not shadow the real OpenAI counters.
  for (const sse of [false, true]) {
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      prompt_tokens: 120,
      completion_tokens: 30,
    };
    const body = JSON.stringify({ choices: [], usage });
    assert.deepEqual(
      capture(sse ? `data: ${body}\n\n` : body, { sse }),
      {
        ...emptyTokenUsage(),
        input: 120,
        output: 30,
        total: 150,
        reportedRequests: 1,
      },
      `sse=${sse}`,
    );
  }
});

test("billing_usage carries measured Anthropic counters when the plain usage is a placeholder", () => {
  const stream =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"billing_usage":{"input_tokens":6,"output_tokens":11}}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  assert.deepEqual(capture(stream, { sse: true, path: "/v1/messages" }), {
    ...emptyTokenUsage(),
    input: 6,
    output: 11,
    total: 17,
    reportedRequests: 1,
  });
});

test("a measured zero output with a measured input is reported without the placeholder mark", () => {
  // message_start proves the input count, message_delta confirms a real zero
  // output. That pair is complete, not partial.
  const stream =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":0}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":0}}\n\n';
  assert.deepEqual(capture(stream, { sse: true, path: "/v1/messages" }), {
    ...emptyTokenUsage(),
    input: 12,
    output: 0,
    total: 12,
    reportedRequests: 1,
  });
});

test("placeholder-only usage stays partial and never becomes a measured zero", () => {
  const stream =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":11}}\n\n';
  const result = capture(stream, { sse: true, path: "/v1/messages" });
  assert.equal(result.reportedRequests, 1);
  assert.equal(result.partialRequests, 1);
  assert.equal(result.output, 11);
  assert.equal(result.input, 0);
});

test("billing_usage decides the shape only when the primary usage has none", () => {
  // A billing envelope repeats Anthropic field names. It must not switch the
  // shape of an OpenAI primary usage, but when the primary object carries no
  // counter names at all the envelope is the only evidence of the shape.
  const billing = { input_tokens: 167, output_tokens: 100, cache_read_input_tokens: 3840 };
  const cases = [
    { label: "event-root billing only", payload: { billing_usage: billing } },
    { label: "shapeless primary usage", payload: { usage: { total_tokens: 0, billing_usage: billing } } },
  ];
  for (const { label, payload } of cases) {
    const result = capture(JSON.stringify(payload), { path: "/v1/messages" });
    // Anthropic reports cache beside input, so the total input includes it.
    assert.equal(result.input, 4007, label);
    assert.equal(result.output, 100, label);
    assert.equal(result.cacheRead, 3840, label);
    assert.equal(result.cacheReadReported, 1, label);
  }
  // An OpenAI primary usage keeps its own shape: cache is already inside
  // prompt_tokens and must never be added a second time.
  const openai = capture(JSON.stringify({
    usage: { prompt_tokens: 4007, completion_tokens: 100, billing_usage: billing },
  }), { path: "/v1/messages" });
  assert.equal(openai.input, 4007);
  assert.equal(openai.cacheRead, 3840);
  // A message_start placeholder already picks the Anthropic shape.
  const stream = capture(
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"billing_usage":{"input_tokens":167,"output_tokens":100,"cache_read_input_tokens":3840}}}\n\n',
    { sse: true, path: "/v1/messages" },
  );
  assert.equal(stream.input, 4007);
  assert.equal(stream.cacheRead, 3840);
});

test("a cache counter never exceeds a known input total", () => {
  // The input total already contains the cached part in both wire shapes. An
  // upstream that reports more cache than input is inconsistent, but showing
  // "cache read > input" is worse than clamping to the comparable total.
  const cases = [
    {
      label: "mixed families",
      usage: { prompt_tokens: 10, completion_tokens: 5, input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      cacheRead: 100,
    },
    {
      label: "mixed creation",
      usage: { prompt_tokens: 10, completion_tokens: 5, input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100 },
      cacheWrite: 100,
    },
    {
      label: "openai cache over prompt",
      usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 100 },
      cacheRead: 100,
    },
  ];
  for (const { label, usage, cacheRead, cacheWrite } of cases) {
    const body = JSON.stringify({ choices: [], usage });
    for (const sse of [false, true]) {
      const result = capture(sse ? `data: ${body}\n\n` : body, { sse });
      assert.ok(result.cacheRead <= result.input, `${label} sse=${sse} cacheRead`);
      assert.ok(result.cacheWrite <= result.input, `${label} sse=${sse} cacheWrite`);
      // The measured cache is still recorded, just bounded by the input total.
      if (cacheRead !== undefined) assert.equal(result.cacheRead, result.input);
      if (cacheWrite !== undefined) assert.equal(result.cacheWrite, result.input);
      assert.equal(result.input, 10);
    }
  }
});

test("an unknown input total leaves the cache counters measured instead of clamped", () => {
  // No input counter means the total is unknown, not zero. The cache hit stays
  // visible and the request is marked partial rather than reporting a fake zero.
  const body = JSON.stringify({ choices: [], usage: { prompt_cache_hit_tokens: 3840 } });
  for (const sse of [false, true]) {
    const result = capture(sse ? `data: ${body}\n\n` : body, { sse });
    assert.equal(result.cacheRead, 3840, `sse=${sse}`);
    assert.equal(result.input, 0);
    assert.equal(result.partialRequests, 1);
    assert.equal(result.cacheReadReported, 1);
  }
});

test("a cache hit reported without prompt_tokens keeps its measured cache count", () => {
  // Some workers report only the cache counters. Clamping the cache read to an
  // unknown input total must not turn a measured value into zero.
  for (const usage of [
    { prompt_cache_hit_tokens: 3840 },
    { prompt_tokens_details: { cached_tokens: 3840 } },
  ]) {
    const body = JSON.stringify({ choices: [], usage });
    for (const sse of [false, true]) {
      const result = capture(sse ? `data: ${body}\n\n` : body, { sse });
      assert.equal(result.cacheRead, 3840, `${JSON.stringify(usage)} sse=${sse}`);
      assert.equal(result.reportedRequests, 1);
      // The input total stays unknown, so the request is not fully measured.
      assert.equal(result.partialRequests, 1);
    }
  }
});

test("a cache hit is counted once even when the same object repeats it in billing_usage", () => {
  // The input total already includes cache in the OpenAI shape. Merging an extra
  // source must not add the cache counters a second time.
  for (const usage of [
    {
      prompt_tokens: 4007, completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 3840 }, prompt_cache_hit_tokens: 3840,
      billing_usage: { input_tokens: 4007, output_tokens: 100 },
    },
    {
      prompt_tokens: 4007, completion_tokens: 100, input_tokens: 0, output_tokens: 0,
      prompt_cache_hit_tokens: 3840, billing_usage: { input_tokens: 4007, output_tokens: 100 },
    },
    {
      prompt_tokens: 4007, completion_tokens: 100,
      billing_usage: { cache_read_input_tokens: 3840 },
    },
  ]) {
    const result = capture(JSON.stringify({ choices: [], usage }));
    assert.equal(result.cacheRead, 3840, JSON.stringify(usage));
    assert.equal(result.input, 4007, JSON.stringify(usage));
    assert.equal(result.output, 100, JSON.stringify(usage));
    assert.equal(result.total, 4107, JSON.stringify(usage));
  }
});

test("an OpenAI cache hit does not inflate the input total it already belongs to", () => {
  // prompt_tokens includes cached tokens. Only the Anthropic shape reports them
  // separately, so only that shape adds cache to the input total.
  const result = capture(JSON.stringify({
    choices: [], usage: {
      prompt_tokens: 4007, completion_tokens: 100,
      prompt_cache_hit_tokens: 3840, prompt_cache_miss_tokens: 167,
    },
  }));
  assert.equal(result.input, 4007);
  assert.equal(result.cacheRead, 3840);
  assert.equal(result.total, 4107);
});

test("cache reporting is explicit so an unreported cache never looks like a measured zero", () => {
  const reported = capture(JSON.stringify({
    choices: [], usage: { prompt_tokens: 4007, completion_tokens: 100, prompt_cache_hit_tokens: 3840 },
  }));
  assert.equal(reported.cacheRead, 3840);
  assert.equal(reported.cacheReadReported, 1);
  const absent = capture(JSON.stringify({
    choices: [], usage: { prompt_tokens: 4007, completion_tokens: 100 },
  }));
  assert.equal(absent.cacheRead, 0);
  assert.equal(absent.cacheReadReported, 0);
  // Accumulating keeps the distinction across requests.
  const totals = addTokenUsage(emptyTokenUsage(), reported);
  addTokenUsage(totals, absent);
  assert.equal(totals.cacheRead, 3840);
  assert.equal(totals.cacheReadReported, 1);
  assert.equal(totals.reportedRequests, 2);
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
    cacheReadReported: 1,
    cacheWriteReported: 1,
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
    removeAll(fixtureRoot);
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
    cacheReadReported: 2,
  };
  assert.deepEqual(overview.stats.tokenUsage.today, expected);
  assert.deepEqual(overview.stats.tokenUsage.total, expected);
  assert.deepEqual(overview.accounts[0].tokenUsage, expected);
  assert.equal(overview.stats.requests, 3);
  const requestLogs = app.store.logs
    .all()
    .filter((entry) => entry.kind === "request")
    .reverse();
  const disk = JSON.stringify(requestLogs);
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
  t.after(() => removeAll(fixtureRoot));
  const store = new Store(directory, { allowLocal: true });
  // A database written before usage totals existed carries no such rows.
  editMeta(directory, (meta) => {
    delete meta.tokenUsage;
    delete meta.tokenUsageStartedAt;
  });
  store.close();
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


test("deriveCacheMiss reports the uncached remainder and never fabricates a zero", () => {
  // OpenAI prompt_tokens already contains the cache hits.
  assert.deepEqual(deriveCacheMiss({ input: 120, cacheRead: 70, reportedRequests: 1, cacheReadReported: 1 }), {
    cacheMiss: 50,
    cacheMissReported: 1,
  });
  assert.deepEqual(deriveCacheMiss({ input: 100, cacheRead: 0, reportedRequests: 1, cacheReadReported: 1 }), {
    cacheMiss: 100,
    cacheMissReported: 1,
  });
  assert.deepEqual(deriveCacheMiss({ input: 100, cacheRead: 100, reportedRequests: 1, cacheReadReported: 1 }), {
    cacheMiss: 0,
    cacheMissReported: 1,
  });
  // Unknown input stays unknown instead of looking like a measured zero.
  assert.equal(deriveCacheMiss({ input: 0, cacheRead: 0 }), null);
  assert.equal(deriveCacheMiss({ input: 0 }), null);
  assert.equal(deriveCacheMiss(null), null);
  assert.equal(deriveCacheMiss({ cacheRead: 10 }), null);
});

test("an interrupted stream keeps measured usage without claiming complete cache coverage", async (t) => {
  // The provider bills a generation even when the panel aborts it. Folding every
  // attempt into the request total keeps the local ledger comparable with the
  // workspace /usage counters.
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cnb-panel-abort-usage-"));
  const directory = join(fixtureRoot, "data");
  let attempt = 0;
  const upstream = http.createServer(async (req, res) => {
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
    for await (const _ of req);
    attempt++;
    res.setHeader("Content-Type", "text/event-stream");
    if (attempt === 1) {
      // A billed generation that dies without finish_reason or [DONE].
      res.write(
        'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":5,"prompt_cache_hit_tokens":60}}\n\n',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      res.destroy();
      return;
    }
    res.end(
      'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":40,"completion_tokens":7,"prompt_cache_hit_tokens":10}}\n\n' +
        "data: [DONE]\n\n",
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
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(upstream);
    removeAll(fixtureRoot);
  });
  const created = app.store.create({
    name: "abort-workspace",
    endpoint,
    proxyKey: PROXY,
  });
  await app.pool.probe(created.id);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GATEWAY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
  await response.text().catch(() => {});
  for (
    let i = 0;
    i < 200 &&
    !app.store.logs.all().some((entry) => entry.kind === "request");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  const record = app.store.logs.all().find((entry) => entry.kind === "request");
  assert.ok(record, "request log written");
  // The aborted attempt was billed: its usage must survive into the ledger.
  assert.equal(record.tokenUsage.input, 100);
  assert.equal(record.tokenUsage.output, 5);
  assert.equal(record.tokenUsage.cacheRead, 60);
  assert.equal(record.tokenUsage.total, 105);
  assert.equal(record.cacheMiss, undefined);
  assert.equal(record.tokenUsage.partialRequests, 1);
});
