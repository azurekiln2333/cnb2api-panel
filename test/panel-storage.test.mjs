import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { logChannel } from "../src/file-storage.mjs";
import { emptyTokenUsage } from "../src/token-usage.mjs";
import { editAccounts, readAccounts, removeAll } from "./support/sqlite-fixture.mjs";

function fixture(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cnb-sqlite-storage-"));
  const directory = join(fixtureRoot, "data");
  t.after(() => removeAll(fixtureRoot));
  return new Store(directory, { allowLocal: true });
}
const account = (store, index = 0) =>
  store.create({
    name: `独立账号 ${index}`,
    repo: `org/repo-${index}`,
    proxyKey: "private-proxy",
    pat: "private-pat",
  });
const changes = (store) =>
  store.db.get("SELECT total_changes() AS total").total;
const usage = (input, output) => ({
  ...emptyTokenUsage(),
  input,
  output,
  total: input + output,
  reportedRequests: 1,
});
const request = (store, id, extra = {}) =>
  store.record({
    kind: "request",
    accountId: id,
    status: 200,
    message: "request",
    tokenUsage: usage(10, 5),
    ...extra,
  });

test("accounts, settings, statistics and logs live in separate SQLite files", (t) => {
  const store = fixture(t);
  const a = account(store);
  store.saveSso({ ...store.state.sso, clientSecret: "private-sso" });
  request(store, a.id);
  store.record({ kind: "audit", accountName: "面板", status: 200, message: "audit" });
  store.record({ kind: "health", accountId: a.id, status: 502, message: "system" });

  assert.equal(store.databaseFile, join(store.directory, "panel.sqlite"));
  assert.equal(store.logs.file, join(store.directory, "../logs/logs.sqlite"));
  assert.equal(existsSync(join(store.directory, "panel.json")), false);
  assert.equal(existsSync(join(store.directory, "accounts.json")), false);
  assert.equal(existsSync(join(store.directory, "stats.json")), false);
  assert.equal(existsSync(join(store.directory, "logs.sqlite")), false);

  // Every channel keeps its own rows and the API sees the same categories.
  for (const channel of ["requests", "audit", "system"])
    assert.equal(store.logs.count(channel), 1);
  for (const entry of store.logs.all())
    assert.ok(["requests", "audit", "system"].includes(logChannel(entry)));

  // No credential reaches the disk in clear text.
  const disk = [
    join(store.directory, "panel.sqlite"),
    join(store.directory, "panel.sqlite-wal"),
    join(store.directory, "../logs/logs.sqlite"),
  ]
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file).toString("latin1"))
    .join("");
  for (const secret of [
    "private-proxy",
    "private-pat",
    "private-sso",
    a.secrets.registrationToken,
  ])
    assert.ok(!disk.includes(secret));

  const restored = new Store(store.directory);
  assert.deepEqual(restored.get(a.id).secrets, a.secrets);
  assert.equal(restored.state.sso.clientSecret, "private-sso");
  assert.equal(restored.get(a.id).requests, 1);
  assert.equal(restored.state.tokenUsage.total, 15);
  assert.equal(restored.logs.all().length, 3);
});

test("a restart restores accounts, credentials, settings, SSO, statistics and relay state", (t) => {
  const store = fixture(t);
  const a = account(store);
  store.settings({ strategy: "failover", sessionAffinity: false, maxAttempts: 5 });
  store.saveSso({ ...store.state.sso, clientSecret: "restart-sso" });
  request(store, a.id);
  store.patch(a.id, { status: "healthy", latencyMs: 12 });
  store.commit((s) => {
    s.registrationRelay.revision = 3;
  });
  const expected = structuredClone(store.state);
  const restored = new Store(store.directory);
  assert.deepEqual(restored.state, expected);
  assert.deepEqual(restored.logs.all(), store.logs.all());
});

test("patch writes one runtime row and never re-encrypts credentials", (t) => {
  const store = fixture(t);
  const a = account(store);
  const b = account(store, 1);
  const encrypt = store.encrypt.bind(store);
  let encryptions = 0;
  store.encrypt = (value) => {
    encryptions++;
    return encrypt(value);
  };
  const before = changes(store);
  store.patch(a.id, { status: "healthy", checkedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(changes(store) - before, 1);
  assert.equal(encryptions, 0);
  assert.equal(store.get(a.id).status, "healthy");
  assert.equal(store.get(b.id).status, "pending");
  // The definition half of the row is untouched by a runtime write.
  const rows = readAccounts(store.directory);
  assert.equal(rows[0].config.status, undefined);
  assert.equal(rows[0].runtime.status, "healthy");
});

test("write volume does not grow with the number of logs or hourly buckets", (t) => {
  const small = fixture(t);
  const smallAccount = account(small);
  const large = fixture(t);
  const largeAccount = account(large);
  large.commit((s) => {
    s.hourly = Array.from({ length: 700 }, (_, index) => ({
      // Inside the 30-day window, so one record only rewrites today's bucket.
      at: new Date(Date.now() - (index + 1) * 3600000).toISOString(),
      requests: 1,
      errors: 0,
      durationMs: 1,
      accounts: { [largeAccount.id]: 1 },
      tokenUsage: usage(1, 1),
    }));
  });
  for (let index = 0; index < 1000; index++)
    large.logs.append({ kind: "request", status: 200, message: `log-${index}` });
  assert.equal(large.logs.count("requests"), 1000);

  const measure = (store, id) => {
    const before = changes(store);
    store.patch(id, { status: "healthy" });
    const patch = changes(store) - before;
    const beforeRecord = changes(store);
    request(store, id);
    return { patch, record: changes(store) - beforeRecord };
  };
  const smallCost = measure(small, smallAccount.id);
  const largeCost = measure(large, largeAccount.id);
  assert.deepEqual(largeCost, smallCost);
  // One account row for the patch; one log row, one bucket, one day, the
  // account row and the token totals for the request.
  assert.equal(smallCost.patch, 1);
  assert.ok(smallCost.record <= 6);
});

test("record appends one log row and only touches the current bucket, day and account", (t) => {
  const store = fixture(t);
  const a = account(store);
  const b = account(store, 1);
  store.commit((s) => {
    s.hourly = [
      {
        at: "2020-01-01T00:00:00.000Z",
        requests: 1,
        errors: 0,
        durationMs: 0,
        accounts: {},
        tokenUsage: emptyTokenUsage(),
      },
    ];
  });
  const logsBefore = store.logs.count("requests");
  const before = changes(store);
  request(store, a.id);
  assert.equal(store.logs.count("requests"), logsBefore + 1);
  assert.equal(store.logs.all()[0].kind, "request");
  // The stale bucket is pruned, the current one is created.
  assert.equal(store.state.hourly.length, 1);
  assert.notEqual(store.state.hourly[0].at, "2020-01-01T00:00:00.000Z");
  assert.equal(store.get(a.id).requests, 1);
  assert.equal(store.get(b.id).requests, 0);
  assert.ok(changes(store) - before <= 6);
});

test("each log channel keeps its own newest 1000 entries", (t) => {
  const store = fixture(t);
  for (let index = 0; index < 1200; index++)
    store.logs.append({ kind: "request", status: 200, message: `request-${index}` });
  for (let index = 0; index < 5; index++)
    store.logs.append({ kind: "audit", status: 200, message: `audit-${index}` });
  assert.equal(store.logs.page("requests", {}).total, 1000);
  assert.equal(store.logs.page("audit", {}).total, 5);
  assert.equal(store.logs.page("system", {}).total, 0);
  const newest = store.logs.page("requests", { limit: 1 }).logs[0];
  assert.equal(newest.message, "request-1199");
  // Physical trimming is amortised but stays bounded.
  assert.ok(store.logs.count("requests") <= 1200);
  assert.equal(store.logs.count("audit"), 5);
});

test("legacy log files are neither read nor modified", (t) => {
  const store = fixture(t);
  const a = account(store);
  const legacy = join(store.directory, "requests.log");
  const content = `${JSON.stringify({
    id: "legacy-entry",
    at: "2020-01-01T00:00:00.000Z",
    kind: "request",
    status: 200,
    message: "legacy",
  })}\n`;
  writeFileSync(legacy, content);
  request(store, a.id);
  assert.equal(readFileSync(legacy, "utf8"), content);
  assert.equal(store.logs.all().length, 1);
  assert.equal(store.logs.all()[0].message, "request");
  const restored = new Store(store.directory);
  assert.equal(restored.logs.all().length, 1);
  assert.equal(readFileSync(legacy, "utf8"), content);
});

test("a failed write throws and leaves the published state untouched", (t) => {
  const store = fixture(t);
  const a = account(store);
  const before = structuredClone(store.state);
  const saveAccounts = store.saveAccounts.bind(store);
  store.saveAccounts = () => {
    throw new Error("simulated write failure");
  };
  assert.throws(() => store.patch(a.id, { status: "healthy" }), /simulated write failure/);
  assert.deepEqual(store.state, before);
  store.saveAccounts = saveAccounts;
  store.patch(a.id, { status: "healthy" });
  assert.equal(store.get(a.id).status, "healthy");
});

test("published account objects are replaced, never modified in place", (t) => {
  const store = fixture(t);
  const a = account(store);
  const held = store.get(a.id);
  const snapshot = structuredClone(held);
  store.patch(a.id, { status: "healthy", tokenUsage: usage(1, 1) });
  assert.deepEqual(held, snapshot);
  assert.notEqual(store.get(a.id), held);
  const accounts = store.state.accounts;
  store.patch(a.id, { status: "unhealthy" });
  assert.notEqual(store.state.accounts, accounts);
  assert.equal(accounts[0].status, "healthy");
});

test("a missing key, an unknown schema and an empty database fail without resetting accounts", (t) => {
  const store = fixture(t);
  account(store);
  const key = join(store.directory, "master.key");
  store.close();
  rmSync(key);
  assert.throws(() => new Store(store.directory), /master.key is missing/);
  assert.equal(existsSync(key), false);

  const fresh = fixture(t);
  account(fresh);
  // A schema version the code does not know must refuse to start.
  fresh.db.run(
    "INSERT INTO schema_version (version, applied_at) VALUES (99, '2026-01-01')",
  );
  assert.throws(() => new Store(fresh.directory), /Unsupported panel database schema/);

  // A database with data but no settings row is incomplete, not empty.
  const orphan = fixture(t);
  account(orphan);
  orphan.db.run("DELETE FROM settings");
  assert.throws(() => new Store(orphan.directory), /Panel settings are missing/);
});

test("legacy documents beside a database are never silently ignored", (t) => {
  const store = fixture(t);
  account(store);
  writeFileSync(join(store.directory, "accounts.json"), "{}");
  assert.throws(() => new Store(store.directory), /Legacy panel data/);
});

test("slow writes are counted and reported once per window", (t) => {
  const store = fixture(t);
  const a = account(store);
  const metrics = store.metrics();
  assert.equal(metrics.slowWrites, 0);
  assert.ok(metrics.writes > 0);
  const noteWrite = store.noteWrite.bind(store);
  store.noteWrite = (operation, elapsed) => noteWrite(operation, 120);
  store.patch(a.id, { status: "healthy" });
  store.patch(a.id, { status: "unhealthy" });
  assert.equal(store.metrics().slowWrites, 2);
  assert.ok(store.metrics().maxWriteMs >= 120);
  assert.ok(store.metrics().lastSlowWriteAt);
  const reported = store.logs
    .all()
    .filter((entry) => entry.kind === "system" && entry.message.includes("存储写入耗时"));
  assert.equal(reported.length, 1);
});

test("settings and SSO survive a restart and stay encrypted at rest", (t) => {
  const store = fixture(t);
  store.settings({ strategy: "least-connections", cooldownSeconds: 30 });
  store.saveSso({ ...store.state.sso, clientSecret: "sso-secret-value" });
  const restored = new Store(store.directory);
  assert.equal(restored.state.settings.strategy, "least-connections");
  assert.equal(restored.state.settings.cooldownSeconds, 30);
  assert.equal(restored.state.sso.clientSecret, "sso-secret-value");
  const stored = store.db.get("SELECT sso FROM settings WHERE id = 1").sso;
  assert.ok(!stored.includes("sso-secret-value"));
  assert.equal(typeof JSON.parse(stored).clientSecret, "string");
});
