import http from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InputError,
  Store,
  publicAccount,
  sanitizeSso,
  ssoIsConfigured,
  validateSso,
} from "./store.mjs";
import {
  OidcError,
  buildAuthorizationUrl,
  createTransaction,
  discoverProvider,
  exchangeAuthorizationCode,
  fetchUserInfo,
  identityFromClaims,
  isAllowed,
  safeEqual,
  verifyIdTokenForConfig,
} from "./auth.mjs";
import { Pool, isReady, isCooling } from "./pool.mjs";
import { addTokenUsage, emptyTokenUsage } from "./token-usage.mjs";
import { auditRequest } from "./audit.mjs";
import { logChannel } from "./file-storage.mjs";

const SESSION_MS = 12 * 60 * 60 * 1000;
const OIDC_TRANSACTION_MS = 10 * 60 * 1000;
const digest = (value) => createHash("sha256").update(String(value)).digest();
const equals = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Boolean(a && b) &&
  timingSafeEqual(digest(a), digest(b));
const json = (res, status, data, headers = {}) => {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(data));
};

async function body(req, maxBytes = 65536) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const reject = (error) => {
      if (!settled) {
        settled = true;
        chunks.length = 0;
        rejectBody(error);
      }
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      // Keep draining after rejection so the HTTP 413 response reaches the client.
      if (size > maxBytes) {
        reject(new InputError("请求体超出大小限制", 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      let value;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reject(new InputError("请求体须为有效的 JSON"));
        return;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        reject(new InputError("请求体须为 JSON 对象"));
        return;
      }
      settled = true;
      resolveBody(value);
    });
    req.on("error", () => reject(new InputError("客户端连接已断开", 400)));
    req.on("close", () => {
      if (!req.complete) reject(new InputError("客户端连接已断开", 400));
    });
  });
}

export function createPanelServer(options) {
  const {
    adminKey,
    gatewayKey,
    dataDir,
    logDir,
    publicUrl = "",
    allowLocal = false,
    ssoBootstrap = null,
    poolOptions = {},
    webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url)),
  } = options;
  if (!adminKey || adminKey.length < 12)
    throw new Error("PANEL_ADMIN_KEY must contain at least 12 characters");
  if (!gatewayKey || gatewayKey.length < 12)
    throw new Error("GATEWAY_KEY must contain at least 12 characters");
  if (adminKey === gatewayKey)
    throw new Error("PANEL_ADMIN_KEY and GATEWAY_KEY must be different");
  if (/[^\x21-\x7e]/.test(gatewayKey))
    throw new Error(
      "GATEWAY_KEY must contain printable ASCII characters without spaces",
    );
  if (publicUrl) {
    let parsed;
    try {
      parsed = new URL(publicUrl);
    } catch {
      throw new Error("PANEL_PUBLIC_URL must be a valid HTTP(S) origin");
    }
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        "PANEL_PUBLIC_URL must be an HTTP(S) origin without a path or credentials",
      );
    }
  }
  const store = new Store(dataDir, { allowLocal, logDir });
  // Environment variables only seed an unconfigured panel; saved SSO settings win.
  if (ssoBootstrap && typeof ssoBootstrap === "object") {
    if (!ssoIsConfigured(store.state.sso)) {
      const seeded = validateSso(ssoBootstrap, store.state.sso, {
        allowLocal,
      });
      store.saveSso(seeded);
    }
  }
  const pool = new Pool(store, poolOptions);
  const sessions = new Map();
  const ssoFingerprint = (sso) =>
    digest(
      JSON.stringify([
        sso.issuer,
        sso.clientId,
        sso.clientSecret,
        sso.scope,
        sso.allowedSubjects,
        sso.allowedEmails,
        sso.callbackUrl,
      ]),
    ).toString("hex");
  const loginFailures = new Map();
  const root = resolve(webRoot);
  const getSession = (req) => {
    const cookie = cookieValue(req, "cnb_session");
    const entry = cookie ? sessions.get(cookie) : null;
    if (!entry || entry.expiresAt < Date.now()) return null;
    return {
      token: cookie,
      user: entry.user,
      ssoFingerprint: entry.ssoFingerprint,
    };
  };
  const isSecure = (req) =>
    publicUrl
      ? new URL(publicUrl).protocol === "https:"
      : Boolean(req.socket.encrypted);
  const sessionCookie = (req, token, age) =>
    `cnb_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${isSecure(req) ? "; Secure" : ""}`;
  const validOrigin = (req) => {
    if (!req.headers.origin) return true;
    try {
      const origin = new URL(req.headers.origin);
      return (
        origin.host === req.headers.host ||
        Boolean(publicUrl && origin.origin === new URL(publicUrl).origin)
      );
    } catch {
      return false;
    }
  };

  const cookieValue = (req, name) => {
    const prefix = `${name}=`;
    const header = (req.headers.cookie || "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(prefix));
    return header ? header.slice(prefix.length) : "";
  };
  const requestOrigin = (req) =>
    publicUrl
      ? new URL(publicUrl).origin
      : `${isSecure(req) ? "https" : "http"}://${req.headers.host || "localhost"}`;
  const ssoCallbackUrl = (req) =>
    store.state.sso.callbackUrl ||
    `${requestOrigin(req)}/api/auth/oidc/callback`;
  const redirectResponse = (res, location, headers = {}) => {
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(302, {
      "Cache-Control": "no-store",
      Location: location,
      ...headers,
    });
    res.end();
  };
  const oidcCookie = (req, value, age) =>
    `cnb_oidc=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${isSecure(req) ? "; Secure" : ""}`;
  const oidcTransactions = new Map();
  const pruneTransactions = () => {
    const now = Date.now();
    for (const [id, tx] of oidcTransactions)
      if (tx.expiresAt <= now) oidcTransactions.delete(id);
    if (oidcTransactions.size >= 500)
      oidcTransactions.delete(oidcTransactions.keys().next().value);
  };
  // Safe reasons never carry tokens, secrets, codes or provider descriptions.
  const safeReason = (error) =>
    error instanceof OidcError && /^[a-z_]+$/.test(error.reason)
      ? error.reason
      : "internal_error";
  const oidcLogin = async (req, res) => {
    const sso = store.state.sso;
    if (!sso.enabled) return redirectResponse(res, "/?auth_error=sso_disabled");
    let discovery;
    try {
      discovery = await discoverProvider(sso, { allowLocal });
    } catch {
      return redirectResponse(res, "/?auth_error=discovery_failed");
    }
    pruneTransactions();
    const transaction = createTransaction();
    const redirectUri = ssoCallbackUrl(req);
    oidcTransactions.set(transaction.txid, {
      state: transaction.state,
      nonce: transaction.nonce,
      verifier: transaction.verifier,
      redirectUri,
      expiresAt: Date.now() + OIDC_TRANSACTION_MS,
    });
    const location = buildAuthorizationUrl(sso, {
      redirectUri,
      state: transaction.state,
      nonce: transaction.nonce,
      codeChallenge: transaction.challenge,
      authorizationEndpoint: discovery.authorizationEndpoint,
    });
    return redirectResponse(res, location, {
      "Set-Cookie": oidcCookie(
        req,
        transaction.txid,
        OIDC_TRANSACTION_MS / 1000,
      ),
    });
  };
  const oidcCallback = async (req, res) => {
    const sso = store.state.sso;
    const clearCookie = oidcCookie(req, "", 0);
    const fail = (reason) => {
      req.auditStatus = 403;
      return redirectResponse(res, `/?auth_error=${reason}`, {
        "Set-Cookie": clearCookie,
      });
    };
    if (!sso.enabled) return fail("sso_disabled");
    const url = new URL(req.url, "http://panel.local");
    const txid = cookieValue(req, "cnb_oidc");
    const transaction = txid ? oidcTransactions.get(txid) : null;
    if (txid) oidcTransactions.delete(txid);
    if (!transaction || transaction.expiresAt <= Date.now())
      return fail("transaction_expired");
    if (url.searchParams.get("error")) return fail("provider_error");
    const state = url.searchParams.get("state") || "";
    if (!safeEqual(state, transaction.state)) return fail("state_mismatch");
    const code = url.searchParams.get("code") || "";
    if (!code || code.length > 4096) return fail("missing_code");
    let discovery;
    let tokens;
    try {
      discovery = await discoverProvider(sso, { allowLocal });
      tokens = await exchangeAuthorizationCode(sso, {
        code,
        codeVerifier: transaction.verifier,
        redirectUri: transaction.redirectUri,
        tokenEndpoint: discovery.tokenEndpoint,
      });
    } catch (error) {
      return fail(safeReason(error));
    }
    let idClaims;
    try {
      idClaims = await verifyIdTokenForConfig(sso, tokens.id_token, {
        nonce: transaction.nonce,
        allowLocal,
      });
    } catch (error) {
      return fail(safeReason(error));
    }
    let userInfo = null;
    try {
      userInfo = await fetchUserInfo(discovery, tokens.access_token);
    } catch {
      // UserInfo stays optional; verified ID token claims remain the fallback.
    }
    if (userInfo && userInfo.sub !== idClaims.sub)
      return fail("userinfo_mismatch");
    let identity;
    try {
      identity = identityFromClaims(userInfo, idClaims);
    } catch (error) {
      return fail(safeReason(error));
    }
    if (!isAllowed(identity, sso)) return fail("not_allowed");
    const token = randomBytes(32).toString("hex");
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    sessions.set(token, {
      expiresAt: Date.now() + SESSION_MS,
      ssoFingerprint: ssoFingerprint(sso),
      subject: identity.sub,
      user: {
        name: identity.name || identity.sub || "SSO 用户",
        email: identity.email,
        picture: identity.picture,
        provider: "oidc",
      },
    });
    // Issue the session and drop the single-use transaction cookie together.
    req.auditActor = { ...sessions.get(token).user, subject: identity.sub };
    req.auditStatus = 200;
    return redirectResponse(res, "/#overview", {
      "Set-Cookie": [sessionCookie(req, token, SESSION_MS / 1000), clearCookie],
    });
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      const path = new URL(req.url, "http://panel.local").pathname;
      const method = req.method;
      const auditSession = getSession(req);
      auditRequest(
        req,
        res,
        path,
        store,
        auditSession
          ? { ...auditSession.user, subject: auditSession.subject }
          : null,
      );
      if (path === "/health" && method === "GET") {
        const ready = store.state.accounts.filter(isReady).length;
        return json(res, ready ? 200 : 503, {
          status: ready ? "ok" : "degraded",
          ready,
        });
      }

      if (
        path === "/register" ||
        path === "/ops/register" ||
        /^\/ops\/register\/[^/]+$/.test(path)
      ) {
        if (method !== "POST")
          return json(
            res,
            405,
            { error: { message: "请使用 POST 注册工作区" } },
            { Allow: "POST" },
          );
        const token = req.headers["x-reg-token"];
        const targetId = path.split("/")[3];
        const account = store.state.accounts.find(
          (a) =>
            (!targetId || a.id === targetId) &&
            equals(token, a.secrets.registrationToken),
        );
        if (!account)
          return json(res, 403, { error: { message: "注册密钥无效" } });
        const input = await body(req, 4096);
        return json(res, 200, await pool.register(account.id, input.uri));
      }

      if (
        path === "/v1/models" ||
        path === "/models" ||
        [
          "/v1/chat/completions",
          "/v1/messages",
          "/v1/messages/count_tokens",
        ].includes(path)
      ) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta, x-session-id, x-conversation-id",
        );
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader(
          "Access-Control-Expose-Headers",
          "X-Request-Id, Retry-After",
        );
        if (method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }
        const key =
          req.headers.authorization?.replace(/^Bearer /i, "") ||
          req.headers["x-api-key"];
        if (!equals(key, gatewayKey)) {
          const error = {
            message: "invalid api key",
            type: "authentication_error",
          };
          return json(
            res,
            401,
            path.startsWith("/v1/messages")
              ? { type: "error", error }
              : { error },
          );
        }
        if ((path === "/v1/models" || path === "/models") && method === "GET") {
          const models = new Set(
            store.state.accounts
              .filter((a) => a.enabled)
              .flatMap((a) =>
                a.models.length ? a.models : a.discoveredModels,
              ),
          );
          return json(res, 200, {
            object: "list",
            data: [...models].map((id) => ({
              id,
              object: "model",
              owned_by: "cnb",
            })),
          });
        }
        if (method !== "POST")
          return json(res, 405, { error: { message: "method not allowed" } });
        const input = await body(req, 4 * 1024 * 1024);
        if (
          input.model !== undefined &&
          (typeof input.model !== "string" || input.model.length > 120)
        )
          throw new InputError("model 须为不超过 120 字符的字符串");
        await pool.forward(req, res, path, input);
        return;
      }

      if (path.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(method) && !validOrigin(req))
          throw new InputError("请求来源不匹配", 403);
        if (path === "/api/auth/config" && method === "GET") {
          const sso = store.state.sso;
          return json(res, 200, {
            keyLoginEnabled: sso.keyLoginEnabled,
            sso: {
              enabled: sso.enabled,
              providerName: sso.providerName || "SSO",
              loginUrl: sso.enabled ? "/api/auth/oidc/login" : "",
            },
          });
        }
        if (path === "/api/auth/oidc/login" && method === "GET")
          return await oidcLogin(req, res);
        if (path === "/api/auth/oidc/callback" && method === "GET")
          return await oidcCallback(req, res);
        if (path === "/api/session" && method === "POST") {
          if (!store.state.sso.keyLoginEnabled)
            throw new InputError("管理密钥登录已停用，请使用单点登录", 403);
          const ip = req.socket.remoteAddress;
          const now = Date.now();
          for (const [address, entry] of loginFailures)
            if (now - entry.at > 600000) loginFailures.delete(address);
          const failures = loginFailures.get(ip);
          if (failures?.count >= 10)
            return json(
              res,
              429,
              { error: { message: "登录尝试过多，请 10 分钟后重试" } },
              { "Retry-After": "600" },
            );
          const input = await body(req, 4096);
          if (!equals(input.key, adminKey)) {
            loginFailures.set(ip, {
              count: (failures?.count || 0) + 1,
              at: failures?.at || now,
            });
            throw new InputError("管理密钥不正确", 401);
          }
          loginFailures.delete(ip);
          const token = randomBytes(32).toString("hex");
          if (sessions.size >= 100)
            sessions.delete(sessions.keys().next().value);
          const user = {
            name: "管理员",
            email: "",
            picture: "",
            provider: "key",
          };
          req.auditActor = user;
          sessions.set(token, { expiresAt: now + SESSION_MS, user });
          return json(
            res,
            200,
            { authenticated: true, user },
            { "Set-Cookie": sessionCookie(req, token, SESSION_MS / 1000) },
          );
        }
        const session = getSession(req);
        if (!session) throw new InputError("请先登录管理面板", 401);
        if (path === "/api/session" && method === "GET")
          return json(res, 200, { authenticated: true, user: session.user });
        if (path === "/api/session" && method === "DELETE") {
          sessions.delete(session.token);
          return json(
            res,
            200,
            { ok: true },
            { "Set-Cookie": sessionCookie(req, "", 0) },
          );
        }
        if (path === "/api/auth/settings" && method === "GET")
          return json(
            res,
            200,
            sanitizeSso(store.state.sso, ssoCallbackUrl(req)),
          );
        if (path === "/api/auth/settings" && method === "PATCH") {
          const input = await body(req);
          const previous = store.state.sso;
          const fields = {};
          if (input.ssoEnabled !== undefined) fields.enabled = input.ssoEnabled;
          for (const key of [
            "keyLoginEnabled",
            "issuer",
            "clientId",
            "clientSecret",
            "scope",
            "providerName",
            "allowedSubjects",
            "allowedEmails",
            "callbackUrl",
          ])
            if (input[key] !== undefined) fields[key] = input[key];
          const candidate = validateSso(fields, previous, { allowLocal });
          // Closing key login needs proof that SSO actually works: a discovery
          // check cannot prove the client secret or allowlist are valid.
          if (
            previous.keyLoginEnabled &&
            candidate.keyLoginEnabled === false &&
            (session.user.provider !== "oidc" ||
              session.ssoFingerprint !== ssoFingerprint(candidate))
          )
            throw new InputError("请先通过 SSO 登录验证，再关闭管理密钥登录");
          // Re-check discovery whenever enabling SSO or changing its identity.
          const needsDiscovery =
            candidate.enabled &&
            (!previous.enabled ||
              previous.issuer !== candidate.issuer ||
              previous.clientId !== candidate.clientId ||
              (!candidate.keyLoginEnabled && previous.keyLoginEnabled));
          if (needsDiscovery) {
            try {
              await discoverProvider(candidate, { allowLocal });
            } catch {
              throw new InputError(
                "SSO 颁发者不可用或 discovery 校验失败，请检查地址后重试",
              );
            }
          }
          store.saveSso(candidate);
          return json(
            res,
            200,
            sanitizeSso(
              candidate,
              candidate.callbackUrl || ssoCallbackUrl(req),
            ),
          );
        }
        if (path === "/api/overview" && method === "GET") {
          const today =
            Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 -
            8 * 3600000;
          const buckets = store.state.hourly.filter(
            (b) => Date.parse(b.at) >= today,
          );
          const requests = buckets.reduce((n, b) => n + b.requests, 0);
          const errors = buckets.reduce((n, b) => n + b.errors, 0);
          const quotas = new Map();
          for (const a of store.state.accounts.filter(
            (a) => a.enabled && a.quota,
          )) {
            const previous = quotas.get(a.quota.org);
            if (!previous || a.quota.syncedAt > previous.syncedAt)
              quotas.set(a.quota.org, a.quota);
          }
          return json(res, 200, {
            accounts: pool.accounts(),
            settings: store.state.settings,
            hourly: store.state.hourly,
            stats: {
              total: store.state.accounts.length,
              ready: store.state.accounts.filter(isReady).length,
              cooling: store.state.accounts.filter(
                (a) => a.enabled && isCooling(a),
              ).length,
              requests,
              errors,
              tokenUsage: {
                today: buckets.reduce(
                  (total, b) => addTokenUsage(total, b.tokenUsage),
                  emptyTokenUsage(),
                ),
                total: store.state.tokenUsage,
                startedAt: store.state.tokenUsageStartedAt,
              },
              successRate: requests
                ? ((requests - errors) / requests) * 100
                : null,
              remainingCredits: quotas.size
                ? [...quotas.values()].reduce(
                    (n, q) =>
                      n +
                      Math.max(
                        0,
                        q.credits.total - q.credits.used - q.credits.freeze,
                      ),
                    0,
                  )
                : null,
              quotaOrganizations: quotas.size,
              averageDurationMs: requests
                ? Math.round(
                    buckets.reduce((n, b) => n + b.durationMs, 0) / requests,
                  )
                : null,
              activeRequests: [...pool.active.values()].reduce(
                (n, v) => n + v,
                0,
              ),
            },
          });
        }
        if (path === "/api/usage/comparison" && method === "GET")
          return json(res, 200, pool.workerUsage.overview());
        if (path === "/api/usage/comparison" && method === "POST") {
          await pool.workerUsage.refreshAll();
          return json(res, 200, pool.workerUsage.overview());
        }
        if (path === "/api/accounts" && method === "GET")
          return json(res, 200, { accounts: pool.accounts() });
        if (path === "/api/accounts" && method === "POST") {
          const account = store.create(await body(req));
          req.auditTarget = account;
          if (account.endpoint) pool.probe(account.id).catch(() => {});
          return json(res, 201, {
            account: publicAccount(account),
            registrationToken: account.secrets.registrationToken,
          });
        }
        const match =
          /^\/api\/accounts\/([\w-]+)(?:\/(probe|quota|wake|registration|pat|credentials))?$/.exec(
            path,
          );
        if (match) {
          const [, id, action] = match;
          const account = store.get(id);
          if (!action && method === "GET")
            return json(res, 200, { account: publicAccount(account) });
          if (!action && method === "PATCH") {
            const updated = store.update(id, await body(req));
            req.auditTarget = updated;
            if (
              updated.endpoint &&
              updated.enabled &&
              updated.status === "pending"
            )
              pool.probe(id).catch(() => {});
            return json(res, 200, { account: publicAccount(updated) });
          }
          if (!action && method === "DELETE") {
            store.remove(id);
            return json(res, 200, { ok: true });
          }
          if (action && method === "POST") {
            if (action === "credentials")
              return json(res, 200, {
                proxyKey: account.secrets.proxyKey || "",
                registrationToken: account.secrets.registrationToken || "",
                pat: account.secrets.pat || "",
              });
            if (action === "pat")
              return json(res, 200, { pat: account.secrets.pat || "" });
            if (action === "probe")
              return json(res, 200, { account: await pool.probe(id) });
            if (action === "quota")
              return json(res, 200, { quota: await pool.quota(id) });
            if (action === "wake") return json(res, 200, await pool.wake(id));
            if (action === "registration") {
              const token = randomBytes(24).toString("hex");
              store.update(id, { registrationToken: token });
              return json(res, 200, { registrationToken: token });
            }
          }
        }
        if (path === "/api/settings" && method === "GET")
          return json(res, 200, { settings: store.state.settings });
        if (path === "/api/settings" && method === "PATCH")
          return json(res, 200, { settings: store.settings(await body(req)) });
        const logRoute = /^\/api\/logs(?:\/(requests|audit|system))?$/.exec(
          path,
        );
        if (logRoute && method === "GET")
          return json(res, 200, {
            logs: store.state.logs.filter(
              (entry) => logChannel(entry) === (logRoute[1] || "requests"),
            ),
          });
        if (path === "/api/access" && method === "GET")
          return json(res, 200, {
            publicUrl,
            maskedKey: `${gatewayKey.slice(0, 6)}${"•".repeat(20)}${gatewayKey.slice(-4)}`,
          });
        if (path === "/api/access/key" && method === "POST")
          return json(res, 200, { key: gatewayKey });
        return json(res, 404, { error: { message: "接口不存在" } });
      }

      if (!["GET", "HEAD"].includes(method))
        return json(res, 404, { error: { message: "not found" } });
      const requested = resolve(root, `.${decodeURIComponent(path)}`);
      if (requested !== root && !requested.startsWith(`${root}${sep}`))
        throw new InputError("无效的资源路径", 400);
      const file =
        existsSync(requested) && statSync(requested).isFile()
          ? requested
          : extname(path)
            ? null
            : resolve(root, "index.html");
      if (!file || !existsSync(file))
        return json(res, 404, {
          error: { message: "前端尚未构建，请先执行 npm run build" },
        });
      const types = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".png": "image/png",
      };
      res.writeHead(200, {
        "Content-Type": types[extname(file)] || "application/octet-stream",
        "Cache-Control": file.includes(`${sep}assets${sep}`)
          ? "public, max-age=31536000, immutable"
          : "no-cache",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      });
      res.end(method === "HEAD" ? undefined : readFileSync(file));
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (!(error instanceof InputError))
        console.error("[panel] request failed:", error.name);
      const status = error instanceof InputError ? error.status : 500;
      const errorBody = {
        message:
          error instanceof InputError
            ? error.message
            : "服务处理失败，请检查服务端日志",
        type:
          status >= 500
            ? "api_error"
            : status === 413
              ? "request_too_large"
              : "invalid_request_error",
      };
      json(
        res,
        status,
        req.url?.split("?")[0].startsWith("/v1/messages")
          ? { type: "error", error: errorBody }
          : { error: errorBody },
      );
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on("close", () => pool.stop());
  return { server, store, pool };
}
