import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
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

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const DEFAULT_SETTINGS = {
  strategy: "weighted",
  sessionAffinity: true,
  maxAttempts: 3,
  cooldownSeconds: 60,
  healthIntervalSeconds: 60,
  connectTimeoutSeconds: 20,
  idleTimeoutSeconds: 300,
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
  if (
    url.protocol === "http:" &&
    !(allowLocal && loopbackHost(url.hostname))
  )
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
    if (typeof entry !== "string") throw new InputError(`${label}须为字符串数组`);
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

export function validateSso(input, previous = DEFAULT_SSO, { allowLocal = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InputError("请填写 SSO 配置");
  const next = withSsoDefaults(previous);
  for (const key of ["enabled", "keyLoginEnabled"])
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean")
        throw new InputError("SSO 启用状态须为布尔值");
      next[key] = input[key];
    }
  if (input.issuer !== undefined) next.issuer = normalizeIssuer(input.issuer, allowLocal);
  if (input.clientId !== undefined) {
    const value = text(input.clientId, 200, "SSO 客户端 ID");
    if (!printable(value)) throw new InputError("SSO 客户端 ID 含有无效字符");
    next.clientId = value;
  }
  // A blank secret keeps the stored value; only a non-blank value replaces it.
  if (input.clientSecret !== undefined) {
    if (typeof input.clientSecret !== "string" || input.clientSecret.length > 1024)
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
  const { secrets, workerUsage, ...visible } = account;
  return {
    ...visible,
    hasProxyKey: Boolean(secrets.proxyKey),
    hasPat: Boolean(secrets.pat),
  };
}

export class Store {
  constructor(directory, { allowLocal = false } = {}) {
    this.directory = resolve(directory);
    this.allowLocal = allowLocal;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const keyFile = join(this.directory, "master.key");
    if (!existsSync(keyFile))
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32)
      throw new Error(
        "data/master.key is invalid; restore the original encryption key",
      );
    this.file = join(this.directory, "panel.json");
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved.version !== 1)
        throw new Error("Unsupported panel data version");
      this.state = {
        ...saved,
        settings: { ...DEFAULT_SETTINGS, ...saved.settings },
        tokenUsage: { ...emptyTokenUsage(), ...saved.tokenUsage },
        tokenUsageStartedAt:
          saved.tokenUsageStartedAt || new Date().toISOString(),
        hourly: (saved.hourly || []).map((b) => ({
          ...b,
          tokenUsage: { ...emptyTokenUsage(), ...b.tokenUsage },
        })),
        accounts: saved.accounts.map((a) => ({
          ...a,
          quotaSync: a.quotaSync || null,
          tokenUsage: { ...emptyTokenUsage(), ...a.tokenUsage },
          secrets: this.decrypt(a.secrets),
        })),
      };
      this.state.sso = this.loadSso(saved.sso);
      if (!saved.tokenUsageStartedAt) this.commit(() => {});
    } else {
      this.state = {
        version: 1,
        accounts: [],
        settings: { ...DEFAULT_SETTINGS },
        sso: { ...DEFAULT_SSO },
        logs: [],
        hourly: [],
        tokenUsage: emptyTokenUsage(),
        tokenUsageStartedAt: new Date().toISOString(),
      };
      this.commit(() => {});
    }
  }

  loadSso(saved) {
    const sso = withSsoDefaults(saved);
    // panel.json keeps the client secret encrypted with master.key.
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

  // Write first, publish second: an unsuccessful write cannot become a successful API mutation.
  commit(mutate) {
    const next = structuredClone(this.state);
    const result = mutate(next);
    const disk = {
      ...next,
      accounts: next.accounts.map((a) => ({
        ...a,
        secrets: this.encrypt(a.secrets),
      })),
      sso: {
        ...withSsoDefaults(next.sso),
        clientSecret: this.encrypt(next.sso?.clientSecret || ""),
      },
    };
    writeFileSync(`${this.file}.tmp`, JSON.stringify(disk), { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    this.state = next;
    return result;
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
      autoWake,
      branch,
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
      latencyMs: null,
      lastError: "",
      quota: null,
      quotaSync: null,
      requests: 0,
      errors: 0,
      lastWakeAt: null,
      tokenUsage: emptyTokenUsage(),
    };
    this.commit((s) => s.accounts.push(account));
    return account;
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
              lastError: "",
              discoveredModels: [],
              latencyMs: null,
            }
          : {},
        old.repo !== fields.repo ? { quota: null, lastWakeAt: null } : {},
        old.repo !== fields.repo || old.secrets.pat !== fields.secrets.pat
          ? { quotaSync: null }
          : {},
      );
    });
    return this.get(id);
  }

  patch(id, fields) {
    this.commit((s) =>
      Object.assign(s.accounts.find((a) => a.id === id) ?? {}, fields),
    );
  }

  remove(id) {
    this.get(id);
    this.commit((s) => {
      s.accounts = s.accounts.filter((a) => a.id !== id);
    });
  }

  settings(input) {
    const next = { ...this.state.settings };
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

  record(entry) {
    const now = Date.now();
    this.commit((s) => {
      const log = {
        ...entry,
        id: randomUUID(),
        at: new Date(now).toISOString(),
      };
      s.logs.unshift(log);
      s.logs = s.logs.slice(0, 1000);
      if (entry.kind !== "request") return;
      const hour = new Date(Math.floor(now / 3600000) * 3600000).toISOString();
      let bucket = s.hourly.find((b) => b.at === hour);
      if (!bucket) {
        bucket = {
          at: hour,
          requests: 0,
          errors: 0,
          durationMs: 0,
          accounts: {},
          tokenUsage: emptyTokenUsage(),
        };
        s.hourly.push(bucket);
      }
      bucket.requests++;
      bucket.errors += entry.status >= 400 ? 1 : 0;
      bucket.durationMs += entry.durationMs || 0;
      if (entry.accountId)
        bucket.accounts[entry.accountId] =
          (bucket.accounts[entry.accountId] || 0) + 1;
      s.hourly = s.hourly.filter((b) => Date.parse(b.at) > now - 30 * 86400000);
      const account = s.accounts.find((a) => a.id === entry.accountId);
      if (entry.tokenUsage) {
        addTokenUsage(s.tokenUsage, entry.tokenUsage);
        addTokenUsage(bucket.tokenUsage, entry.tokenUsage);
        if (account) addTokenUsage(account.tokenUsage, entry.tokenUsage);
      }
      if (account) {
        account.requests++;
        if (entry.status >= 400) account.errors++;
      }
    });
  }
}
