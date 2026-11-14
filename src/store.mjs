import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { addTokenUsage, emptyTokenUsage } from "./token-usage.mjs";
import { loadCreditHistory, loadReportedHistory } from "./credit-rates.mjs";
import {
  backfillDaily,
  emptyDaily,
  loadDaily,
  recordDaily,
  usageDate,
} from "./usage-history.mjs";
import { loadRegistrationRelay, validateRegistrationRelay } from "./registration-relay.mjs";
import {
  DEFAULT_QUOTA_PROTECTION,
  refreshQuotaProtection,
  validateQuotaProtection,
} from "./quota-protection.mjs";
import {
  validateRequestOverrides,
  validateUpstreamHeaders,
} from "./request-overrides.mjs";
import { Connection, LogStore } from "./db.mjs";
import { readLegacyState } from "./legacy-store.mjs";

const RUNTIME_FIELDS = [
  "status",
  "discoveredModels",
  "checkedAt",
  "registeredAt",
  "cooldownUntil",
  "failures",
  "failureKind",
  "latencyMs",
  "lastError",
  "quota",
  "quotaSync",
  "quotaProtection",
  "requests",
  "errors",
  "lastWakeAt",
  "tokenUsage",
  "workerUsage",
  "upstreamModeApplied",
  "upstreamModeAppliedAt",
  "inferenceProbe",
  "probeUsage",
  "creditReportHistory",
  "registrationTokenVersion",
];
// Inference probes reach the worker's /usage counters but never the gateway
// request log, so their usage is kept apart for the reconciliation view.
export const emptyProbeUsage = () => ({ requests: 0, prompt: 0, completion: 0 });
const runtimeDefaults = () => ({
  status: "pending",
  discoveredModels: [],
  checkedAt: null,
  registeredAt: null,
  cooldownUntil: null,
  failures: 0,
  failureKind: null,
  latencyMs: null,
  lastError: "",
  quota: null,
  quotaSync: null,
  requests: 0,
  errors: 0,
  lastWakeAt: null,
  tokenUsage: emptyTokenUsage(),
  upstreamModeApplied: null,
  upstreamModeAppliedAt: null,
  inferenceProbe: null,
  probeUsage: emptyProbeUsage(),
  creditReportHistory: null,
  registrationTokenVersion: 0,
});

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_INFERENCE_PROBE = Object.freeze({
  enabled: false,
  intervalMinutes: 30,
});

// A real generation request costs quota, so it stays off unless enabled and
// runs at most once per interval per account.
export function validateInferenceProbe(input, previous = DEFAULT_INFERENCE_PROBE) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("推理探活配置格式无效");
  const next = { ...DEFAULT_INFERENCE_PROBE, ...previous, ...input };
  if (typeof next.enabled !== "boolean")
    throw new InputError("推理探活开关须为布尔值");
  integer(next.intervalMinutes, 5, 1440, "推理探活间隔");
  return { enabled: next.enabled, intervalMinutes: next.intervalMinutes };
}

export const DEFAULT_SETTINGS = {
  strategy: "weighted",
  sessionAffinity: true,
  maxAttempts: 3,
  cooldownSeconds: 60,
  healthIntervalSeconds: 60,
  connectTimeoutSeconds: 20,
  idleTimeoutSeconds: 300,
  dshCompat: true,
  claudeCodeCompat: true,
  requestOverrides: { operations: [] },
  upstreamHeaders: {},
  registrationRelay: { enabled: false, servers: [] },
  quotaProtection: DEFAULT_QUOTA_PROTECTION,
  inferenceProbe: DEFAULT_INFERENCE_PROBE,
};

export const DEFAULT_SSO = {
  enabled: false,
  keyLoginEnabled: true,
  issuer: "",
  clientId: "",
  clientSecret: "",
  scope: "openid profile email",
  providerName: "",
  allowedSubjects: [],
  allowedEmails: [],
  callbackUrl: "",
};

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const loopbackHost = (hostname) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
const printable = (value) => !/[\x00-\x1f\x7f]/.test(value);

// Per-account upstream selection. "inherit" sends no request header, so the
// worker keeps its own startup default and the panel behaves exactly as before.
export const UPSTREAM_MODES = ["inherit", "auto", "ide", "classic"];

export function normalizeUpstreamMode(input, { lenient = false } = {}) {
  if (input === undefined || input === null || input === "") return "inherit";
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (UPSTREAM_MODES.includes(value)) return value;
  // Stored data may predate this field or carry an unknown value; loading keeps
  // the account usable instead of refusing the whole document.
  if (lenient) return "inherit";
  throw new InputError("上游模式须为 inherit、auto、ide 或 classic");
}

// Issuers need HTTPS; loopback HTTP stays available for local mocks and tests.
export function normalizeIssuer(input, allowLocal = false) {
  const value = text(input, 500, "SSO 颁发者");
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("SSO 颁发者须为完整的 HTTP(S) 地址");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new InputError("SSO 颁发者须为完整的 HTTP(S) 地址");
  if (url.protocol === "http:" && !(allowLocal && loopbackHost(url.hostname)))
    throw new InputError("SSO 颁发者须使用 HTTPS 地址");
  if (url.username || url.password || url.search || url.hash)
    throw new InputError("SSO 颁发者不得包含凭据、查询或片段");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function normalizeScope(input) {
  const raw = text(input, 500, "SSO scope");
  if (!raw) throw new InputError("SSO scope 不得为空");
  const scopes = [...new Set(raw.split(/\s+/).filter(Boolean))];
  if (scopes.length > 20) throw new InputError("SSO scope 数量过多");
  if (scopes.some((s) => !/^[\w.:-]+$/.test(s)))
    throw new InputError("SSO scope 格式不正确");
  if (!scopes.includes("openid"))
    throw new InputError("SSO scope 必须包含 openid");
  return scopes.join(" ");
}

function normalizeCallback(input, allowLocal) {
  const value = text(input, 500, "SSO 回调地址");
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("SSO 回调地址须为完整的 HTTP(S) 地址");
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new InputError("SSO 回调地址须为完整的 HTTP(S) 地址");
  if (url.protocol === "http:" && !(allowLocal && loopbackHost(url.hostname)))
    throw new InputError("SSO 回调地址须使用 HTTPS 地址");
  if (url.username || url.password || url.hash)
    throw new InputError("SSO 回调地址不得包含凭据或片段");
  return url.toString();
}

function normalizeStringList(input, { label, limit, itemLimit, lower }) {
  if (!Array.isArray(input)) throw new InputError(`${label}须为字符串数组`);
  const result = [];
  for (const entry of input) {
    if (typeof entry !== "string")
      throw new InputError(`${label}须为字符串数组`);
    const item = entry.trim();
    if (!item) continue;
    if (item.length > itemLimit || !printable(item))
      throw new InputError(`${label}中存在无效条目`);
    const value = lower ? item.toLowerCase() : item;
    if (!result.includes(value)) result.push(value);
  }
  if (result.length > limit) throw new InputError(`${label}最多 ${limit} 条`);
  return result;
}

export function withSsoDefaults(input) {
  const source = input && typeof input === "object" ? input : {};
  const list = (value) =>
    Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  return {
    enabled: source.enabled === true,
    keyLoginEnabled: source.keyLoginEnabled !== false,
    issuer: typeof source.issuer === "string" ? source.issuer : "",
    clientId: typeof source.clientId === "string" ? source.clientId : "",
    clientSecret:
      typeof source.clientSecret === "string" ? source.clientSecret : "",
    scope:
      typeof source.scope === "string" && source.scope.trim()
        ? source.scope.trim()
        : DEFAULT_SSO.scope,
    providerName:
      typeof source.providerName === "string" ? source.providerName : "",
    allowedSubjects: list(source.allowedSubjects),
    allowedEmails: list(source.allowedEmails),
    callbackUrl:
      typeof source.callbackUrl === "string" ? source.callbackUrl : "",
  };
}

// Enabling SSO always needs a real issuer, client credentials and an explicit
// admin allowlist. Disabling key login always needs working SSO, so a saved
// configuration can never lock the operator out.
function assertSsoPolicy(sso) {
  if (sso.enabled) {
    if (!sso.issuer) throw new InputError("启用 SSO 需要填写颁发者地址");
    if (!sso.clientId) throw new InputError("启用 SSO 需要填写客户端 ID");
    if (!sso.clientSecret) throw new InputError("启用 SSO 需要填写客户端密钥");
    if (!sso.allowedSubjects.length && !sso.allowedEmails.length)
      throw new InputError(
        "启用 SSO 需要至少一个管理员 subject 或已验证邮箱白名单",
      );
  }
  if (!sso.keyLoginEnabled && !sso.enabled)
    throw new InputError("关闭密钥登录前请先启用有效的 SSO");
}

export function validateSso(
  input,
  previous = DEFAULT_SSO,
  { allowLocal = false } = {},
) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("请填写 SSO 配置");
  const next = withSsoDefaults(previous);
  for (const key of ["enabled", "keyLoginEnabled"])
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean")
        throw new InputError("SSO 启用状态须为布尔值");
      next[key] = input[key];
    }
  if (input.issuer !== undefined)
    next.issuer = normalizeIssuer(input.issuer, allowLocal);
  if (input.clientId !== undefined) {
    const value = text(input.clientId, 200, "SSO 客户端 ID");
    if (!printable(value)) throw new InputError("SSO 客户端 ID 含有无效字符");
    next.clientId = value;
  }
  // A blank secret keeps the stored value; only a non-blank value replaces it.
  if (input.clientSecret !== undefined) {
    if (
      typeof input.clientSecret !== "string" ||
      input.clientSecret.length > 1024
    )
      throw new InputError("SSO 客户端密钥格式不正确");
    const value = input.clientSecret.trim();
    if (value && !printable(value))
      throw new InputError("SSO 客户端密钥含有无效字符");
    if (value) next.clientSecret = value;
  }
  if (input.scope !== undefined) next.scope = normalizeScope(input.scope);
  if (input.providerName !== undefined)
    next.providerName = text(input.providerName, 60, "SSO 名称");
  if (input.allowedSubjects !== undefined)
    next.allowedSubjects = normalizeStringList(input.allowedSubjects, {
      label: "管理员 subject 白名单",
      limit: 200,
      itemLimit: 200,
      lower: false,
    });
  if (input.allowedEmails !== undefined)
    next.allowedEmails = normalizeStringList(input.allowedEmails, {
      label: "管理员邮箱白名单",
      limit: 200,
      itemLimit: 320,
      lower: true,
    });
  if (next.allowedEmails.some((email) => !/^[^@\s]+@[^@\s]+$/.test(email)))
    throw new InputError("管理员邮箱白名单中存在无效邮箱");
  if (input.callbackUrl !== undefined)
    next.callbackUrl = normalizeCallback(input.callbackUrl, allowLocal);
  assertSsoPolicy(next);
  return next;
}

// Any saved non-default SSO field means the operator configured the panel,
// so environment bootstrap must never overwrite it.
export function ssoIsConfigured(input) {
  const current = withSsoDefaults(input);
  return Object.keys(DEFAULT_SSO).some(
    (key) => JSON.stringify(current[key]) !== JSON.stringify(DEFAULT_SSO[key]),
  );
}

export function sanitizeSso(sso, callbackUrl = sso.callbackUrl) {
  return {
    ssoEnabled: sso.enabled,
    keyLoginEnabled: sso.keyLoginEnabled,
    issuer: sso.issuer,
    clientId: sso.clientId,
    hasClientSecret: Boolean(sso.clientSecret),
    scope: sso.scope,
    providerName: sso.providerName,
    allowedSubjects: [...sso.allowedSubjects],
    allowedEmails: [...sso.allowedEmails],
    callbackUrl,
  };
}

const text = (v, limit, label) => {
  if (typeof v !== "string" || v.length > limit)
    throw new InputError(`${label}格式不正确`);
  return v.trim();
};
const integer = (v, min, max, label) => {
  if (!Number.isInteger(v) || v < min || v > max)
    throw new InputError(`${label}须为 ${min}–${max} 的整数`);
  return v;
};

export function normalizeEndpoint(input, allowLocal = false) {
  const value = text(input, 500, "工作区地址").replaceAll("{{port}}", "9001");
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError("工作区地址须为完整的 HTTPS URL");
  }
  const cnb =
    url.protocol === "https:" &&
    /^[a-z0-9-]+-\d+\.cnb\.run$/.test(url.hostname) &&
    !url.port;
  const local =
    allowLocal &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    (!cnb && !local) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new InputError("请填写 https://<工作区>-9001.cnb.run 格式的地址");
  }
  return url.origin;
}

export function publicAccount(account) {
  // Rate histories feed /api/credits/rates only; they never reach account lists.
  const { secrets, workerUsage, creditReportHistory, ...visible } = account;
  return {
    ...visible,
    hasProxyKey: Boolean(secrets.proxyKey),
    hasPat: Boolean(secrets.pat),
  };
}

const SLOW_WRITE_MS = 50;
const SLOW_WINDOW_MS = 60_000;
// Legacy documents are imported once by the legacy importer; until that has run
// the panel must never start on an empty database sitting beside them.
const LEGACY_FILES = [
  "panel.json",
  "accounts.json",
  "stats.json",
  "store.pending",
];

const SCHEMA_MIGRATIONS = [  `CREATE TABLE settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     settings TEXT NOT NULL,
     sso TEXT NOT NULL
   );
   CREATE TABLE accounts (
     id TEXT PRIMARY KEY,
     position INTEGER NOT NULL UNIQUE CHECK (position >= 0),
     config TEXT NOT NULL,
     secrets TEXT NOT NULL,
     runtime TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE stats_hourly (
     at TEXT PRIMARY KEY,
     data TEXT NOT NULL
   );
   CREATE TABLE stats_daily (
     day TEXT PRIMARY KEY,
     data TEXT NOT NULL
   );
   CREATE TABLE meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE legacy_imports (
     source TEXT PRIMARY KEY,
     checksum TEXT NOT NULL,
     backup TEXT NOT NULL,
     imported_at TEXT NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
   );`,
];

// Account definition (everything the operator edits) versus runtime state
// (everything the panel observes). Splitting them keeps a health check from
// rewriting and re-encrypting credentials.
const configOf = (account) =>
  Object.fromEntries(
    Object.entries(account).filter(
      ([key]) => key !== "secrets" && !RUNTIME_FIELDS.includes(key),
    ),
  );
const runtimeOf = (account) =>
  Object.fromEntries(
    RUNTIME_FIELDS.filter((key) => account[key] !== undefined).map((key) => [
      key,
      account[key],
    ]),
  );

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");
const backupPattern = (source) =>
  new RegExp(`^${source.replace(".", "\\.")}\\.migrated-\\d+\\.bak$`);

function parseStoredJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    // Parser messages can quote the stored document, credentials included.
    throw new Error(`Invalid ${label} JSON; restore the data backup`);
  }
}

export class Store {
  constructor(directory, { allowLocal = false, logDir, publicUrl = "" } = {}) {
    this.directory = resolve(directory);
    this.allowLocal = allowLocal;
    this.publicUrl = publicUrl;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.databaseFile = join(this.directory, "panel.sqlite");
    this.logs = new LogStore(logDir ?? resolve(this.directory, "../logs"), {
      dataDirectory: this.directory,
    });
    this.logDirectory = this.logs.directory;
    const keyFile = join(this.directory, "master.key");
    if (!existsSync(keyFile)) {
      const existing =
        existsSync(this.databaseFile) ||
        LEGACY_FILES.some((name) => existsSync(join(this.directory, name)));
      if (existing)
        throw new Error(
          "data/master.key is missing; restore the original encryption key",
        );
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32)
      throw new Error(
        "data/master.key is invalid; restore the original encryption key",
      );
    this.connection = new Connection(this.databaseFile);
    this.persisted = {
      settings: null,
      accounts: new Map(),
      hourly: new Map(),
      daily: new Map(),
      dailyAccounts: null,
      meta: new Map(),
    };
    this.secretCache = new Map();
    this.ssoSecret = null;
    this.writes = 0;
    this.slowWrites = 0;
    this.maxWriteMs = 0;
    this.lastSlowWriteAt = null;
    this.slowWindow = null;
    try {
      this.connection.migrate(SCHEMA_MIGRATIONS, "panel");
      this.initialize();
      this.finishLegacyBackups();
      this.state = this.load();
      refreshQuotaProtection(this.state);
      this.assertNoLegacyFiles();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get db() {
    return this.connection;
  }

  initialize() {
    if (this.connection.get("SELECT id FROM settings WHERE id = 1")) return;
    if (
      this.connection.get("SELECT 1 FROM accounts LIMIT 1") ||
      this.connection.get("SELECT 1 FROM meta LIMIT 1") ||
      this.connection.get("SELECT 1 FROM stats_hourly LIMIT 1")
    )
      throw new Error(
        "Panel settings are missing; restore the data backup",
      );
    const legacy = readLegacyState(this.directory, {
      key: this.key,
      allowLocal: this.allowLocal,
      publicUrl: this.publicUrl,
    });
    if (!legacy.found) {
      this.writeFresh();
      return;
    }
    // One transaction writes every row and the manifest, so a crash before the
    // renames can be resumed and a crash before the commit leaves no database.
    const imported = legacy.sources.map((source) => ({
      source: source.name,
      checksum: source.checksum,
      backup: `${source.name}.migrated-${Date.now()}.bak`,
    }));
    const state = { version: 2, ...legacy.state };
    this.connection.transaction(() => {
      this.persistAll(state);
      for (const entry of imported)
        this.connection.run(
          `INSERT INTO legacy_imports (source, checksum, backup, imported_at)
           VALUES (?, ?, ?, ?)`,
          entry.source,
          entry.checksum,
          entry.backup,
          new Date().toISOString(),
        );
    });
    this.connection.checkpoint();
  }

  // SQLite commits before the files are renamed. The manifest makes a crash
  // between these operations recoverable without reimporting or overwriting.
  finishLegacyBackups() {
    for (const imported of this.connection.all(
      "SELECT source, checksum, backup, completed FROM legacy_imports",
    )) {
      if (
        !LEGACY_FILES.includes(imported.source) ||
        !backupPattern(imported.source).test(imported.backup)
      )
        throw new Error(
          "Invalid legacy import manifest; restore the data backup",
        );
      const source = join(this.directory, imported.source);
      const backup = join(this.directory, imported.backup);
      if (imported.completed) {
        if (existsSync(source))
          throw new Error(
            "Legacy panel data reappeared after migration; keep one source of truth",
          );
        continue;
      }
      if (existsSync(source)) {
        if (checksum(readFileSync(source)) !== imported.checksum)
          throw new Error(
            "Legacy panel data changed during migration; preserve both copies before restarting",
          );
        if (existsSync(backup))
          throw new Error(
            "Legacy panel backup already exists; preserve both copies before restarting",
          );
        renameSync(source, backup);
      }
      if (
        !existsSync(backup) ||
        checksum(readFileSync(backup)) !== imported.checksum
      )
        throw new Error(
          "Legacy panel backup is missing or changed; restore it before restarting",
        );
      this.connection.transaction(() =>
        this.connection.run(
          "UPDATE legacy_imports SET completed = 1 WHERE source = ?",
          imported.source,
        ),
      );
    }
  }

  // SQLite and the old documents must never both be a source of truth, not even
  // after a migration brought the panel back to an older image.
  assertNoLegacyFiles() {
    const legacy = LEGACY_FILES.filter((name) =>
      existsSync(join(this.directory, name)),
    );
    if (legacy.length)
      throw new Error(
        `Legacy panel data (${legacy.join(", ")}) exists beside the SQLite database; ` +
          "keep one source of truth before starting",
      );
  }

  writeFresh() {
    const state = {
      version: 2,
      accounts: [],
      settings: {
        ...DEFAULT_SETTINGS,
        registrationRelay: { enabled: false, servers: [] },
      },
      registrationRelay: loadRegistrationRelay(),
      sso: { ...DEFAULT_SSO },
      hourly: [],
      daily: emptyDaily(),
      tokenUsage: emptyTokenUsage(),
      tokenUsageStartedAt: new Date().toISOString(),
      creditHistory: {},
    };
    this.connection.transaction(() => this.persistAll(state));
    this.connection.checkpoint();
  }

  load() {
    const saved = this.connection.get(
      "SELECT settings, sso FROM settings WHERE id = 1",
    );
    if (!saved)
      throw new Error("Panel settings are missing; restore the data backup");
    const settings = {
      ...DEFAULT_SETTINGS,
      ...parseStoredJson(saved.settings, "panel settings"),
    };
    if (typeof settings.dshCompat !== "boolean")
      throw new Error("Invalid DSH compatibility setting");
    if (typeof settings.claudeCodeCompat !== "boolean")
      throw new Error("Invalid Claude Code compatibility setting");
    try {
      settings.requestOverrides = validateRequestOverrides(
        settings.requestOverrides,
      );
      settings.upstreamHeaders = validateUpstreamHeaders(
        settings.upstreamHeaders,
      );
      settings.registrationRelay = validateRegistrationRelay(
        settings.registrationRelay,
        { allowLocal: this.allowLocal, publicUrl: this.publicUrl },
      );
      settings.quotaProtection = validateQuotaProtection(
        settings.quotaProtection,
      );
      settings.inferenceProbe = validateInferenceProbe(settings.inferenceProbe);
    } catch {
      throw new Error(
        "Invalid request override settings; restore the data backup",
      );
    }
    const storedSso = parseStoredJson(saved.sso, "panel SSO");
    const sso = this.loadSso(storedSso);
    this.ssoSecret = {
      plain: typeof sso.clientSecret === "string" ? sso.clientSecret : "",
      value:
        typeof storedSso?.clientSecret === "string"
          ? storedSso.clientSecret
          : "",
    };
    this.persisted.settings = { settings: saved.settings, sso: saved.sso };
    const accounts = this.connection
      .all(
        `SELECT id, position, config, secrets, runtime, updated_at
         FROM accounts ORDER BY position`,
      )
      .map((row) => {
        const config = parseStoredJson(row.config, "account") || {};
        const runtime = parseStoredJson(row.runtime, "account runtime") || {};
        const account = {
          quotaProtectionOverride: false,
          ...runtimeDefaults(),
          ...config,
          upstreamMode: normalizeUpstreamMode(config.upstreamMode, {
            lenient: true,
          }),
          ...runtime,
          tokenUsage: { ...emptyTokenUsage(), ...runtime.tokenUsage },
          probeUsage: { ...emptyProbeUsage(), ...runtime.probeUsage },
          creditReportHistory: loadReportedHistory(runtime.creditReportHistory),
          secrets: this.decrypt(row.secrets),
        };
        if (typeof account.quotaProtectionOverride !== "boolean")
          throw new Error(
            "Invalid quota protection override; restore the data backup",
          );
        this.persisted.accounts.set(row.id, {
          position: row.position,
          config: row.config,
          secrets: row.secrets,
          runtime: row.runtime,
          updatedAt: row.updated_at,
        });
        this.secretCache.set(row.id, {
          json: JSON.stringify(account.secrets ?? {}),
          value: row.secrets,
        });
        return account;
      });
    const hourly = this.connection
      .all("SELECT at, data FROM stats_hourly ORDER BY at")
      .map((row) => {
        const bucket = parseStoredJson(row.data, "hourly bucket") || {};
        this.persisted.hourly.set(row.at, row.data);
        return {
          ...bucket,
          tokenUsage: { ...emptyTokenUsage(), ...bucket.tokenUsage },
        };
      });
    const days = {};
    for (const row of this.connection.all(
      "SELECT day, data FROM stats_daily ORDER BY day",
    )) {
      days[row.day] = parseStoredJson(row.data, "daily rollup");
      this.persisted.daily.set(row.day, row.data);
    }
    const accountsRow = this.connection.get(
      "SELECT value FROM meta WHERE key = 'dailyAccounts'",
    );
    this.persisted.dailyAccounts = accountsRow ? accountsRow.value : null;
    const daily = Object.keys(days).length
      ? loadDaily({
          accounts: accountsRow
            ? parseStoredJson(accountsRow.value, "daily accounts")
            : [],
          days,
        })
      : // A database written before the rollup existed rebuilds it from the
        // hourly window; storage written by this build always has both.
        hourly.length
        ? backfillDaily(hourly)
        : loadDaily({ accounts: [], days });
    const meta = new Map();
    for (const row of this.connection.all("SELECT key, value FROM meta"))
      if (row.key !== "dailyAccounts") meta.set(row.key, row.value);
    this.persisted.meta = meta;
    const stored = (key) =>
      meta.has(key) ? parseStoredJson(meta.get(key), key) : undefined;
    return {
      version: 2,
      settings,
      sso,
      accounts,
      hourly,
      daily,
      tokenUsage: { ...emptyTokenUsage(), ...stored("tokenUsage") },
      tokenUsageStartedAt:
        typeof stored("tokenUsageStartedAt") === "string"
          ? stored("tokenUsageStartedAt")
          : new Date().toISOString(),
      // Documents written before Credits rate estimates have no history.
      creditHistory: loadCreditHistory(stored("creditHistory")),
      registrationRelay: loadRegistrationRelay(stored("registrationRelay")),
    };
  }

  loadSso(saved) {
    const sso = withSsoDefaults(saved);
    // The stored client secret is encrypted with master.key.
    if (typeof saved?.clientSecret === "string" && saved.clientSecret)
      sso.clientSecret = this.decrypt(saved.clientSecret);
    return sso;
  }

  saveSso(candidate) {
    this.commit((s) => {
      s.sso = candidate;
    });
    return this.state.sso;
  }

  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  decrypt(value) {
    const raw = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      raw.subarray(0, 12),
    );
    cipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString(
        "utf8",
      ),
    );
  }

  // Credentials are encrypted once and reused while their plaintext is
  // unchanged, so routine runtime writes never touch AES or the secrets column.
  secretsFor(account) {
    const json = JSON.stringify(account.secrets ?? {});
    const cached = this.secretCache.get(account.id);
    if (cached && cached.json === json) return cached.value;
    const value = this.encrypt(account.secrets ?? {});
    this.secretCache.set(account.id, { json, value });
    return value;
  }

  encryptSecret(plain) {
    const value = typeof plain === "string" ? plain : "";
    if (this.ssoSecret && this.ssoSecret.plain === value)
      return this.ssoSecret.value;
    const encrypted = this.encrypt(value);
    this.ssoSecret = { plain: value, value: encrypted };
    return encrypted;
  }

  saveSettings(state) {
    const settings = JSON.stringify(state.settings);
    const sso = JSON.stringify({
      ...withSsoDefaults(state.sso),
      clientSecret: this.encryptSecret(state.sso?.clientSecret),
    });
    if (
      this.persisted.settings &&
      this.persisted.settings.settings === settings &&
      this.persisted.settings.sso === sso
    )
      return false;
    this.connection.run(
      `INSERT INTO settings (id, settings, sso) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, sso = excluded.sso`,
      settings,
      sso,
    );
    this.persisted.settings = { settings, sso };
    return true;
  }

  saveAccounts(accounts) {
    let durable = false;
    const order = new Map();
    accounts.forEach((account, position) => {
      if (typeof account.id !== "string" || !account.id)
        throw new Error("An account without an id cannot be persisted");
      order.set(account.id, position);
    });
    for (const id of [...this.persisted.accounts.keys()])
      if (!order.has(id)) {
        this.connection.run("DELETE FROM accounts WHERE id = ?", id);
        this.persisted.accounts.delete(id);
        this.secretCache.delete(id);
      }
    // A reorder can cross an occupied position; shifting the whole table by a
    // large offset first keeps the UNIQUE constraint satisfied at every step.
    const reordering = [...this.persisted.accounts].some(
      ([id, cached]) => order.get(id) !== undefined && cached.position !== order.get(id),
    );
    if (reordering) {
      this.connection.exec("UPDATE accounts SET position = position + 1000000");
      for (const cached of this.persisted.accounts.values())
        cached.position += 1000000;
    }
    accounts.forEach((account, position) => {
      const config = JSON.stringify(configOf(account));
      const runtime = JSON.stringify(runtimeOf(account));
      const secrets = this.secretsFor(account);
      const updatedAt =
        typeof account.updatedAt === "string" ? account.updatedAt : "";
      const cached = this.persisted.accounts.get(account.id);
      if (!cached) {
        this.connection.run(
          `INSERT INTO accounts (id, position, config, secrets, runtime, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          account.id,
          position,
          config,
          secrets,
          runtime,
          updatedAt,
        );
        this.persisted.accounts.set(account.id, {
          position,
          config,
          secrets,
          runtime,
          updatedAt,
        });
        durable = true;
        return;
      }
      const assignments = [];
      const values = [];
      if (cached.config !== config) {
        assignments.push("config = ?");
        values.push(config);
        durable = true;
      }
      if (cached.secrets !== secrets) {
        assignments.push("secrets = ?");
        values.push(secrets);
        durable = true;
      }
      if (cached.runtime !== runtime) {
        assignments.push("runtime = ?");
        values.push(runtime);
      }
      if (cached.position !== position) {
        assignments.push("position = ?");
        values.push(position);
      }
      if (cached.updatedAt !== updatedAt) {
        assignments.push("updated_at = ?");
        values.push(updatedAt);
        durable = true;
      }
      if (!assignments.length) return;
      this.connection.run(
        `UPDATE accounts SET ${assignments.join(", ")} WHERE id = ?`,
        ...values,
        account.id,
      );
      Object.assign(cached, { position, config, secrets, runtime, updatedAt });
    });
    return durable;
  }

  saveHourlyBucket(bucket) {
    const data = JSON.stringify(bucket);
    if (this.persisted.hourly.get(bucket.at) === data) return;
    this.connection.run(
      `INSERT INTO stats_hourly (at, data) VALUES (?, ?)
       ON CONFLICT(at) DO UPDATE SET data = excluded.data`,
      bucket.at,
      data,
    );
    this.persisted.hourly.set(bucket.at, data);
  }

  deleteHourly(at) {
    if (!this.persisted.hourly.has(at)) return;
    this.connection.run("DELETE FROM stats_hourly WHERE at = ?", at);
    this.persisted.hourly.delete(at);
  }

  saveHourly(hourly) {
    const seen = new Set();
    for (const bucket of hourly) {
      seen.add(bucket.at);
      this.saveHourlyBucket(bucket);
    }
    for (const at of [...this.persisted.hourly.keys()])
      if (!seen.has(at)) this.deleteHourly(at);
  }

  saveDaily(daily, only) {
    const days = daily?.days && typeof daily.days === "object" ? daily.days : {};
    const keys = Object.keys(days);
    const accounts = JSON.stringify(daily?.accounts ?? []);
    if (this.persisted.dailyAccounts !== accounts) {
      this.connection.run(
        `INSERT INTO meta (key, value) VALUES ('dailyAccounts', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        accounts,
      );
      this.persisted.dailyAccounts = accounts;
    }
    // Retention and account renumbering rewrite every day at once, so a change
    // in the number of days falls back to a full comparison.
    const full = !only || keys.length !== this.persisted.daily.size;
    const targets = full ? keys : keys.filter((day) => only.has(day));
    for (const day of targets) {
      const data = JSON.stringify(days[day]);
      if (this.persisted.daily.get(day) === data) continue;
      this.connection.run(
        `INSERT INTO stats_daily (day, data) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET data = excluded.data`,
        day,
        data,
      );
      this.persisted.daily.set(day, data);
    }
    if (full)
      for (const day of [...this.persisted.daily.keys()])
        if (!days[day]) {
          this.connection.run("DELETE FROM stats_daily WHERE day = ?", day);
          this.persisted.daily.delete(day);
        }
  }

  saveMeta(state) {
    const entries = {
      tokenUsage: JSON.stringify(state.tokenUsage),
      tokenUsageStartedAt: JSON.stringify(state.tokenUsageStartedAt),
      creditHistory: JSON.stringify(state.creditHistory || {}),
      registrationRelay: JSON.stringify(state.registrationRelay),
    };
    for (const [key, value] of Object.entries(entries)) {
      if (this.persisted.meta.get(key) === value) continue;
      this.connection.run(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        value,
      );
      this.persisted.meta.set(key, value);
    }
  }

  persistAll(state) {
    const durableSettings = this.saveSettings(state);
    const durableAccounts = this.saveAccounts(state.accounts);
    this.saveHourly(state.hourly);
    this.saveDaily(state.daily);
    this.saveMeta(state);
    return durableSettings || durableAccounts;
  }

  // Account definitions, SSO and settings are written rarely but must land on
  // disk; the WAL checkpoint after the commit provides that.
  cloneState() {
    const state = this.state;
    return {
      ...state,
      settings: structuredClone(state.settings),
      sso: structuredClone(state.sso),
      accounts: state.accounts.map((account) => structuredClone(account)),
      tokenUsage: { ...state.tokenUsage },
      creditHistory: structuredClone(state.creditHistory),
      registrationRelay: structuredClone(state.registrationRelay),
      // commit() callers change accounts, settings, SSO or relay state only;
      // hourly and daily buckets are written by record() alone.
      hourly: state.hourly,
      daily: state.daily,
    };
  }

  commit(mutate) {
    const started = Date.now();
    const next = this.cloneState();
    const result = mutate(next);
    refreshQuotaProtection(next);
    const durable = this.connection.transaction(() => this.persistAll(next));
    this.state = next;
    if (durable) this.connection.checkpoint();
    this.noteWrite("commit", Date.now() - started);
    return result;
  }

  noteWrite(operation, elapsed) {
    this.writes++;
    if (elapsed > this.maxWriteMs) this.maxWriteMs = elapsed;
    if (elapsed < SLOW_WRITE_MS) return;
    this.slowWrites++;
    this.lastSlowWriteAt = new Date().toISOString();
    const now = Date.now();
    if (this.slowWindow && now - this.slowWindow.started < SLOW_WINDOW_MS) {
      this.slowWindow.count++;
      this.slowWindow.max = Math.max(this.slowWindow.max, elapsed);
      return;
    }
    this.slowWindow = { started: now, count: 1, max: elapsed };
    // One line per window keeps the observation from becoming the noise it
    // measures; the full counters stay available through metrics().
    try {
      this.logs.append({
        kind: "system",
        status: 200,
        message:
          `存储写入耗时 ${Math.round(elapsed)}ms（${operation}），` +
          `超过 ${SLOW_WRITE_MS}ms 阈值，60 秒内只记录一次`,
      });
    } catch {
      // Observing a slow write must never break the write itself.
    }
  }

  metrics() {
    return {
      writes: this.writes,
      slowWrites: this.slowWrites,
      maxWriteMs: this.maxWriteMs,
      lastSlowWriteAt: this.lastSlowWriteAt,
    };
  }

  get(id) {
    const account = this.state.accounts.find((a) => a.id === id);
    if (!account) throw new InputError("账号不存在", 404);
    return account;
  }

  validateAccount(input, previous) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("请填写账号信息");
    const name = text(input.name ?? previous?.name ?? "", 60, "账号名称");
    const repo = text(input.repo ?? previous?.repo ?? "", 200, "仓库路径");
    if (!name) throw new InputError("请填写账号名称");
    if (repo && !/^[\w.-]+(?:\/[\w.-]+)+$/.test(repo))
      throw new InputError("仓库路径格式应为组织/仓库");
    if (
      repo &&
      this.state.accounts.some((a) => a.repo === repo && a.id !== previous?.id)
    )
      throw new InputError("该仓库已接入账号池");
    const group =
      text(input.group ?? previous?.group ?? "默认分组", 40, "分组") ||
      "默认分组";
    const endpoint = normalizeEndpoint(
      input.endpoint ?? previous?.endpoint ?? "",
      this.allowLocal,
    );
    const models = input.models ?? previous?.models ?? [];
    if (
      !Array.isArray(models) ||
      models.length > 50 ||
      models.some((m) => typeof m !== "string" || !m.trim() || m.length > 120)
    ) {
      throw new InputError("模型列表格式不正确，最多支持 50 个模型");
    }
    const secrets = { ...previous?.secrets };
    for (const field of ["proxyKey", "pat"]) {
      if (input[field] !== undefined) {
        const value = text(
          input[field],
          4096,
          field === "pat" ? "CNB 个人令牌" : "工作区 API Key",
        );
        if (value || field === "pat") secrets[field] = value;
      }
    }
    if (secrets.pat && /[^\x21-\x7e]/.test(secrets.pat))
      throw new InputError("CNB 个人令牌须为有效的 ASCII 字符串");
    if (
      !secrets.proxyKey ||
      /[\r\n\x00-\x1f\x7f-\uffff]/.test(secrets.proxyKey)
    )
      throw new InputError("请填写有效的工作区 PROXY_KEY（ASCII 字符）");
    if (input.registrationToken !== undefined) {
      const token = input.registrationToken;
      if (
        typeof token !== "string" ||
        token.length > 4096 ||
        /[^\x21-\x7e]/.test(token)
      )
        throw new InputError(
          "注册密钥须为不含空格的 ASCII 字符串，最多 4096 字符",
        );
      // Empty edits retain the saved token; new accounts generate one below.
      if (token) secrets.registrationToken = token;
    }
    if (
      secrets.registrationToken &&
      this.state.accounts.some(
        (a) =>
          a.id !== previous?.id &&
          a.secrets.registrationToken === secrets.registrationToken,
      )
    )
      throw new InputError(
        "该注册密钥已被其他账号使用，请为每个账号使用不同的密钥",
      );
    const enabled = input.enabled ?? previous?.enabled ?? true;
    const autoWake = input.autoWake ?? previous?.autoWake ?? false;
    if (typeof enabled !== "boolean" || typeof autoWake !== "boolean")
      throw new InputError("启用状态须为布尔值");
    if (input.quotaProtectionOverride !== undefined && typeof input.quotaProtectionOverride !== "boolean")
      throw new InputError("强制启用状态须为布尔值");
    const quotaProtectionOverride = enabled
      ? input.quotaProtectionOverride ?? previous?.quotaProtectionOverride ?? false
      : false;
    if (autoWake && !repo)
      throw new InputError("自动唤醒需要填写 CNB 仓库路径");
    if (autoWake && !secrets.pat)
      throw new InputError("自动唤醒需要 CNB 个人令牌");
    const branch = text(
      input.branch ?? previous?.branch ?? "main",
      120,
      "分支",
    );
    if (!branch) throw new InputError("请填写工作区分支");
    return {
      name,
      repo,
      group,
      endpoint,
      models: [...new Set(models.map((m) => m.trim()))],
      weight: integer(input.weight ?? previous?.weight ?? 1, 1, 100, "权重"),
      priority: integer(
        input.priority ?? previous?.priority ?? 0,
        0,
        100,
        "优先级",
      ),
      enabled,
      quotaProtectionOverride,
      autoWake,
      branch,
      upstreamMode: normalizeUpstreamMode(
        input.upstreamMode ?? previous?.upstreamMode ?? "inherit",
      ),
      secrets,
    };
  }

  create(input) {
    const fields = this.validateAccount(input);
    const now = new Date().toISOString();
    const account = {
      ...fields,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
      secrets: {
        ...fields.secrets,
        registrationToken:
          fields.secrets.registrationToken || randomBytes(24).toString("hex"),
      },
      status: "pending",
      discoveredModels: [],
      checkedAt: null,
      registeredAt: null,
      cooldownUntil: null,
      failures: 0,
      failureKind: null,
      latencyMs: null,
      lastError: "",
      quota: null,
      quotaSync: null,
      requests: 0,
      errors: 0,
      lastWakeAt: null,
      tokenUsage: emptyTokenUsage(),
      upstreamModeApplied: null,
      upstreamModeAppliedAt: null,
      inferenceProbe: null,
      probeUsage: emptyProbeUsage(),
      creditReportHistory: null,
      registrationTokenVersion: 0,
    };
    this.commit((s) => s.accounts.push(account));
    return this.get(account.id);
  }

  update(id, input) {
    const old = this.get(id);
    const fields = this.validateAccount(input, old);
    const changedConnection =
      fields.endpoint !== old.endpoint ||
      fields.secrets.proxyKey !== old.secrets.proxyKey;
    this.commit((s) => {
      Object.assign(
        s.accounts.find((a) => a.id === id),
        fields,
        { updatedAt: new Date().toISOString() },
        changedConnection
          ? {
              status: "pending",
              cooldownUntil: null,
              failures: 0,
              failureKind: null,
              lastError: "",
              discoveredModels: [],
              latencyMs: null,
              upstreamModeApplied: null,
              upstreamModeAppliedAt: null,
              inferenceProbe: null,
            }
          : {},
        old.repo !== fields.repo ? { quota: null, lastWakeAt: null } : {},
        old.repo !== fields.repo || old.secrets.pat !== fields.secrets.pat
          ? { quotaSync: null }
          : {},
        old.secrets.registrationToken !== fields.secrets.registrationToken
          ? { registrationTokenVersion: (old.registrationTokenVersion || 0) + 1 }
          : {},
      );
    });
    return this.get(id);
  }

  // Hot path: a health check or a usage refresh touches one account only, so
  // the write stays on that row instead of snapshotting the whole state.
  patch(id, fields) {
    const started = Date.now();
    const index = this.state.accounts.findIndex((account) => account.id === id);
    if (index < 0) return;
    const account = structuredClone({ ...this.state.accounts[index], ...fields });
    refreshQuotaProtection({ accounts: [account], settings: this.state.settings });
    const next = { ...this.state, accounts: this.state.accounts.slice() };
    next.accounts[index] = account;
    this.connection.transaction(() => this.saveAccounts(next.accounts));
    this.state = next;
    this.noteWrite("patch", Date.now() - started);
  }

  remove(id) {
    this.get(id);
    this.commit((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== id);
    });
  }

  settings(input) {
    const next = { ...this.state.settings };
    if (input.dshCompat !== undefined) {
      if (typeof input.dshCompat !== "boolean")
        throw new InputError("DSH 兼容开关必须为布尔值");
      next.dshCompat = input.dshCompat;
    }
    if (input.claudeCodeCompat !== undefined) {
      if (typeof input.claudeCodeCompat !== "boolean")
        throw new InputError("Claude Code 兼容开关必须为布尔值");
      next.claudeCodeCompat = input.claudeCodeCompat;
    }
    try {
      if (input.requestOverrides !== undefined)
        next.requestOverrides = validateRequestOverrides(input.requestOverrides);
      if (input.upstreamHeaders !== undefined)
        next.upstreamHeaders = validateUpstreamHeaders(input.upstreamHeaders);
      if (input.registrationRelay !== undefined)
        next.registrationRelay = validateRegistrationRelay(input.registrationRelay, { allowLocal: this.allowLocal, publicUrl: this.publicUrl });
      if (input.quotaProtection !== undefined)
        next.quotaProtection = validateQuotaProtection(input.quotaProtection, next.quotaProtection);
      if (input.inferenceProbe !== undefined)
        next.inferenceProbe = validateInferenceProbe(input.inferenceProbe, next.inferenceProbe);
    } catch (error) {
      throw new InputError(error.message);
    }
    if (input.sessionAffinity !== undefined) {
      if (typeof input.sessionAffinity !== "boolean")
        throw new InputError("会话粘性必须为布尔值");
      next.sessionAffinity = input.sessionAffinity;
    }
    if (input.strategy !== undefined) {
      if (
        !["weighted", "least-connections", "failover"].includes(input.strategy)
      )
        throw new InputError("不支持的路由策略");
      next.strategy = input.strategy;
    }
    for (const [key, min, max, label] of [
      ["maxAttempts", 1, 10, "最大尝试次数"],
      ["cooldownSeconds", 5, 3600, "冷却时间"],
      ["healthIntervalSeconds", 15, 3600, "探活间隔"],
      ["connectTimeoutSeconds", 1, 120, "连接超时"],
      ["idleTimeoutSeconds", 10, 1800, "流式空闲超时"],
    ])
      if (input[key] !== undefined)
        next[key] = integer(input[key], min, max, label);
    this.commit((s) => {
      s.settings = next;
    });
    return next;
  }

  // Hot path: one append-only row plus the rows a request actually changes.
  // The log is written first so a failed state write can never lose an entry,
  // and the published state is replaced only after the database commits.
  record(entry) {
    const started = Date.now();
    const now = Date.now();
    const record = {
      ...entry,
      id: randomUUID(),
      at: new Date(now).toISOString(),
    };
    const state = this.state;
    const next = { ...state };
    const changed = new Map();
    const mutable = (id) => {
      if (!id) return null;
      const known = changed.get(id);
      if (known) return known;
      const current = state.accounts.find((item) => item.id === id);
      if (!current) return null;
      const account = structuredClone(current);
      changed.set(id, account);
      return account;
    };
    let hour = null;
    if (entry.kind === "request") {
      const bucketAt = new Date(
        Math.floor(now / 3600000) * 3600000,
      ).toISOString();
      const index = state.hourly.findIndex((bucket) => bucket.at === bucketAt);
      const previous = index < 0 ? null : state.hourly[index];
      hour =
        previous === null
          ? {
              at: bucketAt,
              requests: 0,
              errors: 0,
              durationMs: 0,
              accounts: {},
              tokenUsage: emptyTokenUsage(),
            }
          : {
              ...previous,
              accounts: { ...previous.accounts },
              tokenUsage: { ...previous.tokenUsage },
            };
      hour.requests++;
      hour.errors += entry.status >= 400 ? 1 : 0;
      hour.durationMs += entry.durationMs || 0;
      if (entry.accountId)
        hour.accounts[entry.accountId] =
          (hour.accounts[entry.accountId] || 0) + 1;
      const retained =
        index < 0 ? [...state.hourly, hour] : state.hourly.slice();
      if (index >= 0) retained[index] = hour;
      next.hourly = retained.filter(
        (bucket) => Date.parse(bucket.at) > now - 30 * 86400000,
      );
      // The daily rollup outlives the hourly window with its own retention and
      // carries the per-account split.
      next.daily = structuredClone(state.daily);
      recordDaily(next.daily, entry, now);
      if (entry.tokenUsage) {
        next.tokenUsage = addTokenUsage(
          { ...state.tokenUsage },
          entry.tokenUsage,
        );
        addTokenUsage(hour.tokenUsage, entry.tokenUsage);
        if (Array.isArray(entry.usageAttempts)) {
          // Request/global totals are already folded. Account totals receive
          // only their own attempt measurements, never the final request sum.
          for (const attempt of entry.usageAttempts) {
            const owner = mutable(attempt.accountId);
            if (owner && attempt.tokenUsage)
              addTokenUsage(owner.tokenUsage, attempt.tokenUsage);
          }
        } else {
          const owner = mutable(entry.accountId);
          if (owner) addTokenUsage(owner.tokenUsage, entry.tokenUsage);
        }
      }
      const owner = mutable(entry.accountId);
      if (owner) {
        owner.requests++;
        if (entry.status >= 400) owner.errors++;
      }
    }
    if (changed.size) {
      next.accounts = state.accounts.map(
        (account) => changed.get(account.id) ?? account,
      );
      // Only these accounts' inputs changed, so per-account recomputation is
      // equivalent to a full pass and keeps the write scope at one row each.
      for (const account of changed.values())
        refreshQuotaProtection({
          accounts: [account],
          settings: next.settings,
        });
    }
    this.logs.append(record);
    // Audit and system entries are pure history: only the log row changes.
    if (hour || next.accounts)
      this.connection.transaction(() => {
        if (hour) {
          this.saveHourlyBucket(hour);
          const retained = new Set(next.hourly.map((bucket) => bucket.at));
          for (const bucket of state.hourly)
            if (!retained.has(bucket.at)) this.deleteHourly(bucket.at);
          this.saveDaily(next.daily, new Set([usageDate(now)]));
        }
        this.saveMeta(next);
        if (next.accounts) this.saveAccounts(next.accounts);
      });
    this.state = next;
    this.noteWrite("record", Date.now() - started);
  }

  close() {
    this.logs.close();
    this.connection.close();
  }
}
