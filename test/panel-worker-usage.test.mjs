import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { WorkerUsageMonitor } from "../src/worker-usage.mjs";

const KEY = "worker-comparison-private-key";
const local = (input, output, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  total: input + output,
  reportedRequests: 1,
  missingRequests: 0,
  partialRequests: 0,
});
const snapshot = (prompt, completion, cacheHit = 0, boot = "first-boot") => ({
  boot_id: boot,
  booted_at: "2026-10-24T00:00:00.000Z",
  totals: {
    prompt,
    completion,
    requests: 10,
    errors: 0,
    credit: 1.25,
    cache_hit: cacheHit,
    cache_miss: prompt - cacheHit,
  },
});

async function fixture(t, options = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cnb-worker-usage-test-"));
  const directory = join(fixtureRoot, "data");
  const store = new Store(directory, { allowLocal: true });
  let handler = (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(snapshot(1000, 200, 300)));
  };
  const server = http.createServer((req, res) => {
    assert.equal(req.url, "/usage");
    assert.equal(
      req.headers.authorization,
      `Bearer ${store.state.accounts[0]?.secrets.proxyKey || KEY}`,
    );
    handler(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const account = store.create({ name: "比较工作区", proxyKey: KEY, endpoint });
  store.patch(account.id, { tokenUsage: local(50, 10, 20), status: "healthy" });
  const monitor = new WorkerUsageMonitor(store, options);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  return {
    store,
    directory,
    monitor,
    id: account.id,
    respond: (value) => {
      handler = (_req, res) => res.end(JSON.stringify(value));
    },
    handle: (callback) => {
      handler = callback;
    },
  };
}

test("worker comparison aligns a baseline, tracks deltas without adding history, and persists through restart", async (t) => {
  const app = await fixture(t);
  const initial = await app.monitor.refresh(app.id);
  assert.equal(initial.status, "ok");
  assert.equal(initial.workspaceTotals.total, 1200);
  assert.equal(initial.workspace.total, 0);
  assert.equal(initial.local.total, 0);
  assert.equal(initial.workspaceTotals.cacheWrite, null);
  assert.equal(initial.workspace.cacheWrite, null);
  assert.equal(initial.difference.cacheWrite, null);
  assert.match(initial.message, /基线/);
  app.store.patch(app.id, { tokenUsage: local(150, 40, 50) });
  app.respond(snapshot(1100, 230, 330));
  const next = await app.monitor.refresh(app.id);
  assert.equal(next.local.total, 130);
  assert.equal(next.workspace.total, 130);
  assert.equal(next.workspace.cacheRead, 30);
  assert.equal(next.difference.total, 0);
  assert.equal(next.startedAt, initial.startedAt);
  const restored = new Store(app.directory, { allowLocal: true });
  const afterRestart = await new WorkerUsageMonitor(restored).refresh(app.id);
  assert.deepEqual(afterRestart.local, next.local);
  assert.deepEqual(afterRestart.workspace, next.workspace);
  assert.deepEqual(restored.get(app.id).tokenUsage, local(150, 40, 50));
  assert.equal(afterRestart.startedAt, initial.startedAt);
  app.respond(snapshot(1150, 240, 340));
  const external = await app.monitor.refresh(app.id);
  assert.equal(external.difference.input, 50);
  assert.equal(external.difference.output, 10);
  assert.equal(external.difference.total, 60);
  const text = JSON.stringify(external);
  assert.ok(!text.includes(KEY));
  assert.ok(!text.includes("baseline"));
  assert.ok(!text.includes("connectionFingerprint"));
});

test("boot changes, regressed counters, and local accounting reset establish new comparison baselines", async (t) => {
  const app = await fixture(t);
  await app.monitor.refresh(app.id);
  app.respond(snapshot(100, 10, 30, "second-boot"));
  let row = await app.monitor.refresh(app.id);
  assert.equal(row.bootId, "second-boot");
  assert.equal(row.workspace.total, 0);
  assert.equal(row.local.total, 0);
  app.respond(snapshot(200, 20, 60, "second-boot"));
  row = await app.monitor.refresh(app.id);
  assert.equal(row.workspace.total, 110);
  app.respond(snapshot(10, 1, 3, "second-boot"));
  row = await app.monitor.refresh(app.id);
  assert.equal(row.workspace.total, 0);
  app.store.patch(app.id, { tokenUsage: local(0, 0, 0) });
  app.respond(snapshot(20, 2, 6, "second-boot"));
  row = await app.monitor.refresh(app.id);
  assert.equal(row.workspace.total, 0);
  assert.equal(row.local.total, 0);
});

test("key changes hide old comparison and reset the baseline after authenticated resync", async (t) => {
  const app = await fixture(t);
  await app.monitor.refresh(app.id);
  app.store.update(app.id, { proxyKey: "rotated-worker-private-key" });
  let row = app.monitor.overview().accounts[0];
  assert.equal(row.status, "pending");
  assert.equal(row.workspaceTotals, null);
  row = await app.monitor.refresh(app.id);
  assert.equal(row.status, "ok");
  assert.equal(row.workspace.total, 0);
  assert.equal(row.local.total, 0);
});

test("unsupported and failed snapshots retain last good data without changing routing health or exposing bodies", async (t) => {
  const app = await fixture(t);
  const good = await app.monitor.refresh(app.id);
  app.handle((_req, res) => {
    res.writeHead(404);
    res.end(`secret body ${KEY}`);
  });
  let row = await app.monitor.refresh(app.id);
  assert.equal(row.status, "unsupported");
  assert.equal(row.syncedAt, good.syncedAt);
  assert.deepEqual(row.workspaceTotals, good.workspaceTotals);
  app.handle((_req, res) => {
    res.writeHead(401);
    res.end(`secret body ${KEY}`);
  });
  row = await app.monitor.refresh(app.id);
  assert.equal(row.status, "unavailable");
  assert.match(row.message, /HTTP 401/);
  assert.ok(!JSON.stringify(row).includes(KEY));
  assert.equal(app.store.get(app.id).status, "healthy");
  assert.deepEqual(app.store.get(app.id).tokenUsage, local(50, 10, 20));
});

test("malformed, negative, unsafe and oversized responses are rejected with bounded reads", async (t) => {
  const app = await fixture(t, { maxBytes: 512 });
  for (const invalid of [
    {},
    { ...snapshot(10, 1), totals: { ...snapshot(10, 1).totals, prompt: -1 } },
    {
      ...snapshot(10, 1),
      totals: {
        ...snapshot(10, 1).totals,
        completion: Number.MAX_SAFE_INTEGER + 1,
      },
    },
    { ...snapshot(10, 1), booted_at: "invalid date" },
    { ...snapshot(10, 1), untrustedPayload: "x".repeat(1000) },
  ]) {
    app.respond(invalid);
    const row = await app.monitor.refresh(app.id);
    assert.equal(row.status, "unavailable");
    assert.equal(row.workspaceTotals, null);
  }
  app.respond(snapshot(100, 10, 30));
  assert.equal((await app.monitor.refresh(app.id)).status, "ok");
});

test("legacy snapshots without cache counters expose missing cache data instead of zero", async (t) => {
  const app = await fixture(t);
  const legacy = snapshot(100, 10);
  delete legacy.totals.cache_hit;
  delete legacy.totals.cache_miss;
  app.respond(legacy);
  const row = await app.monitor.refresh(app.id);
  assert.equal(row.status, "ok");
  assert.equal(row.workspaceTotals.total, 110);
  assert.equal(row.workspaceTotals.cacheRead, null);
  assert.equal(row.workspace.cacheRead, null);
  assert.equal(row.difference.cacheRead, null);
  assert.equal(row.local.cacheRead, 0);
});

test("concurrent syncs share one fetch and stale reads cannot overwrite rotated or deleted accounts", async (t) => {
  const app = await fixture(t);
  let release;
  let requested;
  const arrived = new Promise((resolve) => {
    requested = resolve;
  });
  app.handle((_req, res) => {
    release = () => res.end(JSON.stringify(snapshot(100, 10, 30)));
    requested();
  });
  const first = app.monitor.refresh(app.id);
  const second = app.monitor.refresh(app.id);
  assert.equal(first, second);
  await arrived;
  app.store.update(app.id, { proxyKey: "next-private-worker-key" });
  release();
  const row = await first;
  assert.equal(row.status, "pending");
  assert.equal(app.store.get(app.id).workerUsage, undefined);

  let reached;
  const secondArrived = new Promise((resolve) => {
    reached = resolve;
  });
  app.handle((_req, res) => {
    release = () => res.end(JSON.stringify(snapshot(100, 10, 30)));
    reached();
  });
  const deleted = app.monitor.refresh(app.id);
  await secondArrived;
  app.store.remove(app.id);
  release();
  assert.equal(await deleted, null);
  assert.equal(app.store.state.accounts.length, 0);
});

test("snapshot timeout is reported as unavailable and accounts without an endpoint remain pending", async (t) => {
  const app = await fixture(t, { timeoutMs: 40 });
  app.handle(() => {});
  const row = await app.monitor.refresh(app.id);
  assert.equal(row.status, "unavailable");
  app.store.update(app.id, { endpoint: "" });
  const unregistered = await app.monitor.refresh(app.id);
  assert.equal(unregistered.status, "pending");
  assert.equal(unregistered.workspaceTotals, null);
  assert.equal((await app.monitor.refreshAll()).accounts[0].status, "pending");
});
