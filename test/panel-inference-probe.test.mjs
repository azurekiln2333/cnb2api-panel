import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPanelServer } from "../src/app.mjs";
import { DEFAULT_SETTINGS, Store } from "../src/store.mjs";

const ADMIN = "synthetic-probe-admin";
const GATEWAY = "synthetic-probe-gateway";
const PROXY = "synthetic-probe-worker-key";
const MODE_HEADER = "x-cnb2api-upstream-mode";
const APPLIED_HEADER = "x-cnb2api-upstream-mode-applied";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

const usageSnapshot = (prompt, completion, requests) => ({
  boot_id: "probe-boot",
  booted_at: "2026-11-01T00:00:00.000Z",
  schema_version: 2,
  capabilities: { cache_hit: true, cache_miss: true, cache_write: true, credit: true },
  coverage: {
    prompt: requests,
    completion: requests,
    cache_hit: requests,
    cache_miss: requests,
    cache_write: requests,
    credit: requests,
  },
  totals: {
    prompt,
    completion,
    requests,
    errors: 0,
    partial_requests: 0,
    credit: 0,
    cache_hit: 0,
    cache_miss: prompt,
    cache_write: 0,
  },
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "panel-inference-probe-"));
  const directory = join(root, "data");
  // The mock worker answers inference with whatever the current test set here.
  const upstream = {
    status: 200,
    applied: "classic",
    retryAfter: null,
    hang: false,
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    usageTotals: usageSnapshot(0, 0, 0),
    models: [{ id: "discovered-model" }],
  };
  const calls = [];
  const worker = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, method: req.method, headers: req.headers, body });
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data: upstream.models }));
      return;
    }
    if (req.url === "/usage") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(upstream.usageTotals));
      return;
    }
    if (upstream.hang) return;
    const headers = { "Content-Type": "application/json" };
    if (upstream.applied) headers[APPLIED_HEADER] = upstream.applied;
    if (upstream.retryAfter) headers["Retry-After"] = upstream.retryAfter;
    res.writeHead(upstream.status, headers);
    res.end(
      JSON.stringify({
        id: "chatcmpl-probe",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "h" } }],
        ...(upstream.usage ? { usage: upstream.usage } : {}),
      }),
    );
  });
  const endpoint = await listen(worker);
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: GATEWAY,
    dataDir: directory,
    allowLocal: true,
  });
  app.store.settings({ quotaProtection: { enabled: false } });
  const base = await listen(app.server);
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = (path, options = {}) =>
    fetch(`${base}${path}`, {
      ...options,
      headers: { Cookie: cookie, ...options.headers },
    });
  const account = async (overrides = {}) => {
    const created = app.store.create({
      name: `探活-${app.store.state.accounts.length}`,
      endpoint,
      proxyKey: PROXY,
      ...overrides,
    });
    await app.pool.probe(created.id);
    return created.id;
  };
  const probeCalls = () =>
    calls.filter((entry) => entry.url === "/v1/chat/completions");
  const enable = (intervalMinutes = 30) =>
    app.store.settings({ inferenceProbe: { enabled: true, intervalMinutes } });
  t.after(async () => {
    app.pool.stop();
    for (const server of [app.server, worker]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { ...app, base, directory, endpoint, upstream, calls, call, account, probeCalls, enable };
}

test("inference probe settings default to off, validate and survive reload", (t) => {
  const root = mkdtempSync(join(tmpdir(), "panel-inference-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new Store(join(root, "data"), { allowLocal: true });
  assert.deepEqual(DEFAULT_SETTINGS.inferenceProbe, { enabled: false, intervalMinutes: 30 });
  assert.deepEqual(store.state.settings.inferenceProbe, { enabled: false, intervalMinutes: 30 });
  assert.deepEqual(
    store.settings({ inferenceProbe: { enabled: true } }).inferenceProbe,
    { enabled: true, intervalMinutes: 30 },
  );
  // A partial update keeps the other field.
  assert.deepEqual(
    store.settings({ inferenceProbe: { intervalMinutes: 5 } }).inferenceProbe,
    { enabled: true, intervalMinutes: 5 },
  );
  for (const invalid of [
    { intervalMinutes: 4 },
    { intervalMinutes: 1441 },
    { intervalMinutes: 10.5 },
    { enabled: "yes" },
    [],
    null,
  ])
    assert.throws(() => store.settings({ inferenceProbe: invalid }), /推理探活/);
  assert.deepEqual(
    new Store(store.directory, { allowLocal: true }).state.settings.inferenceProbe,
    { enabled: true, intervalMinutes: 5 },
  );

  // Documents written before the feature existed load with the defaults.
  const account = store.create({ name: "旧账号", proxyKey: PROXY });
  const panel = JSON.parse(readFileSync(store.file, "utf8"));
  delete panel.settings.inferenceProbe;
  writeFileSync(store.file, JSON.stringify(panel));
  const stats = JSON.parse(readFileSync(store.statsFile, "utf8"));
  delete stats.accounts[account.id].inferenceProbe;
  delete stats.accounts[account.id].probeUsage;
  writeFileSync(store.statsFile, JSON.stringify(stats));
  const reloaded = new Store(store.directory, { allowLocal: true });
  assert.deepEqual(reloaded.state.settings.inferenceProbe, { enabled: false, intervalMinutes: 30 });
  assert.equal(reloaded.get(account.id).inferenceProbe, null);
  assert.deepEqual(reloaded.get(account.id).probeUsage, { requests: 0, prompt: 0, completion: 0 });
});

test("disabled by default: the scheduler sends no inference probe", async (t) => {
  const app = await fixture(t);
  await app.account();
  assert.equal(app.pool.inferenceTick(), null);
  assert.equal(app.probeCalls().length, 0);
});

test("an enabled probe sends the exact body and headers and follows the account mode", async (t) => {
  const app = await fixture(t);
  const inherit = await app.account();
  app.enable();
  const result = await app.pool.inferenceTick();
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.model, "discovered-model");
  assert.deepEqual(result.usage, { prompt: 3, completion: 1 });
  assert.equal(typeof result.latencyMs, "number");
  assert.equal(result.error, "");
  const [sent] = app.probeCalls();
  assert.equal(sent.method, "POST");
  assert.deepEqual(JSON.parse(sent.body), {
    model: "discovered-model",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1,
    stream: false,
  });
  assert.equal(sent.headers.authorization, `Bearer ${PROXY}`);
  assert.equal(sent.headers["content-type"], "application/json");
  assert.equal(sent.headers[MODE_HEADER], undefined);
  // No request overrides, presets or upstream header carrier.
  assert.equal(sent.headers["x-cnb2api-upstream-headers"], undefined);
  assert.deepEqual(app.store.get(inherit).inferenceProbe, result);
  assert.equal(app.store.get(inherit).upstreamModeApplied, "classic");
  // The same account is not probed again inside the interval.
  assert.equal(app.pool.inferenceTick(), null);

  // A configured model wins over discovered ones; the mode header follows.
  app.store.patch(inherit, { enabled: false });
  const ide = await app.account({ upstreamMode: "ide", models: ["configured-model"] });
  app.upstream.applied = "ide";
  await app.pool.inferenceTick();
  const second = app.probeCalls()[1];
  assert.equal(JSON.parse(second.body).model, "configured-model");
  assert.equal(second.headers[MODE_HEADER], "ide");
  assert.equal(app.store.get(ide).upstreamModeApplied, "ide");
  assert.equal(app.store.get(ide).inferenceProbe.ok, true);
});

test("skip rules: disabled, cooling, unhealthy, quota protected, recent real success, no model", async (t) => {
  const app = await fixture(t);
  const id = await app.account();
  app.enable();
  const interval = 30 * 60000;
  const due = () => app.pool.inferenceProbeDue(app.store.get(id), interval);
  assert.equal(due(), true);

  app.store.patch(id, { enabled: false });
  assert.equal(due(), false);
  app.store.patch(id, { enabled: true });

  app.store.patch(id, { cooldownUntil: new Date(Date.now() + 60000).toISOString() });
  assert.equal(due(), false);
  app.store.patch(id, { cooldownUntil: null });

  app.store.patch(id, { status: "unhealthy" });
  assert.equal(due(), false);
  app.store.patch(id, { status: "healthy" });

  // Quota protection without a verified quota snapshot blocks routing.
  app.store.settings({ quotaProtection: { enabled: true } });
  assert.equal(app.store.get(id).quotaProtection.suspended, true);
  assert.equal(due(), false);
  app.store.settings({ quotaProtection: { enabled: false } });
  assert.equal(due(), true);

  // A real inference success within the interval makes the probe redundant.
  const response = await fetch(`${app.base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "discovered-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(due(), false);
  assert.equal(app.pool.inferenceTick(), null);
  assert.equal(app.pool.inferenceProbeDue(app.store.get(id), interval, Date.now() + interval), true);

  // An in-flight readiness probe on the same account defers the inference probe.
  app.pool.inferenceSuccessAt.clear();
  const readiness = app.pool.probe(id);
  assert.equal(due(), false);
  await readiness;
  assert.equal(due(), true);

  // No configured or discovered model: skip and record the reason.
  app.store.patch(id, { discoveredModels: [] });
  const before = app.probeCalls().length;
  const skipped = await app.pool.inferenceTick();
  assert.equal(skipped.ok, false);
  assert.equal(skipped.error, "无可用模型");
  assert.equal(app.probeCalls().length, before);
  assert.equal(app.store.get(id).inferenceProbe.error, "无可用模型");
});

test("429 and 5xx cool the account with a prefixed message; 400 records without cooldown", async (t) => {
  const app = await fixture(t);
  const id = await app.account();

  app.upstream.status = 400;
  let result = await app.pool.inferenceProbe(id);
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /^推理探活：/);
  let account = app.store.get(id);
  assert.equal(account.status, "healthy");
  assert.equal(account.cooldownUntil, null);
  assert.equal(account.inferenceProbe.status, 400);

  app.upstream.status = 429;
  app.upstream.retryAfter = "120";
  result = await app.pool.inferenceProbe(id);
  assert.equal(result.ok, false);
  account = app.store.get(id);
  assert.equal(account.status, "unhealthy");
  assert.equal(account.failureKind, "upstream");
  assert.match(account.lastError, /^推理探活：工作区返回 HTTP 429/);
  const remaining = Date.parse(account.cooldownUntil) - Date.now();
  assert.ok(remaining > 100000 && remaining <= 120000, `${remaining}`);
  assert.equal(account.inferenceProbe.status, 429);

  // A manual probe may run inside the cooldown; a 2xx proves recovery.
  app.upstream.status = 200;
  app.upstream.retryAfter = null;
  result = await app.pool.inferenceProbe(id);
  assert.equal(result.ok, true);
  account = app.store.get(id);
  assert.equal(account.status, "healthy");
  assert.equal(account.cooldownUntil, null);
  assert.equal(account.lastError, "");

  app.upstream.status = 503;
  await app.pool.inferenceProbe(id);
  account = app.store.get(id);
  assert.equal(account.status, "unhealthy");
  assert.match(account.lastError, /^推理探活：工作区返回 HTTP 503/);
  assert.ok(Date.parse(account.cooldownUntil) > Date.now());
});

test("a connection failure or timeout cools the account like a failed inference attempt", async (t) => {
  const app = await fixture(t);
  const id = await app.account();
  app.store.settings({ idleTimeoutSeconds: 10 });
  t.mock.method(AbortSignal, "timeout", () => AbortSignal.abort(new DOMException("timeout", "TimeoutError")));
  const result = await app.pool.inferenceProbe(id);
  t.mock.restoreAll();
  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.equal(result.error, "推理探活：推理响应等待超时");
  const account = app.store.get(id);
  assert.equal(account.status, "unhealthy");
  assert.equal(account.failureKind, "upstream");
  assert.equal(account.lastError, "推理探活：推理响应等待超时");
  assert.ok(Date.parse(account.cooldownUntil) > Date.now());
});

test("a 2xx probe follows the success path and records the upstream mode", async (t) => {
  const app = await fixture(t);
  const id = await app.account({ upstreamMode: "auto" });
  // A connection failure recorded by an earlier readiness check.
  app.store.patch(id, {
    status: "unhealthy",
    failures: 2,
    failureKind: "connection",
    lastError: "工作区拒绝连接",
    cooldownUntil: new Date(Date.now() + 60000).toISOString(),
  });
  app.upstream.applied = null;
  const result = await app.pool.inferenceProbe(id);
  assert.equal(result.ok, true);
  const account = app.store.get(id);
  assert.equal(account.status, "healthy");
  assert.equal(account.failures, 0);
  assert.equal(account.cooldownUntil, null);
  // A 2xx without the applied header reads as a legacy worker.
  assert.equal(account.upstreamModeApplied, "legacy");

  // Also for inherit accounts.
  app.store.update(id, { upstreamMode: "inherit" });
  app.store.patch(id, { upstreamModeApplied: null, upstreamModeAppliedAt: null });
  await app.pool.inferenceProbe(id);
  assert.equal(app.store.get(id).upstreamModeApplied, "legacy");

  // A non-2xx without the header leaves the measurement unchanged.
  app.upstream.status = 400;
  app.store.patch(id, { upstreamModeApplied: "ide", upstreamModeAppliedAt: "2026-11-01T00:00:00.000Z" });
  await app.pool.inferenceProbe(id);
  assert.equal(app.store.get(id).upstreamModeApplied, "ide");
});

test("the manual endpoint works with the setting off, requires an enabled account and an admin session", async (t) => {
  const app = await fixture(t);
  const id = await app.account();
  assert.equal(app.store.state.settings.inferenceProbe.enabled, false);
  const anonymous = await fetch(`${app.base}/api/accounts/${id}/inference-probe`, { method: "POST" });
  assert.equal(anonymous.status, 401);
  await anonymous.text();
  assert.equal(app.probeCalls().length, 0);

  const response = await app.call(`/api/accounts/${id}/inference-probe`, { method: "POST" });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.ok, true);
  assert.equal(result.model, "discovered-model");
  assert.equal(app.probeCalls().length, 1);

  // Runs regardless of a recent real success.
  app.pool.inferenceSuccessAt.set(id, Date.now());
  const again = await app.call(`/api/accounts/${id}/inference-probe`, { method: "POST" });
  assert.equal(again.status, 200);
  await again.json();
  assert.equal(app.probeCalls().length, 2);

  app.store.patch(id, { enabled: false });
  const disabled = await app.call(`/api/accounts/${id}/inference-probe`, { method: "POST" });
  assert.equal(disabled.status, 409);
  await disabled.text();
  assert.equal(app.probeCalls().length, 2);

  // Every attempt is audited, including the rejected anonymous one.
  const audit = app.store.state.logs.filter((entry) => entry.action === "account.inference_probe");
  assert.deepEqual(audit.map((entry) => entry.status).sort(), [200, 200, 401, 409]);
  assert.equal(audit[0].accountId, id);
});

test("probe usage stays out of logs and token totals but enters reconciliation", async (t) => {
  const app = await fixture(t);
  const id = await app.account();
  await app.pool.workerUsage.refresh(id);
  const logsBefore = app.store.state.logs.filter((entry) => entry.kind === "request").length;
  await app.pool.inferenceProbe(id);
  await app.pool.inferenceProbe(id);
  const account = app.store.get(id);
  assert.deepEqual(account.probeUsage, { requests: 2, prompt: 6, completion: 2 });
  assert.equal(account.tokenUsage.total, 0);
  assert.equal(account.requests, 0);
  assert.equal(app.store.state.tokenUsage.total, 0);
  assert.equal(app.store.state.logs.filter((entry) => entry.kind === "request").length, logsBefore);

  // The worker counted both probes; the comparison explains them.
  app.upstream.usageTotals = usageSnapshot(6, 2, 2);
  const row = await app.pool.workerUsage.refresh(id);
  assert.equal(row.status, "ok");
  assert.equal(row.workspace.total, 8);
  assert.equal(row.local.total, 8);
  assert.equal(row.difference.total, 0);
  assert.deepEqual(row.probe, { requests: 2, prompt: 6, completion: 2 });

  // Persisted as runtime state.
  const reloaded = new Store(app.directory, { allowLocal: true });
  assert.deepEqual(reloaded.get(id).probeUsage, { requests: 2, prompt: 6, completion: 2 });
  assert.equal(reloaded.get(id).inferenceProbe.ok, true);
});
