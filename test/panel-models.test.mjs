import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const ADMIN = "models-test-admin-secret";
const GATEWAY = "models-test-gateway-secret";
const PROXY = "models-test-proxy-secret";
const PAT = "models-test-pat-secret";
const REGISTRATION = "models-test-registration-secret";

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "panel-models-"));
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: GATEWAY,
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    allowLocal: true,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = "";
  const call = (path, { method = "GET", data, authenticated = true, authorization } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const login = async () => {
    const response = await call("/api/session", { method: "POST", data: { key: ADMIN } });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
  };
  const account = ({ discoveredModels = [], status = "healthy", cooldownUntil = null, ...fields } = {}) => {
    const created = app.store.create({
      name: "model-workspace",
      proxyKey: PROXY,
      endpoint: "http://127.0.0.1:19001",
      ...fields,
    });
    app.store.patch(created.id, { discoveredModels, status, cooldownUntil });
    return app.store.get(created.id);
  };
  const inventory = async () => {
    const response = await call("/api/models");
    assert.equal(response.status, 200);
    return (await response.json()).models;
  };
  t.after(async () => {
    app.pool.stop();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  return { ...app, call, login, account, inventory };
}

const reference = (account) => ({ id: account.id, name: account.name });

test("model inventory requires a management session and handles an empty catalog", async (t) => {
  const app = await fixture(t);
  for (const authorization of [undefined, GATEWAY, ADMIN]) {
    const response = await app.call("/api/models", { authorization });
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes(PROXY));
  }
  await app.login();
  assert.deepEqual(await app.inventory(), []);
  // A wildcard route does not invent catalog entries for arbitrary model names.
  app.account({ name: "wildcard" });
  assert.deepEqual(await app.inventory(), []);
  const listed = await app.call("/v1/models", { authorization: GATEWAY });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data, []);
});

test("model inventory preserves both sources and exactly matches public advertisement rules", async (t) => {
  const app = await fixture(t);
  await app.login();
  const scoped = app.account({
    name: "configured",
    models: ["z-model", "shared", "shared"],
    discoveredModels: ["hidden-discovery", "shared", "shared"],
  });
  const discovered = app.account({
    name: "discovered",
    discoveredModels: ["a-model", "shared"],
  });
  const disabled = app.account({
    name: "disabled",
    enabled: false,
    models: ["disabled-config"],
    discoveredModels: ["disabled-discovery", "shared"],
  });
  app.account({ name: "offline", models: ["offline-listed"], status: "unhealthy" });
  app.account({ name: "cooling", models: ["cooling-listed"], cooldownUntil: new Date(Date.now() + 60000).toISOString() });
  const models = await app.inventory();
  assert.deepEqual(models.map((model) => model.id), [
    "a-model", "cooling-listed", "disabled-config", "disabled-discovery",
    "hidden-discovery", "offline-listed", "shared", "z-model",
  ]);
  const shared = models.find((model) => model.id === "shared");
  assert.deepEqual(shared.configuredAccounts, [reference(scoped)]);
  assert.deepEqual(shared.discoveredAccounts, [scoped, discovered, disabled].map(reference));
  assert.deepEqual(shared.eligibleAccounts, [scoped, discovered].map(reference));
  assert.equal(models.find((model) => model.id === "hidden-discovery").listed, false);
  assert.equal(models.find((model) => model.id === "disabled-config").listed, false);
  assert.equal(models.find((model) => model.id === "disabled-discovery").listed, false);
  assert.equal(models.find((model) => model.id === "offline-listed").listed, true);
  assert.equal(models.find((model) => model.id === "cooling-listed").listed, true);
  const listed = await app.call("/v1/models", { authorization: GATEWAY });
  assert.equal(listed.status, 200);
  assert.deepEqual(
    models.filter((model) => model.listed).map((model) => model.id),
    (await listed.json()).data.map((model) => model.id).sort(),
  );
});

test("model eligibility reflects allowlists, wildcard routes and live account readiness", async (t) => {
  const app = await fixture(t);
  await app.login();
  const scoped = app.account({ name: "scoped", models: ["model-a"], discoveredModels: ["model-b"] });
  const wildcard = app.account({ name: "wildcard", discoveredModels: ["model-c"] });
  const offline = app.account({ name: "offline", models: ["model-a"], status: "unhealthy" });
  const cooling = app.account({ name: "cooling", models: ["model-a"], cooldownUntil: new Date(Date.now() + 60000).toISOString() });
  const disabled = app.account({ name: "disabled", models: ["model-a"], enabled: false });
  const noEndpoint = app.account({ name: "no-endpoint", models: ["model-a"], endpoint: "" });
  const models = await app.inventory();
  assert.deepEqual(models.find((model) => model.id === "model-a").eligibleAccounts, [scoped, wildcard].map(reference));
  assert.deepEqual(models.find((model) => model.id === "model-b").eligibleAccounts, [reference(wildcard)]);
  assert.deepEqual(models.find((model) => model.id === "model-c").eligibleAccounts, [reference(wildcard)]);
  assert.equal(models.find((model) => model.id === "model-b").listed, false);
  // Changes take effect on the next read, without an inference or probe request.
  app.store.patch(offline.id, { status: "healthy" });
  app.store.patch(cooling.id, { cooldownUntil: new Date(Date.now() - 1000).toISOString() });
  app.store.update(disabled.id, { enabled: true });
  app.store.update(noEndpoint.id, { endpoint: "http://127.0.0.1:19002" });
  app.store.patch(noEndpoint.id, { status: "healthy" });
  const recovered = await app.inventory();
  assert.deepEqual(
    recovered.find((model) => model.id === "model-a").eligibleAccounts,
    [scoped, wildcard, offline, cooling, disabled, noEndpoint].map(reference),
  );
  app.store.patch(wildcard.id, { status: "unhealthy" });
  assert.deepEqual((await app.inventory()).find((model) => model.id === "model-b").eligibleAccounts, []);
});

test("model inventory exposes only account references and leaves saved state unchanged", async (t) => {
  const app = await fixture(t);
  await app.login();
  const account = app.account({
    name: "private-workspace",
    models: ["private-model"],
    proxyKey: PROXY,
    registrationToken: REGISTRATION,
    pat: PAT,
  });
  const before = JSON.stringify(app.store.state);
  const models = await app.inventory();
  assert.deepEqual(models, [{
    id: "private-model",
    listed: true,
    configuredAccounts: [reference(account)],
    discoveredAccounts: [],
    eligibleAccounts: [reference(account)],
  }]);
  const serialized = JSON.stringify(models);
  for (const secret of [ADMIN, GATEWAY, PROXY, REGISTRATION, PAT]) assert.ok(!serialized.includes(secret));
  assert.equal(JSON.stringify(app.store.state), before);
});
