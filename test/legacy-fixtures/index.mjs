import { createCipheriv } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyTokenUsage } from "../../src/token-usage.mjs";
import { packTokenUsage } from "../../src/usage-history.mjs";

// Test-only key material for synthetic fixtures. It must never match a real
// deployment key, and no fixture may contain a real credential (implement.md 6).
export const TEST_KEY = Buffer.from("cnb-legacy-fixture-test-key-0001");
if (TEST_KEY.length !== 32) throw new Error("fixture key must be 32 bytes");

// Deterministic IVs keep fixtures byte-stable between runs without weakening
// anything: the key only ever protects synthetic fixture payloads.
let iv = 0;
export function seal(value) {
  const vector = Buffer.alloc(12);
  vector.writeUInt32BE(++iv, 8);
  const cipher = createCipheriv("aes-256-gcm", TEST_KEY, vector);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([vector, cipher.getAuthTag(), data]).toString("base64");
}

export const RELAY_SOURCE = "11111111-1111-4111-8111-111111111111";

const alpha = {
  id: "acct-alpha",
  name: "甲账号",
  repo: "org/alpha",
  group: "默认分组",
  endpoint: "https://alpha-9001.cnb.run",
  models: ["m-alpha"],
  upstreamMode: "auto",
  secrets: seal({
    proxyKey: "fixture-proxy-alpha",
    pat: "fixture-pat-alpha",
    registrationToken: "fixture-token-alpha",
  }),
};

const beta = {
  id: "acct-beta",
  name: "乙账号",
  repo: "org/beta",
  group: "备用分组",
  endpoint: "https://beta-9001.cnb.run",
  models: [],
  upstreamMode: "",
  secrets: seal({ proxyKey: "fixture-proxy-beta", pat: "" }),
};

const settings = {
  strategy: "failover",
  sessionAffinity: false,
  maxAttempts: 4,
  cooldownSeconds: 90,
  healthIntervalSeconds: 60,
  connectTimeoutSeconds: 20,
  idleTimeoutSeconds: 300,
  dshCompat: true,
  claudeCodeCompat: false,
  requestOverrides: { operations: [] },
  upstreamHeaders: { "User-Agent": "fixture/1.0" },
  registrationRelay: {
    enabled: true,
    servers: [
      {
        id: "relay-one",
        name: "联动一",
        origin: "https://relay.example.com",
        enabled: true,
      },
    ],
  },
  quotaProtection: { enabled: true, thresholdPercent: 20 },
  inferenceProbe: { enabled: true, intervalMinutes: 60 },
};

const sso = {
  enabled: true,
  keyLoginEnabled: true,
  issuer: "https://sso.example.com",
  clientId: "fixture-client",
  clientSecret: seal("fixture-sso-secret"),
  scope: "openid profile email",
  providerName: "测试 SSO",
  allowedSubjects: ["subject-1"],
  allowedEmails: ["admin@example.com"],
  callbackUrl: "https://panel.example.com/callback",
};

const tokenUsage = { ...emptyTokenUsage(), input: 100, output: 40, total: 140 };

const hourly = [
  {
    at: "2026-11-14T01:00:00.000Z",
    requests: 3,
    errors: 1,
    accounts: { "acct-alpha": 3 },
    accountTokens: { "acct-alpha": packTokenUsage({ input: 30, output: 10 }, 3) },
    tokenUsage: { ...emptyTokenUsage(), input: 30, output: 10, total: 40 },
  },
  {
    at: "2026-11-14T02:00:00.000Z",
    requests: 2,
    accounts: { "acct-alpha": 2 },
    accountTokens: { "acct-alpha": packTokenUsage({ input: 70, output: 30 }, 2) },
    tokenUsage: { ...emptyTokenUsage(), input: 70, output: 30, total: 100 },
  },
];

const daily = {
  accounts: ["acct-alpha"],
  days: {
    "2026-11-14": {
      requests: 5,
      errors: 1,
      tokens: packTokenUsage({ input: 100, output: 40 }, 5),
      accounts: { "0": { requests: 5 } },
    },
  },
};

const relayRuntime = {
  version: 1,
  sourceId: RELAY_SOURCE,
  revision: 3,
  generations: {
    "acct-alpha": {
      revision: 3,
      endpoint: "https://alpha-9001.cnb.run",
      credentialVersion: 2,
      local: true,
    },
  },
  deliveries: {
    "acct-alpha/relay-one": {
      accountId: "acct-alpha",
      serverId: "relay-one",
      origin: "https://relay.example.com",
      endpoint: "https://alpha-9001.cnb.run",
      revision: 3,
      credentialVersion: 2,
      status: "failed",
      attempts: 4,
      nextAttemptAt: 1763000000000,
      paused: false,
      lastAttemptAt: "2026-11-14T02:00:00.000Z",
      lastSuccessAt: "2026-11-13T02:00:00.000Z",
      lastError: "联动服务器未匹配注册密钥",
    },
  },
  receipts: { "acct-alpha": { [RELAY_SOURCE]: 2 } },
};

const alphaRuntime = {
  status: "ok",
  checkedAt: "2026-11-14T02:00:00.000Z",
  latencyMs: 120,
  requests: 42,
  errors: 1,
  quota: {
    org: "org",
    syncedAt: "2026-11-14T02:00:00.000Z",
    credits: { total: 1000, used: 100, freeze: 0 },
  },
  quotaSync: { status: "ok", syncedAt: "2026-11-14T02:00:00.000Z" },
  tokenUsage: { ...emptyTokenUsage(), input: 400, output: 100, total: 500 },
  probeUsage: { requests: 2, prompt: 3, completion: 4 },
  registrationTokenVersion: 2,
};

// Three documents written by the current release, plus an old log file that
// must stay untouched.
export function splitDocuments() {
  return {
    "panel.json": { version: 2, settings, sso },
    "accounts.json": { version: 1, accounts: [alpha, beta] },
    "stats.json": {
      version: 1,
      hourly,
      daily,
      tokenUsage,
      tokenUsageStartedAt: "2026-11-01T00:00:00.000Z",
      registrationRelay: relayRuntime,
      creditHistory: { org: [[1763000000, 2, 3, 4, 5, 6, 7], [60, 0, 0, 0, 0, 0, 0]] },
      accounts: { "acct-alpha": alphaRuntime },
    },
    "requests.log": `${JSON.stringify({ id: "old-request", at: "2026-11-14T02:00:00.000Z", kind: "request", message: "旧日志" })}\n`,
  };
}

// Version 1 kept accounts, statistics and logs inside panel.json.
export function singleFileDocuments() {
  return {
    "panel.json": {
      version: 1,
      accounts: [
        {
          ...alpha,
          requests: 7,
          status: "ok",
          tokenUsage: { ...emptyTokenUsage(), input: 9, output: 1, total: 10 },
        },
      ],
      logs: [
        { id: "v1-log", at: "2026-11-14T02:00:00.000Z", kind: "request" },
      ],
      settings,
      sso,
      hourly,
      tokenUsage,
      tokenUsageStartedAt: "2026-11-01T00:00:00.000Z",
      registrationRelay: relayRuntime,
    },
  };
}

// A journal written by an interrupted multi-document commit: the replacements
// passed to the journal are the newest text, the files on disk are older.
export function pendingDocuments() {
  const stale = splitDocuments();
  const updated = splitDocuments();
  updated["accounts.json"].accounts[0] = { ...alpha, name: "甲账号（已改名）" };
  updated["stats.json"].accounts["acct-alpha"] = { ...alphaRuntime, requests: 43 };
  updated["panel.json"] = {
    version: 2,
    settings: { ...settings, strategy: "round-robin" },
    sso,
  };
  return {
    documents: stale,
    pending: {
      version: 1,
      operations: [
        { type: "replace", file: "accounts.json", text: JSON.stringify(updated["accounts.json"]) },
        { type: "replace", file: "stats.json", text: JSON.stringify(updated["stats.json"]) },
        { type: "replace", file: "panel.json", text: JSON.stringify(updated["panel.json"]) },
        { type: "append", file: "requests.log", offset: 0, text: "{\"id\":\"pending\"}\n" },
        { type: "append", file: "audit.log", offset: 0, text: "{\"id\":\"pending\"}\n" },
      ],
    },
  };
}

// Writes documents byte-for-byte; `key` may be a replacement buffer or null to
// omit master.key entirely (the "missing key" fixture).
export function writeDocuments(directory, documents, { key = TEST_KEY } = {}) {
  mkdirSync(directory, { recursive: true });
  for (const [name, value] of Object.entries(documents))
    writeFileSync(
      join(directory, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  if (key !== null) writeFileSync(join(directory, "master.key"), key);
  return directory;
}
