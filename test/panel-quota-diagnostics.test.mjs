import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";
import { fetchQuota } from "../src/quota.mjs";

const ADMIN = "quota-diagnostics-admin-key";
const GATEWAY = "quota-diagnostics-gateway-key";
const PAT = "quota-diagnostics-personal-token";
const PRIVATE_BODY = "private-upstream-error-body";
const ALLOWANCE = { credit_in_milli: { total: 100_000 } };
const USAGE = { credit_in_milli: 10_000 };

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function fixture(t, handler, { timeoutMs = 1000 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cnb-panel-quota-diagnostics-"));
  const requests = [];
  const cnb = http.createServer((req, res) => {
    const resource = req.url.split("/").pop();
    requests.push(resource);
    assert.equal(req.headers.authorization, `Bearer ${PAT}`);
    res.setHeader("Content-Type", "application/json");
    handler(resource, req, res);
  });
  const cnbBase = await listen(cnb);
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: GATEWAY,
    dataDir: join(directory, "data"),
    allowLocal: true,
    poolOptions: {
      fetchQuotaImpl: (options) => fetchQuota({ ...options, base: cnbBase, timeoutMs }),
    },
  });
  const base = await listen(app.server);
  t.after(async () => {
    await close(app.server);
    await close(cnb);
    rmSync(directory, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = (path, method = "GET") => fetch(`${base}${path}`, {
    method,
    headers: { Cookie: cookie },
  });
  const account = (fields = {}) => {
    const created = app.store.create({
      name: `account-${app.store.state.accounts.length}`,
      repo: `private-org/repo-${app.store.state.accounts.length}`,
      endpoint: "http://127.0.0.1:9001",
      pat: PAT,
      proxyKey: "quota-diagnostics-worker-key",
      ...fields,
    });
    app.store.patch(created.id, { status: "healthy" });
    return app.store.get(created.id);
  };
  return { ...app, call, account, cnb, requests };
}

async function verifyFailure(app, account, { status = 502, code, upstreamStatus } = {}) {
  const response = await app.call(`/api/accounts/${account.id}/quota`, "POST");
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.match(body.error.message, /额度同步失败/);
  if (upstreamStatus) assert.match(body.error.message, new RegExp(`HTTP ${upstreamStatus}`));
  const current = app.store.get(account.id);
  assert.equal(current.quotaSync.status, "error");
  assert.equal(current.quotaSync.error, body.error.message);
  assert.equal(current.quotaProtection.reason, "sync-error");
  assert.equal(current.status, "healthy");
  assert.equal(current.cooldownUntil, null);
  assert.equal(current.failures, 0);
  const accountsResponse = await app.call("/api/accounts");
  const accountsBody = await accountsResponse.text();
  for (const secret of [PAT, PRIVATE_BODY, "private-org"])
    assert.ok(!JSON.stringify(body).includes(secret));
  for (const secret of [PAT, PRIVATE_BODY]) assert.ok(!accountsBody.includes(secret));
  assert.ok(accountsBody.includes(body.error.message));
  return body;
}

test("a CNB response without frozen usage restores all matching accounts through the quota API", async (t) => {
  const app = await fixture(t, (resource, req, res) => {
    res.end(JSON.stringify(resource === "quota" ? ALLOWANCE : USAGE));
  });
  const first = app.account();
  const sibling = app.account();
  const manual = app.account({ enabled: false });
  for (const account of [first, sibling, manual]) {
    app.store.patch(account.id, {
      quotaSync: { status: "error", error: "额度同步失败" },
    });
    assert.equal(app.store.get(account.id).quotaProtection.suspended, true);
  }
  const response = await app.call(`/api/accounts/${first.id}/quota`, "POST");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.quota.credits, { total: 100, used: 10, freeze: 0 });
  assert.deepEqual(app.requests.sort(), ["quota", "volume"]);
  for (const account of [first, sibling, manual]) {
    const current = app.store.get(account.id);
    assert.equal(current.quotaSync.status, "ok");
    assert.equal(current.quotaSync.error, "");
    assert.equal(current.quotaProtection.suspended, false);
    assert.equal(current.quotaProtection.remainingPercent, 90);
  }
  assert.equal(app.store.get(manual.id).enabled, false);
  assert.equal(app.pool.eligible().length, 2);
});

test("quota upstream HTTP failures retain their real status without inference cooldowns or secret disclosure", async (t) => {
  for (const upstreamStatus of [401, 403, 404, 429, 502]) await t.test(String(upstreamStatus), async (t) => {
    const app = await fixture(t, (resource, req, res) => {
      if (resource === "quota") return res.end(JSON.stringify(ALLOWANCE));
      res.writeHead(upstreamStatus);
      res.end(`${PRIVATE_BODY} ${PAT}`);
    });
    const account = app.account();
    await verifyFailure(app, account, { code: "quota_upstream_http", upstreamStatus });
  });
});

test("quota response parsing failures retain distinct safe diagnostics", async (t) => {
  const cases = [
    { name: "non-JSON", code: "quota_invalid_json", quota: ALLOWANCE, volume: `${PRIVATE_BODY} ${PAT}` },
    { name: "missing allowance", code: "quota_invalid_response", quota: {}, volume: USAGE },
    { name: "missing usage", code: "quota_invalid_response", quota: ALLOWANCE, volume: {} },
    { name: "invalid frozen usage", code: "quota_invalid_response", quota: ALLOWANCE, volume: { ...USAGE, freeze_credit_in_milli: null } },
  ];
  for (const item of cases) await t.test(item.name, async (t) => {
    const app = await fixture(t, (resource, req, res) => {
      const value = resource === "quota" ? item.quota : item.volume;
      res.end(typeof value === "string" ? value : JSON.stringify(value));
    });
    const body = await verifyFailure(app, app.account(), { code: item.code });
    assert.ok(!body.error.message.includes("HTTP 502"), "a local parse error must not claim CNB returned HTTP 502");
  });
});

test("quota header and body timeouts return 504 and persist their safe diagnostic", async (t) => {
  for (const bodyStarted of [false, true]) await t.test(bodyStarted ? "body" : "headers", async (t) => {
    const app = await fixture(t, (resource, req, res) => {
      if (resource === "quota") return res.end(JSON.stringify(ALLOWANCE));
      if (bodyStarted) {
        res.writeHead(200);
        res.flushHeaders();
        res.write("{");
      }
    }, { timeoutMs: 250 });
    await verifyFailure(app, app.account(), { status: 504, code: "quota_timeout" });
  });
});

test("a quota connection failure is distinct from an upstream HTTP error", async (t) => {
  const app = await fixture(t, (resource, req, res) => res.end("{}"));
  await close(app.cnb);
  await verifyFailure(app, app.account(), { code: "quota_network" });
});

test("unknown quota failures stay sanitized and normalized invalid data stays classified", async (t) => {
  const app = await fixture(t, (resource, req, res) => res.end("{}"));
  const account = app.account();
  app.pool.fetchQuotaImpl = async () => { throw new Error(`${PRIVATE_BODY} ${PAT}`); };
  await verifyFailure(app, account, { code: "quota_sync_failed" });
  app.pool.fetchQuotaImpl = async () => ({ org: "other", credits: { total: 100, used: 0, freeze: 0 } });
  await verifyFailure(app, account, { code: "quota_invalid_response" });
});
