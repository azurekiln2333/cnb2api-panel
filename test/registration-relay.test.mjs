import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import {
  RegistrationRelay,
  RELAY_HEADERS,
  loadRegistrationRelay,
  parseRelayHeaders,
  validateRegistrationRelay,
} from "../src/registration-relay.mjs";

const TOKEN = "core-registration-private-token";
const PROXY = "core-workspace-private-key";
const URI = "http://127.0.0.1:19001";
const NEXT_URI = "http://127.0.0.1:19002";
const INITIAL_NOW = Date.parse("2026-10-29T08:00:00Z");
const peer = (index = 1, extra = {}) => ({
  id: `peer-${index}`, name: `Peer ${index}`, origin: `https://panel-${index}.example.com`, enabled: true, ...extra,
});
const envelope = (sourceId = randomUUID(), revision = "1") => ({
  [RELAY_HEADERS.version]: "1", [RELAY_HEADERS.source]: sourceId, [RELAY_HEADERS.revision]: revision,
});
const acknowledgement = (init, extra = {}) => new Response(JSON.stringify({
  ok: true, accountId: randomUUID(),
  relay: { version: 1, sourceId: init.headers[RELAY_HEADERS.source], revision: Number(init.headers[RELAY_HEADERS.revision]) },
  ...extra,
}), { headers: { "Content-Type": "application/json" } });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "registration-relay-core-"));
  const directory = join(root, "data");
  const store = new Store(directory, { allowLocal: true });
  let now = INITIAL_NOW;
  const relay = new RegistrationRelay(store, {
    now: () => now, fetchImpl: async (_url, init) => acknowledgement(init), ...options,
  });
  // Each test explicitly advances one dispatch batch, without incidental background work.
  relay.kick = () => {};
  t.after(async () => {
    relay.stop();
    await Promise.allSettled([...relay.active.values()].map((work) => work.promise));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    store, relay, root, directory,
    account: (extra = {}) => store.create({ name: "Workspace", proxyKey: PROXY, registrationToken: TOKEN, ...extra }),
    configure: (servers = [peer()], enabled = true) => store.settings({ registrationRelay: { enabled, servers } }),
    advance: (milliseconds) => { now += milliseconds; },
    job: (account, server = peer()) => store.state.registrationRelay.deliveries[`${account.id}/${server.id}`],
  };
}

test("relay settings canonicalize normal panel origins and enforce bounded peers", () => {
  assert.deepEqual(validateRegistrationRelay(), { enabled: false, servers: [] });
  const result = validateRegistrationRelay({ enabled: true, servers: [peer(1, { id: "", name: " Peer ", origin: "HTTPS://Panel.Example.COM:443/" }), peer(2, { origin: "https://other.example.com:8443/" })] });
  assert.match(result.servers[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(result.servers[0].name, "Peer");
  assert.equal(result.servers[0].origin, "https://panel.example.com");
  assert.equal(result.servers[1].origin, "https://other.example.com:8443");
  for (const origin of ["http://panel.example.com", "https://user:secret@panel.example.com", "https://panel.example.com/ops/register", "https://panel.example.com/?q=1", "https://panel.example.com/#fragment", "not-a-url"]) {
    assert.throws(() => validateRegistrationRelay({ enabled: true, servers: [peer(1, { origin })] }), { status: 400 });
  }
  for (const servers of [
    [peer(), peer(2, { origin: "HTTPS://PANEL-1.EXAMPLE.COM:443/" })],
    [peer(), peer(2, { id: "peer-1" })],
    [peer(1, { id: "unsafe/id" })], [peer(1, { name: "x".repeat(81) })],
    [peer(1, { name: "unsafe\nname" })], [peer(1, { enabled: "true" })],
    Array.from({ length: 21 }, (_, index) => peer(index)),
  ]) assert.throws(() => validateRegistrationRelay({ enabled: true, servers }), { status: 400 });
  assert.throws(() => validateRegistrationRelay({ enabled: true, servers: [peer()] }, { publicUrl: "https://panel-1.example.com/console" }), /本机/);
  for (const origin of ["http://127.0.0.1:9000", "http://localhost:9000", "http://[::1]:9000"]) {
    assert.throws(() => validateRegistrationRelay({ enabled: true, servers: [peer(1, { origin })] }));
    assert.equal(validateRegistrationRelay({ enabled: true, servers: [peer(1, { origin })] }, { allowLocal: true }).servers[0].origin, origin);
  }
  assert.throws(() => validateRegistrationRelay({ enabled: true, servers: [peer(1, { origin: "http://10.0.0.1:9000" })] }, { allowLocal: true }));
});

test("relay headers accept a complete safe envelope and reject partial or malformed metadata", () => {
  assert.equal(parseRelayHeaders({}), null);
  assert.equal(parseRelayHeaders(new Headers()), null);
  const source = randomUUID();
  assert.deepEqual(parseRelayHeaders(new Headers(envelope(source.toUpperCase(), "9007199254740991"))), { sourceId: source, revision: Number.MAX_SAFE_INTEGER });
  for (const headers of [
    { [RELAY_HEADERS.version]: "1" }, { [RELAY_HEADERS.source]: source },
    envelope(source, "0"), envelope(source, "01"), envelope(source, "-1"),
    envelope(source, "9007199254740992"), envelope("invalid-source"),
    { ...envelope(source), [RELAY_HEADERS.version]: "2" },
    { ...envelope(source), [RELAY_HEADERS.revision]: ["1", "2"] },
  ]) assert.throws(() => parseRelayHeaders(headers), { status: 400 });
});

test("relay runtime upgrades old statistics once and preserves source identity and encrypted credentials", (t) => {
  const f = fixture(t);
  const account = f.account();
  const oldStats = JSON.parse(readFileSync(f.store.statsFile, "utf8"));
  delete oldStats.registrationRelay;
  writeFileSync(f.store.statsFile, JSON.stringify(oldStats));
  const restored = new Store(f.directory, { allowLocal: true });
  const source = restored.state.registrationRelay.sourceId;
  assert.equal(JSON.parse(readFileSync(f.store.statsFile, "utf8")).registrationRelay.sourceId, source);
  assert.equal(new Store(f.directory, { allowLocal: true }).state.registrationRelay.sourceId, source);
  assert.equal(restored.get(account.id).secrets.registrationToken, TOKEN);
  const disk = [restored.file, restored.accountsFile, restored.statsFile].map((file) => readFileSync(file, "utf8")).join("");
  assert.equal(disk.includes(TOKEN), false);
  assert.equal(disk.includes(PROXY), false);
  const broken = structuredClone(restored.state.registrationRelay);
  broken.deliveries.invalid = {};
  assert.throws(() => loadRegistrationRelay(broken), { status: 500 });
});

test("original registration atomically persists its current endpoint and outbox for disabled accounts too", (t) => {
  const f = fixture(t);
  const account = f.account({ enabled: false });
  f.configure([peer(), peer(2, { enabled: false })]);
  assert.deepEqual(f.relay.register(account.id, URI), { applied: true, result: { ok: true, accountId: account.id } });
  const restored = new Store(f.directory, { allowLocal: true });
  assert.equal(restored.get(account.id).endpoint, URI);
  assert.equal(Object.keys(restored.state.registrationRelay.deliveries).length, 1);
  assert.equal(f.job(account).endpoint, URI);
  assert.equal(JSON.stringify(f.relay.status()).includes(TOKEN), false);
  const snapshots = structuredClone(f.store.snapshots);
  let writes = 0;
  const write = f.store.storage.write.bind(f.store.storage);
  f.store.storage.write = (operations) => { writes++; return write(operations); };
  f.relay.reconcile();
  assert.equal(writes, 0);
  assert.deepEqual(f.store.snapshots, snapshots);
});

test("self-origin relay requests cannot replace local registration or remove other peer deliveries", (t) => {
  const f = fixture(t);
  const account = f.account();
  f.configure([peer(), peer(2)]);
  f.relay.register(account.id, URI);
  const before = structuredClone(f.store.state);
  assert.throws(() => f.relay.register(account.id, NEXT_URI, { sourceId: f.store.state.registrationRelay.sourceId.toUpperCase(), revision: 100 }), { status: 400 });
  assert.deepEqual(f.store.state, before);
});

test("an in-flight stale completion cannot acknowledge or overlap the newer URI for its peer", async (t) => {
  const calls = [];
  const f = fixture(t, { fetchImpl: async (url, init) => {
    const pending = deferred();
    calls.push({ url, init, pending });
    return pending.promise;
  } });
  const account = f.account();
  f.configure();
  f.relay.register(account.id, URI);
  const first = f.relay.run();
  assert.equal(calls.length, 1);
  f.relay.register(account.id, NEXT_URI);
  const currentRevision = f.job(account).revision;
  await f.relay.run();
  assert.equal(calls.length, 1);
  calls[0].pending.resolve(acknowledgement(calls[0].init));
  await first;
  assert.equal(f.job(account).revision, currentRevision);
  assert.equal(f.job(account).status, "pending");
  assert.equal(f.job(account).attempts, 0);
  const second = f.relay.run();
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), { uri: NEXT_URI });
  assert.equal(calls[1].init.headers["X-Reg-Token"], TOKEN);
  assert.equal(calls[1].init.redirect, "error");
  calls[1].pending.resolve(acknowledgement(calls[1].init));
  await second;
  assert.equal(f.job(account).status, "success");
});

test("token rotation, peer origin changes and deleted accounts invalidate obsolete active work", async (t) => {
  const calls = [];
  const f = fixture(t, { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Promise(() => {});
  } });
  const account = f.account();
  f.configure();
  f.relay.register(account.id, URI);
  const old = f.relay.run();
  f.store.update(account.id, { registrationToken: `${TOKEN}-rotated` });
  f.relay.reconcile();
  await old;
  assert.equal(calls[0].init.signal.aborted, true);
  assert.equal(f.job(account).credentialVersion, 1);
  assert.equal(f.job(account).attempts, 0);
  const rotated = f.relay.run();
  assert.equal(calls[1].init.headers["X-Reg-Token"], `${TOKEN}-rotated`);
  f.configure([peer(1, { origin: "https://replacement.example.com" })]);
  f.relay.reconcile();
  await rotated;
  assert.equal(calls[1].init.signal.aborted, true);
  const replaced = f.relay.run();
  assert.equal(calls[2].url, "https://replacement.example.com/ops/register");
  f.store.remove(account.id);
  f.relay.reconcile();
  await replaced;
  assert.equal(calls[2].init.signal.aborted, true);
  assert.deepEqual(f.store.state.registrationRelay.deliveries, {});
  assert.deepEqual(f.store.state.registrationRelay.generations, {});
  assert.equal(JSON.stringify(f.store.state.registrationRelay).includes(TOKEN), false);
});

test("relay dispatch is bounded to four concurrent jobs and serializes each account/peer", async (t) => {
  const calls = [];
  const f = fixture(t, { fetchImpl: async (_url, init) => {
    const pending = deferred();
    calls.push({ init, pending });
    return pending.promise;
  } });
  f.configure([peer(1), peer(2), peer(3)]);
  for (let index = 0; index < 3; index++) {
    const account = f.account({ registrationToken: `${TOKEN}-${index}` });
    f.relay.register(account.id, URI);
  }
  const first = f.relay.run();
  assert.equal(calls.length, 4);
  assert.equal(f.relay.active.size, 4);
  await f.relay.run();
  assert.equal(calls.length, 4);
  for (const call of calls) call.pending.resolve(acknowledgement(call.init));
  await first;
  const second = f.relay.run();
  assert.equal(calls.length, 8);
  for (const call of calls.slice(4)) call.pending.resolve(acknowledgement(call.init));
  await second;
  const final = f.relay.run();
  assert.equal(calls.length, 9);
  calls[8].pending.resolve(acknowledgement(calls[8].init));
  await final;
  assert.equal(f.relay.status().servers.every((server) => server.status === "success"), true);
});

test("backoff survives restart, waits until due and manual synchronization retries immediately", async (t) => {
  let calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; throw new Error(`unsafe-error:${TOKEN}`); } });
  const account = f.account();
  f.configure();
  f.relay.register(account.id, URI);
  await f.relay.run();
  assert.equal(f.job(account).status, "failed");
  assert.equal(f.job(account).nextAttemptAt, INITIAL_NOW + 5000);
  assert.equal(calls, 1);
  const restored = new Store(f.directory, { allowLocal: true });
  assert.equal(restored.state.registrationRelay.deliveries[`${account.id}/peer-1`].nextAttemptAt, INITIAL_NOW + 5000);
  await f.relay.run();
  f.advance(4999);
  await f.relay.run();
  assert.equal(calls, 1);
  f.advance(1);
  await f.relay.run();
  assert.equal(calls, 2);
  assert.equal(f.job(account).nextAttemptAt, INITIAL_NOW + 15000);
  for (let attempt = 0; attempt < 6; attempt++) {
    f.advance(300000);
    await f.relay.run();
  }
  assert.equal(f.job(account).nextAttemptAt, INITIAL_NOW + 5000 + 6 * 300000 + 300000);
  assert.equal(f.relay.sync().scheduled, 1);
  await f.relay.run();
  assert.equal(calls, 9);
  assert.equal(f.job(account).attempts, 1);
  const diagnostics = readFileSync(f.store.logFiles.system, "utf8") + readFileSync(f.store.statsFile, "utf8");
  assert.equal(diagnostics.includes(TOKEN), false);
  assert.equal(diagnostics.includes("unsafe-error"), false);
});

test("disabled peers and the main switch pause work and re-enable with an immediate current delivery", async (t) => {
  let calls = 0;
  const f = fixture(t, { fetchImpl: async () => { calls++; return new Response("untrusted-body", { status: 503 }); } });
  const account = f.account();
  f.configure();
  f.relay.register(account.id, URI);
  await f.relay.run();
  assert.ok(f.job(account).nextAttemptAt > INITIAL_NOW);
  f.configure([peer(1, { enabled: false })]);
  f.relay.reconcile();
  await f.relay.run();
  assert.equal(calls, 1);
  assert.equal(f.relay.status().servers[0].status, "disabled");
  assert.equal(new Store(f.directory, { allowLocal: true }).state.registrationRelay.deliveries[`${account.id}/peer-1`].paused, true);
  f.configure();
  f.relay.reconcile();
  assert.equal(f.job(account).nextAttemptAt, INITIAL_NOW);
  assert.equal(f.job(account).status, "pending");
  await f.relay.run();
  assert.equal(calls, 2);
  f.configure([peer()], false);
  f.relay.reconcile();
  await f.relay.run();
  assert.equal(calls, 2);
  f.configure();
  f.relay.reconcile();
  await f.relay.run();
  assert.equal(calls, 3);
  f.configure([]);
  f.relay.reconcile();
  assert.deepEqual(f.store.state.registrationRelay.deliveries, {});
});

test("unsafe or unsupported peer acknowledgements produce bounded safe failures", async (t) => {
  const cases = [
    [() => new Response(`private:${TOKEN}`, { status: 403 }), "联动服务器未匹配注册密钥"],
    [() => new Response(`private:${TOKEN}`, { status: 302, headers: { Location: "https://unexpected.example.com" } }), "联动服务器返回失败状态"],
    [() => new Response(`private:${TOKEN}`, { headers: { "Content-Type": "text/html" } }), "联动服务器返回了无效确认"],
    [(_url, init) => acknowledgement(init, { relay: undefined }), "联动服务器版本不支持注册联动"],
    [(_url, init) => acknowledgement(init, { relay: { version: 2 } }), "联动服务器版本不支持注册联动"],
    [(_url, init) => acknowledgement(init, { relay: { version: 1, sourceId: randomUUID(), revision: 1 } }), "联动服务器返回了无效确认"],
    [() => new Response("{".repeat(17000), { headers: { "Content-Type": "application/json" } }), "联动服务器返回了无效确认"],
    [() => new Response("invalid", { headers: { "Content-Type": "application/json" } }), "联动服务器返回了无效确认"],
  ];
  for (const [fetchImpl, message] of cases) {
    const f = fixture(t, { fetchImpl });
    const account = f.account();
    f.configure();
    f.relay.register(account.id, URI);
    await f.relay.run();
    assert.equal(f.job(account).status, "failed");
    assert.equal(f.relay.status().servers[0].lastError, message);
    assert.equal(JSON.stringify(f.relay.status()).includes(TOKEN), false);
  }
});

test("the request deadline bounds an unfinished response body even when cancellation stalls", async (t) => {
  const f = fixture(t, { timeoutMs: 30, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); },
    cancel() { return new Promise(() => {}); },
  }), { headers: { "Content-Type": "application/json" } }) });
  const account = f.account();
  f.configure();
  f.relay.register(account.id, URI);
  const started = Date.now();
  await f.relay.run();
  assert.ok(Date.now() - started < 1000);
  assert.equal(f.relay.active.size, 0);
  assert.equal(f.job(account).lastError, "联动服务器响应超时");
});

test("periodic persistence failures stop the relay instead of escaping the interval", async (t) => {
  const f = fixture(t, { pollMs: 5 });
  f.relay.start();
  f.relay.reconcile = () => { throw new Error("simulated-storage-failure"); };
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(f.relay.stopped, true);
  assert.equal(f.relay.timer, null);
});
