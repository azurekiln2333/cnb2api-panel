import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenUsageCapture, deriveCacheMiss } from "../src/token-usage.mjs";
import { toResponsesResponse, ResponsesStream } from "../src/responses.mjs";
import { Pool } from "../src/pool.mjs";
import { Store } from "../src/store.mjs";

const completion = (usage, choices = [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }]) => ({ usage, choices });
const capture = (values, sse = false) => {
  const collector = new TokenUsageCapture(sse ? "text/event-stream" : "application/json");
  for (const value of values) collector.push(Buffer.from(sse
    ? `data: ${JSON.stringify(value)}\n\n` : JSON.stringify(value)));
  return collector.finish();
};
const streamUsage = (values) => {
  const stream = new ResponsesStream();
  const chunks = [];
  for (const value of values) chunks.push(...stream.push(Buffer.from(`data: ${JSON.stringify(value)}\n\n`)));
  chunks.push(...stream.finish());
  const events = chunks.map((chunk) => JSON.parse(chunk.toString().split("\ndata: ")[1]));
  return events.at(-1).response.usage;
};

test("cache aliases and both placeholder families agree between panel and Responses", () => {
  const cases = [
    { prompt_tokens: 4007, completion_tokens: 100, cache_read_input_tokens: 0, prompt_tokens_details: { cached_tokens: 3840 } },
    { prompt_tokens: 0, completion_tokens: 0, input_tokens: 167, output_tokens: 100, cache_read_input_tokens: 3840 },
    { prompt_tokens: 4007, completion_tokens: 100, cache_read_input_tokens: 3840, prompt_cache_hit_tokens: 3000 },
  ];
  for (const usage of cases) {
    const value = completion(usage);
    const local = capture([value]);
    const converted = toResponsesResponse(value).usage;
    assert.equal(local.input, 4007);
    assert.equal(local.cacheRead, 3840);
    assert.equal(converted.input_tokens, local.input);
    assert.equal(converted.input_tokens_details.cached_tokens, local.cacheRead);
    assert.equal(converted.total_tokens, local.total);
  }
});

test("billing-only events enrich Chat usage in either order without changing input semantics", () => {
  const primary = { choices: [], usage: { prompt_tokens: 4007, completion_tokens: 100 } };
  const billing = { billing_usage: { cache_read_input_tokens: 3840 } };
  const fullBilling = { billing_usage: { input_tokens: 167, output_tokens: 100, cache_read_input_tokens: 3840 } };
  for (const bill of [billing, fullBilling]) {
    for (const values of [[primary, bill], [bill, primary]]) {
      const local = capture(values, true);
      const converted = streamUsage(values);
      assert.equal(local.input, 4007);
      assert.equal(local.cacheRead, 3840);
      assert.equal(converted.input_tokens, local.input);
      assert.equal(converted.input_tokens_details.cached_tokens, local.cacheRead);
      assert.equal(converted.total_tokens, local.total);
    }
  }
});

test("split measured fields survive later output-only and zero-placeholder blocks", () => {
  const values = [
    { choices: [], usage: { prompt_tokens: 4007, prompt_cache_hit_tokens: 3840 } },
    { choices: [], usage: { completion_tokens: 100 } },
    { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 } },
  ];
  const local = capture(values, true);
  const converted = streamUsage(values);
  assert.equal(local.total, 4107);
  assert.equal(local.cacheRead, 3840);
  assert.equal(local.reportedRequests, 1);
  assert.equal(converted.total_tokens, local.total);
  assert.equal(converted.input_tokens_details.cached_tokens, local.cacheRead);
});

test("fully cached Messages input survives split zero-only Chat placeholders", () => {
  const counts = { choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, input_tokens: 0, output_tokens: 0 } };
  const cache = { choices: [], usage: { cache_read_input_tokens: 3840 } };
  for (const values of [[counts, cache], [cache, counts]]) {
    const local = capture(values, true);
    const converted = streamUsage(values);
    assert.equal(local.input, 3840);
    assert.equal(local.cacheRead, 3840);
    assert.equal(converted.input_tokens, 3840);
    assert.equal(converted.input_tokens_details.cached_tokens, 3840);
  }
});

test("cache miss requires a completely covered attempt population", () => {
  const missing = capture([{ usage: { prompt_tokens: 100, completion_tokens: 2 } }]);
  assert.equal(deriveCacheMiss(missing), null);
  const zero = capture([{ usage: { prompt_tokens: 100, completion_tokens: 2, prompt_cache_hit_tokens: 0 } }]);
  assert.deepEqual(deriveCacheMiss(zero), { cacheMiss: 100, cacheMissReported: 1 });
  assert.equal(deriveCacheMiss({ ...zero, missingRequests: 1 }), null);
  assert.equal(deriveCacheMiss({ ...zero, partialRequests: 1 }), null);
  assert.equal(deriveCacheMiss({ ...zero, reportedRequests: 2 }), null);
  assert.equal(deriveCacheMiss({ input: 100, cacheRead: 0 }), null);
});

test("Responses compatibility zero never creates measured local cache coverage", () => {
  for (const measuredZero of [false, true]) {
    const value = completion({ prompt_tokens: 100, completion_tokens: 2,
      ...(measuredZero ? { prompt_cache_hit_tokens: 0 } : {}) });
    for (const sse of [false, true]) {
      const local = capture([value], sse);
      const converted = sse ? streamUsage([{ usage: value.usage,
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] }])
        : toResponsesResponse(value).usage;
      assert.equal(converted.input_tokens_details.cached_tokens, 0);
      assert.equal(local.cacheRead, 0);
      assert.equal(local.cacheReadReported, Number(measuredZero));
      assert.equal(local.input, 100);
      assert.equal(local.output, 2);
      assert.equal(deriveCacheMiss(local)?.cacheMiss ?? null, measuredZero ? 100 : null);
    }
  }
});

for (const firstContentType of ["application/json", "text/event-stream", "missing"]) {
  test(`two-account retry retains measured usage under its original account: ${firstContentType}`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "panel-usage-retry-"));
    const directory = join(root, "data");
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new Store(directory, { allowLocal: true });
    const accounts = ["A", "B"].map((name, index) => store.create({ name, endpoint: `http://127.0.0.1:${19001 + index}`, proxyKey: "dummy-retry-key" }));
    const first = completion({ prompt_tokens: 100, completion_tokens: 5, prompt_cache_hit_tokens: 60 }, []);
    const second = completion({ prompt_tokens: 40, completion_tokens: 7, prompt_cache_hit_tokens: 10 });
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      if (calls++ > 0) return Response.json(second);
      if (firstContentType === "missing") throw new Error("synthetic connection error");
      return new Response(firstContentType === "text/event-stream"
        ? `data: ${JSON.stringify(first)}\n\n` : JSON.stringify(first), {
        headers: { "content-type": firstContentType },
      });
    });
    const pool = {
      store, active: new Map(), healthVersions: new Map(),
      affinity: { clear() {}, forget() {} },
      select(_model, excluded) { return accounts.map((account) => store.get(account.id)).find((account) => !excluded.has(account.id)); },
      async confirmConnectionFailure() {}, confirmInferenceSuccess() {},
    };
    const res = new EventEmitter();
    Object.assign(res, { destroyed: false, writableEnded: false, headersSent: false,
      writeHead() { this.headersSent = true; }, write() { return true; }, end() { this.writableEnded = true; } });
    await Pool.prototype.forward.call(pool, { headers: {} }, res, "/v1/responses", { model: "test-model", input: "synthetic", stream: false });
    const entry = store.state.logs.find((value) => value.kind === "request");
    const firstTotal = firstContentType === "missing" ? 0 : 105;
    assert.equal(calls, 2);
    assert.equal(entry.attempts, 2);
    assert.equal(entry.tokenUsage.total, firstTotal + 47);
    assert.equal(entry.tokenUsage.reportedRequests + entry.tokenUsage.missingRequests, 2);
    assert.equal(entry.tokenUsage.partialRequests, firstContentType === "missing" ? 0 : 1);
    assert.equal(entry.usageAttempts.length, 2);
    assert.deepEqual(entry.usageAttempts.map((item) => item.accountId), accounts.map((item) => item.id));
    assert.equal(entry.usageAttempts[0].tokenUsage.total, firstTotal);
    assert.equal(entry.usageAttempts[1].tokenUsage.total, 47);
    assert.equal(entry.cacheMiss, undefined, "failed/unknown attempt prevents a false complete miss total");
    for (const state of [store.state, new Store(directory, { allowLocal: true }).state]) {
      assert.equal(state.tokenUsage.total, firstTotal + 47);
      assert.equal(state.hourly[0].tokenUsage.total, firstTotal + 47);
      assert.equal(state.hourly[0].requests, 1, "one user request despite two attempts");
      assert.equal(state.accounts.find((account) => account.id === accounts[0].id).tokenUsage.total, firstTotal);
      assert.equal(state.accounts.find((account) => account.id === accounts[1].id).tokenUsage.total, 47);
    }
    if (firstContentType === "application/json")
      assert.equal(entry.requestDiagnostics.streamFailures[0].usageCaptured, true);
  });
}
