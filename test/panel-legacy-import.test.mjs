import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLegacyState } from "../src/legacy-store.mjs";
import { emptyTokenUsage } from "../src/token-usage.mjs";
import {
  TEST_KEY,
  pendingDocuments,
  singleFileDocuments,
  splitDocuments,
  writeDocuments,
} from "./legacy-fixtures/index.mjs";

const OPTIONS = { allowLocal: true, publicUrl: "https://panel.example.com" };

function fixture(t, documents, options) {
  const root = mkdtempSync(join(tmpdir(), "cnb-legacy-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "data");
  writeDocuments(directory, documents, options);
  return directory;
}

const snapshot = (directory) =>
  Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => [name, readFileSync(join(directory, name)).toString("base64")]),
  );

test("split documents import settings, sso, accounts, statistics and relay state unchanged", (t) => {
  const directory = fixture(t, splitDocuments());
  const before = snapshot(directory);
  const { found, state, sources } = readLegacyState(directory, OPTIONS);
  assert.equal(found, true);
  assert.deepEqual(Object.keys(state).sort(), [
    "accounts",
    "creditHistory",
    "daily",
    "hourly",
    "registrationRelay",
    "settings",
    "sso",
    "tokenUsage",
    "tokenUsageStartedAt",
  ]);
  assert.equal(state.logs, undefined);
  assert.equal(state.version, undefined);
  const alpha = state.accounts.find((account) => account.id === "acct-alpha");
  assert.deepEqual(alpha.secrets, {
    proxyKey: "fixture-proxy-alpha",
    pat: "fixture-pat-alpha",
    registrationToken: "fixture-token-alpha",
  });
  assert.equal(alpha.name, "甲账号");
  assert.equal(alpha.repo, "org/alpha");
  assert.equal(alpha.upstreamMode, "auto");
  // Runtime fields come from stats.json, not from the account document.
  assert.equal(alpha.status, "ok");
  assert.equal(alpha.requests, 42);
  assert.equal(alpha.latencyMs, 120);
  assert.equal(alpha.registrationTokenVersion, 2);
  assert.deepEqual(alpha.tokenUsage, {
    ...emptyTokenUsage(),
    input: 400,
    output: 100,
    total: 500,
  });
  assert.deepEqual(alpha.probeUsage, { requests: 2, prompt: 3, completion: 4 });
  // Derived quota protection is recomputed from the imported settings.
  assert.deepEqual(alpha.quotaProtection, {
    suspended: false,
    reason: null,
    remainingPercent: 90,
    thresholdPercent: 20,
  });
  const beta = state.accounts.find((account) => account.id === "acct-beta");
  assert.deepEqual(beta.secrets, { proxyKey: "fixture-proxy-beta", pat: "" });
  assert.equal(beta.upstreamMode, "inherit");
  assert.equal(beta.status, "pending");
  assert.equal(beta.requests, 0);
  assert.equal(beta.registeredAt, null);
  assert.equal(beta.quotaProtectionOverride, false);
  assert.deepEqual(beta.quotaProtection, {
    suspended: true,
    reason: "unknown",
    remainingPercent: null,
    thresholdPercent: 20,
  });
  assert.equal(state.settings.strategy, "failover");
  assert.equal(state.settings.sessionAffinity, false);
  assert.equal(state.settings.maxAttempts, 4);
  assert.equal(state.settings.cooldownSeconds, 90);
  assert.equal(state.settings.dshCompat, true);
  assert.equal(state.settings.claudeCodeCompat, false);
  assert.deepEqual(state.settings.requestOverrides, { operations: [] });
  assert.deepEqual(state.settings.upstreamHeaders, {
    "user-agent": "fixture/1.0",
  });
  assert.deepEqual(state.settings.registrationRelay, {
    enabled: true,
    servers: [
      {
        id: "relay-one",
        name: "联动一",
        origin: "https://relay.example.com",
        enabled: true,
      },
    ],
  });
  assert.deepEqual(state.settings.quotaProtection, {
    enabled: true,
    thresholdPercent: 20,
  });
  assert.deepEqual(state.settings.inferenceProbe, {
    enabled: true,
    intervalMinutes: 60,
  });
  assert.equal(state.sso.clientSecret, "fixture-sso-secret");
  assert.equal(state.sso.issuer, "https://sso.example.com");
  assert.equal(state.sso.enabled, true);
  assert.deepEqual(state.sso.allowedSubjects, ["subject-1"]);
  assert.deepEqual(state.sso.allowedEmails, ["admin@example.com"]);
  assert.deepEqual(state.tokenUsage, {
    ...emptyTokenUsage(),
    input: 100,
    output: 40,
    total: 140,
  });
  assert.equal(state.tokenUsageStartedAt, "2026-11-01T00:00:00.000Z");
  assert.equal(state.hourly.length, 2);
  assert.equal(state.hourly[1].tokenUsage.input, 70);
  assert.deepEqual(state.daily.accounts, ["acct-alpha"]);
  assert.equal(state.daily.days["2026-11-14"].requests, 5);
  assert.deepEqual(state.creditHistory, {
    org: [
      [1763000000, 2, 3, 4, 5, 6, 7],
      [60, 0, 0, 0, 0, 0, 0],
    ],
  });
  assert.equal(state.registrationRelay.revision, 3);
  assert.equal(state.registrationRelay.sourceId, "11111111-1111-4111-8111-111111111111");
  const delivery = state.registrationRelay.deliveries["acct-alpha/relay-one"];
  assert.equal(delivery.status, "failed");
  assert.equal(delivery.attempts, 4);
  assert.equal(delivery.lastError, "联动服务器未匹配注册密钥");
  assert.deepEqual(state.registrationRelay.receipts, {
    "acct-alpha": { "11111111-1111-4111-8111-111111111111": 2 },
  });
  assert.deepEqual(
    sources.map((source) => source.name),
    ["panel.json", "accounts.json", "stats.json"],
  );
  for (const source of sources) {
    assert.equal(source.path, join(directory, source.name));
    assert.equal(
      source.checksum,
      createHash("sha256").update(readFileSync(source.path)).digest("hex"),
    );
  }
  // Importing never rewrites, renames or deletes the old files.
  assert.deepEqual(snapshot(directory), before);
  assert.equal(TEST_KEY.length, 32);
});

test("an interrupted commit journal wins over the documents left on disk", (t) => {
  const { documents, pending } = pendingDocuments();
  const directory = fixture(t, {
    ...documents,
    "store.pending": JSON.stringify(pending),
  });
  const logs = readFileSync(join(directory, "requests.log"), "utf8");
  const { state, sources } = readLegacyState(directory, OPTIONS);
  assert.equal(
    state.accounts.find((account) => account.id === "acct-alpha").name,
    "甲账号（已改名）",
  );
  assert.equal(
    state.accounts.find((account) => account.id === "acct-alpha").requests,
    43,
  );
  assert.equal(state.settings.strategy, "round-robin");
  assert.ok(sources.some((source) => source.name === "store.pending"));
  // Log appends in the journal are ignored, not replayed.
  assert.equal(readFileSync(join(directory, "requests.log"), "utf8"), logs);
  assert.equal(existsSync(join(directory, "audit.log")), false);
  assert.equal(existsSync(join(directory, "store.pending")), true);
});

test("a version 1 single-file panel.json imports accounts, statistics and runtime fields", (t) => {
  const directory = fixture(t, singleFileDocuments());
  const { found, state } = readLegacyState(directory, OPTIONS);
  assert.equal(found, true);
  assert.equal(state.accounts.length, 1);
  const [account] = state.accounts;
  assert.equal(account.name, "甲账号");
  assert.equal(account.requests, 7);
  assert.equal(account.status, "ok");
  assert.deepEqual(account.secrets, {
    proxyKey: "fixture-proxy-alpha",
    pat: "fixture-pat-alpha",
    registrationToken: "fixture-token-alpha",
  });
  assert.equal(account.tokenUsage.input, 9);
  assert.equal(state.settings.strategy, "failover");
  assert.equal(state.sso.clientSecret, "fixture-sso-secret");
  // Version 1 had no separate credits history: it starts empty, not invented.
  assert.deepEqual(state.creditHistory, {});
  // The daily rollup is rebuilt from the hourly window, as the old loader did.
  assert.equal(state.daily.days["2026-11-14"].requests, 5);
  assert.equal(state.logs, undefined);
  // The old loader wrote panel.json.v1.bak; importing must not touch the disk.
  assert.deepEqual(
    readdirSync(directory).sort(),
    ["master.key", "panel.json"],
  );
});

test("corrupt documents, missing keys and stray files fail without touching the data", (t) => {
  const corrupt = fixture(t, splitDocuments());
  writeFileSync(join(corrupt, "stats.json"), "{not json");
  const before = snapshot(corrupt);
  assert.throws(() => readLegacyState(corrupt, OPTIONS), SyntaxError);
  assert.deepEqual(snapshot(corrupt), before);

  const noKey = fixture(t, splitDocuments(), { key: null });
  assert.throws(
    () => readLegacyState(noKey, OPTIONS),
    /master.key is missing/,
  );
  assert.equal(existsSync(join(noKey, "master.key")), false);

  const shortKey = fixture(t, splitDocuments(), { key: Buffer.alloc(16, 3) });
  assert.throws(() => readLegacyState(shortKey), /master.key is invalid/);

  const orphan = fixture(t, { "accounts.json": { version: 1, accounts: [] } });
  assert.throws(
    () => readLegacyState(orphan, OPTIONS),
    /panel.json is missing/,
  );

  const badPending = fixture(t, {
    ...splitDocuments(),
    "store.pending": "not a transaction",
  });
  assert.throws(
    () => readLegacyState(badPending, OPTIONS),
    /Invalid pending storage transaction/,
  );

  const unsupported = fixture(t, {
    "panel.json": { version: 9, settings: {}, sso: {} },
  });
  assert.throws(() => readLegacyState(unsupported), /Unsupported panel data version/);
});

test("a directory without old documents reports nothing to import", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cnb-legacy-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "data");
  writeDocuments(directory, {}, { key: TEST_KEY });
  assert.deepEqual(readLegacyState(directory, OPTIONS), {
    found: false,
    state: null,
    sources: [],
  });
  // An explicitly supplied key is used as-is and nothing is read from disk.
  assert.deepEqual(readLegacyState(directory, { key: TEST_KEY }), {
    found: false,
    state: null,
    sources: [],
  });
});
