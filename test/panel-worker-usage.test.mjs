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
  reportedRequests: Math.max(1, Math.ceil(input / 100)),
  missingRequests: 0,
  partialRequests: 0,
  cacheReadReported: Math.max(1, Math.ceil(input / 100)),
  cacheWriteReported: Math.max(1, Math.ceil(input / 100)),
});
const snapshot = (prompt, completion, cacheHit = 0, boot = "first-boot") => ({
  boot_id: boot,
  booted_at: "2026-10-24T00:00:00.000Z",
  schema_version: 2,
  capabilities: {
    cache_hit: true,
    cache_miss: true,
    cache_write: false,
    credit: true,
  },
  coverage: Object.fromEntries(
    [
      "prompt",
      "completion",
      "cache_hit",
      "cache_miss",
      "cache_write",
      "credit",
    ].map((field) => [
      field,
      field === "cache_write" ? 0 : Math.max(1, Math.ceil(prompt / 100)),
    ]),
  ),
  totals: {
    prompt,
    completion,
    requests: Math.max(1, Math.ceil(prompt / 100)),
    errors: 0,
    partial_requests: 0,
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
  delete legacy.schema_version;
  delete legacy.capabilities;
  delete legacy.coverage;
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

test("upstream credit and prefix-cache counters are diffed from the same baseline", async (t) => {
  const app = await fixture(t);
  const initial = await app.monitor.refresh(app.id);
  assert.equal(initial.supportsCredit, true);
  // A fresh baseline subtracts itself, so every delta starts at zero.
  assert.deepEqual(initial.upstream, {
    prompt: 0,
    completion: 0,
    requests: 0,
    errors: 0,
    partialRequests: 0,
    credit: 0,
    cacheHit: 0,
    cacheMiss: 0,
    cacheWrite: null,
    coverage: {
      prompt: 0,
      completion: 0,
      credit: 0,
      cacheHit: 0,
      cacheMiss: 0,
      cacheWrite: 0,
    },
  });
  app.respond({
    ...snapshot(9000, 400, 3840),
    coverage: {
      prompt: 15,
      completion: 15,
      cache_hit: 15,
      cache_miss: 15,
      cache_write: 0,
      credit: 15,
    },
    totals: {
      prompt: 9000,
      completion: 400,
      requests: 15,
      errors: 1,
      partial_requests: 0,
      credit: 7.5,
      cache_hit: 3840,
      cache_miss: 5160,
    },
  });
  const next = await app.monitor.refresh(app.id);
  assert.equal(next.upstream.prompt, 8000);
  assert.equal(next.upstream.completion, 200);
  assert.equal(next.upstream.requests, 5);
  assert.equal(next.upstream.errors, 1);
  assert.equal(next.upstream.credit, 6.25);
  assert.equal(next.upstream.cacheHit, 3540);
  // The baseline snapshot already reported cache_miss = 1000 - 300 = 700.
  assert.equal(next.upstream.cacheMiss, 4460);
  // Cache hit + miss must still reconcile with the reported prompt tokens.
  assert.equal(
    next.upstream.cacheHit + next.upstream.cacheMiss,
    next.upstream.prompt,
  );
  // The comparison never leaks into the local accounting totals.
  assert.deepEqual(app.store.get(app.id).tokenUsage, local(50, 10, 20));
  assert.equal(next.local.total, 0);
});

test("fractional credit is accepted while legacy snapshots omit it", async (t) => {
  const app = await fixture(t);
  app.respond({
    boot_id: "first-boot",
    booted_at: "2026-10-24T00:00:00.000Z",
    totals: {
      prompt: 100,
      completion: 10,
      requests: 1,
      errors: 0,
      credit: 0.000125,
    },
  });
  const row = await app.monitor.refresh(app.id);
  assert.equal(row.status, "ok");
  assert.equal(row.supportsCredit, true);
  assert.equal(row.upstream.credit, 0);

  // A snapshot without the credit counter keeps the field but marks it absent.
  app.respond({
    boot_id: "second-boot",
    booted_at: "2026-10-24T00:00:00.000Z",
    totals: { prompt: 100, completion: 10, requests: 1, errors: 0 },
  });
  const legacy = await app.monitor.refresh(app.id);
  assert.equal(legacy.status, "ok");
  assert.equal(legacy.supportsCredit, false);
  assert.equal(legacy.upstream.credit, null);
});

test("a negative or non-JSON-numeric credit counter rejects the whole snapshot", async (t) => {
  const app = await fixture(t);
  await app.monitor.refresh(app.id);
  // JSON cannot carry NaN/Infinity, so only negative and non-numeric values are
  // reachable from a real workspace response.
  for (const credit of [-1, "1.5", true]) {
    app.respond({
      boot_id: "first-boot",
      booted_at: "2026-10-24T00:00:00.000Z",
      totals: { prompt: 100, completion: 10, requests: 1, errors: 0, credit },
    });
    const row = await app.monitor.refresh(app.id);
    assert.equal(
      row.status,
      "unavailable",
      `credit ${String(credit)} must be rejected`,
    );
  }
});

test("supported but unreported fields stay unknown, while measured zero and partial coverage survive", async (t) => {
  const app = await fixture(t);
  const measured = (requests, prompt, credit, creditReports, cacheReports) => ({
    ...snapshot(prompt, requests * 10, 0),
    capabilities: {
      cache_hit: true,
      cache_miss: true,
      cache_write: true,
      credit: true,
    },
    totals: {
      prompt,
      completion: requests * 10,
      requests,
      errors: 0,
      partial_requests: 0,
      credit,
      cache_hit: 0,
      cache_miss: 0,
      cache_write: 0,
    },
    coverage: {
      prompt: requests,
      completion: requests,
      credit: creditReports,
      cache_hit: cacheReports,
      cache_miss: 0,
      cache_write: cacheReports,
    },
  });
  app.respond(measured(0, 0, 0, 0, 0));
  await app.monitor.refresh(app.id);
  app.respond(measured(1, 100, 0, 0, 0));
  const missing = await app.monitor.refresh(app.id);
  assert.equal(missing.supportsCredit, true);
  assert.equal(missing.upstream.credit, null);
  assert.equal(missing.upstream.cacheHit, null);
  assert.equal(missing.upstream.cacheMiss, null);
  assert.equal(missing.workspace.cacheRead, null);
  assert.equal(missing.upstream.coverage.credit, 0);
  app.respond(measured(2, 200, 0, 1, 1));
  const partial = await app.monitor.refresh(app.id);
  assert.equal(partial.upstream.credit, 0);
  assert.equal(partial.upstream.cacheHit, 0);
  assert.equal(partial.upstream.cacheWrite, 0);
  assert.equal(partial.upstream.requests, 2);
  assert.equal(partial.upstream.coverage.credit, 1);
  assert.equal(partial.difference.cacheRead, null);
  assert.equal(partial.local.cacheReadReported, 0);
});

test("schema and capability changes reset only comparison baselines", async (t) => {
  const app = await fixture(t);
  const legacy = {
    boot_id: "first-boot",
    booted_at: "2026-10-24T00:00:00.000Z",
    totals: { prompt: 100, completion: 10, requests: 1 },
  };
  app.respond(legacy);
  await app.monitor.refresh(app.id);
  app.respond({
    ...legacy,
    totals: { prompt: 200, completion: 20, requests: 2 },
  });
  assert.equal((await app.monitor.refresh(app.id)).upstream.credit, null);
  const modern = snapshot(300, 30, 100);
  app.respond(modern);
  let row = await app.monitor.refresh(app.id);
  assert.equal(row.schemaVersion, 2);
  assert.equal(row.workspace.total, 0);
  const upgraded = {
    ...snapshot(400, 40, 150),
    capabilities: { ...modern.capabilities, cache_write: true },
    totals: { ...snapshot(400, 40, 150).totals, cache_write: 0 },
    coverage: { ...snapshot(400, 40, 150).coverage, cache_write: 4 },
  };
  app.respond(upgraded);
  row = await app.monitor.refresh(app.id);
  assert.equal(row.workspace.total, 0);
  assert.equal(row.workspace.cacheWrite, 0);
  assert.deepEqual(app.store.get(app.id).tokenUsage, local(50, 10, 20));
});

test("partial attempt counts preserve subtotals and suppress comparison completeness", async (t) => {
  const app = await fixture(t);
  app.respond(snapshot(100, 10, 50));
  await app.monitor.refresh(app.id);
  app.store.patch(app.id, { tokenUsage: local(150, 20, 70) });
  const interrupted = snapshot(200, 20, 100);
  interrupted.totals.partial_requests = 1;
  app.respond(interrupted);
  const row = await app.monitor.refresh(app.id);
  assert.equal(row.upstream.partialRequests, 1);
  assert.equal(row.upstream.requests, 1);
  assert.equal(row.upstream.coverage.cacheHit, 1);
  assert.equal(row.workspace.input, 100);
  assert.equal(row.workspace.cacheRead, 50);
  assert.equal(row.difference.input, null);
  assert.equal(row.difference.cacheRead, null);
  assert.equal(row.upstream.errors, 0);

  // An older worker cannot prove a complete observation window.
  const legacy = snapshot(300, 30, 150);
  delete legacy.totals.partial_requests;
  app.respond(legacy);
  const reset = await app.monitor.refresh(app.id);
  assert.equal(reset.upstream.partialRequests, null);
  assert.equal(reset.workspace.input, 0);
  assert.equal(reset.difference.input, null);
  assert.deepEqual(app.store.get(app.id).tokenUsage, local(150, 20, 70));
});

test("invalid partial attempt counts reject the snapshot", async (t) => {
  const app = await fixture(t);
  for (const value of [-1, 1.5, 2, "1", null]) {
    const invalid = snapshot(100, 10, 50);
    invalid.totals.partial_requests = value;
    app.respond(invalid);
    assert.equal((await app.monitor.refresh(app.id)).status, "unavailable");
  }
});

test("invalid coverage cannot manufacture measured usage", async (t) => {
  const app = await fixture(t);
  for (const invalid of [
    {
      ...snapshot(100, 10),
      coverage: { ...snapshot(100, 10).coverage, credit: 2 },
    },
    {
      ...snapshot(100, 10),
      coverage: { ...snapshot(100, 10).coverage, prompt: 0 },
    },
    {
      ...snapshot(100, 10),
      capabilities: { ...snapshot(100, 10).capabilities, credit: false },
    },
  ]) {
    app.respond(invalid);
    assert.equal((await app.monitor.refresh(app.id)).status, "unavailable");
  }
});
