import { createHash } from "node:crypto";

const TOKEN_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "total",
  "reportedRequests",
  "missingRequests",
  "partialRequests",
  "cacheReadReported",
  "cacheWriteReported",
];
const REMOTE_FIELDS = [
  "prompt",
  "completion",
  "requests",
  "errors",
  "partial_requests",
  "credit",
  "cache_hit",
  "cache_miss",
  "cache_write",
];
const MEASURED_FIELDS = [
  "prompt",
  "completion",
  "credit",
  "cache_hit",
  "cache_miss",
  "cache_write",
];
const API_FIELDS = {
  prompt: "prompt",
  completion: "completion",
  credit: "credit",
  cache_hit: "cacheHit",
  cache_miss: "cacheMiss",
  cache_write: "cacheWrite",
};
const fingerprint = (account) =>
  createHash("sha256")
    .update(JSON.stringify([account.endpoint, account.secrets.proxyKey]))
    .digest("hex");
const totals = (source = {}) =>
  Object.fromEntries(TOKEN_FIELDS.map((field) => [field, source[field] || 0]));
const difference = (current, previous) =>
  Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field, current[field] - previous[field]]),
  );
const decreased = (current, previous, fields) =>
  fields.some((field) => current[field] < previous[field]);
// Workspace counters keep their /usage names; the API exposes camelCase so the
// console never needs to know the upstream wire format.
const subtract = (current, baseline, fields) =>
  Object.fromEntries(
    fields.map((field) => [
      field,
      current[field] === null ? null : current[field] - (baseline[field] ?? 0),
    ]),
  );
function upstreamView(counters, coverage, support) {
  const result = {
    requests: counters.requests,
    errors: counters.errors,
    partialRequests: counters.partial_requests,
    coverage: {},
  };
  for (const field of MEASURED_FIELDS) {
    const key = API_FIELDS[field];
    const reported = coverage[field];
    result.coverage[key] = reported;
    // A legacy positive subtotal remains useful, but its coverage is unknown.
    result[key] =
      support[field] &&
      (counters.requests === 0 || reported > 0 || counters[field] > 0)
        ? counters[field]
        : null;
  }
  return result;
}
function tokenView(upstream) {
  return {
    input: upstream.prompt,
    output: upstream.completion,
    cacheRead: upstream.cacheHit,
    cacheWrite: upstream.cacheWrite,
    total:
      upstream.prompt === null || upstream.completion === null
        ? null
        : upstream.prompt + upstream.completion,
  };
}
function localKnown(local, field) {
  const attempts = local.reportedRequests + local.missingRequests;
  if (!attempts) return local[field] === 0;
  if (local.missingRequests || local.partialRequests) return false;
  if (field === "cacheRead" || field === "cacheWrite")
    return local[`${field}Reported`] === attempts;
  return local.reportedRequests === attempts;
}
function remoteKnown(upstream, field) {
  if (upstream.partialRequests !== 0) return false;
  const keys =
    field === "total"
      ? ["prompt", "completion"]
      : [
          {
            input: "prompt",
            output: "completion",
            cacheRead: "cacheHit",
            cacheWrite: "cacheWrite",
          }[field],
        ];
  return keys.every(
    (key) =>
      upstream[key] !== null &&
      upstream.coverage[key] !== null &&
      upstream.coverage[key] === upstream.requests &&
      (upstream.requests > 0 || upstream[key] === 0),
  );
}

function validateSnapshot(value) {
  if (
    !value ||
    typeof value.boot_id !== "string" ||
    !value.boot_id ||
    value.boot_id.length > 200 ||
    typeof value.booted_at !== "string" ||
    !Number.isFinite(Date.parse(value.booted_at)) ||
    !value.totals ||
    typeof value.totals !== "object"
  )
    throw new Error("invalid usage snapshot");
  const remote = {};
  for (const field of REMOTE_FIELDS) {
    if (field === "partial_requests" && value.totals[field] === undefined) {
      remote[field] = null;
      continue;
    }
    // credit carries fractional units; every other counter is a token count.
    const counter =
      value.totals[field] ??
      (field.startsWith("cache_") || field === "errors" || field === "credit"
        ? 0
        : NaN);
    if (
      field === "credit"
        ? !Number.isFinite(counter) || counter < 0
        : !Number.isSafeInteger(counter) || counter < 0
    )
      throw new Error("invalid usage counter");
    remote[field] = counter;
  }
  if (!Number.isSafeInteger(remote.prompt + remote.completion))
    throw new Error("usage total exceeds safe integer range");
  if (
    remote.partial_requests !== null &&
    remote.partial_requests > remote.requests
  )
    throw new Error("invalid partial usage count");
  const schemaVersion = value.schema_version ?? 1;
  if (
    !Number.isSafeInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > 2
  )
    throw new Error("unsupported usage schema");
  const support = {};
  const coverage = {};
  for (const field of MEASURED_FIELDS) {
    const supported =
      schemaVersion === 2 && field !== "prompt" && field !== "completion"
        ? value.capabilities?.[field]
        : value.totals[field] !== undefined;
    if (typeof supported !== "boolean")
      throw new Error("invalid usage capability");
    support[field] = supported;
    if (schemaVersion === 2 && supported && value.totals[field] === undefined)
      throw new Error("missing supported usage counter");
    const reported = schemaVersion === 2 ? value.coverage?.[field] : null;
    if (
      schemaVersion === 2 &&
      (!Number.isSafeInteger(reported) ||
        reported < 0 ||
        reported > remote.requests)
    )
      throw new Error("invalid usage coverage");
    if (
      schemaVersion === 2 &&
      ((!supported && (reported || remote[field])) ||
        (reported === 0 && remote[field] > 0))
    )
      throw new Error("inconsistent usage coverage");
    coverage[field] = reported;
  }
  return {
    bootId: value.boot_id,
    bootedAt: new Date(value.booted_at).toISOString(),
    counters: remote,
    coverage,
    support,
    schemaVersion,
    schemaFingerprint: JSON.stringify([
      schemaVersion,
      support,
      remote.partial_requests !== null,
    ]),
  };
}

async function readSnapshot(response, maxBytes) {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new Error("usage response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty usage response");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error("usage response too large");
      chunks.push(value);
    }
    return validateSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** Independent diagnostics: worker snapshots never modify gateway token totals or health. */
export class WorkerUsageMonitor {
  constructor(store, { timeoutMs = 5000, maxBytes = 65536 } = {}) {
    this.store = store;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.pending = new Map();
  }

  row(account) {
    const saved = account.workerUsage;
    const current =
      saved?.connectionFingerprint === fingerprint(account) ? saved : null;
    const remote = (value) =>
      value && !current.schemaFingerprint
        ? {
            ...value,
            cacheRead:
              current.supportsCacheRead && value.cacheRead > 0
                ? value.cacheRead
                : null,
            cacheWrite: null,
          }
        : value || null;
    const upstream =
      current?.upstream && !current.schemaFingerprint
        ? {
            ...current.upstream,
            credit:
              current.supportsCredit && current.upstream.credit > 0
                ? current.upstream.credit
                : null,
            cacheHit:
              current.supportsCacheRead && current.upstream.cacheHit > 0
                ? current.upstream.cacheHit
                : null,
            cacheMiss:
              current.upstream.cacheMiss > 0
                ? current.upstream.cacheMiss
                : null,
            cacheWrite: null,
            coverage: Object.fromEntries(
              Object.values(API_FIELDS).map((key) => [key, null]),
            ),
          }
        : current?.upstream || null;
    return {
      accountId: account.id,
      accountName: account.name,
      status: current?.status || "pending",
      message:
        current?.message ||
        (account.endpoint ? "尚未读取工作区用量" : "工作区尚未注册地址"),
      syncedAt: current?.syncedAt || null,
      bootedAt: current?.bootedAt || null,
      bootId: current?.bootId || null,
      startedAt: current?.startedAt || null,
      workspaceTotals: remote(current?.workspaceTotals),
      local: current?.local || null,
      workspace: remote(current?.workspace),
      difference: remote(current?.difference),
      // Real upstream cost and prefix-cache counters. These are read-only
      // diagnostics; they never feed routing, quota or billing decisions.
      upstream,
      supportsCredit: current?.supportsCredit === true,
      schemaVersion: current?.schemaVersion ?? null,
    };
  }

  overview() {
    return {
      accounts: this.store.state.accounts.map((account) => this.row(account)),
    };
  }

  refresh(id) {
    if (this.pending.has(id)) return this.pending.get(id);
    const work = this.read(id).finally(() => this.pending.delete(id));
    this.pending.set(id, work);
    return work;
  }

  async refreshAll() {
    const accounts = [...this.store.state.accounts].filter(
      (account) => account.enabled && account.endpoint,
    );
    for (let i = 0; i < accounts.length; i += 5)
      await Promise.allSettled(
        accounts.slice(i, i + 5).map((account) => this.refresh(account.id)),
      );
    return this.overview();
  }

  async read(id) {
    const source = this.store.state.accounts.find(
      (account) => account.id === id,
    );
    if (!source || !source.endpoint) return source ? this.row(source) : null;
    const connectionFingerprint = fingerprint(source);
    let snapshot;
    let failure = null;
    try {
      const response = await fetch(`${source.endpoint}/usage`, {
        headers: { Authorization: `Bearer ${source.secrets.proxyKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel();
        failure = {
          status: [404, 405, 501].includes(response.status)
            ? "unsupported"
            : "unavailable",
          message: [404, 405, 501].includes(response.status)
            ? "该工作区未提供 /usage 用量接口"
            : `工作区用量读取失败（HTTP ${response.status}）`,
        };
      } else snapshot = await readSnapshot(response, this.maxBytes);
    } catch {
      failure = {
        status: "unavailable",
        message: "工作区用量读取失败、超时或返回格式无效",
      };
    }

    // Registration, key rotation or deletion can happen while /usage is in flight.
    const account = this.store.state.accounts.find((item) => item.id === id);
    if (!account) return null;
    if (fingerprint(account) !== connectionFingerprint)
      return this.row(account);
    const previous =
      account.workerUsage?.connectionFingerprint === connectionFingerprint
        ? account.workerUsage
        : null;
    if (failure) {
      this.store.patch(id, {
        workerUsage: { ...previous, connectionFingerprint, ...failure },
      });
      return this.row(this.store.get(id));
    }

    const now = new Date().toISOString();
    const localCurrent = totals(account.tokenUsage);
    const reset =
      !previous?.baselineUpstream ||
      previous.bootId !== snapshot.bootId ||
      previous.bootedAt !== snapshot.bootedAt ||
      previous.schemaFingerprint !== snapshot.schemaFingerprint ||
      decreased(snapshot.counters, previous.lastRemote, REMOTE_FIELDS) ||
      decreased(snapshot.coverage, previous.lastCoverage, MEASURED_FIELDS) ||
      decreased(localCurrent, previous.lastLocal, TOKEN_FIELDS);
    const baselineUpstream = reset
      ? snapshot.counters
      : previous.baselineUpstream;
    const baselineLocal = reset ? localCurrent : previous.baselineLocal;
    const baselineCoverage = reset
      ? snapshot.coverage
      : previous.baselineCoverage;
    const local = difference(localCurrent, baselineLocal);
    const upstream = upstreamView(
      subtract(snapshot.counters, baselineUpstream, REMOTE_FIELDS),
      subtract(snapshot.coverage, baselineCoverage, MEASURED_FIELDS),
      snapshot.support,
    );
    const workspace = tokenView(upstream);
    const state = {
      connectionFingerprint,
      status: "ok",
      message: reset
        ? "对比基线已建立，后续同步显示增量"
        : "已同步。差值为工作区减本地，缺失字段显示为 —",
      syncedAt: now,
      startedAt: reset ? now : previous.startedAt,
      bootId: snapshot.bootId,
      bootedAt: snapshot.bootedAt,
      supportsCacheRead: snapshot.support.cache_hit,
      supportsCredit: snapshot.support.credit,
      schemaVersion: snapshot.schemaVersion,
      schemaFingerprint: snapshot.schemaFingerprint,
      baselineUpstream,
      baselineLocal,
      baselineCoverage,
      lastRemote: snapshot.counters,
      lastCoverage: snapshot.coverage,
      lastLocal: localCurrent,
      workspaceTotals: tokenView(
        upstreamView(snapshot.counters, snapshot.coverage, snapshot.support),
      ),
      local,
      workspace,
      upstream,
      difference: Object.fromEntries(
        ["input", "output", "cacheRead", "cacheWrite", "total"].map((field) => [
          field,
          remoteKnown(upstream, field) && localKnown(local, field)
            ? workspace[field] - local[field]
            : null,
        ]),
      ),
    };
    this.store.patch(id, { workerUsage: state });
    return this.row(this.store.get(id));
  }
}
