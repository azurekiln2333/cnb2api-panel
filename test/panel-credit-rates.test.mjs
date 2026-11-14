import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, publicAccount } from "../src/store.mjs";
import { Pool } from "../src/pool.mjs";
import { WorkerUsageMonitor } from "../src/worker-usage.mjs";
import { createPanelServer } from "../src/app.mjs";
import { editAccounts, editMeta, removeAll } from "./support/sqlite-fixture.mjs";
import {
  appendSample,
  BILLING_FIELDS,
  billingWindow,
  creditRates,
  decodeHistory,
  encodeHistory,
  loadCreditHistory,
  MAX_SAMPLES,
  MIN_RATE_TOKENS,
  nnlsSplit,
  recordBillingSample,
  recordReportedSample,
  REPORTED_FIELDS,
} from "../src/credit-rates.mjs";

const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const MINUTE = 60000;
const HOUR = 3600000;
const iso = (ms) => new Date(T0 + ms).toISOString();
const usage = (input, output, cacheRead = 0) => ({
  input, output, cacheRead, cacheWrite: 0, total: input + output,
  reportedRequests: 1, missingRequests: 0, partialRequests: 0,
  cacheReadReported: 1, cacheWriteReported: 1,
});
const quota = (used, freeze = 0, total = 1000) => ({
  org: "org", credits: { total, used, freeze },
  dev: { total: 1, used: 0, freeze: 0 }, ci: { total: 1, used: 0 },
});
const account = (id, repo, tokens = usage(0, 0), fields = {}) => ({
  id, name: id, repo, enabled: true, tokenUsage: tokens, quota: null,
  creditReportHistory: null, ...fields,
});
// Absolute billing sample in the stored field order.
const billingSample = (ms, used, input, output, freeze = 0) => [
  (T0 + ms) / 1000, Math.round(used * 1000), Math.round(freeze * 1000), input, output, 0, 0,
];
const stored = (...samples) => encodeHistory(samples);
const billing = (state, org) => decodeHistory(state.creditHistory[org], BILLING_FIELDS.length);
const reportedSamples = (history) => decodeHistory(history.samples, REPORTED_FIELDS.length);
const record = (state, org, used, at, freeze = 0) => {
  state.creditHistory = recordBillingSample(state, org, quota(used, freeze), iso(at));
  return billing(state, org);
};

test("billing history appends changes, skips unchanged samples and keeps one per hour", () => {
  const state = { accounts: [account("a", "org/repo", usage(100, 10))], creditHistory: {} };
  assert.equal(record(state, "org", 1, 0).length, 1);
  assert.equal(record(state, "org", 1, MINUTE).length, 1, "unchanged sample is skipped");
  assert.equal(record(state, "org", 1, 30 * MINUTE).length, 1);
  assert.equal(record(state, "org", 1, HOUR).length, 2, "one sample per hour keeps an end point");
  state.accounts[0].tokenUsage = usage(200, 10);
  assert.equal(record(state, "org", 1, HOUR + MINUTE).length, 3, "token change is recorded");
  assert.equal(record(state, "org", 2.5, HOUR + 2 * MINUTE, 0.125).length, 4, "credit change is recorded");
  assert.deepEqual(billing(state, "org").at(-1), [(T0 + HOUR + 2 * MINUTE) / 1000, 2500, 125, 200, 10, 0, 0]);
  // Stored form: the first row is absolute, later rows are differences.
  assert.deepEqual(state.creditHistory.org[1], [HOUR / 1000, 0, 0, 0, 0, 0, 0]);
});

test("billing history sums the organization's accounts and excludes probe usage", () => {
  const state = {
    accounts: [
      account("a", "org/one", usage(100, 10, 40), { probeUsage: { requests: 9, prompt: 900, completion: 9 } }),
      account("b", "org/two", usage(50, 5)),
      account("c", "other/repo", usage(1000, 100)),
    ],
    creditHistory: { gone: stored(billingSample(0, 1, 0, 0)) },
  };
  record(state, "org", 1, 0);
  assert.deepEqual(billing(state, "org")[0].slice(3), [150, 15, 40, 0]);
  assert.equal(state.creditHistory.gone, undefined, "organizations without accounts are pruned");
});

test("billing history retains seven days and thins by age", () => {
  let history = [];
  const same = () => false;
  const broken = () => false;
  for (let i = 0; i <= 8 * 24 * 60; i += 2)
    history = appendSample(history, billingSample(i * MINUTE, i, i * 1000, i), { same, broken });
  const newest = history.at(-1)[0];
  assert.ok(newest - history[0][0] <= 7 * 86400, "samples older than seven days are dropped");
  assert.ok(newest - history[0][0] >= 6.9 * 86400, "thinning keeps the seven day window covered");
  const age = (sample) => newest - sample[0];
  assert.equal(history.filter((s) => age(s) <= 3600).length, 31, "the last hour keeps every sample");
  const day = history.filter((s) => age(s) > 3600 && age(s) <= 86400);
  assert.ok(day.length >= 135 && day.length <= 140, `one per 10 minutes up to a day (${day.length})`);
  const week = history.filter((s) => age(s) > 86400);
  assert.ok(week.length >= 140 && week.length <= 146, `one per hour after a day (${week.length})`);
  assert.ok(history.length <= MAX_SAMPLES);
  // The NNLS split still has enough intervals in the 24h and 7d windows.
  const now = (newest + 1) * 1000;
  assert.ok(billingWindow(history, now - 86400000).intervals.length >= 12);
  assert.ok(billingWindow(history, now - 7 * 86400000).intervals.length >= 12);
  // Loading trims an oversized history to the hard cap, dropping the oldest.
  const dense = Array.from({ length: 500 }, (_, i) => billingSample(i * 1000, i, i, 0));
  const loaded = decodeHistory(loadCreditHistory({ org: encodeHistory(dense) }).org, BILLING_FIELDS.length);
  assert.equal(loaded.length, MAX_SAMPLES);
  assert.deepEqual(loaded[0], dense[100]);
});

test("billing history resets on a billing period reset or a statistics reset", () => {
  const state = { accounts: [account("a", "org/repo", usage(100, 10))], creditHistory: {} };
  record(state, "org", 50, 0);
  record(state, "org", 60, MINUTE);
  assert.equal(billing(state, "org").length, 2);
  assert.equal(record(state, "org", 5, 2 * MINUTE).length, 1, "used Credits decreased");
  record(state, "org", 6, 3 * MINUTE);
  state.accounts[0].tokenUsage = usage(10, 1);
  const history = record(state, "org", 7, 4 * MINUTE);
  assert.equal(history.length, 1, "local tokens decreased");
  assert.equal(history[0][1], 7000);
});

test("billing rate uses used plus frozen Credits per million tokens and needs enough data", () => {
  const now = T0 + 2 * HOUR;
  const state = {
    accounts: [account("a", "org/repo", usage(0, 0), { quota: { ...quota(14, 1, 1000), syncedAt: iso(110 * MINUTE) } })],
    creditHistory: {
      org: stored(
        billingSample(90 * MINUTE, 10, 0, 0, 0),
        billingSample(100 * MINUTE, 12, 100_000, 50_000, 3),
        billingSample(110 * MINUTE, 14, 300_000, 100_000, 1),
      ),
    },
  };
  const row = creditRates(state, { window: "1h", now }).accounts[0];
  assert.equal(row.status, "ok");
  assert.equal(row.deltaCredits, 5);
  assert.equal(row.deltaTokens, 400_000);
  assert.equal(row.billing.rate, 12.5);
  assert.equal(row.windowStart, iso(90 * MINUTE));
  assert.equal(row.windowEnd, iso(110 * MINUTE));
  assert.equal(row.remainingCredits, 985);
  assert.equal(row.tokensLeft, Math.floor((985 / 12.5) * 1e6));
  assert.equal(row.sharedOrg, false);
  // A shorter delta is below the minimum token rule.
  state.creditHistory.org = stored(
    billingSample(90 * MINUTE, 10, 0, 0, 0),
    billingSample(100 * MINUTE, 12, MIN_RATE_TOKENS - 2, 1, 3),
  );
  const short = creditRates(state, { window: "1h", now }).accounts[0];
  assert.equal(short.status, "insufficient");
  assert.equal(short.billing, null);
  assert.equal(short.tokensLeft, null);
  // Credits that went down (frozen Credits released) give no valid rate.
  state.creditHistory.org = stored(billingSample(90 * MINUTE, 10, 0, 0, 10), billingSample(100 * MINUTE, 11, 200_000, 0, 0));
  assert.equal(creditRates(state, { window: "1h", now }).accounts[0].billing, null);
  // Samples outside the window do not count.
  assert.equal(creditRates(state, { window: "1h", now: now + 2 * HOUR }).accounts[0].status, "no_data");
  assert.throws(() => creditRates(state, { window: "2h", now }));
});

test("tokens left falls back to the seven day rate when the last day has too little data", () => {
  const now = T0 + 3 * 24 * HOUR;
  const state = {
    accounts: [account("a", "org/repo", usage(0, 0), { quota: { ...quota(10, 0, 110), syncedAt: iso(0) } })],
    creditHistory: {
      org: stored(
        billingSample(0, 0, 0, 0),
        billingSample(now - T0 - 2 * HOUR, 10, 1_000_000, 0),
        billingSample(now - T0 - HOUR, 10, 1_000_500, 0),
      ),
    },
  };
  const row = creditRates(state, { window: "24h", now }).accounts[0];
  assert.equal(row.status, "insufficient");
  assert.equal(row.tokensLeft, 10_005_000);
});

test("NNLS split recovers known input and output prices", () => {
  const intervals = Array.from({ length: 20 }, (_, i) => {
    const input = 10_000 + i * 3_700 + (i % 3) * 9_000;
    const output = 1_000 + ((i * 7) % 5) * 800;
    return { input, output, credits: input * 2e-6 + output * 8e-6 };
  });
  const fit = nnlsSplit(intervals);
  assert.ok(Math.abs(fit.a * 1e6 - 2) < 1e-6);
  assert.ok(Math.abs(fit.b * 1e6 - 8) < 1e-6);
  assert.ok(fit.r2 > 0.999);
  assert.equal(nnlsSplit(intervals.slice(0, 11)), null, "fewer than 12 intervals");
  // A negative unconstrained coefficient is clamped to zero.
  const clamped = nnlsSplit(intervals.map((item) => ({ ...item, credits: Math.max(0, item.input * 3e-6 - item.output * 1e-6) })));
  assert.ok(clamped.a >= 0 && clamped.b >= 0);
});

test("billing split is shown only for a well-conditioned fit", () => {
  const build = (noise) => {
    const samples = [billingSample(0, 0, 0, 0)];
    for (let i = 1; i <= 14; i++) {
      const last = samples.at(-1);
      const input = 20_000 + (i % 4) * 15_000;
      const output = 2_000 + (i % 3) * 3_000;
      const credits = input * 1e-6 + output * 5e-6 + (noise ? ((i * 37) % 11) * 0.05 : 0);
      samples.push(billingSample(i * MINUTE, last[1] / 1000 + credits, last[3] + input, last[4] + output));
    }
    return { accounts: [account("a", "org/repo")], creditHistory: { org: encodeHistory(samples) } };
  };
  const clean = creditRates(build(false), { window: "1h", now: T0 + 30 * MINUTE }).accounts[0].billing;
  // Billing Credits are stored in milli-Credits, so allow that rounding.
  assert.ok(Math.abs(clean.inputRate - 1) < 0.05, `input ${clean.inputRate}`);
  assert.ok(Math.abs(clean.outputRate - 5) < 0.2, `output ${clean.outputRate}`);
  const noisy = creditRates(build(true), { window: "1h", now: T0 + 30 * MINUTE }).accounts[0].billing;
  assert.ok(noisy.rate > 0);
  assert.ok(noisy.r2 < 0.8);
  assert.equal(noisy.inputRate, null);
  assert.equal(noisy.outputRate, null);
  assert.equal(billingWindow(decodeHistory(build(false).creditHistory.org, 7), T0).intervals.length, 14);
});

const snapshot = ({ credit = 0, prompt = 0, completion = 0, requests = 0, coverage = requests, supports = true, boot = "boot-1" } = {}) => ({
  bootId: boot,
  support: { credit: supports },
  counters: { credit, prompt, completion, requests },
  coverage: { credit: supports ? coverage : null },
});
const reportedHistory = (...snapshots) =>
  snapshots.reduce(
    (history, value, i) => recordReportedSample(history, value, { at: iso(i * MINUTE), reset: false }),
    null,
  );

test("reported history restarts on a baseline reset and reports missing, partial and full credit", () => {
  let history = recordReportedSample(null, snapshot(), { at: iso(0), reset: true });
  history = recordReportedSample(history, snapshot(), { at: iso(MINUTE), reset: false });
  assert.equal(reportedSamples(history).length, 1, "unchanged snapshot is skipped");
  history = recordReportedSample(
    history,
    snapshot({ credit: 4, prompt: 150_000, completion: 50_000, requests: 10 }),
    { at: iso(2 * MINUTE), reset: false },
  );
  assert.deepEqual(reportedSamples(history).at(-1), [(T0 + 2 * MINUTE) / 1000, 4_000_000, 150_000, 50_000, 10, 10]);
  const state = { accounts: [account("a", "", usage(0, 0), { creditReportHistory: history })], creditHistory: {} };
  const full = creditRates(state, { window: "1h", now: T0 + 10 * MINUTE }).accounts[0];
  assert.equal(full.reportedStatus, "ok");
  assert.deepEqual(full.reported, { rate: 20, partial: false });
  assert.equal(full.status, "no_data", "no repository means no billing estimate");
  assert.equal(full.deviation, null);
  // Partial coverage keeps the value and flags it.
  state.accounts[0].creditReportHistory = recordReportedSample(
    history,
    snapshot({ credit: 8, prompt: 300_000, completion: 100_000, requests: 20, coverage: 15 }),
    { at: iso(3 * MINUTE), reset: false },
  );
  const partial = creditRates(state, { window: "1h", now: T0 + 10 * MINUTE }).accounts[0];
  assert.equal(partial.reportedStatus, "partial");
  assert.equal(partial.reported.partial, true);
  // A new boot id restarts the history from that snapshot.
  const rebooted = recordReportedSample(
    state.accounts[0].creditReportHistory,
    snapshot({ credit: 1, prompt: 10, completion: 1, requests: 1, boot: "boot-2" }),
    { at: iso(4 * MINUTE), reset: false },
  );
  assert.equal(reportedSamples(rebooted).length, 1);
  assert.equal(rebooted.bootId, "boot-2");
  // Old workers and zero coverage are not reported.
  state.accounts[0].creditReportHistory = reportedHistory(snapshot({ supports: false }));
  assert.equal(creditRates(state, { window: "1h", now: T0 + MINUTE }).accounts[0].reportedStatus, "missing");
  state.accounts[0].creditReportHistory = reportedHistory(snapshot(), snapshot({ prompt: 200_000, requests: 5, coverage: 0 }));
  const uncovered = creditRates(state, { window: "1h", now: T0 + 2 * MINUTE }).accounts[0];
  assert.equal(uncovered.reportedStatus, "missing");
  assert.equal(uncovered.reported, null);
});

test("overall adds deltas of distinct organizations and never double counts a shared one", () => {
  const history = (credits, tokens) => stored(billingSample(0, 0, 0, 0), billingSample(10 * MINUTE, credits, tokens, 0));
  const state = {
    accounts: [
      account("a", "shared/one", usage(0, 0), {
        quota: { ...quota(0, 0, 100), syncedAt: iso(0) },
        creditReportHistory: reportedHistory(snapshot(), snapshot({ credit: 2.2, prompt: 200_000, requests: 4 })),
      }),
      account("b", "shared/two", usage(0, 0), { quota: { ...quota(0, 0, 100), syncedAt: iso(0) } }),
      account("c", "solo/repo", usage(0, 0), { quota: { ...quota(0, 0, 50), syncedAt: iso(0) } }),
      account("d", "off/repo", usage(0, 0), { enabled: false }),
    ],
    creditHistory: { shared: history(2, 200_000), solo: history(6, 200_000), off: history(100, 100_000) },
  };
  const result = creditRates(state, { window: "1h", now: T0 + 20 * MINUTE });
  const [a, b, c] = result.accounts;
  assert.equal(a.sharedOrg, true);
  assert.equal(b.sharedOrg, true);
  assert.equal(c.sharedOrg, false);
  assert.equal(a.billing.rate, 10);
  assert.equal(b.billing.rate, 10);
  assert.equal(c.billing.rate, 30);
  assert.ok(Math.abs(a.deviation - 0.1) < 1e-9);
  assert.equal(result.overall.organizations, 2);
  assert.equal(result.overall.deltaCredits, 8);
  assert.equal(result.overall.deltaTokens, 400_000);
  assert.equal(result.overall.billing.rate, 20, "summed deltas, not an average of 10, 10 and 30");
  assert.equal(result.overall.remainingCredits, 150, "shared organization remaining counted once");
  assert.ok(Math.abs(result.overall.reported.rate - 11) < 1e-9);
  assert.equal(result.overall.reportedStatus, "ok");
});

async function workerFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cnb-credit-rates-worker-"));
  const store = new Store(join(root, "data"), { allowLocal: true });
  let body = null;
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const created = store.create({
    name: "rate-worker", proxyKey: "rate-worker-key",
    endpoint: `http://127.0.0.1:${server.address().port}`,
  });
  let clock = T0;
  const monitor = new WorkerUsageMonitor(store, { now: () => clock });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    removeAll(root);
  });
  return {
    store, monitor, id: created.id,
    serve: (value) => { body = value; },
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
}
const workerSnapshot = ({ prompt, completion, credit, requests, coverage = requests, boot = "boot-a", schema = 2 }) => ({
  boot_id: boot,
  booted_at: "2026-10-31T00:00:00.000Z",
  ...(schema === 2
    ? {
        schema_version: 2,
        capabilities: { cache_hit: false, cache_miss: false, cache_write: false, credit: true },
        coverage: { prompt: requests, completion: requests, cache_hit: 0, cache_miss: 0, cache_write: 0, credit: coverage },
      }
    : {}),
  totals: { prompt, completion, requests, errors: 0, partial_requests: 0, ...(schema === 2 ? { credit } : {}) },
});

test("worker usage snapshots feed reported history and follow the boot id baseline", async (t) => {
  const app = await workerFixture(t);
  app.serve(workerSnapshot({ prompt: 1000, completion: 100, credit: 1, requests: 1 }));
  await app.monitor.read(app.id);
  app.advance(5 * MINUTE);
  app.serve(workerSnapshot({ prompt: 201_000, completion: 100_100, credit: 4, requests: 11 }));
  await app.monitor.read(app.id);
  assert.equal(reportedSamples(app.store.get(app.id).creditReportHistory).length, 2);
  let row = creditRates(app.store.state, { window: "1h", now: app.now() }).accounts[0];
  assert.equal(row.reportedStatus, "ok");
  assert.ok(Math.abs(row.reported.rate - 10) < 1e-9);
  assert.equal("creditReportHistory" in publicAccount(app.store.get(app.id)), false);
  app.advance(MINUTE);
  app.serve(workerSnapshot({ prompt: 10, completion: 1, credit: 0.01, requests: 1, boot: "boot-b" }));
  await app.monitor.read(app.id);
  assert.equal(reportedSamples(app.store.get(app.id).creditReportHistory).length, 1, "a new boot id restarts the history");
  row = creditRates(app.store.state, { window: "1h", now: app.now() }).accounts[0];
  assert.equal(row.reportedStatus, "insufficient");
  app.advance(MINUTE);
  app.serve(workerSnapshot({ prompt: 300_000, completion: 0, credit: 0, requests: 3, schema: 1 }));
  await app.monitor.read(app.id);
  row = creditRates(app.store.state, { window: "1h", now: app.now() }).accounts[0];
  assert.equal(row.reportedStatus, "missing", "an old worker does not report credit");
});

test("quota sync records billing samples that survive a restart; old documents load without history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cnb-credit-rates-store-"));
  t.after(() => removeAll(root));
  const directory = join(root, "data");
  let store = new Store(directory, { allowLocal: true });
  let clock = T0;
  let used = 10;
  const pool = new Pool(store, { now: () => clock, fetchQuotaImpl: async ({ org }) => ({ ...quota(used, 1), org }) });
  const created = store.create({ name: "rate", repo: "rate-org/repo", proxyKey: "rate-proxy-key", pat: "rate-pat" });
  await pool.quota(created.id);
  store.patch(created.id, { tokenUsage: usage(150_000, 50_000) });
  clock += MINUTE;
  used = 12;
  await pool.quota(created.id);
  assert.equal(billing(store.state, "rate-org").length, 2);
  const before = creditRates(store.state, { window: "1h", now: clock }).accounts[0];
  assert.equal(before.billing.rate, 10);
  store = new Store(directory, { allowLocal: true });
  assert.deepEqual(store.state.creditHistory, pool.store.state.creditHistory);
  assert.deepEqual(creditRates(store.state, { window: "1h", now: clock }).accounts[0], before);
  // A statistics document from 1.2.10 has no history fields.
  editMeta(directory, (meta) => {
    delete meta.creditHistory;
  });
  editAccounts(directory, (accounts) => {
    for (const account of accounts) delete account.runtime.creditReportHistory;
  });
  store = new Store(directory, { allowLocal: true });
  assert.deepEqual(store.state.creditHistory, {});
  assert.equal(store.state.accounts[0].creditReportHistory, null);
  assert.equal(creditRates(store.state, { now: clock }).accounts[0].status, "no_data");
  const good = stored(billingSample(0, 1, 1, 1));
  assert.deepEqual(loadCreditHistory({ org: [[1, 2]], legacy: [{ at: iso(0) }], other: "x", good }), { good });
});

test("credit rates API requires an admin session and validates the window", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cnb-credit-rates-api-"));
  let clock = T0;
  const app = createPanelServer({
    adminKey: "credit-rates-admin-key",
    gatewayKey: "credit-rates-gateway-key",
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    allowLocal: true,
    poolOptions: { now: () => clock, fetchQuotaImpl: async ({ org }) => ({ ...quota(clock === T0 ? 0 : 5), org }) },
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.pool.stop();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    removeAll(root);
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  for (const key of [null, "credit-rates-gateway-key"]) {
    const response = await fetch(`${base}/api/credits/rates`, key ? { headers: { Authorization: `Bearer ${key}` } } : {});
    assert.equal(response.status, 401);
  }
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "credit-rates-admin-key" }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const get = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  const created = app.store.create({ name: "api", repo: "api-org/repo", proxyKey: "api-proxy-key", pat: "api-pat" });
  await app.pool.quota(created.id);
  app.store.patch(created.id, { tokenUsage: usage(400_000, 100_000) });
  clock += 2 * MINUTE;
  await app.pool.quota(created.id);
  for (const window of ["1h", "24h", "7d"]) {
    const response = await get(`/api/credits/rates?window=${window}`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.window, window);
    assert.equal(data.accounts[0].billing.rate, 10);
    assert.equal(data.overall.billing.rate, 10);
  }
  assert.equal((await (await get("/api/credits/rates")).json()).window, "24h");
  assert.equal((await get("/api/credits/rates?window=30d")).status, 400);
  const overview = await (await get("/api/overview")).json();
  assert.equal(overview.creditRates.window, "24h");
  assert.equal(overview.creditRates.overall.billing.rate, 10);
  assert.equal("creditReportHistory" in overview.accounts[0], false);
});
