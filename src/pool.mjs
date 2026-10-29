import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fetchQuota } from "./quota.mjs";
import { InputError, normalizeEndpoint, publicAccount } from "./store.mjs";
import { emptyTokenUsage, TokenUsageCapture } from "./token-usage.mjs";
import { WorkerUsageMonitor } from "./worker-usage.mjs";
import { initialUserMessage, requestShape } from "./request-details.mjs";
import { MAX_REQUEST_BYTES, rewriteRequest } from "./request-overrides.mjs";
import { SessionAffinity, sessionKey } from "./session-affinity.mjs";
import { prepareResponsesRequest, toResponsesResponse, ResponsesStream } from "./responses.mjs";

export const isCooling = (a) =>
  Boolean(a.cooldownUntil && Date.parse(a.cooldownUntil) > Date.now());
export const isReady = (a) =>
  a.enabled && a.status === "healthy" && a.endpoint && !isCooling(a);
const retryable = (status) =>
  [401, 402, 403, 408, 429].includes(status) || status >= 500;
const sameConnection = (a, b) =>
  a.endpoint === b.endpoint && a.secrets.proxyKey === b.secrets.proxyKey;
const blocksRecovery = (a) =>
  ["upstream", "response"].includes(a.failureKind) ||
  (!a.failureKind && /^工作区返回 HTTP \d+/.test(a.lastError || ""));
const newerRoutingCooldown = (current, source) =>
  isCooling(current) && blocksRecovery(current) &&
  (current.cooldownUntil !== source.cooldownUntil || current.failureKind !== source.failureKind);
const MODEL_RESPONSE_BYTES = 256 * 1024;
const RESPONSE_CONVERSION_BYTES = 8 * 1024 * 1024;

function probeFailure(error, stage) {
  if (error instanceof InputError) return error;
  if (wakeTimedOut(error))
    return new InputError(
      stage === "body" ? "工作区探活超时：读取模型列表超时" : "工作区探活超时：未收到响应头",
      504,
    );
  const code = error?.cause?.code || error?.code || "";
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code))
    return new InputError("工作区域名解析失败，请检查面板服务器 DNS", 502);
  if (code === "ECONNREFUSED")
    return new InputError("工作区拒绝连接，请检查代理服务端口", 502);
  if (/CERT|TLS|SSL/.test(code))
    return new InputError("工作区 TLS 握手失败，请检查证书和网络", 502);
  if (error instanceof SyntaxError)
    return new InputError("工作区模型响应不是有效 JSON", 502);
  return new InputError(
    stage === "body" ? "工作区模型响应中断" : "面板无法连接工作区，请检查代理服务和网络",
    502,
  );
}

async function readModelList(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new InputError("工作区未返回模型列表", 502);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MODEL_RESPONSE_BYTES)
        throw new InputError("工作区模型响应超出大小限制", 502);
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    if (!data || !Array.isArray(data.data) || data.object !== "list")
      throw new InputError("工作区模型列表格式无效", 502);
    return data;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
const wakeHttpHint = (status) =>
  ({
    400: "启动参数无效，请检查仓库路径和分支名称",
    401: "个人令牌无效或已过期，请更新 CNB 个人令牌",
    402: "CNB 额度或资源不可用，请检查组织配额后重试",
    403: "个人令牌无权访问该仓库或启动工作区，请检查仓库授权和 repo-cnb-trigger:rw 权限",
    404: "未找到仓库或分支，请检查仓库路径、分支和令牌可见范围",
    408: "CNB 启动接口超时，请稍后重试",
    409: "工作区状态冲突或正在启动，请稍后重试",
    422: "仓库或分支无法启动，请检查分支和 .cnb.yml 的 vscode 配置",
    429: "CNB 请求频率受限，请稍后重试",
  })[status] ||
  (status >= 500
    ? "CNB 服务暂时不可用，请稍后重试"
    : "CNB 启动接口拒绝请求，请检查仓库路径、分支和个人令牌权限");
const wakeTimedOut = (error) =>
  ["TimeoutError", "AbortError"].includes(error?.name) ||
  [
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
  ].includes(error?.cause?.code);
const WAKE_ERROR_BYTES = 16 * 1024;
const WAKE_SECRET_LABEL =
  "(?:authorization|(?:access[-_]?|refresh[-_]?)?token|reg[-_]?token|registration[-_]?token|pat|password|passwd|api[-_]?key|proxy[-_]?key|secret)";
const WAKE_QUOTED_SECRET = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/.source;

function safeWakeExplanation(input, secrets) {
  const variants = new Set();
  for (const secret of Object.values(secrets)) {
    if (typeof secret !== "string" || !secret) continue;
    variants.add(secret);
    variants.add(encodeURI(secret));
    variants.add(encodeURIComponent(secret));
    variants.add(encodeURIComponent(encodeURIComponent(secret)));
    variants.add(new URLSearchParams({ value: secret }).toString().slice(6));
  }
  const maskKnownSecrets = (value) => {
    for (const secret of [...variants].sort((a, b) => b.length - a.length))
      value = value.replace(
        new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
        "[已隐藏]",
      );
    return value;
  };
  let message = maskKnownSecrets(input);
  // Decode common URL-encoded explanations before generic credential masking.
  for (let i = 0; i < 2; i++) {
    try {
      message = decodeURIComponent(message);
    } catch {
      break;
    }
  }
  message = maskKnownSecrets(message);
  if (/<!doctype\b|<\/?[a-z][^>]*>/i.test(message)) return "";
  message = message
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(
      new RegExp(`\\bBearer(?:\\s|%20|%09)+(?:${WAKE_QUOTED_SECRET}|[^\\s,;<>]+)`, "gi"),
      "Bearer [已隐藏]",
    )
    .replace(
      new RegExp(
        `(["']?\\b${WAKE_SECRET_LABEL}\\b["']?\\s*(?:[:=]|%3a|%3d)\\s*)(?:${WAKE_QUOTED_SECRET}|[^\\s,;&]+)`,
        "gi",
      ),
      "$1[已隐藏]",
    )
    .replace(/\s+/g, " ")
    .trim();
  const useful = message
    .replaceAll("[已隐藏]", "")
    .replace(new RegExp(`\\b(?:Bearer|${WAKE_SECRET_LABEL})\\b`, "gi"), "");
  return /[\p{L}\p{N}]/u.test(useful) ? message.slice(0, 400) : "";
}

async function wakeErrorExplanation(response, secrets) {
  let reader;
  try {
    reader = response.body?.getReader();
    if (!reader) return "";
    const type = response.headers.get("content-type") || "";
    if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|\s*$)/i.test(type)) return "";
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size >= WAKE_ERROR_BYTES) return "";
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
    for (const candidate of [data?.message, data?.msg, data?.error?.message, data?.error])
      if (typeof candidate === "string") {
        const message = safeWakeExplanation(candidate, secrets);
        if (message) return message;
      }
  } catch {
    // Diagnostic parsing, timeouts, and interrupted bodies never hide the HTTP failure.
  } finally {
    if (reader) {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return "";
}

export class Pool {
  constructor(
    store,
    {
      fetchQuotaImpl = fetchQuota,
      now = Date.now,
      quotaIntervalMs = 60000,
      quotaPollMs = 1000,
    } = {},
  ) {
    this.store = store;
    this.active = new Map();
    this.scores = new Map();
    this.affinity = new SessionAffinity({ now });
    this.probes = new Map();
    this.healthVersions = new Map();
    this.wakes = new Map();
    this.autoWakeAttempts = new Map();
    this.lastCycle = 0;
    this.workerUsage = new WorkerUsageMonitor(store);
    this.fetchQuotaImpl = fetchQuotaImpl;
    this.quotaNow = now;
    this.quotaIntervalMs = quotaIntervalMs;
    this.quotaPollMs = quotaPollMs;
    this.quotaJobs = new Map();
    this.quotaPreferred = new Map();
    this.quotaActive = 0;
    this.quotaQueue = [];
    // A previous process's health result cannot prove that a workspace is still alive.
    if (store.state.accounts.some((a) => a.status === "healthy"))
      store.commit((s) => {
        for (const account of s.accounts)
          if (account.status === "healthy") account.status = "pending";
      });
  }

  accounts() {
    return this.store.state.accounts.map((a) => ({
      ...publicAccount(a),
      activeRequests: this.active.get(a.id) || 0,
    }));
  }

  eligible(model = "", excluded = new Set()) {
    return this.store.state.accounts.filter(
      (a) =>
        isReady(a) &&
        !excluded.has(a.id) &&
        (!model || !a.models.length || a.models.includes(model)),
    );
  }

  select(model, excluded, affinityKey = null) {
    let candidates = this.eligible(model, excluded);
    if (!candidates.length) return null;
    const highest = Math.max(...candidates.map((a) => a.priority));
    candidates = candidates.filter((a) => a.priority === highest);
    const bound = this.affinity.get(affinityKey);
    const preferred = candidates.find((a) => a.id === bound);
    if (preferred) return preferred;
    this.affinity.forget(affinityKey);
    const bind = (chosen) => {
      this.affinity.bind(affinityKey, chosen.id);
      return chosen;
    };
    const strategy = this.store.state.settings.strategy;
    if (strategy === "failover")
      return bind(
        candidates.sort(
          (a, b) =>
            b.weight - a.weight || a.createdAt.localeCompare(b.createdAt),
        )[0],
      );
    if (strategy === "least-connections") {
      return bind(
        candidates.sort(
          (a, b) =>
            (this.active.get(a.id) || 0) / a.weight -
              (this.active.get(b.id) || 0) / b.weight ||
            (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity),
        )[0],
      );
    }
    // Smooth weighted round-robin keeps short bursts spread across the pool.
    let chosen;
    let total = 0;
    for (const account of candidates) {
      const score = (this.scores.get(account.id) || 0) + account.weight;
      this.scores.set(account.id, score);
      total += account.weight;
      if (!chosen || score > this.scores.get(chosen.id)) chosen = account;
    }
    this.scores.set(chosen.id, this.scores.get(chosen.id) - total);
    return bind(chosen);
  }

  fail(id, reason, status = 502, source, { routing = false, kind = routing ? "upstream" : "connection" } = {}) {
    let a;
    try {
      a = this.store.get(id);
    } catch {
      return;
    }
    if (
      source &&
      (!sameConnection(a, source) ||
        (!routing && source.healthVersion !== undefined &&
          source.healthVersion !== (this.healthVersions.get(id) || 0)))
    )
      return;
    const failures = a.failures + 1;
    const seconds = Math.min(
      3600,
      this.store.state.settings.cooldownSeconds *
        2 ** Math.min(5, failures - 1),
    );
    this.store.patch(id, {
      status: "unhealthy",
      lastError: reason,
      failures,
      failureKind: kind,
      cooldownUntil: new Date(Date.now() + seconds * 1000).toISOString(),
      checkedAt: new Date().toISOString(),
    });
    this.store.record({
      kind: "health",
      accountId: id,
      accountName: a.name,
      status,
      message: reason,
    });
  }

  probe(id) {
    const account = this.store.get(id);
    const previous = this.probes.get(id);
    if (previous && sameConnection(previous, account)) return previous.promise;
    const current = { endpoint: account.endpoint, secrets: account.secrets };
    current.promise = this.check(id).finally(() => {
      if (this.probes.get(id) === current) this.probes.delete(id);
    });
    this.probes.set(id, current);
    return current.promise;
  }

  async check(id) {
    const a = this.store.get(id);
    if (!a.endpoint) return publicAccount(a);
    const started = Date.now();
    let stage = "headers";
    try {
      const response = await fetch(`${a.endpoint}/v1/models`, {
        headers: { Authorization: `Bearer ${a.secrets.proxyKey}` },
        signal: AbortSignal.timeout(
          this.store.state.settings.connectTimeoutSeconds * 1000,
        ),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new InputError(
          `工作区鉴权探活返回 HTTP ${response.status}`,
          response.status,
        );
      }
      stage = "body";
      const data = await readModelList(response);
      const current = this.store.get(id);
      if (
        current.endpoint !== a.endpoint ||
        current.secrets.proxyKey !== a.secrets.proxyKey
      )
        return publicAccount(current);
      // An automatic check already in flight must not erase a provider cooldown
      // established after that check started. A later explicit probe may retry.
      if (newerRoutingCooldown(current, a)) return publicAccount(current);
      this.healthVersions.set(id, (this.healthVersions.get(id) || 0) + 1);
      this.store.patch(id, {
        status: "healthy",
        failures: 0,
        failureKind: null,
        cooldownUntil: null,
        lastError: "",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        discoveredModels: data.data
          .map((m) => m?.id)
          .filter((id) => typeof id === "string")
          .slice(0, 100),
      });
    } catch (error) {
      let current;
      try {
        current = this.store.get(id);
      } catch {
        return null;
      }
      if (
        current.endpoint === a.endpoint &&
        current.secrets.proxyKey === a.secrets.proxyKey &&
        !newerRoutingCooldown(current, a)
      ) {
        const failure = probeFailure(error, stage);
        this.fail(
          id,
          failure.message,
          failure.status,
          undefined,
          { kind: stage === "body" && (error instanceof InputError || error instanceof SyntaxError)
            ? "response"
            : failure.status < 500 && failure.status !== 408 ? "upstream" : "connection" },
        );
      }
    }
    return publicAccount(this.store.get(id));
  }

  async recover(id) {
    const current = this.store.get(id);
    if (
      current.enabled && current.autoWake && current.repo && current.secrets.pat &&
      current.status !== "healthy" &&
      !blocksRecovery(current) &&
      (!current.endpoint || current.failures >= 3)
    )
      await this.wake(id, { automatic: true });
  }

  async confirmConnectionFailure(source) {
    let current;
    try {
      current = this.store.get(source.id);
    } catch {
      return;
    }
    if (!sameConnection(current, source) ||
        source.healthVersion !== (this.healthVersions.get(source.id) || 0)) return;
    if (isCooling(current) && blocksRecovery(current)) return;
    // A model request can fail while the authenticated worker remains reachable.
    // Only a failed readiness check can establish that the connection is down.
    await this.probe(source.id);
    await this.recover(source.id).catch(() => {});
  }

  async register(id, uri) {
    const a = this.store.get(id);
    const endpoint = normalizeEndpoint(uri, this.store.allowLocal);
    if (!endpoint) throw new InputError("缺少工作区地址");
    // Disabled accounts may update their address but never become eligible for traffic.
    this.store.patch(id, {
      endpoint,
      registeredAt: new Date().toISOString(),
      status: "pending",
      cooldownUntil: null,
      failures: 0,
      failureKind: null,
      lastError: "",
      discoveredModels: [],
    });
    this.store.record({
      kind: "register",
      accountId: id,
      accountName: a.name,
      status: 200,
      message: "工作区地址已更新",
    });
    // Registration only needs durable acknowledgement. Verification continues independently.
    this.probe(id).catch(() => {});
    return { ok: true, accountId: id };
  }

  async quota(id) {
    const a = this.store.get(id);
    if (!a.repo) throw new InputError("同步额度需要先填写 CNB 仓库路径");
    if (!a.secrets.pat)
      throw new InputError("请先为该账号配置可读取组织额度的 CNB 个人令牌");
    const org = a.repo.split("/")[0];
    if (this.quotaJobs.has(org)) return this.quotaJobs.get(org);
    const work = this.fetchOrgQuota(a).finally(() =>
      this.quotaJobs.delete(org),
    );
    this.quotaJobs.set(org, work);
    return work;
  }

  async acquireQuotaSlot() {
    if (this.quotaActive >= 3)
      await new Promise((ready) => this.quotaQueue.push(ready));
    else this.quotaActive++;
  }

  releaseQuotaSlot() {
    const next = this.quotaQueue.shift();
    if (next) next();
    else this.quotaActive--;
  }

  async fetchOrgQuota(source) {
    const org = source.repo.split("/")[0];
    let currentSource = source;
    const sourceIsCurrent = () => {
      const current = this.store.state.accounts.find(
        (a) => a.id === currentSource.id,
      );
      return Boolean(
        current &&
        current.repo === currentSource.repo &&
        current.secrets.pat === currentSource.secrets.pat,
      );
    };
    const patchOrg = (fields, predicate = () => true) =>
      this.store.commit((s) => {
        for (const a of s.accounts)
          if (a.repo.split("/")[0] === org && predicate(a))
            Object.assign(a, fields);
      });
    await this.acquireQuotaSlot();
    const lastAttemptAt = new Date(this.quotaNow()).toISOString();
    const previous = source.quotaSync;
    try {
      if (!sourceIsCurrent())
        throw new InputError("账号配置已更改，请重新同步额度", 409);
      patchOrg({
        quotaSync: {
          status: "syncing",
          lastAttemptAt,
          nextAttemptAt: null,
          error: "",
        },
      });
      const seen = new Set();
      const candidates = [
        source,
        ...this.store.state.accounts.filter(
          (a) => a.enabled && a.repo.split("/")[0] === org && a.secrets.pat,
        ),
      ]
        .filter((a) => {
          if (seen.has(a.secrets.pat)) return false;
          seen.add(a.secrets.pat);
          return true;
        })
        .slice(0, 3);
      let quota;
      for (let i = 0; i < candidates.length; i++) {
        currentSource = candidates[i];
        if (!sourceIsCurrent())
          throw new InputError("账号配置已更改，请重新同步额度", 409);
        try {
          quota = await this.fetchQuotaImpl({
            org,
            token: currentSource.secrets.pat,
          });
        } catch (error) {
          if (!sourceIsCurrent())
            throw new InputError("账号配置已更改，请重新同步额度", 409);
          const unauthorized =
            [401, 403].includes(error?.status) ||
            /\bHTTP (401|403)\b/.test(error?.message || "");
          if (unauthorized && i < candidates.length - 1) continue;
          throw error;
        }
        if (!sourceIsCurrent())
          throw new InputError("账号配置已更改，请重新同步额度", 409);
        break;
      }
      if (quota?.org !== org) throw new Error("invalid quota organization");
      this.quotaPreferred.set(org, currentSource.id);
      const syncedAt = new Date(this.quotaNow()).toISOString();
      patchOrg({
        quota: { ...quota, syncedAt },
        quotaSync: {
          status: "ok",
          lastAttemptAt,
          nextAttemptAt: new Date(
            this.quotaNow() + this.quotaIntervalMs,
          ).toISOString(),
          error: "",
        },
      });
      return quota;
    } catch {
      if (!sourceIsCurrent()) {
        patchOrg(
          { quotaSync: null },
          (a) =>
            a.quotaSync?.status === "syncing" &&
            a.quotaSync.lastAttemptAt === lastAttemptAt,
        );
        throw new InputError("账号配置已更改，请重新同步额度", 409);
      }
      const previousDelay =
        previous?.status === "error"
          ? Date.parse(previous.nextAttemptAt) -
            Date.parse(previous.lastAttemptAt)
          : 0;
      const retryDelay = Math.min(
        15 * 60000,
        Math.max(this.quotaIntervalMs, (previousDelay || 0) * 2),
      );
      patchOrg({
        quotaSync: {
          status: "error",
          lastAttemptAt,
          nextAttemptAt: new Date(this.quotaNow() + retryDelay).toISOString(),
          error: "额度同步失败，请检查个人令牌的组织计费读取权限或网络连接",
        },
      });
      throw new InputError(
        "额度同步失败，请检查个人令牌的组织计费读取权限或网络连接",
        502,
      );
    } finally {
      this.releaseQuotaSlot();
    }
  }

  async quotaCycle({ force = false } = {}) {
    if (this.quotaCycling) return;
    this.quotaCycling = true;
    try {
      const organizations = new Map();
      for (const a of this.store.state.accounts) {
        if (!a.enabled || !a.repo || !a.secrets.pat) continue;
        const due = Date.parse(a.quotaSync?.nextAttemptAt || "") || 0;
        if (force || due <= this.quotaNow())
          organizations.set(a.repo.split("/")[0], a.id);
      }
      const ids = [...organizations.values()];
      for (let i = 0; i < ids.length; i++) {
        const account = this.store.get(ids[i]);
        const preferred = this.store.state.accounts.find(
          (a) =>
            a.id === this.quotaPreferred.get(account.repo.split("/")[0]) &&
            a.enabled &&
            a.repo.split("/")[0] === account.repo.split("/")[0] &&
            a.secrets.pat,
        );
        if (preferred) ids[i] = preferred.id;
      }
      for (let i = 0; i < ids.length; i += 3)
        await Promise.allSettled(
          ids.slice(i, i + 3).map((id) => this.quota(id)),
        );
    } finally {
      this.quotaCycling = false;
    }
  }

  async wake(id, { automatic = false } = {}) {
    if (this.wakes.has(id)) return this.wakes.get(id);
    const a = this.store.get(id);
    const previousAttempt = this.autoWakeAttempts.get(id);
    // Only background retries are throttled; explicit operator actions may retry.
    // Check before caching work so a skipped automatic wake cannot block a manual one.
    if (
      automatic &&
      ((a.lastWakeAt && Date.now() - Date.parse(a.lastWakeAt) < 30 * 60000) ||
        (previousAttempt?.repo === a.repo && Date.now() - previousAttempt.at < 30 * 60000))
    )
      throw new InputError("工作区已发起唤醒，30 分钟冷却内请勿重复启动", 409);
    if (automatic) this.autoWakeAttempts.set(id, { repo: a.repo, at: Date.now() });
    const work = this.startWorkspace(id).finally(() => this.wakes.delete(id));
    this.wakes.set(id, work);
    return work;
  }

  async startWorkspace(id) {
    const a = this.store.get(id);
    if (!a.repo) throw new InputError("唤醒工作区需要先填写 CNB 仓库路径");
    if (!a.secrets.pat)
      throw new InputError("唤醒需要具备工作区启动权限的 CNB 个人令牌");
    const fail = (
      message,
      upstreamStatus = null,
      status = upstreamStatus >= 400 ? upstreamStatus : 502,
    ) => {
      this.store.record({
        kind: "wake",
        accountId: id,
        accountName: a.name,
        status,
        upstreamStatus,
        message,
      });
      // Keep dependency failures distinct from session errors and proxy-generated 502 pages.
      throw new InputError(message, 424);
    };
    let response;
    try {
      response = await fetch(
        `https://api.cnb.cool/${a.repo}/-/workspace/start`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${a.secrets.pat}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ branch: a.branch }),
          signal: AbortSignal.timeout(30000),
          redirect: "error",
        },
      );
    } catch (error) {
      const timedOut = wakeTimedOut(error);
      fail(
        timedOut
          ? "CNB 唤醒失败：启动请求超时，请检查网络连接并稍后重试"
          : "CNB 唤醒失败：网络连接失败，请检查面板服务器到 CNB 的网络连接",
        null,
        timedOut ? 504 : 502,
      );
    }
    if (!response.ok) {
      const explanation = await wakeErrorExplanation(response, a.secrets);
      fail(
        `CNB 唤醒失败（HTTP ${response.status}）：${wakeHttpHint(response.status)}` +
          (explanation ? `；CNB 说明：${explanation}` : ""),
        response.status,
      );
    }
    let data;
    try {
      data = await response.json();
    } catch (error) {
      const timedOut = wakeTimedOut(error);
      fail(
        timedOut
          ? "CNB 唤醒失败：读取启动响应超时，请检查网络连接并稍后重试"
          : error?.name === "SyntaxError"
            ? "CNB 唤醒失败：启动响应不是有效 JSON，无法确认工作区启动"
            : "CNB 唤醒失败：读取启动响应时网络连接中断，请稍后重试",
        response.status,
        timedOut ? 504 : 502,
      );
    }
    // CNB only returns sn for newly created environments; existing ones return url.
    // The WebIDE/loading URL confirms the result but is never used as a worker endpoint.
    if (
      ![data?.sn, data?.url].some(
        (value) => typeof value === "string" && value.trim(),
      )
    )
      fail(
        "CNB 唤醒失败：响应未返回有效的工作区编号或 WebIDE 地址，无法确认工作区启动",
        response.status,
      );
    this.store.patch(id, { lastWakeAt: new Date().toISOString() });
    this.store.record({
      kind: "wake",
      accountId: id,
      accountName: a.name,
      status: 200,
      message: "已向 CNB 提交工作区启动请求",
    });
    return { ok: true };
  }

  async cycle() {
    if (this.cycling) return;
    this.cycling = true;
    try {
      // Limit concurrency so a large unhealthy pool cannot overwhelm the host.
      const accounts = [...this.store.state.accounts];
      for (let i = 0; i < accounts.length; i += 5) {
        await Promise.allSettled(
          accounts
            .slice(i, i + 5)
            .filter((a) => {
              if (!a.enabled) return false;
              // Provider/auth/rate-limit cooldowns still gate traffic. A broken
              // connection must remain eligible for periodic recovery checks.
              return !isCooling(a) || !blocksRecovery(a);
            })
            .map(async (a) => {
              await this.probe(a.id);
              const current = this.store.get(a.id);
              if (current.status === "healthy")
                await this.workerUsage.refresh(current.id);
              await this.recover(a.id);
            }),
        );
      }
    } finally {
      this.cycling = false;
    }
  }

  start() {
    if (this.timer) return;
    this.lastCycle = Date.now();
    this.cycle().catch(() => {});
    // Credits are an organization API, independent of workspace health and UI.
    this.quotaCycle({ force: true }).catch(() => {});
    this.quotaTimer = setInterval(
      () => this.quotaCycle().catch(() => {}),
      this.quotaPollMs,
    );
    this.quotaTimer.unref();
    this.timer = setInterval(() => {
      if (
        Date.now() - this.lastCycle <
        this.store.state.settings.healthIntervalSeconds * 1000
      )
        return;
      this.lastCycle = Date.now();
      this.cycle().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    clearInterval(this.quotaTimer);
    this.timer = null;
    this.quotaTimer = null;
  }

  async forward(req, res, path, payload) {
    const requestId = randomUUID();
    const started = Date.now();
    const responses = path === "/v1/responses";
    const upstreamPath = responses ? "/v1/chat/completions" : path;
    const prepared = responses ? prepareResponsesRequest(payload) : null;
    const semanticPayload = prepared ? prepared.payload : payload;
    const { dshCompat, requestOverrides, upstreamHeaders } = this.store.state.settings;
    const rewritten = rewriteRequest(semanticPayload, { dshCompat, requestOverrides }, upstreamPath);
    const forwardedPayload = upstreamPath === "/v1/chat/completions"
      ? {
          ...rewritten.payload,
          stream_options: { ...rewritten.payload.stream_options, include_usage: true },
        }
      : rewritten.payload;
    // Codex client metadata describes the client session, not the model request.
    // Strict Chat-only workers reject it even on native Chat requests.
    if (upstreamPath === "/v1/chat/completions") delete forwardedPayload.client_metadata;
    // CNB workers always stream from the model upstream, including when they
    // aggregate a non-streaming response. Request usage in both client modes.
    const requestBody = JSON.stringify(forwardedPayload);
    const headerNames = Object.keys(upstreamHeaders);
    const headerCarrier = headerNames.length
      ? Buffer.from(JSON.stringify(upstreamHeaders), "utf8").toString("base64url")
      : "";
    const diagnostics = {
      received: requestShape(payload),
      forwarded: requestShape(forwardedPayload),
      rules: rewritten.rules,
      headers: { configured: headerNames, supported: null, attempts: [] },
    };
    const affinityKey = this.store.state.settings.sessionAffinity
      ? sessionKey(req.headers, semanticPayload)
      : null;
    if (!this.store.state.settings.sessionAffinity) this.affinity.clear();
    const initialMessage = initialUserMessage(semanticPayload);
    const excluded = new Set();
    const controller = new AbortController();
    const disconnected = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", disconnected);
    let account = null;
    let finalStatus = 503;
    let attempts = 0;
    let success = false;
    let firstByteMs = null;
    let responseBytes = 0;
    let usageCapture = null;
    let usageComplete = false;
    let failureMessage = "没有可用账号，请检查工作区状态、模型范围或冷却时间";
    try {
      if (Buffer.byteLength(requestBody, "utf8") > MAX_REQUEST_BYTES) {
        finalStatus = 413;
        failureMessage = "请求体经覆盖后超出大小限制";
        const error = { type: "invalid_request_error", message: failureMessage };
        res.writeHead(finalStatus, {
          "Content-Type": "application/json",
          "X-Request-Id": requestId,
        });
        res.end(JSON.stringify(path.startsWith("/v1/messages") ? { type: "error", error } : { error }));
        return;
      }
      for (; attempts < this.store.state.settings.maxAttempts;) {
        if (controller.signal.aborted) {
          finalStatus = 499;
          return;
        }
        const selected = this.select(forwardedPayload.model, excluded, affinityKey);
        if (!selected) break;
        account = selected;
        const source = {
          ...account,
          healthVersion: this.healthVersions.get(account.id) || 0,
        };
        attempts++;
        excluded.add(account.id);
        this.active.set(account.id, (this.active.get(account.id) || 0) + 1);
        let timer;
        if (headerCarrier) diagnostics.headers.supported = null;
        try {
          const attempt = new AbortController();
          timer = setTimeout(
            () => attempt.abort(),
            // Workers may not send headers until generation produces its first
            // token (or finishes a non-streaming response). This is inference
            // idle time, not the authenticated readiness connection deadline.
            this.store.state.settings.idleTimeoutSeconds * 1000,
          );
          const signal = AbortSignal.any([controller.signal, attempt.signal]);
          const response = await fetch(`${account.endpoint}${upstreamPath}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${account.secrets.proxyKey}`,
              "Content-Type": "application/json",
              ...(req.headers["anthropic-version"]
                ? { "anthropic-version": req.headers["anthropic-version"] }
                : {}),
              ...(headerCarrier
                ? { "x-cnb2api-upstream-headers": headerCarrier }
                : {}),
            },
            body: requestBody,
            signal,
            redirect: "error",
          });
          clearTimeout(timer);
          finalStatus = response.status;
          if (headerCarrier) {
            const supported = response.headers.get("x-cnb2api-override-support") === "1"
              ? true
              : null;
            diagnostics.headers.supported = supported;
            diagnostics.headers.attempts.push({ attempt: attempts, status: response.status, supported });
          }
          if (retryable(response.status)) {
            await response.body?.cancel();
            failureMessage = `工作区返回 HTTP ${response.status}，已进入冷却`;
            this.fail(account.id, failureMessage, response.status, source, { routing: true });
            this.affinity.forget(affinityKey, account.id);
            this.store.record({
              kind: "failover",
              accountId: account.id,
              accountName: account.name,
              status: response.status,
              message: "上游失败，尝试切换下一个可用账号",
            });
            continue;
          }
          if (!response.ok)
            failureMessage = `工作区返回 HTTP ${response.status}`;
          if (path !== "/v1/messages/count_tokens")
            usageCapture = new TokenUsageCapture(
              response.headers.get("content-type") || "application/json",
              upstreamPath,
            );
          const convert = responses && response.ok;
          const convertStream = convert && payload.stream === true;
          const converter = convertStream ? new ResponsesStream({ model: payload.model, requestId, toolContext: prepared.toolContext }) : null;
          const replyHeaders = {
            "Content-Type":
              convert ? (convertStream ? "text/event-stream" : "application/json") :
                response.headers.get("content-type") || "application/json",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Request-Id": requestId,
            ...(response.headers.has("retry-after")
              ? { "Retry-After": response.headers.get("retry-after") }
              : {}),
          };
          if (!convert || convertStream) res.writeHead(response.status, replyHeaders);
          const emit = async (value) => {
            const writable = res.write(value);
            firstByteMs ??= Date.now() - started;
            responseBytes += Buffer.byteLength(value);
            if (!writable) await once(res, "drain", { signal: controller.signal });
          };
          const chunks = [];
          let bufferedBytes = 0;
          const reader = response.body?.getReader();
          if (reader) {
            try {
              while (!controller.signal.aborted) {
                timer = setTimeout(
                  () => attempt.abort(),
                  this.store.state.settings.idleTimeoutSeconds * 1000,
                );
                const { done, value } = await reader.read();
                clearTimeout(timer);
                if (done) break;
                usageCapture?.push(value);
                if (converter) {
                  for (const frame of converter.push(value)) await emit(frame);
                } else if (convert) {
                  bufferedBytes += value.byteLength;
                  if (bufferedBytes > RESPONSE_CONVERSION_BYTES)
                    throw new Error("Responses conversion response exceeds limit");
                  chunks.push(value);
                } else await emit(value);
              }
            } finally {
              clearTimeout(timer);
              await reader.cancel().catch(() => {});
            }
          }
          if (controller.signal.aborted) {
            finalStatus = 499;
            return;
          }
          if (converter) {
            for (const frame of converter.finish()) await emit(frame);
          } else if (convert) {
            const converted = toResponsesResponse(
              JSON.parse(Buffer.concat(chunks, bufferedBytes).toString("utf8")),
              { model: payload.model, requestId, toolContext: prepared.toolContext },
            );
            res.writeHead(response.status, replyHeaders);
            await emit(Buffer.from(JSON.stringify(converted)));
          }
          success = response.ok;
          usageComplete = true;
          res.end();
          return;
        } catch (error) {
          clearTimeout(timer);
          if (controller.signal.aborted || res.destroyed) {
            finalStatus = 499;
            return;
          }
          finalStatus = 502;
          failureMessage = res.headersSent
            ? "上游响应中断"
            : wakeTimedOut(error) || error?.name === "AbortError"
              ? "推理响应等待超时，正在检查工作区连接"
              : "推理请求连接失败，正在检查工作区连接";
          await this.confirmConnectionFailure(source).catch(() => {});
          this.affinity.forget(affinityKey, account.id);
          if (res.headersSent) {
            res.destroy();
            return;
          }
        } finally {
          this.active.set(
            account.id,
            Math.max(0, (this.active.get(account.id) || 1) - 1),
          );
        }
      }
      if (!res.destroyed) {
        res.writeHead(503, {
          "Content-Type": "application/json",
          "Retry-After": "15",
          "X-Request-Id": requestId,
        });
        finalStatus = 503;
        const error = { type: "api_error", message: "服务暂时不可用，请稍后重试" };
        res.end(
          JSON.stringify(
            path.startsWith("/v1/messages")
              ? { type: "error", error }
              : { error },
          ),
        );
      }
    } finally {
      res.removeListener("close", disconnected);
      this.store.record({
        kind: "request",
        requestId,
        accountId: account?.id ?? null,
        accountName: account?.name ?? "—",
        status: finalStatus,
        model:
          typeof payload.model === "string" ? payload.model.slice(0, 120) : "",
        path,
        method: "POST",
        stream: payload.stream === true,
        requestBytes: Buffer.byteLength(requestBody, "utf8"),
        responseBytes,
        firstByteMs,
        upstreamEndpoint: account?.endpoint || "",
        requestDiagnostics: diagnostics,
        ...(initialMessage ? { initialMessage } : {}),
        attempts,
        durationMs: Date.now() - started,
        ...(path !== "/v1/messages/count_tokens" && attempts > 0
          ? {
              tokenUsage: usageCapture
                ? usageCapture.finish(usageComplete)
                : { ...emptyTokenUsage(), missingRequests: 1 },
            }
          : {}),
        message: success
          ? "请求完成"
          : finalStatus === 499
            ? "客户端断开连接"
            : failureMessage,
      });
    }
  }
}
