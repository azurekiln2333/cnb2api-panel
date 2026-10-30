import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, publicAccount } from "../src/store.mjs";
import { Pool, isReady } from "../src/pool.mjs";
import { quotaProtectionFor } from "../src/quota-protection.mjs";

const snapshot = (org, { total = 100, used = 10, freeze = 0 } = {}) => ({
  org,
  credits: { total, used, freeze },
  dev: { total: 100, used: 0, freeze: 0 },
  ci: { total: 0, used: 0 },
});

function fixture(t, fetchQuotaImpl) {
  const root = mkdtempSync(join(tmpdir(), "cnb-quota-protection-"));
  const directory = join(root, "data");
  const store = new Store(directory, { allowLocal: true });
  let clock = Date.now();
  const pool = new Pool(store, { fetchQuotaImpl, now: () => clock });
  const account = (fields = {}) => {
    const created = store.create({
      name: `account-${store.state.accounts.length}`,
      repo: `org/repo-${store.state.accounts.length}`,
      endpoint: "http://127.0.0.1:9001",
      proxyKey: "fixture-proxy-key",
      pat: "fixture-personal-token",
      ...fields,
    });
    store.patch(created.id, { status: "healthy" });
    return store.get(created.id);
  };
  t.after(() => {
    pool.stop();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, pool, account, directory, advance: (ms) => { clock += ms; } };
}

test("quota protection defaults on and unverified quota cannot route", (t) => {
  const app = fixture(t, async ({ org }) => snapshot(org));
  const account = app.account({ pat: "" });
  assert.deepEqual(app.store.state.settings.quotaProtection, { enabled: true, thresholdPercent: 10 });
  assert.equal(account.enabled, true);
  assert.deepEqual(account.quotaProtection, {
    suspended: true, reason: "unknown", remainingPercent: null, thresholdPercent: 10,
  });
  assert.equal(isReady(account), false);
  assert.deepEqual(app.pool.eligible(), []);
  assert.equal(publicAccount(account).quotaProtection.suspended, true);
});

test("automatic quota polling suspends below ten percent and resumes at the exact threshold", async (t) => {
  let used = 91;
  let calls = 0;
  const app = fixture(t, async ({ org }) => { calls++; return snapshot(org, { used }); });
  const account = app.account();
  await app.pool.quotaCycle();
  assert.equal(app.store.get(account.id).quotaProtection.reason, "low");
  assert.equal(app.store.get(account.id).quotaProtection.remainingPercent, 9);
  assert.equal(app.store.get(account.id).enabled, true);
  assert.deepEqual(app.pool.eligible(), []);
  used = 90;
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.equal(calls, 2);
  assert.equal(app.store.get(account.id).quotaProtection.suspended, false);
  assert.equal(app.store.get(account.id).quotaProtection.remainingPercent, 10);
  assert.equal(app.pool.eligible()[0].id, account.id);
});

test("decimal credit arithmetic preserves the exact threshold without allowing genuinely lower balances", () => {
  const account = {
    repo: "org/repo",
    quotaSync: { status: "ok" },
  };
  for (const credits of [
    { total: 3, used: 2.7, freeze: 0 },
    { total: 0.3, used: 0.27, freeze: 0 },
    { total: 3, used: 2.5, freeze: 0.2 },
  ]) {
    account.quota = { ...snapshot("org", credits), syncedAt: new Date().toISOString() };
    assert.equal(quotaProtectionFor(account).suspended, false);
  }
  account.quota = { ...snapshot("org", { total: 3, used: 2.700000000003 }), syncedAt: new Date().toISOString() };
  assert.ok(quotaProtectionFor(account).remainingPercent < 10);
  assert.equal(quotaProtectionFor(account).reason, "low");
});

test("frozen credits count toward protection and a new quota period automatically resumes routing", async (t) => {
  let credits = { total: 100, used: 89, freeze: 2 };
  const app = fixture(t, async ({ org }) => snapshot(org, credits));
  const account = app.account();
  await app.pool.quotaCycle();
  assert.equal(app.store.get(account.id).quotaProtection.suspended, true);
  credits = { total: 100, used: 0, freeze: 0 };
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.equal(app.store.get(account.id).quotaProtection.remainingPercent, 100);
  assert.equal(app.pool.eligible()[0].id, account.id);
});

test("organization protection is shared without changing manual account enablement", async (t) => {
  let used = 95;
  const app = fixture(t, async ({ org }) => snapshot(org, { used }));
  const active = app.account();
  const noToken = app.account({ pat: "" });
  const manual = app.account({ enabled: false });
  await app.pool.quotaCycle();
  for (const account of [active, noToken, manual])
    assert.equal(app.store.get(account.id).quotaProtection.reason, "low");
  used = 0;
  app.advance(60000);
  await app.pool.quotaCycle();
  for (const account of [active, noToken, manual])
    assert.equal(app.store.get(account.id).quotaProtection.suspended, false);
  assert.equal(app.store.get(manual.id).enabled, false);
  assert.deepEqual(app.pool.eligible().map((account) => account.id).sort(), [active.id, noToken.id].sort());
});

test("a failed synchronization retains numbers for display but suspends routing until verified recovery", async (t) => {
  let failed = false;
  const app = fixture(t, async ({ org }) => {
    if (failed) throw new Error("private upstream failure fixture-personal-token");
    return snapshot(org);
  });
  const account = app.account();
  await app.pool.quotaCycle();
  const good = structuredClone(app.store.get(account.id).quota);
  failed = true;
  app.advance(60000);
  await app.pool.quotaCycle();
  const state = app.store.get(account.id);
  assert.deepEqual(state.quota, good);
  assert.equal(state.quotaProtection.reason, "sync-error");
  assert.equal(state.quotaProtection.remainingPercent, 90);
  assert.deepEqual(app.pool.eligible(), []);
  failed = false;
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.equal(app.store.get(account.id).quotaProtection.suspended, false);
  assert.equal(app.pool.eligible().length, 1);
});

test("retrying failed or unverified quota never temporarily re-enables stale snapshots", async (t) => {
  for (const reason of ["sync-error", "unknown"]) await t.test(reason, async (t) => {
    let phase = "initial";
    let release;
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    const app = fixture(t, async ({ org }) => {
      if (phase === "fail") throw new Error("synthetic quota failure");
      if (phase === "retry") return new Promise((resolve) => {
        release = () => resolve(snapshot(org));
        started();
      });
      return snapshot(org);
    });
    const account = app.account();
    await app.pool.quota(account.id);
    if (reason === "sync-error") {
      phase = "fail";
      await assert.rejects(app.pool.quota(account.id));
    } else app.store.update(account.id, { pat: "rotated-fixture-token" });
    assert.equal(app.store.get(account.id).quotaProtection.reason, reason);
    phase = "retry";
    const retry = app.pool.quota(account.id);
    await waiting;
    assert.equal(app.store.get(account.id).quotaSync.status, "syncing");
    assert.equal(app.store.get(account.id).quotaProtection.reason, reason);
    assert.deepEqual(app.pool.eligible(), []);
    release();
    await retry;
    assert.equal(app.store.get(account.id).quotaProtection.suspended, false);
    assert.equal(app.pool.eligible().length, 1);
  });
});

test("a verified sibling cannot restore rotated credentials while its shared quota request is pending", async (t) => {
  for (const failure of [false, true]) await t.test(failure ? "failed response" : "successful response", async (t) => {
    let held = false;
    let complete;
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    const app = fixture(t, async ({ org }) => {
      if (!held) return snapshot(org);
      return new Promise((resolve, reject) => {
        complete = () => failure ? reject(new Error("synthetic quota failure")) : resolve(snapshot(org));
        started();
      });
    });
    const source = app.account();
    const sibling = app.account();
    await app.pool.quota(source.id);
    app.store.update(sibling.id, { pat: "rotated-sibling-token" });
    assert.equal(app.store.get(sibling.id).quotaProtection.reason, "unknown");
    held = true;
    const retry = app.pool.quota(source.id);
    await waiting;
    assert.equal(app.store.get(source.id).quotaSync.previousStatus, "ok");
    assert.equal(app.store.get(sibling.id).quotaSync.previousStatus, null);
    assert.equal(app.store.get(sibling.id).quotaProtection.reason, "unknown");
    assert.deepEqual(app.pool.eligible().map((account) => account.id), [source.id]);
    complete();
    if (failure) {
      await assert.rejects(retry);
      assert.equal(app.store.get(sibling.id).quotaProtection.reason, "sync-error");
      assert.deepEqual(app.pool.eligible(), []);
    } else {
      await retry;
      assert.equal(app.store.get(sibling.id).quotaProtection.suspended, false);
      assert.equal(app.pool.eligible().length, 2);
    }
  });
});

test("invalid snapshots cannot replace a verified quota or turn unknown values into zero", async (t) => {
  let result;
  const app = fixture(t, async ({ org }) => result ?? snapshot(org));
  const account = app.account();
  await app.pool.quotaCycle();
  const good = structuredClone(app.store.get(account.id).quota);
  for (const credits of [{ total: 100, used: null, freeze: 0 }, { total: 100, used: 0 }, { total: -1, used: 0, freeze: 0 }, { total: 100, used: Infinity, freeze: 0 }]) {
    result = { org: "org", credits };
    await assert.rejects(app.pool.quota(account.id), /额度同步失败/);
    assert.deepEqual(app.store.get(account.id).quota, good);
    assert.equal(app.store.get(account.id).quotaProtection.suspended, true);
  }
});

test("policy changes immediately update readiness and preserve configured thresholds", async (t) => {
  const app = fixture(t, async ({ org }) => snapshot(org, { used: 85 }));
  const account = app.account();
  await app.pool.quotaCycle();
  assert.equal(app.pool.eligible().length, 1);
  app.store.settings({ quotaProtection: { thresholdPercent: 20 } });
  assert.equal(app.store.get(account.id).quotaProtection.reason, "low");
  app.store.settings({ quotaProtection: { enabled: false } });
  assert.equal(app.store.get(account.id).quotaProtection.reason, "disabled");
  assert.equal(app.pool.eligible().length, 1);
  app.store.settings({ quotaProtection: { enabled: true } });
  assert.equal(app.store.state.settings.quotaProtection.thresholdPercent, 20);
  assert.deepEqual(app.pool.eligible(), []);
  for (const value of [null, [], { enabled: 1 }, { thresholdPercent: 0 }, { thresholdPercent: 101 }, { thresholdPercent: 1.5 }])
    assert.throws(() => app.store.settings({ quotaProtection: value }));
});

test("session affinity cannot reuse a suspended account and selects a verified organization", async (t) => {
  let limited = false;
  const app = fixture(t, async ({ org }) => snapshot(org, { used: org === "first" && limited ? 95 : 10 }));
  const first = app.account({ repo: "first/repo", priority: 10, models: ["quota-model"] });
  const second = app.account({ repo: "second/repo", priority: 1, models: ["quota-model"] });
  await app.pool.quotaCycle();
  assert.equal(app.pool.select("", new Set(), "quota-session").id, first.id);
  limited = true;
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.equal(app.pool.select("", new Set(), "quota-session").id, second.id);
  assert.equal(app.pool.affinity.get("quota-session"), second.id);
  assert.deepEqual(app.pool.models().find((model) => model.id === "quota-model").eligibleAccounts,
    [{ id: second.id, name: second.name }]);
});

test("restart recomputes quota protection and keeps runtime state out of account definitions", async (t) => {
  const app = fixture(t, async ({ org }) => snapshot(org, { used: 95 }));
  const account = app.account();
  await app.pool.quotaCycle();
  const definitions = JSON.parse(readFileSync(join(app.directory, "accounts.json"), "utf8"));
  const stats = JSON.parse(readFileSync(join(app.directory, "stats.json"), "utf8"));
  assert.equal(definitions.accounts[0].quotaProtection, undefined);
  assert.equal(stats.accounts[account.id].quotaProtection.reason, "low");
  stats.accounts[account.id].quotaProtection.suspended = false;
  writeFileSync(join(app.directory, "stats.json"), JSON.stringify(stats));
  const restored = new Store(app.directory, { allowLocal: true });
  assert.equal(restored.get(account.id).quotaProtection.suspended, true);
  assert.equal(restored.get(account.id).enabled, true);
});

test("legacy installations default protection on and new credentials require verification", async (t) => {
  const app = fixture(t, async ({ org }) => snapshot(org));
  const account = app.account();
  await app.pool.quotaCycle();
  const panel = JSON.parse(readFileSync(join(app.directory, "panel.json"), "utf8"));
  delete panel.settings.quotaProtection;
  writeFileSync(join(app.directory, "panel.json"), JSON.stringify(panel));
  const restored = new Store(app.directory, { allowLocal: true });
  assert.equal(restored.state.settings.quotaProtection.enabled, true);
  restored.update(account.id, { pat: "new-fixture-token" });
  assert.equal(restored.get(account.id).quotaProtection.reason, "unknown");
  assert.equal(restored.get(account.id).quotaProtection.suspended, true);
});

test("zero and overdrawn quotas suspend while invalid or mismatched quota stays unknown", () => {
  const account = {
    repo: "org/repo",
    quotaSync: { status: "ok" },
    quota: { ...snapshot("org", { total: 0, used: 0 }), syncedAt: new Date().toISOString() },
  };
  assert.equal(quotaProtectionFor(account).reason, "low");
  account.quota = { ...snapshot("org", { used: 120 }), syncedAt: new Date().toISOString() };
  assert.equal(quotaProtectionFor(account).remainingPercent, 0);
  account.quota.org = "other-org";
  assert.equal(quotaProtectionFor(account).reason, "invalid");
  assert.equal(quotaProtectionFor(account).remainingPercent, null);
});

test("only an explicit account override bypasses quota suspension without affecting organization siblings", async (t) => {
  for (const reason of ["unknown", "low", "sync-error"]) await t.test(reason, async (t) => {
    const app = fixture(t, async ({ org }) => {
      if (reason === "sync-error") throw new Error("synthetic quota failure");
      return snapshot(org, { used: 95 });
    });
    const first = app.account();
    const sibling = app.account();
    if (reason !== "unknown") await app.pool.quotaCycle();
    assert.equal(app.store.get(first.id).quotaProtectionOverride, false);
    assert.equal(app.store.get(first.id).quotaProtection.reason, reason);
    app.store.update(first.id, { enabled: true });
    assert.equal(app.store.get(first.id).quotaProtection.suspended, true);
    const enabled = app.store.update(first.id, { enabled: true, quotaProtectionOverride: true });
    assert.equal(enabled.quotaProtectionOverride, true);
    assert.equal(enabled.quotaProtection.suspended, false);
    assert.equal(enabled.quotaProtection.reason, "override");
    assert.equal(enabled.quotaProtection.remainingPercent, reason === "low" ? 5 : null);
    assert.equal(publicAccount(enabled).quotaProtectionOverride, true);
    assert.deepEqual(app.pool.eligible().map((account) => account.id), [first.id]);
    assert.equal(app.store.get(sibling.id).quotaProtectionOverride, false);
    assert.equal(app.store.get(sibling.id).quotaProtection.reason, reason);
    app.store.update(first.id, { quotaProtectionOverride: false });
    assert.equal(app.store.get(first.id).quotaProtection.suspended, true);
    assert.deepEqual(app.pool.eligible(), []);
  });
});

test("account override persists in account definitions and legacy accounts default to automatic protection", (t) => {
  const app = fixture(t, async ({ org }) => snapshot(org));
  const account = app.account();
  app.store.update(account.id, { enabled: true, quotaProtectionOverride: true });
  const definitions = JSON.parse(readFileSync(join(app.directory, "accounts.json"), "utf8"));
  const stats = JSON.parse(readFileSync(join(app.directory, "stats.json"), "utf8"));
  assert.equal(definitions.accounts[0].quotaProtectionOverride, true);
  assert.equal(stats.accounts[account.id].quotaProtectionOverride, undefined);
  const restored = new Store(app.directory, { allowLocal: true });
  assert.equal(restored.get(account.id).quotaProtectionOverride, true);
  assert.equal(restored.get(account.id).quotaProtection.reason, "override");
  assert.equal(isReady(restored.get(account.id)), true);
  delete definitions.accounts[0].quotaProtectionOverride;
  writeFileSync(join(app.directory, "accounts.json"), JSON.stringify(definitions));
  const legacy = new Store(app.directory, { allowLocal: true });
  assert.equal(legacy.get(account.id).quotaProtectionOverride, false);
  assert.equal(legacy.get(account.id).quotaProtection.suspended, true);
  definitions.accounts[0].quotaProtectionOverride = "true";
  writeFileSync(join(app.directory, "accounts.json"), JSON.stringify(definitions));
  assert.throws(() => new Store(app.directory, { allowLocal: true }), /Invalid quota protection override/);
});

test("manual enablement survives failed and low quota polls then restores automatic protection after verified recovery", async (t) => {
  let phase = "failed";
  let calls = 0;
  const app = fixture(t, async ({ org }) => {
    calls++;
    if (phase === "failed") throw new Error("synthetic quota failure");
    return snapshot(org, { used: phase === "low" ? 95 : 0 });
  });
  const account = app.account();
  const sibling = app.account();
  app.store.update(account.id, { enabled: true, quotaProtectionOverride: true });
  await app.pool.quotaCycle();
  assert.equal(app.store.get(account.id).quotaSync.status, "error");
  assert.equal(app.store.get(account.id).quotaProtection.reason, "override");
  phase = "low";
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.equal(app.store.get(account.id).quotaProtection.reason, "override");
  assert.equal(app.store.get(account.id).quotaProtection.remainingPercent, 5);
  assert.equal(app.store.get(sibling.id).quotaProtection.reason, "low");
  phase = "recovered";
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.equal(app.store.get(account.id).quotaProtectionOverride, false);
  assert.equal(app.store.get(account.id).quotaProtection.reason, null);
  assert.equal(app.store.get(sibling.id).quotaProtection.suspended, false);
  phase = "low";
  app.advance(60000);
  await app.pool.quotaCycle();
  assert.equal(calls, 4);
  assert.equal(app.store.get(account.id).quotaProtection.reason, "low");
  assert.equal(app.store.get(account.id).quotaProtectionOverride, false);
  assert.deepEqual(app.pool.eligible(), []);
});

test("manual disablement clears an account override and ordinary enablement keeps automatic protection", (t) => {
  const app = fixture(t, async ({ org }) => snapshot(org));
  const account = app.account();
  app.store.update(account.id, { enabled: true, quotaProtectionOverride: true });
  const disabled = app.store.update(account.id, { enabled: false, quotaProtectionOverride: true });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.quotaProtectionOverride, false);
  assert.equal(isReady(disabled), false);
  const enabled = app.store.update(account.id, { enabled: true });
  assert.equal(enabled.quotaProtectionOverride, false);
  assert.equal(enabled.quotaProtection.suspended, true);
  for (const invalid of [null, 0, 1, "true", {}, []])
    assert.throws(() => app.store.update(account.id, { quotaProtectionOverride: invalid }), /强制启用状态须为布尔值/);
  assert.equal(app.store.get(account.id).quotaProtectionOverride, false);
});

test("quota override leaves health, inference cooldowns, model scope and manual state in control", (t) => {
  const app = fixture(t, async ({ org }) => snapshot(org));
  const account = app.account({ models: ["allowed-model"] });
  app.store.update(account.id, { enabled: true, quotaProtectionOverride: true });
  assert.equal(app.pool.eligible("allowed-model").length, 1);
  assert.deepEqual(app.pool.eligible("other-model"), []);
  app.store.patch(account.id, { status: "unhealthy" });
  assert.equal(isReady(app.store.get(account.id)), false);
  app.store.patch(account.id, { status: "healthy", cooldownUntil: new Date(Date.now() + 60000).toISOString() });
  assert.equal(isReady(app.store.get(account.id)), false);
  assert.deepEqual(app.pool.eligible("allowed-model"), []);
  app.store.update(account.id, { enabled: false });
  app.store.patch(account.id, { cooldownUntil: null });
  assert.equal(isReady(app.store.get(account.id)), false);
  assert.equal(app.store.get(account.id).quotaProtectionOverride, false);
});

test("global policy changes preserve a pending account override and verified recovery uses the current threshold", async (t) => {
  const app = fixture(t, async ({ org }) => snapshot(org, { used: 85 }));
  const account = app.account();
  app.store.settings({ quotaProtection: { thresholdPercent: 20 } });
  app.store.update(account.id, { enabled: true, quotaProtectionOverride: true });
  app.store.settings({ quotaProtection: { enabled: false } });
  assert.equal(app.store.get(account.id).quotaProtection.reason, "disabled");
  assert.equal(app.store.get(account.id).quotaProtectionOverride, true);
  await app.pool.quota(account.id);
  assert.equal(app.store.get(account.id).quotaProtectionOverride, true);
  app.store.settings({ quotaProtection: { enabled: true } });
  assert.equal(app.store.get(account.id).quotaProtection.reason, "override");
  app.store.settings({ quotaProtection: { thresholdPercent: 15 } });
  assert.equal(app.store.get(account.id).quotaProtectionOverride, false);
  assert.equal(app.store.get(account.id).quotaProtection.reason, null);
});
