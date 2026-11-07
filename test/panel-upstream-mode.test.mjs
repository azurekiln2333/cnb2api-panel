import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPanelServer } from "../src/app.mjs";
import {
  Store,
  UPSTREAM_MODES,
  normalizeUpstreamMode,
} from "../src/store.mjs";

const ADMIN = "synthetic-panel-admin";
const GATEWAY = "synthetic-gateway-key";
const PROXY = "synthetic-workspace-key";
const MODE_HEADER = "x-cnb2api-upstream-mode";
const APPLIED_HEADER = "x-cnb2api-upstream-mode-applied";

function storeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "panel-upstream-mode-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new Store(join(root, "data"), { allowLocal: true });
}

test("upstream mode validates, defaults to inherit and survives reload", (t) => {
  const store = storeFixture(t);
  assert.deepEqual(UPSTREAM_MODES, ["inherit", "auto", "ide", "classic"]);
  assert.equal(normalizeUpstreamMode(undefined), "inherit");
  assert.equal(normalizeUpstreamMode(null), "inherit");
  assert.equal(normalizeUpstreamMode(""), "inherit");
  assert.equal(normalizeUpstreamMode(" AUTO "), "auto");
  assert.equal(normalizeUpstreamMode("turbo", { lenient: true }), "inherit");
  assert.throws(() => normalizeUpstreamMode("turbo"), /上游模式/);

  const plain = store.create({ name: "默认账号", proxyKey: PROXY });
  assert.equal(plain.upstreamMode, "inherit");
  const ide = store.create({
    name: "IDE 账号",
    proxyKey: PROXY,
    upstreamMode: " IDE ",
  });
  assert.equal(ide.upstreamMode, "ide");
  assert.equal(store.update(ide.id, { upstreamMode: "classic" }).upstreamMode, "classic");
  // Omitting the field keeps the saved value, like the other account fields.
  assert.equal(store.update(ide.id, { name: "IDE 账号 2" }).upstreamMode, "classic");
  assert.throws(
    () => store.create({ name: "坏账号", proxyKey: PROXY, upstreamMode: "fastest" }),
    /上游模式/,
  );

  // Data written before the field existed must load as "inherit".
  const saved = JSON.parse(readFileSync(store.accountsFile, "utf8"));
  for (const account of saved.accounts) delete account.upstreamMode;
  writeFileSync(store.accountsFile, JSON.stringify(saved));
  const reloaded = new Store(store.directory, { allowLocal: true });
  assert.equal(reloaded.get(plain.id).upstreamMode, "inherit");
  assert.equal(reloaded.get(ide.id).upstreamMode, "inherit");

  // An unknown stored value must not reject the whole document.
  saved.accounts[0].upstreamMode = "turbo";
  writeFileSync(store.accountsFile, JSON.stringify(saved));
  assert.equal(
    new Store(store.directory, { allowLocal: true }).get(plain.id).upstreamMode,
    "inherit",
  );
});

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "panel-upstream-mode-http-"));
  const directory = join(root, "data");
  // The mock worker reports back whatever the current test set here.
  const upstream = { applied: null, status: 200 };
  const calls = [];
  const worker = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    calls.push({ url: req.url, headers: req.headers });
    if (req.url === "/v1/models") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ object: "list", data: [{ id: "test-model" }] }));
      return;
    }
    if (req.url === "/usage") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ prompt: 0, completion: 0, requests: 0, errors: 0 }),
      );
      return;
    }
    const headers = { "Content-Type": "application/json" };
    if (upstream.applied) headers[APPLIED_HEADER] = upstream.applied;
    res.writeHead(upstream.status, headers);
    res.end(
      JSON.stringify({
        id: "chatcmpl-synthetic",
        object: "chat.completion",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
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
  const call = (path) =>
    fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  const account = async (overrides = {}) => {
    const created = app.store.create({
      name: `账号-${calls.length}`,
      endpoint,
      proxyKey: PROXY,
      ...overrides,
    });
    await app.pool.probe(created.id);
    return created.id;
  };
  const send = (headers = {}) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GATEWAY}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  t.after(async () => {
    app.pool.stop();
    for (const server of [app.server, worker]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { ...app, base, directory, upstream, calls, call, account, send };
}

test("the mode header is sent only for inference on a non-inherit account", async (t) => {
  const app = await fixture(t);
  const id = await app.account({ upstreamMode: "ide" });
  const probeCall = app.calls.find((entry) => entry.url === "/v1/models");
  assert.ok(probeCall, "the readiness probe must have run");
  assert.equal(probeCall.headers[MODE_HEADER], undefined);

  await app.pool.workerUsage.refresh(id);
  const usageCall = app.calls.find((entry) => entry.url === "/usage");
  assert.ok(usageCall, "the /usage read must have run");
  assert.equal(usageCall.headers[MODE_HEADER], undefined);

  app.upstream.applied = "ide";
  app.calls.length = 0;
  const response = await app.send();
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].headers[MODE_HEADER], "ide");
  // The worker's answer is runtime state, never a response header for clients.
  assert.equal(response.headers.get(APPLIED_HEADER), null);
  const account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamMode, "ide");
  assert.equal(account.upstreamModeApplied, "ide");
  assert.equal(typeof account.upstreamModeAppliedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(account.upstreamModeAppliedAt)));
  // Runtime facts survive a restart, unlike the request itself.
  const reloaded = new Store(app.directory, { allowLocal: true });
  assert.equal(reloaded.get(id).upstreamModeApplied, "ide");
});

test("inherit sends nothing and still records what the worker reports", async (t) => {
  const app = await fixture(t);
  const id = await app.account();
  app.upstream.applied = "classic";
  app.calls.length = 0;
  // A client-supplied header must never be forwarded on behalf of the account.
  const response = await app.send({ [MODE_HEADER]: "ide" });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].headers[MODE_HEADER], undefined);
  const account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamModeApplied, "classic");
});

test("a sent header with no applied header reads as a legacy worker", async (t) => {
  const app = await fixture(t);
  const id = await app.account({ upstreamMode: "auto" });
  app.upstream.applied = null;
  app.calls.length = 0;
  const response = await app.send();
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(app.calls[0].headers[MODE_HEADER], "auto");
  let account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamModeApplied, "legacy");

  // A modern worker on the same account overwrites the legacy measurement.
  app.upstream.applied = "classic";
  await (await app.send()).text();
  account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamModeApplied, "classic");

  // Inherit with no applied header is simply unmeasured. Disable the first
  // account so the request has exactly one eligible target.
  app.store.patch(id, { enabled: false });
  const unmeasured = await app.account();
  app.upstream.applied = null;
  await (await app.send()).text();
  account = (await (await app.call(`/api/accounts/${unmeasured}`)).json()).account;
  assert.equal(account.upstreamModeApplied, null);
  assert.equal(account.upstreamModeAppliedAt, null);
});

test("a non-2xx without an applied header leaves the measurement unchanged", async (t) => {
  const app = await fixture(t);
  const id = await app.account({ upstreamMode: "ide" });
  app.upstream.applied = "ide";
  await (await app.send()).text();
  let account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamModeApplied, "ide");
  const measuredAt = account.upstreamModeAppliedAt;

  // A 502 from an edge gateway in front of a sleeping workspace proves nothing
  // about the worker version, so the previous measurement must survive.
  app.upstream.status = 502;
  app.upstream.applied = null;
  app.calls.length = 0;
  const failed = await app.send();
  assert.equal(failed.status, 503);
  await failed.text();
  assert.equal(app.calls[0].headers[MODE_HEADER], "ide");
  account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamModeApplied, "ide");
  assert.equal(account.upstreamModeAppliedAt, measuredAt);
  assert.equal(account.upstreamMode, "ide");
});

test("an upstream error that still reports an applied mode is recorded", async (t) => {
  const app = await fixture(t);
  const id = await app.account({ upstreamMode: "auto" });
  app.upstream.status = 502;
  app.upstream.applied = "classic";
  app.calls.length = 0;
  const failed = await app.send();
  assert.equal(failed.status, 503);
  await failed.text();
  assert.equal(app.calls[0].headers[MODE_HEADER], "auto");
  const account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamModeApplied, "classic");
});

test("count_tokens neither sends the mode header nor flips the measurement", async (t) => {
  const app = await fixture(t);
  const id = await app.account({ upstreamMode: "ide" });
  app.upstream.applied = "ide";
  await (await app.send()).text();
  let account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamModeApplied, "ide");
  const measuredAt = account.upstreamModeAppliedAt;

  // The worker answers count_tokens locally and never reports an applied mode,
  // so a 2xx there must not read as a legacy worker.
  app.upstream.applied = null;
  app.calls.length = 0;
  const counted = await fetch(`${app.base}/v1/messages/count_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GATEWAY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(counted.status, 200);
  await counted.text();
  assert.equal(app.calls.length, 1);
  assert.equal(app.calls[0].url, "/v1/messages/count_tokens");
  assert.equal(app.calls[0].headers[MODE_HEADER], undefined);
  account = (await (await app.call(`/api/accounts/${id}`)).json()).account;
  assert.equal(account.upstreamModeApplied, "ide");
  assert.equal(account.upstreamModeAppliedAt, measuredAt);
});

test("changing the connection clears the previous worker's measurement", async (t) => {
  const app = await fixture(t);
  const id = await app.account({ upstreamMode: "ide" });
  app.upstream.applied = "ide";
  await (await app.send()).text();
  assert.equal(app.store.get(id).upstreamModeApplied, "ide");

  app.store.update(id, { ...app.store.get(id), proxyKey: "synthetic-rotated-key" });
  const account = app.store.get(id);
  assert.equal(account.upstreamModeApplied, null);
  assert.equal(account.upstreamModeAppliedAt, null);
});
