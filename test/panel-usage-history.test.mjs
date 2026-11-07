import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createPanelServer } from "../src/app.mjs";
import { Store } from "../src/store.mjs";
import {
  DAILY_RETENTION_DAYS,
  HISTORY_DAYS,
  emptyDaily,
  packTokenUsage,
  recordDaily,
  unpackTokenUsage,
  usageDate,
  usageHistory,
} from "../src/usage-history.mjs";
import { emptyTokenUsage } from "../src/token-usage.mjs";

const ADMIN = "synthetic-panel-admin";
const GATEWAY = "synthetic-gateway-key";
const PROXY = "synthetic-workspace-key";
const DAY_MS = 86_400_000;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "panel-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return new Store(join(root, "data"), { allowLocal: true });
}

const usage = (input, output, extra = {}) => ({
  ...emptyTokenUsage(),
  input,
  output,
  total: input + output,
  reportedRequests: 1,
  ...extra,
});

const saved = (store) => JSON.parse(readFileSync(store.statsFile, "utf8"));
const rewrite = (store, change) => {
  const stats = saved(store);
  change(stats);
  writeFileSync(store.statsFile, JSON.stringify(stats));
  return new Store(store.directory, { allowLocal: true });
};

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("packed token counters round-trip every coverage field", () => {
  const full = {
    input: 850_000,
    output: 62_000,
    cacheRead: 610_000,
    cacheWrite: 24_000,
    total: 912_000,
    reportedRequests: 83,
    missingRequests: 2,
    partialRequests: 1,
    cacheReadReported: 80,
    cacheWriteReported: 0,
  };
  for (const requests of [0, 85, 120])
    assert.deepEqual(unpackTokenUsage(packTokenUsage(full, requests), requests), full);
  // Fully measured traffic drops every coverage slot.
  assert.equal(
    packTokenUsage(
      { ...full, partialRequests: 0, cacheReadReported: 83, cacheWriteReported: 83 },
      85,
    ),
    "i7v4:1bu8:d2og:iio:2",
  );
  // A total beyond input + output survives as its own slot.
  assert.equal(unpackTokenUsage(packTokenUsage({ ...full, total: 1_000_000 })).total, 1_000_000);
  assert.equal(packTokenUsage(emptyTokenUsage()), "");
  assert.deepEqual(unpackTokenUsage(""), emptyTokenUsage());
  assert.deepEqual(unpackTokenUsage(undefined), emptyTokenUsage());
});

test("hourly buckets keep per-account tokens and old buckets still load", (t) => {
  const store = fixture(t);
  const a = store.create({ name: "账号 A", proxyKey: PROXY });
  const b = store.create({ name: "账号 B", proxyKey: PROXY });
  const c = store.create({ name: "账号 C", proxyKey: PROXY });
  store.record({ kind: "request", accountId: a.id, status: 200, tokenUsage: usage(10, 5) });
  store.record({ kind: "request", accountId: a.id, status: 200, tokenUsage: usage(1, 1) });
  store.record({ kind: "request", accountId: b.id, status: 200, tokenUsage: usage(2, 2) });
  const bucket = store.state.hourly.at(-1);
  const split = (id) => unpackTokenUsage(store.state.hourly.at(-1).accountTokens[id]);
  assert.equal(split(a.id).input, 11);
  assert.equal(split(a.id).output, 6);
  assert.equal(split(a.id).reportedRequests, 2);
  assert.equal(split(b.id).total, 4);
  // Only accounts with traffic in the hour get an entry.
  assert.deepEqual(Object.keys(bucket.accountTokens).sort(), [a.id, b.id].sort());
  assert.equal(c.id in bucket.accountTokens, false);
  assert.deepEqual(bucket.accounts, { [a.id]: 2, [b.id]: 1 });

  // A retried request keeps each attempt under its own account.
  store.record({
    kind: "request",
    accountId: b.id,
    status: 200,
    tokenUsage: usage(3, 3),
    usageAttempts: [
      { accountId: a.id, tokenUsage: usage(7, 0) },
      { accountId: b.id, tokenUsage: usage(3, 3) },
    ],
  });
  assert.equal(split(a.id).input, 18);
  assert.equal(split(b.id).total, 10);

  // A bucket saved before accountTokens existed keeps an unknown split, also
  // after it receives more traffic in the same hour.
  const reloaded = rewrite(store, (stats) => {
    for (const entry of stats.hourly) delete entry.accountTokens;
  });
  assert.equal(reloaded.state.hourly.at(-1).accountTokens, undefined);
  reloaded.record({ kind: "request", accountId: a.id, status: 200, tokenUsage: usage(1, 1) });
  const after = reloaded.state.hourly.at(-1);
  assert.equal(after.accountTokens, undefined);
  // 10 + 1 + 2 + 3 + 1: the retried request contributes its final measurement.
  assert.equal(after.tokenUsage.input, 17);
  assert.equal(after.requests, 5);
});

test("daily rollup counts requests, errors and per-account tokens", (t) => {
  const store = fixture(t);
  const a = store.create({ name: "账号 A", proxyKey: PROXY });
  const b = store.create({ name: "账号 B", proxyKey: PROXY });
  store.record({ kind: "request", accountId: a.id, status: 200, tokenUsage: usage(10, 5) });
  store.record({ kind: "request", accountId: a.id, status: 502 });
  store.record({
    kind: "request",
    accountId: b.id,
    status: 200,
    tokenUsage: usage(3, 3),
    usageAttempts: [
      { accountId: a.id, tokenUsage: usage(7, 0) },
      { accountId: b.id, tokenUsage: usage(3, 3) },
    ],
  });
  // Audit entries never reach the usage rollups.
  store.record({ kind: "audit", action: "noop" });
  const history = usageHistory(store.state, 7);
  const today = history.days.at(-1);
  assert.equal(today.requests, 3);
  assert.equal(today.errors, 1);
  assert.equal(today.tokenUsage.input, 13);
  assert.equal(today.tokenUsage.reportedRequests, 2);
  assert.equal(today.partial, false);
  const [first, second] = history.accounts;
  // Requests follow the final account. Tokens follow each attempt.
  assert.equal(first.accountId, a.id);
  assert.equal(first.requests, 2);
  assert.equal(first.tokenUsage.input, 17);
  assert.equal(first.tokenUsage.reportedRequests, 2);
  assert.equal(second.accountId, b.id);
  assert.equal(second.requests, 1);
  assert.equal(second.tokenUsage.total, 6);

  // The rollup persists with the other statistics.
  const restored = new Store(store.directory, { allowLocal: true });
  assert.deepEqual(restored.state.daily, store.state.daily);
  assert.deepEqual(saved(store).daily, store.state.daily);
});

test("daily rollup splits on UTC+8 midnight and expires after its retention", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-03-01T15:59:00.000Z") });
  const store = fixture(t);
  const a = store.create({ name: "账号 A", proxyKey: PROXY });
  const b = store.create({ name: "账号 B", proxyKey: PROXY });
  store.record({ kind: "request", accountId: a.id, status: 200, tokenUsage: usage(10, 5) });
  assert.deepEqual(Object.keys(store.state.daily.days), ["2026-03-01"]);

  // 16:00Z is midnight in UTC+8.
  t.mock.timers.setTime(Date.parse("2026-03-01T16:00:00.000Z"));
  store.record({ kind: "request", accountId: b.id, status: 502, tokenUsage: usage(1, 1) });
  assert.deepEqual(Object.keys(store.state.daily.days).sort(), ["2026-03-01", "2026-03-02"]);
  assert.equal(usageHistory(store.state, 7).days.at(-2).tokenUsage.input, 10);
  assert.equal(store.state.daily.days["2026-03-02"].errors, 1);
  assert.deepEqual(store.state.daily.accounts, [a.id, b.id]);

  // Day 400 after the first one drops it and the account it alone referenced.
  const later = Date.parse("2026-03-01T15:59:00.000Z") + DAILY_RETENTION_DAYS * DAY_MS;
  t.mock.timers.setTime(later);
  store.record({ kind: "request", accountId: b.id, status: 200, tokenUsage: usage(1, 1) });
  assert.deepEqual(Object.keys(store.state.daily.days), ["2026-03-02", usageDate(later)]);
  assert.deepEqual(store.state.daily.accounts, [b.id]);
  const history = usageHistory(store.state, 365);
  assert.equal(history.accounts.length, 1);
  assert.equal(history.accounts[0].accountId, b.id);
  assert.equal(history.accounts[0].requests, 1);
});

test("state without a daily rollup backfills from hourly and marks it partial", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-03-05T02:00:00.000Z") });
  const store = fixture(t);
  const a = store.create({ name: "账号 A", proxyKey: PROXY });
  store.record({ kind: "request", accountId: a.id, status: 200, tokenUsage: usage(10, 5) });
  t.mock.timers.setTime(Date.parse("2026-03-05T03:00:00.000Z"));
  store.record({ kind: "request", accountId: a.id, status: 502 });
  const original = saved(store);

  const reloaded = rewrite(store, (stats) => {
    delete stats.daily;
    for (const entry of stats.hourly) delete entry.accountTokens;
  });
  const history = usageHistory(reloaded.state, 7);
  const day = history.days.at(-1);
  assert.equal(day.date, "2026-03-05");
  assert.equal(day.partial, true);
  assert.equal(day.requests, 2);
  assert.equal(day.errors, 1);
  assert.equal(day.tokenUsage.input, 10);
  assert.equal(history.totals.partial, true);
  // Request counts survive. The per-account token split is unknown.
  assert.equal(history.accounts[0].requests, 2);
  assert.equal(history.accounts[0].tokenUsage.total, 0);
  assert.equal(history.accounts[0].partial, true);

  // The next commit persists the rebuilt rollup, and new traffic adds to it.
  reloaded.record({ kind: "request", accountId: a.id, status: 200, tokenUsage: usage(1, 1) });
  const persisted = saved(reloaded).daily;
  assert.equal(persisted.days["2026-03-05"].partial, true);
  assert.equal(persisted.days["2026-03-05"].requests, 3);

  // Hourly buckets that already carry the split rebuild complete days.
  const complete = rewrite(store, (stats) => {
    Object.assign(stats, original);
    delete stats.daily;
  });
  const rebuilt = usageHistory(complete.state, 7);
  assert.equal(rebuilt.days.at(-1).partial, false);
  assert.equal(rebuilt.accounts[0].tokenUsage.input, 10);
});

test("saved rollups load leniently and the size budget stays small", (t) => {
  const store = fixture(t);
  const a = store.create({ name: "账号 A", proxyKey: PROXY });
  const loaded = rewrite(store, (stats) => {
    stats.daily = {
      accounts: [a.id],
      days: {
        "2026-03-01": { requests: 2, tokens: "a:5", accounts: "0:2:a:5,7:1:3", partial: true },
        "not-a-date": { requests: 9 },
        "2026-03-02": null,
      },
    };
  });
  assert.deepEqual(Object.keys(loaded.state.daily.days), ["2026-03-01"]);
  // The row for an unknown account index is dropped.
  assert.equal(loaded.state.daily.days["2026-03-01"].accounts, "0:2:a:5");
  assert.equal(rewrite(store, (stats) => (stats.daily = [])).state.daily.accounts.length, 0);

  // 400 days x 10 busy accounts must stay cheap to clone and serialize on
  // every commit.
  const daily = emptyDaily();
  const ids = Array.from({ length: 10 }, () => randomUUID());
  const start = Date.parse("2026-01-01T04:00:00.000Z");
  for (let index = 0; index < DAILY_RETENTION_DAYS; index++)
    for (const id of ids)
      recordDaily(
        daily,
        {
          accountId: id,
          status: 200,
          tokenUsage: usage(850_000, 62_000, {
            cacheRead: 610_000,
            cacheWrite: 24_000,
            cacheReadReported: 1,
            cacheWriteReported: 1,
          }),
        },
        start + index * DAY_MS,
      );
  assert.equal(Object.keys(daily.days).length, DAILY_RETENTION_DAYS);
  assert.ok(Buffer.byteLength(JSON.stringify(daily)) < 150_000);
});

test("usage history zero-fills missing days and totals each account", (t) => {
  const now = Date.parse("2026-03-10T04:00:00.000Z");
  t.mock.timers.enable({ apis: ["Date"], now });
  const store = fixture(t);
  const a = store.create({ name: "主账号", proxyKey: PROXY });
  const b = store.create({ name: "备用账号", proxyKey: PROXY });
  store.record({ kind: "request", accountId: a.id, status: 200, tokenUsage: usage(1200, 300) });
  store.record({ kind: "request", accountId: b.id, status: 200, tokenUsage: usage(10, 5) });
  t.mock.timers.setTime(now + 2 * DAY_MS);
  store.record({ kind: "request", accountId: b.id, status: 500, tokenUsage: usage(1, 1) });

  assert.deepEqual(HISTORY_DAYS, [7, 30, 90, 365]);
  const history = usageHistory(store.state, 7);
  assert.deepEqual(history.range, { days: 7, from: "2026-03-06", to: "2026-03-12" });
  assert.deepEqual(
    history.days.map((day) => day.date),
    [
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
      "2026-03-11",
      "2026-03-12",
    ],
  );
  assert.deepEqual(history.days[5], {
    date: "2026-03-11",
    requests: 0,
    errors: 0,
    tokenUsage: emptyTokenUsage(),
    partial: false,
  });
  assert.equal(history.days[4].requests, 2);
  assert.equal(history.days.at(-1).errors, 1);
  assert.equal(history.totals.requests, 3);
  assert.equal(history.totals.errors, 1);
  assert.equal(history.totals.tokenUsage.total, 1_517);
  assert.equal(history.totals.partial, false);
  // Sorted by token total, descending, with the current account names.
  assert.deepEqual(history.accounts.map((row) => row.accountId), [a.id, b.id]);
  assert.equal(history.accounts[0].name, "主账号");
  assert.equal(history.accounts[0].tokenUsage.total, 1_500);
  assert.equal(history.accounts[1].requests, 2);
  assert.equal(history.accounts[1].tokenUsage.total, 17);

  // Days that fall outside the range are left out of every total.
  t.mock.timers.setTime(now + 8 * DAY_MS);
  const shifted = usageHistory(store.state, 7);
  assert.equal(shifted.totals.requests, 1);
  assert.deepEqual(shifted.accounts.map((row) => row.accountId), [b.id]);
  // A deleted account keeps its usage under an empty name.
  store.remove(b.id);
  assert.equal(usageHistory(store.state, 7).accounts[0].name, "");
});

test("the history API enforces its ranges and needs an admin session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "panel-history-api-"));
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: GATEWAY,
    dataDir: join(root, "data"),
    allowLocal: true,
  });
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${base}/api/usage/history?days=7`)).status, 401);
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = (path) => fetch(`${base}${path}`, { headers: { Cookie: cookie } });

  const empty = await (await call("/api/usage/history?days=7")).json();
  assert.equal(empty.days.length, 7);
  assert.equal(empty.totals.requests, 0);
  assert.deepEqual(empty.accounts, []);

  const account = app.store.create({ name: "历史账号", proxyKey: PROXY });
  app.store.record({
    kind: "request",
    accountId: account.id,
    status: 200,
    tokenUsage: usage(1200, 300),
  });

  for (const days of HISTORY_DAYS) {
    const range = await (await call(`/api/usage/history?days=${days}`)).json();
    assert.equal(range.days.length, days);
    assert.equal(range.range.days, days);
    assert.equal(range.days.at(-1).date, usageDate(Date.now()));
    assert.equal(range.days.at(-1).requests, 1);
    assert.equal(range.days.at(-1).tokenUsage.input, 1_200);
    assert.equal(range.accounts[0].accountId, account.id);
    assert.equal(range.accounts[0].name, "历史账号");
    assert.equal(range.totals.tokenUsage.total, 1_500);
  }
  // A missing parameter falls back to 30 days. Other values are rejected.
  assert.equal((await (await call("/api/usage/history")).json()).days.length, 30);
  for (const days of [1, 14, 366, "abc", ""])
    assert.equal((await call(`/api/usage/history?days=${days}`)).status, 400);

  // The overview keeps polling light: the per-account split stays server-side.
  const overview = await (await call("/api/overview")).json();
  assert.equal(overview.hourly.length, 1);
  assert.equal("accountTokens" in overview.hourly[0], false);
  assert.ok(app.store.state.hourly[0].accountTokens[account.id]);
});
