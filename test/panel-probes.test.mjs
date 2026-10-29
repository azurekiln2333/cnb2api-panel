import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Pool } from "../src/pool.mjs";
import { createPanelServer } from "../src/app.mjs";

const key = "probe-worker-private-key";
const models = () => Response.json({ object: "list", data: [{ id: "test-model" }] });
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "panel-probe-"));
  const store = new Store(join(directory, "data"), { allowLocal: true });
  const pool = new Pool(store);
  const account = store.create({ name: "probe", endpoint: "http://127.0.0.1:9001", proxyKey: key });
  t.after(() => {
    pool.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, pool, id: account.id };
}

test("probe replacement starts immediately and stale cleanup cannot remove its work", async (t) => {
  const app = fixture(t);
  const pending = [];
  t.mock.method(globalThis, "fetch", (url, options) => new Promise((resolve) => {
    pending.push({ url, options, resolve });
  }));
  const first = app.pool.probe(app.id);
  assert.equal(app.pool.probe(app.id), first);
  app.store.update(app.id, { endpoint: "http://127.0.0.1:9002" });
  const second = app.pool.probe(app.id);
  assert.notEqual(first, second);
  assert.equal(pending.length, 2);
  pending[0].resolve(models());
  await first;
  assert.equal(app.pool.probe(app.id), second);
  assert.equal(app.store.get(app.id).status, "pending");
  pending[1].resolve(models());
  await second;
  assert.equal(app.store.get(app.id).status, "healthy");
  assert.equal(app.pool.probes.size, 0);

  const third = app.pool.probe(app.id);
  app.store.update(app.id, { proxyKey: "replacement-private-key" });
  const fourth = app.pool.probe(app.id);
  assert.notEqual(third, fourth);
  pending[3].resolve(models());
  await fourth;
  pending[2].resolve(new Response("secret-error", { status: 401 }));
  await third;
  assert.equal(app.store.get(app.id).status, "healthy");
  assert.equal(pending[3].options.headers.Authorization, "Bearer replacement-private-key");
});

test("probe errors distinguish timeout, DNS, TLS, authentication and invalid models safely", async (t) => {
  const cases = [
    ["timeout", () => { throw new DOMException(key, "TimeoutError"); }, /超时/, 504],
    ["dns", () => { throw new TypeError(key, { cause: { code: "ENOTFOUND" } }); }, /域名解析/, 502],
    ["tls", () => { throw new TypeError(key, { cause: { code: "CERT_HAS_EXPIRED" } }); }, /TLS/, 502],
    ["refused", () => { throw new TypeError(key, { cause: { code: "ECONNREFUSED" } }); }, /拒绝连接/, 502],
    ["auth", () => new Response(key, { status: 401 }), /HTTP 401/, 401],
    ["json", () => new Response(key), /有效 JSON/, 502],
    ["schema", () => Response.json({ object: "wrong", data: [] }), /格式无效/, 502],
    ["oversize", () => new Response("x".repeat(256 * 1024 + 1)), /大小限制/, 502],
  ];
  for (const [name, respond, pattern, status] of cases) {
    await t.test(name, async (t) => {
      const app = fixture(t);
      t.mock.method(globalThis, "fetch", async () => respond());
      const result = await app.pool.probe(app.id);
      assert.equal(result.status, "unhealthy");
      assert.match(result.lastError, pattern);
      assert.equal(app.store.state.logs[0].status, status);
      assert.ok(!JSON.stringify(app.store.state.logs).includes(key));
    });
  }
});

test("stalled model response bodies remain bounded by the probe deadline", async (t) => {
  const app = fixture(t);
  app.store.state.settings.connectTimeoutSeconds = 0.03;
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"object":"list","data":['));
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  })));
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  const result = await app.pool.probe(app.id);
  assert.match(result.lastError, /读取模型列表超时/);
  assert.equal(result.status, "unhealthy");
});

test("a new healthy probe prevents older inference failures from cooling the same endpoint", async (t) => {
  const app = fixture(t);
  t.mock.method(globalThis, "fetch", async () => models());
  await app.pool.probe(app.id);
  const source = { ...app.store.get(app.id), healthVersion: app.pool.healthVersions.get(app.id) };
  await app.pool.probe(app.id);
  app.pool.fail(app.id, "old inference failure", 502, source);
  assert.equal(app.store.get(app.id).status, "healthy");
  assert.equal(app.store.get(app.id).cooldownUntil, null);
});

test("a new health check does not suppress an actual upstream rate-limit response", async (t) => {
  const app = fixture(t);
  t.mock.method(globalThis, "fetch", async () => models());
  await app.pool.probe(app.id);
  const source = { ...app.store.get(app.id), healthVersion: app.pool.healthVersions.get(app.id) };
  await app.pool.probe(app.id);
  app.pool.fail(app.id, "HTTP 429", 429, source, { routing: true });
  assert.equal(app.store.get(app.id).status, "unhealthy");
  assert.equal(app.store.get(app.id).failureKind, "upstream");
});

test("an older models check cannot erase a newer upstream cooldown", async (t) => {
  const app = fixture(t);
  let resolveProbe;
  let respond = () => new Promise((resolve) => { resolveProbe = resolve; });
  t.mock.method(globalThis, "fetch", (...args) => respond(...args));
  const pending = app.pool.probe(app.id);
  app.pool.fail(app.id, "HTTP 429", 429, app.store.get(app.id), { routing: true });
  const cooldownUntil = app.store.get(app.id).cooldownUntil;
  resolveProbe(models());
  await pending;
  assert.equal(app.store.get(app.id).status, "unhealthy");
  assert.equal(app.store.get(app.id).cooldownUntil, cooldownUntil);
  assert.equal(app.store.get(app.id).failureKind, "upstream");

  respond = async () => models();
  await app.pool.probe(app.id);
  assert.equal(app.store.get(app.id).status, "healthy");
});

test("an inference connection confirmation cannot bypass a concurrent upstream cooldown", async (t) => {
  const app = fixture(t);
  const remote = t.mock.method(globalThis, "fetch", async () => models());
  await app.pool.probe(app.id);
  const source = { ...app.store.get(app.id), healthVersion: app.pool.healthVersions.get(app.id) };
  app.pool.fail(app.id, "HTTP 429", 429, source, { routing: true });
  const count = remote.mock.callCount();
  await app.pool.confirmConnectionFailure(source);
  assert.equal(remote.mock.callCount(), count);
  assert.equal(app.store.get(app.id).status, "unhealthy");
  assert.equal(app.store.get(app.id).failureKind, "upstream");
});

test("a failed automatic wake is throttled while explicit retry remains available", async (t) => {
  const app = fixture(t);
  app.store.update(app.id, { repo: "org/workspace", pat: "wake-private-token", autoWake: true });
  const remote = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("temporary CNB outage");
  });
  await assert.rejects(app.pool.wake(app.id, { automatic: true }), { status: 424 });
  await assert.rejects(app.pool.wake(app.id, { automatic: true }), { status: 409 });
  assert.equal(remote.mock.callCount(), 1);
  await assert.rejects(app.pool.wake(app.id), { status: 424 });
  assert.equal(remote.mock.callCount(), 2);
});

test("automatic recovery checks cooling connections and wakes persistent failures", async (t) => {
  const app = fixture(t);
  app.store.update(app.id, { repo: "org/workspace", pat: "wake-private-token", autoWake: true });
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    if (url.includes("api.cnb.cool")) return Response.json({ sn: "started" });
    throw new TypeError("failed", { cause: { code: "ECONNREFUSED" } });
  });
  await app.pool.cycle();
  assert.equal(app.store.get(app.id).failures, 1);
  assert.ok(Date.parse(app.store.get(app.id).cooldownUntil) > Date.now());
  await app.pool.cycle();
  await app.pool.cycle();
  assert.equal(app.store.get(app.id).failures, 3);
  assert.equal(urls.filter((url) => url.includes("workspace/start")).length, 1);
  await app.pool.cycle();
  assert.equal(urls.filter((url) => url.includes("workspace/start")).length, 1);
});

test("automatic checks preserve rate-limit cooldowns and cannot trigger a wake", async (t) => {
  const app = fixture(t);
  app.store.update(app.id, { repo: "org/workspace", pat: "wake-private-token", autoWake: true });
  const remote = t.mock.method(globalThis, "fetch", async () => models());
  await app.pool.probe(app.id);
  app.pool.fail(app.id, "HTTP 429", 429, app.store.get(app.id), { routing: true });
  const before = remote.mock.callCount();
  await app.pool.cycle();
  assert.equal(remote.mock.callCount(), before);
  assert.equal(app.store.get(app.id).status, "unhealthy");
  const restored = new Store(app.store.directory, { allowLocal: true });
  const restarted = new Pool(restored);
  t.after(() => restarted.stop());
  assert.equal(restored.get(app.id).failureKind, "upstream");
  await restarted.cycle();
  assert.equal(remote.mock.callCount(), before);
  assert.equal(restored.get(app.id).status, "unhealthy");
});

test("restart preserves recovery of connection cooldowns and legacy HTTP cooldowns", async (t) => {
  const app = fixture(t);
  t.mock.method(globalThis, "fetch", async () => models());
  app.pool.fail(app.id, "connection failure");
  const restored = new Store(app.store.directory, { allowLocal: true });
  const restarted = new Pool(restored);
  t.after(() => restarted.stop());
  await restarted.cycle();
  assert.equal(restored.get(app.id).status, "healthy");
  restored.patch(app.id, {
    status: "unhealthy", failureKind: null,
    lastError: "工作区返回 HTTP 429，已进入冷却",
    cooldownUntil: new Date(Date.now() + 60000).toISOString(),
  });
  await restarted.cycle();
  assert.equal(restored.get(app.id).status, "unhealthy");
});

test("slow first inference response is not treated as the worker connection timeout", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "panel-first-response-"));
  const app = createPanelServer({
    adminKey: "panel-private-admin-key", gatewayKey: "panel-private-gateway-key",
    dataDir: join(directory, "data"), allowLocal: true,
  });
  const worker = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1150));
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "slow but valid" } }] }));
  });
  const endpoint = await listen(worker);
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(worker);
    rmSync(directory, { recursive: true, force: true });
  });
  const account = app.store.create({ name: "slow", endpoint, proxyKey: key });
  app.store.settings({ connectTimeoutSeconds: 1, idleTimeoutSeconds: 10 });
  await app.pool.probe(account.id);
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: "Bearer panel-private-gateway-key", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "slow but valid");
  assert.equal(app.store.get(account.id).status, "healthy");
  assert.equal(app.store.get(account.id).cooldownUntil, null);
});
