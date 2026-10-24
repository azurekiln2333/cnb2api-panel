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
];
const REMOTE_FIELDS = [
  "prompt",
  "completion",
  "requests",
  "errors",
  "cache_hit",
  "cache_miss",
];
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
    const counter =
      value.totals[field] ??
      (field.startsWith("cache_") || field === "errors" ? 0 : NaN);
    if (!Number.isSafeInteger(counter) || counter < 0)
      throw new Error("invalid usage counter");
    remote[field] = counter;
  }
  if (!Number.isSafeInteger(remote.prompt + remote.completion))
    throw new Error("usage total exceeds safe integer range");
  return {
    bootId: value.boot_id,
    bootedAt: new Date(value.booted_at).toISOString(),
    counters: remote,
    supportsCacheRead: value.totals.cache_hit !== undefined,
    tokens: totals({
      input: remote.prompt,
      output: remote.completion,
      cacheRead: remote.cache_hit,
      total: remote.prompt + remote.completion,
      // /usage exposes aggregate requests, but cannot identify usage coverage.
      // Only token fields are compared; coverage counters remain unknown/zero.
    }),
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
      value
        ? {
            ...value,
            cacheRead: current.supportsCacheRead ? value.cacheRead : null,
            cacheWrite: null,
          }
        : null;
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
      !previous?.baselineRemote ||
      previous.bootId !== snapshot.bootId ||
      previous.bootedAt !== snapshot.bootedAt ||
      previous.supportsCacheRead !== snapshot.supportsCacheRead ||
      decreased(snapshot.counters, previous.lastRemote, REMOTE_FIELDS) ||
      decreased(localCurrent, previous.lastLocal, TOKEN_FIELDS);
    const baselineRemote = reset ? snapshot.tokens : previous.baselineRemote;
    const baselineLocal = reset ? localCurrent : previous.baselineLocal;
    const local = difference(localCurrent, baselineLocal);
    const workspace = difference(snapshot.tokens, baselineRemote);
    const delta = difference(workspace, local);
    const state = {
      connectionFingerprint,
      status: "ok",
      message: reset
        ? "对比基线已建立，后续同步显示增量"
        : "已同步；差值为工作区减本地，工作区未提供缓存写入计数",
      syncedAt: now,
      startedAt: reset ? now : previous.startedAt,
      bootId: snapshot.bootId,
      bootedAt: snapshot.bootedAt,
      supportsCacheRead: snapshot.supportsCacheRead,
      baselineRemote,
      baselineLocal,
      lastRemote: snapshot.counters,
      lastLocal: localCurrent,
      workspaceTotals: snapshot.tokens,
      local,
      workspace,
      difference: Object.fromEntries(
        ["input", "output", "cacheRead", "cacheWrite", "total"].map((field) => [
          field,
          delta[field],
        ]),
      ),
    };
    this.store.patch(id, { workerUsage: state });
    return this.row(this.store.get(id));
  }
}
