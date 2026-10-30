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

const gatewayKey = "rate-test-gateway-key";
const proxyKey = "rate-test-worker-key";
const modelList = () => ({ object: "list", data: [{ id: "test-model" }] });
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
function clock(t) {
  const value = { now: Date.now() };
  t.mock.method(Date, "now", () => value.now);
  return value;
}
function poolFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "panel-rate-unit-"));
  const store = new Store(join(directory, "data"), { allowLocal: true });
  store.settings({ quotaProtection: { enabled: false, thresholdPercent: 10 } });
  const pool = new Pool(store);
  const account = store.create({ name: "rate", endpoint: "http://127.0.0.1:9001", proxyKey });
  store.patch(account.id, { status: "healthy" });
  t.after(() => { pool.stop(); rmSync(directory, { recursive: true, force: true }); });
  return { store, pool, id: account.id };
}
async function httpFixture(t, count = 1) {
  const directory = mkdtempSync(join(tmpdir(), "panel-rate-http-"));
  const app = createPanelServer({ adminKey: "rate-test-admin-key", gatewayKey,
    dataDir: join(directory, "data"), allowLocal: true });
  app.store.settings({ quotaProtection: { enabled: false, thresholdPercent: 10 } });
  const state = { modelsStatus: 200, chatStatus: 200, modelRequests: 0,
    chatRequests: 0, retryAfter: "2", holdProbe: false, pendingProbe: null };
  const worker = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/v1/models") {
      state.modelRequests++;
      if (state.holdProbe) { state.pendingProbe = res; return; }
      res.statusCode = state.modelsStatus;
      if (state.modelsStatus === 429) res.setHeader("Retry-After", state.retryAfter);
      res.end(JSON.stringify(state.modelsStatus === 200 ? modelList() : { error: { message: "model check busy" } }));
      return;
    }
    if (req.url === "/usage") { res.end(JSON.stringify({})); return; }
    state.chatRequests++;
    res.statusCode = state.chatStatus;
    if (state.chatStatus === 429) res.setHeader("Retry-After", state.retryAfter);
    res.end(JSON.stringify(state.chatStatus === 200
      ? { model: "test-model", choices: [{ message: { role: "assistant", content: "still working" } }] }
      : { error: { message: "temporarily limited" } }));
  });
  const endpoint = await listen(worker);
  const base = await listen(app.server);
  const ids = [];
  for (let i = 0; i < count; i++) {
    const account = app.store.create({ name: `worker-${i}`, endpoint, proxyKey });
    ids.push(account.id);
    await app.pool.probe(account.id);
  }
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(worker);
    rmSync(directory, { recursive: true, force: true });
  });
  const chat = () => fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${gatewayKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hello" }] }),
  });
  return { ...app, state, ids, chat };
}

test("a models-only 429 preserves working inference accounts and retries automatically", async (t) => {
  const time = clock(t);
  const app = await httpFixture(t, 3);
  app.state.modelsStatus = 429;
  const initialChecks = app.state.modelRequests;
  await app.pool.cycle();
  assert.equal(app.state.modelRequests, initialChecks + 3);
  for (const id of app.ids) {
    assert.equal(app.store.get(id).status, "healthy");
    assert.equal(app.store.get(id).cooldownUntil, null);
    assert.equal(app.store.get(id).failures, 0);
    assert.equal(app.store.get(id).lastError, "");
  }
  const response = await app.chat();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, "still working");
  await app.pool.cycle();
  assert.equal(app.state.modelRequests, initialChecks + 3, "automatic checks honor their own Retry-After");
  app.state.modelsStatus = 200;
  time.now += 2001;
  await app.pool.cycle();
  assert.equal(app.state.modelRequests, initialChecks + 6);
  assert.ok(app.ids.every((id) => app.store.get(id).status === "healthy"));
});

test("a successful inference invalidates an older failed readiness check", async (t) => {
  const app = await httpFixture(t);
  app.state.holdProbe = true;
  const checking = app.pool.cycle();
  for (let i = 0; i < 50 && !app.state.pendingProbe; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(app.state.pendingProbe);
  const response = await app.chat();
  assert.equal(response.status, 200);
  await response.json();
  app.state.pendingProbe.destroy();
  await checking;
  assert.equal(app.store.get(app.ids[0]).status, "healthy");
  assert.equal(app.store.get(app.ids[0]).cooldownUntil, null);
});

test("completed inference repairs connection health while preserving actual provider cooldown", (t) => {
  const app = poolFixture(t);
  const source = { ...app.store.get(app.id), healthVersion: 0 };
  app.pool.fail(app.id, "connection failed", 502, source);
  app.pool.confirmInferenceSuccess(source);
  assert.equal(app.store.get(app.id).status, "healthy");
  assert.equal(app.store.get(app.id).failures, 0);
  assert.equal(app.store.get(app.id).cooldownUntil, null);
  app.pool.fail(app.id, "provider rate limited", 429, source, { routing: true });
  const deadline = app.store.get(app.id).cooldownUntil;
  app.pool.confirmInferenceSuccess(source);
  assert.equal(app.store.get(app.id).status, "unhealthy");
  assert.equal(app.store.get(app.id).cooldownUntil, deadline);
  app.store.update(app.id, { endpoint: "http://127.0.0.1:9002" });
  app.pool.confirmInferenceSuccess(source);
  assert.equal(app.store.get(app.id).status, "pending");
});

test("a throttled models check cannot wake a workspace and explicit probes remain available", async (t) => {
  const app = poolFixture(t);
  app.store.update(app.id, { repo: "org/workspace", pat: "rate-test-pat", autoWake: true });
  app.store.patch(app.id, { status: "unhealthy", failureKind: "connection", failures: 3 });
  let throttled = true;
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return throttled
      ? new Response(null, { status: 429, headers: { "Retry-After": "60" } })
      : Response.json(modelList());
  });
  await app.pool.cycle();
  await app.pool.cycle();
  assert.equal(urls.length, 1);
  assert.ok(urls[0].endsWith("/v1/models"));
  assert.equal(app.store.get(app.id).failures, 3);
  throttled = false;
  await app.pool.probe(app.id);
  assert.equal(urls.length, 2);
  assert.equal(app.store.get(app.id).status, "healthy");
});

test("simultaneous upstream 429 responses do not multiply one cooldown into an hour", (t) => {
  clock(t);
  const app = poolFixture(t);
  const source = { ...app.store.get(app.id), healthVersion: 0 };
  app.pool.fail(app.id, "rate limited", 429, source, { routing: true });
  const first = app.store.get(app.id).cooldownUntil;
  for (let i = 0; i < 12; i++) app.pool.fail(app.id, "rate limited", 429, source, { routing: true });
  assert.equal(app.store.get(app.id).failures, 1);
  assert.equal(app.store.get(app.id).cooldownUntil, first);
  assert.equal(Date.parse(first) - Date.now(), 60000);
});

test("real inference 429 honors Retry-After and recovers after expiry without a manual probe", async (t) => {
  const time = clock(t);
  const app = await httpFixture(t);
  app.state.chatStatus = 429;
  const response = await app.chat();
  assert.equal(response.status, 503);
  await response.json();
  const id = app.ids[0];
  assert.equal(app.store.get(id).status, "unhealthy");
  assert.equal(Date.parse(app.store.get(id).cooldownUntil) - time.now, 2000);
  const before = app.state.modelRequests;
  await app.pool.cycle();
  assert.equal(app.state.modelRequests, before);
  app.state.chatStatus = 200;
  time.now += 2001;
  await app.pool.cycle();
  assert.equal(app.store.get(id).status, "healthy");
  assert.equal(app.store.get(id).cooldownUntil, null);
  const healthy = await app.chat();
  assert.equal(healthy.status, 200);
  await healthy.json();
});

test("Retry-After dates are supported and invalid values use the configured cooldown", (t) => {
  const time = clock(t);
  const app = poolFixture(t);
  const source = app.store.get(app.id);
  const deadline = new Date(Math.floor(time.now / 1000) * 1000 + 90000).toUTCString();
  app.pool.fail(app.id, "rate limited", 429, source, { routing: true, retryAfter: deadline });
  assert.equal(app.store.get(app.id).cooldownUntil, new Date(deadline).toISOString());
  app.store.patch(app.id, { status: "healthy", failures: 0, failureKind: null, cooldownUntil: null });
  app.pool.fail(app.id, "rate limited", 429, app.store.get(app.id), { routing: true, retryAfter: "bad" });
  assert.equal(Date.parse(app.store.get(app.id).cooldownUntil) - time.now, 60000);
});

test("restart revalidates a persisted models-only 429 without waiting for its old routing cooldown", async (t) => {
  const app = poolFixture(t);
  app.store.patch(app.id, {
    status: "unhealthy", failures: 6, failureKind: "upstream",
    lastError: "工作区鉴权探活返回 HTTP 429",
    cooldownUntil: new Date(Date.now() + 3600000).toISOString(),
  });
  const restored = new Store(app.store.directory, { allowLocal: true });
  const restarted = new Pool(restored);
  t.after(() => restarted.stop());
  assert.equal(restored.get(app.id).status, "pending", "migration does not invent successful health");
  assert.equal(restored.get(app.id).failures, 0);
  assert.equal(restored.get(app.id).failureKind, null);
  assert.equal(restored.get(app.id).cooldownUntil, null);
  assert.equal(restored.get(app.id).lastError, "");
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return url.endsWith("/v1/models") ? Response.json(modelList()) : new Response(null, { status: 404 });
  });
  await restarted.cycle();
  assert.equal(urls.filter((url) => url.endsWith("/v1/models")).length, 1);
  assert.equal(restored.get(app.id).status, "healthy");
  assert.equal(restarted.eligible()[0].id, app.id);
  const persisted = new Store(app.store.directory, { allowLocal: true });
  assert.equal(persisted.get(app.id).failureKind, null);
  assert.equal(persisted.get(app.id).cooldownUntil, null);
});

test("restart preserves actual inference cooldowns and other probe failures", async (t) => {
  const app = poolFixture(t);
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const failures = [
    { failureKind: "upstream", lastError: "工作区返回 HTTP 429，已进入冷却" },
    { failureKind: null, lastError: "工作区返回 HTTP 429，已进入冷却" },
    { failureKind: "upstream", lastError: "工作区鉴权探活返回 HTTP 401" },
    { failureKind: "response", lastError: "工作区鉴权探活返回 HTTP 429" },
  ];
  const ids = failures.map((fields, index) => {
    const id = index === 0 ? app.id : app.store.create({
      name: `preserved-${index}`, endpoint: `http://127.0.0.1:${9001 + index}`, proxyKey,
    }).id;
    app.store.patch(id, { status: "unhealthy", failures: 4, cooldownUntil: deadline, ...fields });
    return id;
  });
  const restored = new Store(app.store.directory, { allowLocal: true });
  const restarted = new Pool(restored);
  t.after(() => restarted.stop());
  const remote = t.mock.method(globalThis, "fetch", async () => Response.json(modelList()));
  await restarted.cycle();
  assert.equal(remote.mock.callCount(), 0);
  for (const [index, id] of ids.entries()) {
    const current = restored.get(id);
    assert.equal(current.status, "unhealthy");
    assert.equal(current.cooldownUntil, deadline);
    assert.equal(current.failures, 4);
    assert.equal(current.failureKind, failures[index].failureKind);
    assert.equal(current.lastError, failures[index].lastError);
  }
});

test("legacy probe migration preserves manual disablement and independent quota suspension", async (t) => {
  const app = poolFixture(t);
  app.store.settings({ quotaProtection: { enabled: true } });
  app.store.update(app.id, { repo: "org/limited" });
  const disabled = app.store.create({
    name: "manually-disabled", enabled: false, repo: "org/disabled",
    endpoint: "http://127.0.0.1:9002", proxyKey,
  });
  for (const id of [app.id, disabled.id]) app.store.patch(id, {
    status: "unhealthy", failures: 6, failureKind: "upstream",
    lastError: "工作区鉴权探活返回 HTTP 429",
    cooldownUntil: new Date(Date.now() + 3600000).toISOString(),
    quota: { org: "org", credits: { total: 100, used: 95, freeze: 0 }, syncedAt: new Date().toISOString() },
    quotaSync: { status: "ok" },
  });
  const restored = new Store(app.store.directory, { allowLocal: true });
  const restarted = new Pool(restored);
  t.after(() => restarted.stop());
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(url);
    return url.endsWith("/v1/models") ? Response.json(modelList()) : new Response(null, { status: 404 });
  });
  assert.equal(restored.get(disabled.id).enabled, false);
  assert.equal(restored.get(disabled.id).status, "pending");
  assert.equal(restored.get(app.id).quotaProtection.reason, "low");
  await restarted.cycle();
  assert.equal(urls.filter((url) => url.endsWith("/v1/models")).length, 1);
  assert.equal(restored.get(app.id).status, "healthy");
  assert.equal(restored.get(app.id).quotaProtection.reason, "low");
  assert.equal(restored.get(disabled.id).enabled, false);
  assert.equal(restored.get(disabled.id).status, "pending");
  assert.deepEqual(restarted.eligible(), []);
});
