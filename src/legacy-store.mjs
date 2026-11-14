import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadCreditHistory, loadReportedHistory } from "./credit-rates.mjs";
import { DEFAULT_QUOTA_PROTECTION, refreshQuotaProtection, validateQuotaProtection } from "./quota-protection.mjs";
import { loadRegistrationRelay, validateRegistrationRelay } from "./registration-relay.mjs";
import { validateRequestOverrides, validateUpstreamHeaders } from "./request-overrides.mjs";
import { emptyTokenUsage } from "./token-usage.mjs";
import { backfillDaily, loadDaily } from "./usage-history.mjs";
// src/store.mjs imports this module, so the panel defaults it shares cannot be
// imported back without a cycle. The definitions below are copies of the ones in
// store.mjs; they must be kept identical, because an imported document has to
// load with exactly the defaults the old loader applied.
const DEFAULT_INFERENCE_PROBE = Object.freeze({
  enabled: false,
  intervalMinutes: 30,
});

class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_SETTINGS = {
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

const DEFAULT_SSO = {
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

const emptyProbeUsage = () => ({ requests: 0, prompt: 0, completion: 0 });

function validateInferenceProbe(input, previous = DEFAULT_INFERENCE_PROBE) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("推理探活配置格式无效");
  const next = { ...DEFAULT_INFERENCE_PROBE, ...previous, ...input };
  if (typeof next.enabled !== "boolean")
    throw new InputError("推理探活开关须为布尔值");
  if (
    !Number.isInteger(next.intervalMinutes) ||
    next.intervalMinutes < 5 ||
    next.intervalMinutes > 1440
  )
    throw new InputError("推理探活间隔须为 5–1440 的整数");
  return { enabled: next.enabled, intervalMinutes: next.intervalMinutes };
}

const UPSTREAM_MODES = ["inherit", "auto", "ide", "classic"];

function normalizeUpstreamMode(input, { lenient = false } = {}) {
  if (input === undefined || input === null || input === "") return "inherit";
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (UPSTREAM_MODES.includes(value)) return value;
  // Stored data may predate this field or carry an unknown value; loading keeps
  // the account usable instead of refusing the whole document.
  if (lenient) return "inherit";
  throw new InputError("上游模式须为 inherit、auto、ide 或 classic");
}

function withSsoDefaults(input) {
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

const DOCUMENTS = ["panel.json", "accounts.json", "stats.json"];
const PENDING = "store.pending";

// Mirrors runtimeDefaults() in store.mjs. Keep the two lists identical: an
// imported account must load exactly like the old one.
const runtimeDefaults = () => ({
  quotaProtectionOverride: false,
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

const checksum = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Old documents keep credentials encrypted with data/master.key in the format
// iv(12) | tag(16) | data, base64 encoded.
export function decryptLegacyValue(key, value) {
  const raw = Buffer.from(value, "base64");
  const cipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
  cipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString(
      "utf8",
    ),
  );
}

// A pending journal holds the completed text of a multi-file write that the
// old process may not have flushed. Only encrypted document replacements are
// replayed; log appends belong to the files this migration leaves untouched.
function applyPending(raw, pendingText) {
  let transaction;
  try {
    transaction = JSON.parse(pendingText);
  } catch {
    throw new Error("Invalid pending storage transaction");
  }
  if (transaction?.version !== 1 || !Array.isArray(transaction.operations))
    throw new Error("Invalid pending storage transaction");
  for (const operation of transaction.operations) {
    if (!["replace", "append"].includes(operation?.type))
      throw new Error(
        "Invalid pending storage operation; restore the data backup",
      );
    if (operation.type !== "replace") continue;
    if (!DOCUMENTS.includes(operation.file) || typeof operation.text !== "string")
      throw new Error(
        "Invalid pending storage operation; restore the data backup",
      );
    raw[operation.file] = operation.text;
  }
}

function readKey(directory, key) {
  if (key) return key;
  const file = join(directory, "master.key");
  if (!existsSync(file))
    throw new Error(
      "data/master.key is missing; restore the original encryption key",
    );
  const bytes = readFileSync(file);
  if (bytes.length !== 32)
    throw new Error(
      "data/master.key is invalid; restore the original encryption key",
    );
  return bytes;
}

// Reads the file layout written before SQLite and rebuilds the in-memory state
// the old Store constructor produced, minus the log channels. Nothing on disk
// is created, renamed or deleted here; the caller owns import, backup and
// crash recovery (design.md §3.5).
export function readLegacyState(
  directory,
  { key, allowLocal = false, publicUrl = "" } = {},
) {
  const root = resolve(directory);
  const paths = Object.fromEntries(
    [...DOCUMENTS, PENDING].map((name) => [name, join(root, name)]),
  );
  const present = DOCUMENTS.filter((name) => existsSync(paths[name]));
  if (!present.length) return { found: false, state: null, sources: [] };
  if (!present.includes("panel.json"))
    throw new Error(
      "data/panel.json is missing; restore the panel configuration backup",
    );
  const resolutionKey = readKey(root, key);
  const raw = {};
  const sources = [];
  for (const name of present) {
    const bytes = readFileSync(paths[name]);
    raw[name] = bytes.toString("utf8");
    sources.push({ name, path: paths[name], checksum: checksum(bytes) });
  }
  if (existsSync(paths[PENDING])) {
    const bytes = readFileSync(paths[PENDING]);
    sources.push({ name: PENDING, path: paths[PENDING], checksum: checksum(bytes) });
    applyPending(raw, bytes.toString("utf8"));
  }
  const original = raw["panel.json"];
  const saved = JSON.parse(original);
  if (![1, 2].includes(saved.version))
    throw new Error("Unsupported panel data version");
  // Version 1 kept accounts, statistics and logs inside panel.json; version 2
  // split them into accounts.json and stats.json.
  const legacy = saved.version === 1;
  const accounts = legacy
    ? { accounts: saved.accounts }
    : JSON.parse(raw["accounts.json"]);
  const stats = legacy ? saved : JSON.parse(raw["stats.json"]);
  if (
    !Array.isArray(accounts.accounts) ||
    (!legacy && (accounts.version !== 1 || stats.version !== 1))
  )
    throw new Error("Unsupported account or statistics data version");
  if (
    !legacy &&
    (!stats.accounts ||
      typeof stats.accounts !== "object" ||
      Array.isArray(stats.accounts) ||
      !Array.isArray(stats.hourly) ||
      !stats.tokenUsage ||
      typeof stats.tokenUsage !== "object" ||
      typeof stats.tokenUsageStartedAt !== "string" ||
      !saved.settings ||
      typeof saved.settings !== "object" ||
      Array.isArray(saved.settings) ||
      !saved.sso ||
      typeof saved.sso.clientSecret !== "string")
  )
    throw new Error(
      "Invalid panel or statistics document; restore the data backup",
    );
  const settings = { ...DEFAULT_SETTINGS, ...saved.settings };
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
      { allowLocal, publicUrl },
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
  const hourly = (stats.hourly || []).map((bucket) => ({
    ...bucket,
    tokenUsage: { ...emptyTokenUsage(), ...bucket.tokenUsage },
  }));
  // Documents written before the daily rollup rebuild it from the hourly
  // window, exactly like the old constructor did.
  const daily =
    stats.daily === undefined ? backfillDaily(hourly) : loadDaily(stats.daily);
  const state = {
    settings,
    registrationRelay: loadRegistrationRelay(stats.registrationRelay),
    tokenUsage: { ...emptyTokenUsage(), ...stats.tokenUsage },
    tokenUsageStartedAt:
      stats.tokenUsageStartedAt || new Date().toISOString(),
    creditHistory: legacy ? {} : loadCreditHistory(stats.creditHistory),
    hourly,
    daily,
    accounts: accounts.accounts.map((account) => ({
      ...runtimeDefaults(),
      ...account,
      // Accounts saved before this field existed load as "inherit".
      upstreamMode: normalizeUpstreamMode(account.upstreamMode, {
        lenient: true,
      }),
      // Runtime fields live in stats.json; only the keys the old writer put
      // there are overlaid, so a stale document cannot invent new ones.
      ...(legacy
        ? {}
        : Object.fromEntries(
            Object.entries(stats.accounts?.[account.id] ?? {}).filter(
              ([, value]) => value !== undefined,
            ),
          )),
      tokenUsage: {
        ...emptyTokenUsage(),
        ...(legacy
          ? account.tokenUsage
          : stats.accounts?.[account.id]?.tokenUsage),
      },
      probeUsage: {
        ...emptyProbeUsage(),
        ...(legacy ? null : stats.accounts?.[account.id]?.probeUsage),
      },
      creditReportHistory: legacy
        ? null
        : loadReportedHistory(stats.accounts?.[account.id]?.creditReportHistory),
      secrets: decryptLegacyValue(resolutionKey, account.secrets),
    })),
  };
  if (
    state.accounts.some(
      (account) => typeof account.quotaProtectionOverride !== "boolean",
    )
  )
    throw new Error(
      "Invalid quota protection override; restore the data backup",
    );
  const sso = withSsoDefaults(saved.sso);
  // panel.json keeps the client secret encrypted with master.key.
  if (typeof saved.sso?.clientSecret === "string" && saved.sso.clientSecret)
    sso.clientSecret = decryptLegacyValue(resolutionKey, saved.sso.clientSecret);
  state.sso = sso;
  // Derived protection flags are part of the in-memory shape, so importing
  // must produce the same values the old constructor computed.
  refreshQuotaProtection(state);
  return { found: true, state, sources };
}
