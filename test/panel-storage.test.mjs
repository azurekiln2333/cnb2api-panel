import test from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { FileStorage, logChannel, retainLogs } from "../src/file-storage.mjs";
import { emptyTokenUsage } from "../src/token-usage.mjs";

function fixture(t) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "cnb-split-storage-"));
  const directory = join(fixtureRoot, "data");
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
  return new Store(directory, { allowLocal: true });
}
const account = (store) =>
  store.create({
    name: "独立账号",
    repo: "org/repo",
    proxyKey: "private-proxy",
    pat: "private-pat",
  });
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const lines = (file) =>
  readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
function legacy(store) {
  return {
    ...store.state,
    version: 1,
    accounts: store.state.accounts.map((a) => ({
      ...a,
      secrets: store.encrypt(a.secrets),
    })),
    sso: {
      ...store.state.sso,
      clientSecret: store.encrypt(store.state.sso.clientSecret),
    },
  };
}

test("accounts, configuration, statistics and three log streams persist separately", (t) => {
  const store = fixture(t);
  const a = account(store);
  store.saveSso({ ...store.state.sso, clientSecret: "private-sso" });
  const originals = Object.fromEntries(
    [store.file, store.accountsFile].map((file) => [
      file,
      {
        text: readFileSync(file, "utf8"),
        mtime: statSync(file, { bigint: true }).mtimeNs,
      },
    ]),
  );
  store.record({
    kind: "request",
    accountId: a.id,
    accountName: a.name,
    status: 200,
    message: "request-marker",
    tokenUsage: {
      ...emptyTokenUsage(),
      input: 7,
      output: 3,
      total: 10,
      reportedRequests: 1,
    },
  });
  store.record({
    kind: "audit",
    accountName: "面板",
    status: 200,
    message: "audit-marker",
  });
  store.record({
    kind: "health",
    accountId: a.id,
    accountName: a.name,
    status: 502,
    message: "system-marker",
  });
  for (const [file, original] of Object.entries(originals)) {
    assert.equal(readFileSync(file, "utf8"), original.text);
    assert.equal(statSync(file, { bigint: true }).mtimeNs, original.mtime);
  }
  assert.deepEqual(Object.keys(json(store.file)).sort(), [
    "settings",
    "sso",
    "version",
  ]);
  const savedAccount = json(store.accountsFile).accounts[0];
  assert.equal(typeof savedAccount.secrets, "string");
  assert.equal(savedAccount.requests, undefined);
  assert.equal(savedAccount.tokenUsage, undefined);
  assert.equal(json(store.statsFile).accounts[a.id].requests, 1);
  for (const [channel, file] of Object.entries(store.logFiles)) {
    assert.equal(file, join(store.directory, "../logs", `${channel}.log`));
    assert.equal(existsSync(join(store.directory, `${channel}.log`)), false);
    assert.ok(lines(file).every((entry) => logChannel(entry) === channel));
    assert.equal(lines(file).length, 1);
  }
  for (const file of [
    store.file,
    store.accountsFile,
    store.statsFile,
    ...Object.values(store.logFiles),
  ])
    for (const secret of [
      "private-proxy",
      "private-pat",
      "private-sso",
      a.secrets.registrationToken,
    ])
      assert.ok(!readFileSync(file, "utf8").includes(secret));
  const restored = new Store(store.directory);
  assert.deepEqual(restored.get(a.id).secrets, a.secrets);
  assert.equal(restored.get(a.id).requests, 1);
  assert.equal(restored.state.tokenUsage.total, 10);
  assert.equal(restored.state.sso.clientSecret, "private-sso");
  assert.equal(restored.state.logs.length, 3);
});

function logsInLegacyDirectory(store) {
  for (const [channel, file] of Object.entries(store.logFiles))
    renameSync(file, join(store.directory, `${channel}.log`));
}

test("existing data-directory logs migrate into a sibling logs directory and resume without duplicates", (t) => {
  const store = fixture(t);
  const a = account(store);
  for (const kind of ["request", "audit", "health"])
    store.record({
      kind,
      accountId: a.id,
      status: 200,
      message: `migrate-${kind}`,
    });
  const expected = structuredClone(store.state);
  const savedAccounts = readFileSync(store.accountsFile);
  logsInLegacyDirectory(store);
  const restored = new Store(store.directory);
  const byId = (logs) => [...logs].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    { ...restored.state, logs: byId(restored.state.logs) },
    { ...expected, logs: byId(expected.logs) },
  );
  assert.deepEqual(readFileSync(restored.accountsFile), savedAccounts);
  for (const [channel, file] of Object.entries(restored.logFiles)) {
    assert.equal(existsSync(join(store.directory, `${channel}.log`)), false);
    assert.equal(lines(file).length, 1);
  }
  restored.record({ kind: "audit", status: 200, message: "after-migration" });
  assert.equal(lines(restored.logFiles.audit).length, 2);
  assert.equal(new Store(store.directory).state.logs.length, 4);
});

test("interrupted log-directory migration resumes a completed destination copy safely", (t) => {
  const store = fixture(t);
  store.record({ kind: "request", status: 200, message: "copy-once" });
  logsInLegacyDirectory(store);
  const atomic = FileStorage.prototype.atomic;
  try {
    FileStorage.prototype.atomic = function (name, bytes) {
      atomic.call(this, name, bytes);
      throw new Error("stopped after copying a log");
    };
    assert.throws(() => new Store(store.directory), /stopped after copying/);
  } finally {
    FileStorage.prototype.atomic = atomic;
  }
  assert.equal(existsSync(join(store.directory, "requests.log")), true);
  const restored = new Store(store.directory);
  assert.equal(restored.state.logs.length, 1);
  assert.equal(lines(restored.logFiles.requests).length, 1);
  assert.equal(existsSync(join(store.directory, "requests.log")), false);
});

test("old pending appends recover after moving logs out of the data directory", (t) => {
  const store = fixture(t);
  const a = account(store);
  store.record({
    kind: "request",
    accountId: a.id,
    status: 200,
    message: "before",
  });
  const apply = store.storage.apply.bind(store.storage);
  store.storage.apply = (operations) => {
    apply(operations.filter((operation) => operation.type === "replace"));
    const append = operations.find((operation) => operation.type === "append");
    appendFileSync(
      store.storage.path(append.file),
      Buffer.from(append.text).subarray(0, 17),
    );
    throw new Error("old process interrupted");
  };
  assert.throws(
    () =>
      store.record({
        kind: "request",
        accountId: a.id,
        status: 200,
        message: "recovered",
      }),
    /old process interrupted/,
  );
  logsInLegacyDirectory(store);
  const restored = new Store(store.directory);
  assert.equal(restored.get(a.id).requests, 2);
  assert.deepEqual(
    lines(restored.logFiles.requests).map((entry) => entry.message),
    ["before", "recovered"],
  );
  assert.equal(new Store(store.directory).get(a.id).requests, 2);
});

test("conflicting destination logs stop migration without overwriting either copy", (t) => {
  const store = fixture(t);
  store.record({ kind: "audit", status: 200, message: "original" });
  const source = join(store.directory, "audit.log");
  copyFileSync(store.logFiles.audit, source);
  const target = readFileSync(store.logFiles.audit);
  appendFileSync(
    source,
    JSON.stringify({
      id: "other",
      at: new Date().toISOString(),
      kind: "audit",
      message: "conflict",
    }) + "\n",
  );
  const original = readFileSync(source);
  assert.throws(
    () => new Store(store.directory),
    /destination already has different logs/,
  );
  assert.deepEqual(readFileSync(source), original);
  assert.deepEqual(readFileSync(store.logFiles.audit), target);
});

test("a custom log directory works and logs cannot be placed inside the data directory", (t) => {
  const store = fixture(t);
  const logDir = join(store.directory, "../operator-logs");
  const configured = new Store(store.directory, { logDir });
  configured.record({
    kind: "audit",
    status: 200,
    message: "custom-directory",
  });
  assert.equal(configured.logFiles.audit, join(logDir, "audit.log"));
  assert.equal(
    new Store(store.directory, { logDir }).state.logs[0].message,
    "custom-directory",
  );
  for (const invalid of [store.directory, join(store.directory, "logs")])
    assert.throws(
      () => new Store(store.directory, { logDir: invalid }),
      /outside PANEL_DATA_DIR/,
    );
});

test("legacy panel.json migrates without losing accounts, credentials, metrics or event categories", (t) => {
  const store = fixture(t);
  const a = account(store);
  store.settings({ strategy: "failover", sessionAffinity: false });
  store.saveSso({ ...store.state.sso, clientSecret: "legacy-sso" });
  store.record({
    kind: "request",
    accountId: a.id,
    status: 200,
    message: "old-request",
  });
  store.record({
    kind: "account",
    accountId: a.id,
    status: 201,
    message: "old-audit",
  });
  store.record({
    kind: "wake",
    accountId: a.id,
    status: 200,
    message: "old-system",
  });
  const original = JSON.stringify(legacy(store));
  writeFileSync(store.file, original);
  const expected = structuredClone(store.state);
  const migrated = new Store(store.directory);
  assert.equal(
    readFileSync(join(store.directory, "panel.json.v1.bak"), "utf8"),
    original,
  );
  assert.deepEqual(migrated.state, expected);
  assert.equal(json(store.file).version, 2);
  assert.equal(json(store.file).accounts, undefined);
  assert.equal(json(store.file).logs, undefined);
  assert.equal(lines(store.logFiles.audit)[0].message, "old-audit");
  assert.equal(lines(store.logFiles.requests)[0].message, "old-request");
  assert.equal(lines(store.logFiles.system)[0].message, "old-system");
  assert.deepEqual(
    new Store(store.directory).state.accounts,
    expected.accounts,
  );
  assert.equal(
    readFileSync(join(store.directory, "panel.json.v1.bak"), "utf8"),
    original,
  );
});

test("an interrupted multi-file write recovers once and keeps encrypted credentials in its journal", (t) => {
  const store = fixture(t);
  const originalApply = store.storage.apply.bind(store.storage);
  store.storage.apply = (operations) => {
    originalApply(operations.slice(0, 1));
    throw new Error("simulated process interruption");
  };
  assert.throws(() => account(store), /simulated process interruption/);
  assert.equal(store.state.accounts.length, 0);
  const pending = readFileSync(store.storage.pending, "utf8");
  assert.ok(!pending.includes("private-proxy"));
  assert.throws(() => store.settings({ strategy: "failover" }), /pending/);
  const recovered = new Store(store.directory);
  assert.equal(recovered.state.accounts.length, 1);
  assert.equal(recovered.state.accounts[0].secrets.proxyKey, "private-proxy");
  assert.equal(existsSync(store.storage.pending), false);
  assert.equal(new Store(store.directory).state.accounts.length, 1);
});

test("interrupted log appends recover partial UTF-8 writes without duplication or lost totals", (t) => {
  const store = fixture(t);
  const a = account(store);
  const originalApply = store.storage.apply.bind(store.storage);
  store.storage.apply = (operations) => {
    originalApply(operations.filter((op) => op.type === "replace"));
    const append = operations.find((op) => op.type === "append");
    const bytes = Buffer.from(append.text, "utf8");
    const emojiOffset = bytes.indexOf(Buffer.from("😀", "utf8"));
    assert.ok(emojiOffset >= 0);
    appendFileSync(
      store.storage.path(append.file),
      bytes.subarray(0, emojiOffset + 2),
    );
    throw new Error("interrupted append");
  };
  assert.throws(
    () =>
      store.record({
        kind: "request",
        accountId: a.id,
        status: 200,
        message: "恢复😀",
      }),
    /interrupted append/,
  );
  const recovered = new Store(store.directory);
  assert.equal(recovered.get(a.id).requests, 1);
  assert.equal(lines(store.logFiles.requests).length, 1);
  assert.equal(lines(store.logFiles.requests)[0].message, "恢复😀");
  assert.equal(new Store(store.directory).get(a.id).requests, 1);
});

test("a completed append followed by interruption is not replayed twice", (t) => {
  const store = fixture(t);
  const apply = store.storage.apply.bind(store.storage);
  store.storage.apply = (operations) => {
    apply(operations);
    throw new Error("stopped before clearing journal");
  };
  assert.throws(() =>
    store.record({ kind: "audit", status: 200, message: "only-once" }),
  );
  const restored = new Store(store.directory);
  assert.equal(restored.state.logs.length, 1);
  assert.equal(lines(store.logFiles.audit).length, 1);
});

test("interrupted legacy migration resumes from the durable journal and preserves its original backup", (t) => {
  const store = fixture(t);
  const a = account(store);
  store.record({
    kind: "request",
    accountId: a.id,
    status: 200,
    message: "legacy-before-interruption",
  });
  const original = JSON.stringify(legacy(store));
  writeFileSync(store.file, original);
  const apply = FileStorage.prototype.apply;
  try {
    FileStorage.prototype.apply = function (operations) {
      apply.call(this, operations.slice(0, 1));
      throw new Error("migration stopped");
    };
    assert.throws(() => new Store(store.directory), /migration stopped/);
  } finally {
    FileStorage.prototype.apply = apply;
  }
  const restored = new Store(store.directory);
  assert.equal(restored.get(a.id).secrets.proxyKey, "private-proxy");
  assert.equal(restored.get(a.id).requests, 1);
  assert.equal(lines(store.logFiles.requests).length, 1);
  assert.equal(
    readFileSync(join(store.directory, "panel.json.v1.bak"), "utf8"),
    original,
  );
  assert.equal(json(store.file).version, 2);
});

test("each log stream has independent retention and compaction leaves other files unchanged", (t) => {
  const store = fixture(t);
  const requests = Array.from({ length: 2000 }, (_, i) => ({
    id: `request-${i}`,
    at: new Date(i).toISOString(),
    kind: "request",
    status: 200,
    message: `request-${i}`,
  }));
  writeFileSync(
    store.logFiles.requests,
    requests.map((entry) => JSON.stringify(entry) + "\n").join(""),
  );
  store.record({ kind: "audit", status: 200, message: "audit-retained" });
  store.record({ kind: "health", status: 502, message: "system-retained" });
  const before = readFileSync(store.logFiles.audit, "utf8");
  const restored = new Store(store.directory);
  assert.equal(
    restored.state.logs.filter((entry) => entry.kind === "request").length,
    1000,
  );
  restored.record({ kind: "request", status: 200, message: "newest" });
  assert.equal(lines(store.logFiles.requests).length, 1000);
  assert.equal(lines(store.logFiles.requests).at(-1).message, "newest");
  assert.equal(readFileSync(store.logFiles.audit, "utf8"), before);
  assert.equal(new Store(store.directory).state.logs.length, 1002);
  assert.equal(retainLogs([...requests].reverse()).length, 1000);
});

test("missing keys, invalid documents and mixed log categories fail without resetting saved accounts", (t) => {
  const store = fixture(t);
  account(store);
  const original = readFileSync(store.accountsFile, "utf8");
  const key = join(store.directory, "master.key");
  const keyBytes = readFileSync(key);
  rmSync(key);
  assert.throws(() => new Store(store.directory), /master.key is missing/);
  assert.equal(existsSync(key), false);
  writeFileSync(key, keyBytes);
  writeFileSync(
    store.logFiles.audit,
    '{"id":"wrong","at":"2026-10-25","kind":"request"}\n',
  );
  assert.throws(() => new Store(store.directory), /Invalid event category/);
  writeFileSync(store.logFiles.audit, "");
  writeFileSync(store.statsFile, "invalid json");
  assert.throws(() => new Store(store.directory));
  assert.equal(readFileSync(store.accountsFile, "utf8"), original);
});
