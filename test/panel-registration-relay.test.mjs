import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const ADMIN = "relay-panel-admin-key";
const GATEWAY = "relay-panel-gateway-key";
const TOKEN = "relay-workspace-registration-secret";
const PROXY = "relay-workspace-proxy-secret";
const URI = "http://127.0.0.1:19001";
const NEXT_URI = "http://127.0.0.1:19002";
const SOURCE_HEADER = "x-cnb2api-relay-source";
const REVISION_HEADER = "x-cnb2api-relay-revision";
const RELAY_HEADER = "x-cnb2api-registration-relay";
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const waitFor = async (predicate) => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Registration relay did not reach the expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const relayHeaders = (sourceId, revision) => ({
  [RELAY_HEADER]: "1", [SOURCE_HEADER]: sourceId, [REVISION_HEADER]: String(revision),
});
const acknowledgement = (req) => ({
  ok: true, accountId: randomUUID(),
  relay: { version: 1, sourceId: req.headers[SOURCE_HEADER], revision: Number(req.headers[REVISION_HEADER]) },
});

async function panel(t, { relayOptions = {}, publicUrl = "" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "panel-registration-relay-"));
  const options = {
    adminKey: ADMIN, gatewayKey: GATEWAY, allowLocal: true,
    dataDir: join(root, "data"), logDir: join(root, "logs"), publicUrl,
    poolOptions: { registrationRelayOptions: { timeoutMs: 1000, pollMs: 10, ...relayOptions } },
  };
  const probes = [];
  const instrument = (app) => {
    app.pool.probe = async (id) => { probes.push(id); return app.store.get(id); };
    return app;
  };
  let app = instrument(createPanelServer(options));
  let base = await listen(app.server);
  let cookie = "";
  const call = (path, { method = "GET", data, authenticated = true, headers = {} } = {}) => fetch(`${base}${path}`, {
    method, headers: {
      ...(authenticated && cookie ? { Cookie: cookie } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers,
    }, body: data === undefined ? undefined : JSON.stringify(data),
  });
  const login = async () => {
    const response = await call("/api/session", { method: "POST", data: { key: ADMIN }, authenticated: false });
    assert.equal(response.status, 200);
    cookie = response.headers.get("set-cookie").split(";")[0];
  };
  await login();
  app.pool.registrationRelay.start();
  const result = {
    ...app, root, probes, get base() { return base; }, call,
    account: (extra = {}) => app.store.create({ name: "shared-workspace", proxyKey: PROXY, registrationToken: TOKEN, ...extra }),
    register: (uri = URI, extra = {}) => call(extra.path || "/ops/register", {
      method: "POST", authenticated: false, data: { uri },
      headers: { "X-Reg-Token": extra.token || TOKEN, ...extra.headers },
    }),
    setPeers: async (servers, enabled = true) => {
      const response = await call("/api/settings", { method: "PATCH", data: { registrationRelay: { enabled, servers } } });
      assert.equal(response.status, 200, await response.clone().text());
      return (await response.json()).settings.registrationRelay;
    },
    async restart() {
      app.pool.stop();
      await close(app.server);
      app = instrument(createPanelServer(options));
      base = await listen(app.server);
      Object.assign(result, app);
      await login();
      app.pool.registrationRelay.start();
    },
  };
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    rmSync(root, { recursive: true, force: true });
  });
  return result;
}

async function peer(t, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls.push({ path: req.url, headers: req.headers, payload });
    handler(req, res, payload);
  });
  const origin = await listen(server);
  t.after(() => close(server));
  return { origin, calls };
}
const serverEntry = (origin, extra = {}) => ({ id: randomUUID(), name: "linked-panel", origin, enabled: true, ...extra });

test("registration relay defaults off and management status/sync require a session", async (t) => {
  const app = await panel(t);
  const account = app.account();
  assert.deepEqual(app.store.state.settings.registrationRelay, { enabled: false, servers: [] });
  for (const [path, method] of [["/api/registration-relay", "GET"], ["/api/registration-relay/sync", "POST"]]) {
    const response = await app.call(path, { method, authenticated: false });
    assert.equal(response.status, 401);
  }
  const response = await app.register(URI, { path: `/ops/register/${account.id}` });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, accountId: account.id });
  assert.equal(app.store.get(account.id).endpoint, URI);
  assert.deepEqual(app.probes, [account.id]);
  assert.deepEqual(await (await app.call("/api/registration-relay")).json(), { enabled: false, servers: [] });
});

test("both legacy routes keep health for repeated URIs and probe changed domains", async (t) => {
  const app = await panel(t);
  const account = app.account();
  assert.equal((await app.register()).status, 200);
  const fields = {
    status: "healthy", failures: 0, cooldownUntil: null, failureKind: null,
    lastError: "", discoveredModels: ["fixture-model"],
  };
  app.store.patch(account.id, fields);
  for (const path of ["/ops/register", `/ops/register/${account.id}`]) {
    const response = await app.register(URI, { path });
    assert.deepEqual(await response.json(), { ok: true, accountId: account.id });
    for (const [field, value] of Object.entries(fields)) assert.deepEqual(app.store.get(account.id)[field], value);
  }
  assert.deepEqual(app.probes, [account.id]);
  assert.equal((await app.register(NEXT_URI)).status, 200);
  assert.equal(app.store.get(account.id).endpoint, NEXT_URI);
  assert.equal(app.store.get(account.id).status, "pending");
  assert.deepEqual(app.probes, [account.id, account.id]);
});

test("one registration reaches all enabled panels with different local account IDs", async (t) => {
  const source = await panel(t);
  const first = await panel(t);
  const second = await panel(t);
  const disabled = await panel(t);
  const accounts = [source, first, second, disabled].map((app) => app.account());
  assert.equal(new Set(accounts.map((account) => account.id)).size, 4);
  await source.setPeers([
    serverEntry(first.base, { name: "first" }),
    serverEntry(second.base, { name: "second" }),
    serverEntry(disabled.base, { name: "disabled", enabled: false }),
  ]);
  const response = await source.register(URI, { path: `/ops/register/${accounts[0].id}` });
  assert.equal(response.status, 200);
  await waitFor(() => first.store.get(accounts[1].id).endpoint === URI && second.store.get(accounts[2].id).endpoint === URI);
  await waitFor(() => source.pool.registrationRelay.status().servers.filter((entry) => entry.enabled).every((entry) => entry.status === "success"));
  assert.equal(disabled.store.get(accounts[3].id).endpoint, "");
  assert.equal(first.probes.length, 1);
  assert.equal(second.probes.length, 1);
  const safe = JSON.stringify([
    await (await source.call("/api/registration-relay")).json(),
    await (await source.call("/api/settings")).json(),
    await (await source.call("/api/overview")).json(), source.store.state.logs,
  ]);
  for (const secret of [TOKEN, PROXY, ADMIN, GATEWAY]) assert.ok(!safe.includes(secret));
  const stats = readFileSync(join(source.root, "data", "stats.json"), "utf8");
  assert.ok(!stats.includes(TOKEN));
  assert.ok(!stats.includes(PROXY));
});

test("local acknowledgement and probe do not wait for a stalled linked server", async (t) => {
  let release;
  const remote = await peer(t, (req, res) => {
    release = () => json(res, 200, acknowledgement(req));
  });
  const source = await panel(t, { relayOptions: { timeoutMs: 2000 } });
  const account = source.account();
  await source.setPeers([serverEntry(remote.origin)]);
  let timer;
  let response;
  try {
    response = await Promise.race([
      source.register(),
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Local registration waited for the peer")), 700); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(response.status, 200);
  assert.equal(source.store.get(account.id).endpoint, URI);
  assert.deepEqual(source.probes, [account.id]);
  await waitFor(() => Boolean(release));
  assert.equal(remote.calls[0].path, "/ops/register");
  assert.equal(remote.calls[0].headers["x-reg-token"], TOKEN);
  assert.deepEqual(remote.calls[0].payload, { uri: URI });
  release();
  await waitFor(() => source.pool.registrationRelay.status().servers[0].status === "success");
});

test("invalid registrations and malformed relay headers never mutate or fan out", async (t) => {
  const remote = await peer(t, (req, res) => json(res, 200, acknowledgement(req)));
  const source = await panel(t);
  const account = source.account();
  await source.setPeers([serverEntry(remote.origin)]);
  assert.equal((await source.register(URI, { token: "wrong-token" })).status, 403);
  assert.equal((await source.register("https://not-a-workspace.example")).status, 400);
  assert.equal((await source.register(URI, { headers: { [RELAY_HEADER]: "1" } })).status, 400);
  assert.equal((await source.register(URI, { token: "wrong-token", headers: { [RELAY_HEADER]: "1" } })).status, 403);
  assert.equal(source.store.get(account.id).endpoint, "");
  assert.equal(remote.calls.length, 0);
  assert.equal(source.probes.length, 0);
});

test("cross-linked primary panels apply relayed updates only once without looping", async (t) => {
  const first = await panel(t);
  const second = await panel(t);
  const firstAccount = first.account();
  const secondAccount = second.account();
  await first.setPeers([serverEntry(second.base)]);
  await second.setPeers([serverEntry(first.base)]);
  assert.equal((await first.register()).status, 200);
  await waitFor(() => second.store.get(secondAccount.id).endpoint === URI);
  await waitFor(() => first.pool.registrationRelay.status().servers[0].status === "success");
  first.pool.registrationRelay.reconcile();
  second.pool.registrationRelay.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(first.store.get(firstAccount.id).endpoint, URI);
  assert.deepEqual(first.probes, [firstAccount.id]);
  assert.deepEqual(second.probes, [secondAccount.id]);
  assert.equal(first.store.state.logs.filter((entry) => entry.message === "工作区地址已更新").length, 1);
  assert.equal(second.store.state.logs.filter((entry) => entry.message === "工作区地址已更新").length, 1);
});

test("a peer body stalled after HTTP 200 times out without blocking local registration", async (t) => {
  const remote = await peer(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"ok":true,');
  });
  const source = await panel(t, { relayOptions: { timeoutMs: 60 } });
  const account = source.account();
  await source.setPeers([serverEntry(remote.origin)]);
  const response = await source.register();
  assert.equal(response.status, 200);
  await waitFor(() => source.pool.registrationRelay.status().servers[0].status === "failed");
  const state = source.pool.registrationRelay.status().servers[0];
  assert.match(state.lastError, /超时|timeout/i);
  assert.equal(source.store.get(account.id).endpoint, URI);
  assert.equal(source.store.get(account.id).failures, 0);
  assert.equal(source.store.get(account.id).cooldownUntil, null);
  assert.deepEqual(source.probes, [account.id]);
});

test("management accepts ordinary HTTPS panel origins and rejects self or duplicate targets", async (t) => {
  const app = await panel(t, { publicUrl: "https://primary.example" });
  const settings = await app.setPeers([serverEntry("https://replica.example/")]);
  assert.equal(settings.servers[0].origin, "https://replica.example");
  for (const servers of [
    [serverEntry("https://primary.example")],
    [serverEntry("https://replica.example"), serverEntry("https://replica.example/")],
    [serverEntry("https://user:secret@replica.example")],
  ]) {
    const response = await app.call("/api/settings", { method: "PATCH", data: { registrationRelay: { enabled: true, servers } } });
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes("user:secret"));
  }
  assert.equal(app.store.state.settings.registrationRelay.servers[0].origin, "https://replica.example");
});

test("duplicate and older relayed revisions preserve the latest URI and probe state", async (t) => {
  const receiver = await panel(t);
  const account = receiver.account();
  const sourceId = randomUUID();
  const latest = await receiver.register(NEXT_URI, { headers: relayHeaders(sourceId, 2) });
  assert.equal(latest.status, 200);
  const acknowledgement = await latest.json();
  assert.deepEqual(acknowledgement.relay, { version: 1, sourceId, revision: 2 });
  for (const revision of [1, 2]) {
    const response = await receiver.register(URI, { headers: relayHeaders(sourceId, revision) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).relay.revision, revision);
    assert.equal(receiver.store.get(account.id).endpoint, NEXT_URI);
  }
  assert.deepEqual(receiver.probes, [account.id]);
  await receiver.restart();
  const replay = await receiver.register(URI, { headers: relayHeaders(sourceId, 1) });
  assert.equal(replay.status, 200);
  assert.equal(receiver.store.get(account.id).endpoint, NEXT_URI);
  assert.deepEqual(receiver.probes, [account.id]);
});

test("a missing peer token stays visible and manual sync retries after repair with an audit record", async (t) => {
  const source = await panel(t);
  const receiver = await panel(t);
  source.account();
  const target = receiver.account({ registrationToken: "different-registration-secret" });
  await source.setPeers([serverEntry(receiver.base)]);
  assert.equal((await source.register()).status, 200);
  await waitFor(() => source.pool.registrationRelay.status().servers[0].status === "failed");
  assert.equal(receiver.store.get(target.id).endpoint, "");
  assert.equal(receiver.store.state.accounts.length, 1);
  receiver.store.update(target.id, { registrationToken: TOKEN });
  const synced = await source.call("/api/registration-relay/sync", { method: "POST" });
  assert.equal(synced.status, 200);
  assert.ok((await synced.json()).scheduled >= 1);
  await waitFor(() => source.pool.registrationRelay.status().servers[0].status === "success");
  assert.equal(receiver.store.get(target.id).endpoint, URI);
  const audit = source.store.state.logs.find((entry) => entry.action === "registration.relay.sync");
  assert.equal(audit.status, 200);
  const safe = JSON.stringify([source.pool.registrationRelay.status(), source.store.state.logs]);
  assert.ok(!safe.includes(TOKEN));
  assert.ok(!safe.includes("different-registration-secret"));
});

test("failed delivery resumes from durable state after restart without exposing peer errors", async (t) => {
  let available = false;
  const privateError = "peer-private-response-body";
  const remote = await peer(t, (req, res) => available
    ? json(res, 200, acknowledgement(req))
    : json(res, 503, { error: { message: privateError } }));
  let clock = Date.now();
  const source = await panel(t, { relayOptions: { now: () => clock } });
  const account = source.account();
  await source.setPeers([serverEntry(remote.origin)]);
  assert.equal((await source.register()).status, 200);
  await waitFor(() => source.pool.registrationRelay.status().servers[0].status === "failed");
  assert.ok(!JSON.stringify(source.store.state.logs).includes(privateError));
  available = true;
  clock += 600000;
  await source.restart();
  await waitFor(() => source.pool.registrationRelay.status().servers[0].status === "success");
  assert.equal(source.store.get(account.id).endpoint, URI);
  assert.equal(remote.calls.length, 2);
  assert.equal(remote.calls[1].headers[SOURCE_HEADER], remote.calls[0].headers[SOURCE_HEADER]);
  assert.equal(remote.calls[1].headers[REVISION_HEADER], remote.calls[0].headers[REVISION_HEADER]);
  assert.ok(!readFileSync(join(source.root, "data", "stats.json"), "utf8").includes(privateError));
});
