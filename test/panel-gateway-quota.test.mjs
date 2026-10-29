import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const ADMIN = "quota-test-admin-secret";
const GATEWAY = "quota-test-gateway-secret";
const PROXY = "quota-test-proxy-secret";
const PAT = "quota-test-pat-secret";
const REGISTRATION = "quota-test-registration-secret";
const NOW = "2026-10-29T09:00:00.000Z";
const PATHS = [
  "/v1/quota", "/v1/dashboard/billing/subscription", "/dashboard/billing/subscription",
  "/v1/dashboard/billing/usage", "/dashboard/billing/usage",
];
const snapshot = (org, total = 100, used = 20, freeze = 3, syncedAt = NOW) => ({
  org, credits: { total, used, freeze }, syncedAt,
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "panel-gateway-quota-"));
  const app = createPanelServer({
    adminKey: ADMIN, gatewayKey: GATEWAY,
    dataDir: join(root, "data"), logDir: join(root, "logs"), allowLocal: true,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = "";
  const call = (path, { method = "GET", key = GATEWAY, apiKey = false, session = false, data } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      ...(key ? apiKey ? { "x-api-key": key } : { Authorization: `Bearer ${key}` } : {}),
      ...(session && cookie ? { Cookie: cookie } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const account = (org, quota = null, fields = {}) => {
    const created = app.store.create({
      name: `private-${org || "no-repo"}-account`,
      repo: org ? `${org}/repo-${app.store.state.accounts.length}` : "",
      proxyKey: PROXY, pat: PAT, ...fields,
    });
    app.store.patch(created.id, { quota });
    return app.store.get(created.id);
  };
  const read = async (path) => {
    const response = await call(path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const login = async () => {
    const response = await call("/api/session", { method: "POST", key: null, data: { key: ADMIN } });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
  };
  t.after(async () => {
    app.pool.stop();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { ...app, call, read, account, login };
}

test("quota and both billing prefixes use gateway authentication, methods and CORS", async (t) => {
  const app = await fixture(t);
  app.account("private-org", snapshot("private-org"));
  await app.login();
  for (const path of PATHS) {
    for (const key of [null, ADMIN, PROXY, "wrong-key"]) {
      const response = await app.call(path, { key, session: true });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.type, "authentication_error");
    }
    assert.equal((await app.call(path)).status, 200);
    assert.equal((await app.call(path, { apiKey: true })).status, 200);
    const preflight = await app.call(path, { method: "OPTIONS", key: null });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.match(preflight.headers.get("access-control-allow-methods"), /GET/);
    assert.equal((await app.call(path, { method: "POST", data: {} })).status, 405);
  }
});

test("native quota deduplicates enabled organizations and selects the newest valid sibling snapshot", async (t) => {
  const app = await fixture(t);
  app.account("alpha-private", snapshot("alpha-private", 100, 20, 3));
  app.account("alpha-private", snapshot("alpha-private", 110, 21, 4, "2026-10-29T10:00:00.000Z"));
  app.account("alpha-private", snapshot("alpha-private", 120, 30, 5, "2026-10-29T12:00:00.000Z"), { enabled: false });
  app.account("alpha-private", snapshot("alpha-private", -1, 0, 0, "2026-10-29T13:00:00.000Z"));
  app.account("alpha-private", snapshot("unrelated-private", 1000, 0, 0, "2026-10-29T14:00:00.000Z"));
  app.account("beta-private", snapshot("beta-private", 50, 20, 2));
  app.account("disabled-only-private", snapshot("disabled-only-private", 1000, 0, 0), { enabled: false });
  app.account("unrelated-private", snapshot("alpha-private", 9999, 0, 0, "2026-10-29T15:00:00.000Z"), { enabled: false });
  assert.deepEqual(await app.read("/v1/quota"), {
    object: "quota", unit: "cnb_credits", total: 170, used: 50, frozen: 7,
    remaining: 113, organizations: 2, syncedAt: NOW,
  });
});

test("New API's actual subtraction preserves per-organization frozen and overdrawn balances", async (t) => {
  const app = await fixture(t);
  app.account("overdrawn-private", snapshot("overdrawn-private", 100, 150, 4));
  app.account("available-private", snapshot("available-private", 100, 10, 20));
  const quota = await app.read("/v1/quota");
  assert.equal(quota.remaining, 70);
  assert.equal(quota.used, 160);
  assert.equal(quota.frozen, 24);
  for (const prefix of ["/v1", ""]) {
    const subscription = await app.read(`${prefix}/dashboard/billing/subscription`);
    const usage = await app.read(`${prefix}/dashboard/billing/usage?start_date=1900-01-01&end_date=1900-01-31`);
    assert.equal(subscription.object, "billing_subscription");
    assert.equal(subscription.hard_limit_usd, 200);
    assert.equal(usage.total_usage, 13000);
    // controller/channel-billing.go:689 in the adjacent New API source.
    assert.equal(subscription.hard_limit_usd - usage.total_usage / 100, quota.remaining);
    assert.equal(subscription.unit, "cnb_credits");
    assert.equal(usage.unit, "cnb_credits");
    assert.equal(subscription.period, "current");
    assert.equal(usage.period, "current");
    assert.deepEqual(usage, await app.read(`${prefix}/dashboard/billing/usage`));
  }
});

test("missing complete quota coverage returns a safe error instead of partial or invented zero", async (t) => {
  const cases = [
    ["empty", () => {}],
    ["missing", (app) => app.account("missing-private")],
    ["partial", (app) => { app.account("known-private", snapshot("known-private")); app.account("missing-private"); }],
    ["disabled-only", (app) => app.account("disabled-private", snapshot("disabled-private"), { enabled: false })],
    ["repository-free", (app) => app.account("")],
    ["partially unidentified", (app) => { app.account("known-private", snapshot("known-private")); app.account(""); }],
  ];
  for (const [name, setup] of cases) await t.test(name, async (t) => {
    const app = await fixture(t);
    setup(app);
    for (const path of PATHS) {
      const response = await app.call(path);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: {
        message: "quota data temporarily unavailable", type: "service_unavailable_error", code: "quota_unavailable",
      } });
    }
  });
});

test("invalid snapshots cannot become a successful or fresh quota response", async (t) => {
  const org = "invalid-private";
  const cases = [
    ["missing credits", { org, syncedAt: NOW }],
    ["negative total", snapshot(org, -1)],
    ["negative used", snapshot(org, 100, -1)],
    ["negative frozen", snapshot(org, 100, 1, -1)],
    ["infinite total", snapshot(org, Infinity)],
    ["NaN used", snapshot(org, 100, NaN)],
    ["string frozen", snapshot(org, 100, 1, "2")],
    ["invalid time", snapshot(org, 100, 1, 2, "not-a-date")],
    ["missing time", { org, credits: { total: 100, used: 1, freeze: 2 } }],
    ["wrong organization", snapshot("different-private")],
  ];
  for (const [name, quota] of cases) await t.test(name, async (t) => {
    const app = await fixture(t);
    app.account(org, quota);
    const response = await app.call("/v1/quota");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "quota_unavailable");
  });
});

test("valid exhausted quota is a real zero balance and does not depend on workspace health", async (t) => {
  const app = await fixture(t);
  const account = app.account("exhausted-private", snapshot("exhausted-private", 0, 2, 3));
  app.store.patch(account.id, { status: "unhealthy", cooldownUntil: new Date(Date.now() + 60000).toISOString() });
  const quota = await app.read("/v1/quota");
  assert.equal(quota.remaining, 0);
  assert.equal(quota.total, 0);
  assert.equal(quota.organizations, 1);
  const subscription = await app.read("/v1/dashboard/billing/subscription");
  const usage = await app.read("/v1/dashboard/billing/usage");
  assert.equal(subscription.hard_limit_usd - usage.total_usage / 100, 0);
});

test("public quota responses reveal no credentials or account identities and only read cached state", async (t) => {
  const app = await fixture(t);
  const account = app.account("secret-organization", snapshot("secret-organization"), { registrationToken: REGISTRATION });
  app.pool.fetchQuotaImpl = () => assert.fail("Public quota reads must not refresh upstream state");
  const before = JSON.stringify(app.store.state);
  for (const path of PATHS) {
    const body = JSON.stringify(await app.read(path));
    for (const sensitive of [ADMIN, GATEWAY, PROXY, PAT, REGISTRATION, account.id, account.name, "secret-organization"])
      assert.ok(!body.includes(sensitive));
  }
  assert.equal(JSON.stringify(app.store.state), before);
});
