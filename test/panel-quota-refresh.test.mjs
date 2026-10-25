import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { Pool } from "../src/pool.mjs";

const snapshot = (org, used = 10) => ({
  org,
  credits: { total: 100, used, freeze: 1 },
  dev: { total: 100, used: 1, freeze: 0 },
  ci: { total: 100, used: 0 },
});
const turn = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

function fixture(t, fetchQuotaImpl, options = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cnb-panel-auto-quota-"));
  const directory = join(fixtureRoot, "data");
  const store = new Store(directory, { allowLocal: true });
  let clock = Date.parse("2026-10-24T08:00:00.000Z");
  const pool = new Pool(store, {
    fetchQuotaImpl,
    now: () => clock,
    ...options,
  });
  t.after(() => {
    pool.stop();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  const account = (fields = {}) =>
    store.create({
      name: `account-${store.state.accounts.length}`,
      repo: `org/repo-${store.state.accounts.length}`,
      proxyKey: "quota-test-proxy-key",
      pat: "quota-personal-token",
      ...fields,
    });
  return {
    store,
    pool,
    account,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

test("server start syncs offline workspace credits without a browser, then respects the 60 second cadence", async (t) => {
  const calls = [];
  const app = fixture(t, async ({ org, token }) => {
    calls.push({ org, token });
    return snapshot(org, calls.length);
  });
  const account = app.account();
  app.pool.start();
  await Promise.all([...app.pool.quotaJobs.values()]);
  await turn();
  assert.equal(calls.length, 1);
  assert.equal(app.store.get(account.id).quota.credits.used, 1);
  assert.equal(app.store.get(account.id).status, "pending");
  assert.equal(app.store.get(account.id).quotaSync.status, "ok");
  app.advance(59999);
  await app.pool.quotaCycle();
  assert.equal(calls.length, 1);
  app.advance(1);
  await app.pool.quotaCycle();
  assert.equal(calls.length, 2);
  assert.equal(app.store.get(account.id).quota.credits.used, 2);
});

test("same organization shares one in-flight query and propagates quota to every matching account", async (t) => {
  const gate = deferred();
  let calls = 0;
  const app = fixture(t, async ({ org }) => {
    calls++;
    await gate.promise;
    return snapshot(org);
  });
  const first = app.account();
  const second = app.account({ pat: "different-personal-token" });
  const noToken = app.account({ pat: "" });
  const paused = app.account({ enabled: false });
  const elsewhere = app.account({ repo: "elsewhere/repo" });
  const pending = [app.pool.quota(first.id), app.pool.quota(second.id)];
  await turn();
  assert.equal(calls, 1);
  assert.equal(app.store.get(first.id).quotaSync.status, "syncing");
  gate.resolve();
  await Promise.all(pending);
  for (const a of [first, second, noToken, paused]) {
    assert.deepEqual(app.store.get(a.id).quota, app.store.get(first.id).quota);
    assert.equal(app.store.get(a.id).quotaSync.status, "ok");
  }
  assert.equal(app.store.get(elsewhere.id).quota, null);
});

test("manual and automatic organization queries share a global concurrency bound", async (t) => {
  let active = 0;
  let highest = 0;
  const gates = [];
  const app = fixture(t, async ({ org }) => {
    active++;
    highest = Math.max(highest, active);
    const gate = deferred();
    gates.push(gate);
    await gate.promise;
    active--;
    return snapshot(org);
  });
  const accounts = Array.from({ length: 7 }, (_, i) =>
    app.account({ repo: `org${i}/repo` }),
  );
  const pending = accounts.map((a) => app.pool.quota(a.id));
  await turn();
  assert.equal(gates.length, 3);
  while (gates.length < 7) {
    for (const gate of gates) gate.resolve();
    await turn();
  }
  for (const gate of gates) gate.resolve();
  await Promise.all(pending);
  assert.equal(highest, 3);
  assert.equal(app.pool.quotaActive, 0);
});

test("failed polls retain last good quota, sanitize errors, and back off while manual sync can retry immediately", async (t) => {
  let calls = 0;
  const app = fixture(t, async ({ org }) => {
    calls++;
    if (calls > 1)
      throw new Error("private upstream body quota-personal-token");
    return snapshot(org);
  });
  const a = app.account();
  await app.pool.quotaCycle();
  const good = structuredClone(app.store.get(a.id).quota);
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.deepEqual(app.store.get(a.id).quota, good);
  const firstFailure = app.store.get(a.id).quotaSync;
  assert.equal(firstFailure.status, "error");
  assert.equal(Date.parse(firstFailure.nextAttemptAt) - app.now(), 60000);
  assert.ok(!JSON.stringify(firstFailure).includes("private upstream body"));
  assert.ok(!JSON.stringify(firstFailure).includes("quota-personal-token"));
  app.advance(59999);
  await app.pool.quotaCycle();
  assert.equal(calls, 2);
  app.advance(1);
  await app.pool.quotaCycle();
  assert.equal(calls, 3);
  assert.equal(
    Date.parse(app.store.get(a.id).quotaSync.nextAttemptAt) - app.now(),
    120000,
  );
  await assert.rejects(app.pool.quota(a.id), /额度同步失败/);
  assert.equal(calls, 4);
  assert.deepEqual(app.store.get(a.id).quota, good);
  for (let i = 0; i < 5; i++)
    await assert.rejects(app.pool.quota(a.id), /额度同步失败/);
  assert.equal(
    Date.parse(app.store.get(a.id).quotaSync.nextAttemptAt) - app.now(),
    15 * 60000,
  );
});

test("credential changes and newly added accounts are picked up on the next scheduler scan", async (t) => {
  const calls = [];
  const app = fixture(t, async ({ org, token }) => {
    calls.push({ org, token });
    return snapshot(org);
  });
  const a = app.account({ pat: "" });
  const paused = app.account({ repo: "paused/repo", enabled: false });
  await app.pool.quotaCycle();
  assert.equal(calls.length, 0);
  app.store.update(a.id, { pat: "new-personal-token" });
  await app.pool.quotaCycle();
  assert.equal(calls[0].token, "new-personal-token");
  app.store.update(a.id, { pat: "rotated-personal-token" });
  await app.pool.quotaCycle();
  assert.equal(calls[1].token, "rotated-personal-token");
  app.account({ repo: "neworg/repo" });
  app.store.update(paused.id, { enabled: true });
  await app.pool.quotaCycle();
  assert.deepEqual(
    calls
      .slice(2)
      .map((c) => c.org)
      .sort(),
    ["neworg", "paused"],
  );
});

test("stale quota responses cannot overwrite rotated credentials, moved organizations, or deleted accounts", async (t) => {
  let gate = deferred();
  const app = fixture(t, async ({ org }) => {
    await gate.promise;
    return snapshot(org, 70);
  });
  const a = app.account();
  const peer = app.account({ pat: "" });
  const pending = app.pool.quota(a.id);
  await turn();
  app.store.update(a.id, { pat: "rotated-token" });
  gate.resolve();
  await assert.rejects(pending, /账号配置已更改/);
  assert.equal(app.store.get(a.id).quota, null);
  assert.equal(app.store.get(peer.id).quota, null);
  assert.equal(app.store.get(peer.id).quotaSync, null);
  gate = deferred();
  const moved = app.pool.quota(a.id);
  await turn();
  app.store.update(a.id, { repo: "other-org/repo" });
  gate.resolve();
  await assert.rejects(moved, /账号配置已更改/);
  assert.equal(app.store.get(a.id).quota, null);
  gate = deferred();
  const deleted = app.pool.quota(a.id);
  await turn();
  app.store.remove(a.id);
  gate.resolve();
  await assert.rejects(deleted, /账号配置已更改/);
  assert.equal(app.store.state.accounts.length, 1);
});

test("an unauthorized organization token falls back to a valid sibling token and prefers it on later polls", async (t) => {
  const calls = [];
  const app = fixture(t, async ({ org, token }) => {
    calls.push(token);
    if (token === "invalid-token") {
      const error = new Error("HTTP 403 private body");
      error.status = 403;
      throw error;
    }
    return snapshot(org);
  });
  const good = app.account({ pat: "valid-token" });
  const bad = app.account({ pat: "invalid-token" });
  await app.pool.quotaCycle();
  assert.deepEqual(calls, ["invalid-token", "valid-token"]);
  assert.equal(app.store.get(bad.id).quotaSync.status, "ok");
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.deepEqual(calls, ["invalid-token", "valid-token", "valid-token"]);
  assert.deepEqual(app.store.get(good.id).quota, app.store.get(bad.id).quota);
});
