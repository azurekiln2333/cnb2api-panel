import { randomUUID } from "node:crypto";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const date = (value) => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const pair = (accountId, serverId) => `${accountId}/${serverId}`;
const eligible = (account) => Boolean(account.endpoint && account.secrets.registrationToken);
const credentialVersion = (account) => account.registrationTokenVersion || 0;
const latest = (values) => values.filter(Boolean).sort().at(-1) || null;

export const RELAY_HEADERS = Object.freeze({
  version: "x-cnb2api-registration-relay",
  source: "x-cnb2api-relay-source",
  revision: "x-cnb2api-relay-revision",
});

export function parseRelayHeaders(headers) {
  const read = (name) => typeof headers.get === "function" ? headers.get(name) ?? undefined : headers[name];
  const version = read(RELAY_HEADERS.version);
  const sourceId = read(RELAY_HEADERS.source);
  const rawRevision = read(RELAY_HEADERS.revision);
  if ([version, sourceId, rawRevision].every((value) => value === undefined)) return null;
  if (version !== "1" || !uuid(sourceId) || typeof rawRevision !== "string" || !/^[1-9]\d{0,15}$/.test(rawRevision))
    fail("注册联动请求头格式不正确");
  const revision = Number(rawRevision);
  if (!Number.isSafeInteger(revision)) fail("注册联动版本号无效");
  return { sourceId: sourceId.toLowerCase(), revision };
}

export function validateRegistrationRelay(value, { allowLocal = false, publicUrl = "" } = {}) {
  if (value === undefined) return { enabled: false, servers: [] };
  if (!object(value) || typeof value.enabled !== "boolean" || !Array.isArray(value.servers) || value.servers.length > 20)
    fail("注册联动配置须包含开关和最多 20 台服务器");
  const origins = new Set();
  const ids = new Set();
  const servers = value.servers.map((server) => {
    if (!object(server) || typeof server.name !== "string" || !server.name.trim() || server.name.trim().length > 80 || /[\x00-\x1f\x7f]/.test(server.name))
      fail("联动服务器名称须为 1 至 80 字符");
    if (typeof server.origin !== "string" || server.origin.length > 500) fail("联动服务器地址格式不正确");
    let url;
    try { url = new URL(server.origin.trim()); } catch { fail("联动服务器须使用完整的 HTTPS 地址"); }
    const local = allowLocal && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      fail("联动服务器须使用不含路径和凭据的 HTTPS 地址");
    if (publicUrl && url.origin === new URL(publicUrl).origin) fail("联动服务器不能填写本机地址");
    const serverId = server.id === undefined || server.id === "" ? randomUUID() : server.id;
    if (!id(serverId) || ids.has(serverId)) fail("联动服务器标识无效或重复");
    if (origins.has(url.origin)) fail("联动服务器地址不能重复");
    if (typeof server.enabled !== "boolean") fail("联动服务器启用状态须为布尔值");
    ids.add(serverId);
    origins.add(url.origin);
    return { id: serverId, name: server.name.trim(), origin: url.origin, enabled: server.enabled };
  });
  return { enabled: value.enabled, servers };
}

export function loadRegistrationRelay(value) {
  if (value === undefined) return { version: 1, sourceId: randomUUID(), revision: 0, generations: {}, deliveries: {}, receipts: {} };
  const invalid = () => fail("Invalid registration relay state; restore the statistics backup", 500);
  if (!object(value) || value.version !== 1 || !uuid(value.sourceId) || !integer(value.revision) ||
    !object(value.generations) || !object(value.deliveries) || !object(value.receipts)) invalid();
  for (const [accountId, generation] of Object.entries(value.generations)) {
    if (!id(accountId) || !object(generation) || !integer(generation.revision) || generation.revision < 1 ||
      generation.revision > value.revision || typeof generation.endpoint !== "string" || generation.endpoint.length > 500 ||
      !integer(generation.credentialVersion) || typeof generation.local !== "boolean") invalid();
  }
  for (const [key, delivery] of Object.entries(value.deliveries)) {
    if (!object(delivery) || !id(delivery.accountId) || !id(delivery.serverId) || key !== pair(delivery.accountId, delivery.serverId) ||
      !integer(delivery.revision) || delivery.revision < 1 || delivery.revision > value.revision ||
      !integer(delivery.credentialVersion) || typeof delivery.endpoint !== "string" || delivery.endpoint.length > 500 ||
      typeof delivery.origin !== "string" || delivery.origin.length > 500 || !["pending", "failed", "success"].includes(delivery.status) ||
      !integer(delivery.attempts) || !integer(delivery.nextAttemptAt) || !date(delivery.lastAttemptAt) || !date(delivery.lastSuccessAt) ||
      (delivery.paused !== undefined && typeof delivery.paused !== "boolean") ||
      typeof delivery.lastError !== "string" || delivery.lastError.length > 160) invalid();
  }
  for (const [accountId, sources] of Object.entries(value.receipts)) {
    if (!id(accountId) || !object(sources) || Object.keys(sources).length > 32) invalid();
    for (const [sourceId, revision] of Object.entries(sources)) if (!uuid(sourceId) || !integer(revision) || revision < 1) invalid();
  }
  return structuredClone(value);
}

function advance(runtime) {
  if (runtime.revision >= Number.MAX_SAFE_INTEGER) fail("注册联动版本号已达上限", 503);
  return ++runtime.revision;
}

function generation(runtime, account, local = true) {
  const value = { revision: advance(runtime), endpoint: account.endpoint, credentialVersion: credentialVersion(account), local };
  runtime.generations[account.id] = value;
  return value;
}

function enqueue(runtime, account, server, version, now) {
  const key = pair(account.id, server.id);
  const previous = runtime.deliveries[key];
  runtime.deliveries[key] = {
    accountId: account.id, serverId: server.id, origin: server.origin,
    endpoint: account.endpoint, revision: version.revision, credentialVersion: version.credentialVersion,
    status: "pending", attempts: 0, nextAttemptAt: now, paused: false,
    lastAttemptAt: null, lastSuccessAt: previous?.lastSuccessAt || null, lastError: "",
  };
}

function validJob(state, job, requireEnabled = true) {
  const account = state.accounts.find((entry) => entry.id === job.accountId);
  const server = state.settings.registrationRelay.servers.find((entry) => entry.id === job.serverId);
  const version = state.registrationRelay.generations[job.accountId];
  const current = state.registrationRelay.deliveries[pair(job.accountId, job.serverId)];
  return Boolean(account && server && current && version?.local && eligible(account) &&
    (!requireEnabled || (state.settings.registrationRelay.enabled && server.enabled)) &&
    current.revision === job.revision && current.origin === job.origin && current.endpoint === job.endpoint &&
    current.credentialVersion === job.credentialVersion &&
    server.origin === job.origin && account.endpoint === job.endpoint &&
    credentialVersion(account) === job.credentialVersion && version.revision === job.revision);
}

function reconcileState(state, runtime, now, force = false) {
  for (const accountId of Object.keys(runtime.generations)) if (!state.accounts.some((account) => account.id === accountId)) delete runtime.generations[accountId];
  for (const accountId of Object.keys(runtime.receipts)) if (!state.accounts.some((account) => account.id === accountId)) delete runtime.receipts[accountId];
  const candidate = { ...state, registrationRelay: runtime };
  for (const [key, delivery] of Object.entries(runtime.deliveries)) {
    if (!validJob(candidate, delivery, false)) delete runtime.deliveries[key];
    else if (!state.settings.registrationRelay.enabled || !state.settings.registrationRelay.servers.find((server) => server.id === delivery.serverId)?.enabled)
      delivery.paused = true;
  }
  let scheduled = 0;
  for (const account of state.accounts) {
    if (!eligible(account)) continue;
    let version = runtime.generations[account.id];
    if (force || !version || version.endpoint !== account.endpoint || version.credentialVersion !== credentialVersion(account))
      version = generation(runtime, account);
    if (!state.settings.registrationRelay.enabled || !version.local) continue;
    for (const server of state.settings.registrationRelay.servers) {
      if (!server.enabled) continue;
      const current = runtime.deliveries[pair(account.id, server.id)];
      if (force || !current || current.paused || current.revision !== version.revision || current.origin !== server.origin) {
        enqueue(runtime, account, server, version, now);
        scheduled++;
      }
    }
  }
  return scheduled;
}

const failure = (kind, status = 502) => Object.assign(new Error(kind), { relayKind: kind, status });
const messages = {
  authentication: "联动服务器未匹配注册密钥",
  unsupported: "联动服务器版本不支持注册联动",
  acknowledgement: "联动服务器返回了无效确认",
  timeout: "联动服务器响应超时",
  connection: "联动服务器连接失败",
  http: "联动服务器返回失败状态",
};

export class RegistrationRelay {
  constructor(store, { now = Date.now, fetchImpl = fetch, timeoutMs = 10000, pollMs = 1000, publicUrl = "" } = {}) {
    this.store = store;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
    this.publicUrl = publicUrl;
    this.active = new Map();
    this.stopped = false;
    this.scheduled = false;
  }

  register(accountId, endpoint, relay = null) {
    const account = this.store.get(accountId);
    if (relay && (!uuid(relay.sourceId) || !integer(relay.revision) || relay.revision < 1)) fail("注册联动请求头格式不正确");
    if (relay?.sourceId.toLowerCase() === this.store.state.registrationRelay.sourceId.toLowerCase())
      fail("注册联动不能回传到来源服务器");
    const result = { ok: true, accountId, ...(relay ? { relay: { version: 1, sourceId: relay.sourceId, revision: relay.revision } } : {}) };
    if (relay && (this.store.state.registrationRelay.receipts[accountId]?.[relay.sourceId] || 0) >= relay.revision)
      return { applied: false, result };
    this.store.commit((state) => {
      const target = state.accounts.find((entry) => entry.id === account.id);
      Object.assign(target, {
        endpoint, registeredAt: new Date(this.now()).toISOString(), status: "pending", cooldownUntil: null,
        failures: 0, failureKind: null, lastError: "", discoveredModels: [],
      });
      const runtime = state.registrationRelay;
      const version = generation(runtime, target, !relay);
      for (const [key, delivery] of Object.entries(runtime.deliveries)) if (delivery.accountId === accountId) delete runtime.deliveries[key];
      if (relay) {
        const sources = runtime.receipts[accountId] ??= {};
        if (sources[relay.sourceId] === undefined && Object.keys(sources).length >= 32) fail("注册联动来源数量已达上限");
        sources[relay.sourceId] = relay.revision;
      } else if (state.settings.registrationRelay.enabled) {
        for (const server of state.settings.registrationRelay.servers)
          if (server.enabled) enqueue(runtime, target, server, version, this.now());
      }
    });
    return { applied: true, result };
  }

  reconcile() {
    const runtime = structuredClone(this.store.state.registrationRelay);
    const scheduled = reconcileState(this.store.state, runtime, this.now());
    if (JSON.stringify(runtime) !== JSON.stringify(this.store.state.registrationRelay))
      this.store.commit((state) => { state.registrationRelay = runtime; });
    for (const [key, work] of this.active) if (!validJob(this.store.state, work.job)) work.controller.abort();
    this.kick();
    return { scheduled };
  }

  sync() {
    if (!this.store.state.settings.registrationRelay.enabled) return { scheduled: 0 };
    let scheduled;
    this.store.commit((state) => { scheduled = reconcileState(state, state.registrationRelay, this.now(), true); });
    this.reconcile();
    return { scheduled };
  }

  status() {
    const { enabled, servers } = this.store.state.settings.registrationRelay;
    return { enabled, servers: servers.map((server) => {
      const jobs = Object.values(this.store.state.registrationRelay.deliveries).filter((job) => job.serverId === server.id && job.origin === server.origin);
      const pending = jobs.filter((job) => job.status === "pending").length;
      const failed = jobs.filter((job) => job.status === "failed").length;
      const newestFailure = jobs.filter((job) => job.lastError).sort((left, right) => (right.lastAttemptAt || "").localeCompare(left.lastAttemptAt || ""))[0];
      return { ...server, status: !enabled || !server.enabled ? "disabled" : failed ? "failed" : pending ? "pending" : jobs.length ? "success" : "idle",
        pending, failed, lastAttemptAt: latest(jobs.map((job) => job.lastAttemptAt)),
        lastSuccessAt: latest(jobs.map((job) => job.lastSuccessAt)), lastError: newestFailure?.lastError || "" };
    }) };
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.reconcile();
    this.timer = setInterval(() => {
      try { this.reconcile(); } catch { this.stop(); }
    }, this.pollMs);
    this.timer.unref();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    for (const work of this.active.values()) work.controller.abort();
  }

  kick() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.stopped) this.run().catch(() => { this.stop(); });
    });
  }

  async run() {
    if (this.stopped) return;
    const started = [];
    for (const [key, saved] of Object.entries(this.store.state.registrationRelay.deliveries)) {
      if (this.active.size >= 4) break;
      if (this.active.has(key) || saved.status === "success" || saved.nextAttemptAt > this.now() || !validJob(this.store.state, saved)) continue;
      const work = { job: structuredClone(saved), controller: new AbortController() };
      this.active.set(key, work);
      const promise = this.deliver(work).finally(() => {
        if (this.active.get(key) === work) this.active.delete(key);
        this.kick();
      });
      work.promise = promise;
      started.push(promise);
    }
    await Promise.all(started);
  }

  async request(job, token, signal) {
    const response = await this.fetchImpl(`${job.origin}/ops/register`, {
      method: "POST", redirect: "error", signal,
      headers: { "Content-Type": "application/json", "X-Reg-Token": token,
        [RELAY_HEADERS.version]: "1", [RELAY_HEADERS.source]: this.store.state.registrationRelay.sourceId,
        [RELAY_HEADERS.revision]: String(job.revision) },
      body: JSON.stringify({ uri: job.endpoint }),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw failure([401, 403].includes(response.status) ? "authentication" : "http", response.status);
    }
    if (!/\bapplication\/json\b/i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel().catch(() => {});
      throw failure("acknowledgement");
    }
    const reader = response.body?.getReader();
    if (!reader) throw failure("acknowledgement");
    const chunks = [];
    let bytes = 0;
    let body;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) throw failure("acknowledgement");
        chunks.push(Buffer.from(value));
      }
      try { body = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); } catch { throw failure("acknowledgement"); }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!object(body) || body.ok !== true || !id(body.accountId)) throw failure("acknowledgement");
    if (!object(body.relay) || body.relay.version !== 1) throw failure("unsupported");
    if (body.relay.sourceId !== this.store.state.registrationRelay.sourceId || body.relay.revision !== job.revision) throw failure("acknowledgement");
  }

  async deliver({ job, controller }) {
    if (!validJob(this.store.state, job)) return;
    const token = this.store.get(job.accountId).secrets.registrationToken;
    const attemptAt = new Date(this.now()).toISOString();
    this.store.commit((state) => {
      const current = state.registrationRelay.deliveries[pair(job.accountId, job.serverId)];
      current.attempts++;
      current.lastAttemptAt = attemptAt;
    });
    let expired = false;
    let onAbort;
    const interrupted = new Promise((_resolve, reject) => {
      onAbort = () => reject(failure(expired ? "timeout" : "cancelled", expired ? 504 : 502));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => { expired = true; controller.abort(); }, this.timeoutMs);
    let error = null;
    try { await Promise.race([this.request(job, token, controller.signal), interrupted]); }
    catch (caught) { error = caught; }
    finally { clearTimeout(timer); controller.signal.removeEventListener("abort", onAbort); }
    if (this.stopped || !validJob(this.store.state, job) || error?.relayKind === "cancelled") return;
    const message = error ? messages[error.relayKind] || messages.connection : "";
    this.store.commit((state) => {
      const current = state.registrationRelay.deliveries[pair(job.accountId, job.serverId)];
      if (error) {
        current.status = "failed";
        current.lastError = message;
        current.nextAttemptAt = this.now() + Math.min(300000, 5000 * 2 ** Math.min(6, current.attempts - 1));
      } else {
        current.status = "success";
        current.lastError = "";
        current.lastSuccessAt = new Date(this.now()).toISOString();
        current.nextAttemptAt = 0;
      }
    });
    const account = this.store.get(job.accountId);
    this.store.record({ kind: "register", accountId: job.accountId, accountName: account.name,
      relayServerId: job.serverId, status: error ? error.status || 502 : 200,
      message: error ? message : "注册信息已同步到联动服务器" });
  }
}
