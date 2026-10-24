import {
  createHash,
  createPublicKey,
  createVerify,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// Standards-based OIDC relying party. The panel only needs Node crypto and
// fetch, so this module stays free of runtime dependencies.

export class OidcError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "OidcError";
    this.reason = reason;
  }
}

const DEFAULTS = {
  timeoutMs: 10000,
  maxBytes: 256 * 1024,
  discoveryTtlMs: 10 * 60 * 1000,
  jwksTtlMs: 10 * 60 * 1000,
  skewSeconds: 60,
};

const discoveryCache = new Map();
const jwksCache = new Map();

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const loopbackHost = (hostname) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");

// Discovery-supplied endpoints may never downgrade a scheme or carry
// credentials/fragments. Plain HTTP is reserved for loopback mocks when the
// operator sets allowLocal.
function validateEndpoint(value, allowLocal = false) {
  if (typeof value !== "string" || !value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.username || url.password || url.hash) return "";
  if (url.protocol === "https:") return url.toString();
  if (url.protocol !== "http:") return "";
  if (!allowLocal || !loopbackHost(url.hostname)) return "";
  return url.toString();
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const normalizeIssuer = (value) => String(value || "").replace(/\/+$/, "");

export function resetOidcCaches() {
  discoveryCache.clear();
  jwksCache.clear();
}

const safeEqual = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
};

async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new OidcError("response_too_large");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size);
}

async function fetchJson(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULTS.timeoutMs,
    maxBytes = DEFAULTS.maxBytes,
    fetchImpl = fetch,
  } = options;
  if (typeof url !== "string" || !url) throw new OidcError("invalid_endpoint");
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new OidcError("network_error");
  }
  let buffer;
  try {
    buffer = await readLimited(response, maxBytes);
  } catch {
    throw new OidcError("invalid_response");
  }
  if (!response.ok) throw new OidcError(`http_${response.status}`);
  try {
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new OidcError("invalid_json");
  }
}

const endpoint = (value) =>
  typeof value === "string" && /^https?:\/\//.test(value) ? value : "";

export async function discoverProvider(config, options = {}) {
  const issuer = normalizeIssuer(config.issuer);
  if (!issuer) throw new OidcError("invalid_issuer");
  const cached = discoveryCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const allowLocal = options.allowLocal === true;
  const document = await fetchJson(
    `${issuer}/.well-known/openid-configuration`,
    options,
  );
  if (normalizeIssuer(document.issuer) !== issuer)
    throw new OidcError("issuer_mismatch");
  const value = {
    issuer: document.issuer,
    authorizationEndpoint: validateEndpoint(
      document.authorization_endpoint,
      allowLocal,
    ),
    tokenEndpoint: validateEndpoint(document.token_endpoint, allowLocal),
    userinfoEndpoint: validateEndpoint(document.userinfo_endpoint, allowLocal),
    jwksUri: validateEndpoint(document.jwks_uri, allowLocal),
  };
  if (!value.authorizationEndpoint || !value.tokenEndpoint || !value.jwksUri)
    throw new OidcError("invalid_discovery");
  if (!document.id_token_signing_alg_values_supported?.includes("RS256"))
    throw new OidcError("unsupported_alg");
  discoveryCache.set(issuer, {
    expiresAt: Date.now() + (options.discoveryTtlMs ?? DEFAULTS.discoveryTtlMs),
    value,
  });
  return value;
}

export async function loadJwks(jwksUri, options = {}) {
  const { force = false, jwksTtlMs = DEFAULTS.jwksTtlMs } = options;
  if (!validateEndpoint(jwksUri, options.allowLocal === true))
    throw new OidcError("invalid_endpoint");
  if (!force) {
    const cached = jwksCache.get(jwksUri);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }
  const document = await fetchJson(jwksUri, options);
  if (!Array.isArray(document.keys) || !document.keys.length)
    throw new OidcError("invalid_jwks");
  jwksCache.set(jwksUri, {
    expiresAt: Date.now() + jwksTtlMs,
    value: document,
  });
  return document;
}

export function createPkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function buildAuthorizationUrl(config, { redirectUri, state, nonce, codeChallenge, authorizationEndpoint }) {
  // Only standard code-flow parameters. prompt, max_age and response_mode are
  // intentionally never sent.
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeAuthorizationCode(
  config,
  { code, codeVerifier, redirectUri, tokenEndpoint },
  options = {},
) {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  // Some providers URL-decode each Basic half, so encode them individually.
  const basic = Buffer.from(
    `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`,
  ).toString("base64");
  const data = await fetchJson(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: form.toString(),
    ...options,
  });
  if (typeof data.access_token !== "string" || !data.access_token)
    throw new OidcError("missing_access_token");
  return data;
}

export async function fetchUserInfo(discovery, accessToken, options = {}) {
  if (!discovery.userinfoEndpoint) return null;
  return fetchJson(discovery.userinfoEndpoint, {
    headers: { Authorization: `Bearer ${accessToken}` },
    ...options,
  });
}

function decodeSegment(segment) {
  if (!BASE64URL.test(segment)) throw new OidcError("invalid_id_token");
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

export function verifyIdToken(
  idToken,
  { issuer, clientId, nonce, jwks, now = Date.now(), skewSeconds = DEFAULTS.skewSeconds } = {},
) {
  if (typeof idToken !== "string" || !idToken || idToken.length > 8192)
    throw new OidcError("invalid_id_token");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("invalid_id_token");
  let header;
  let payload;
  try {
    header = decodeSegment(parts[0]);
    payload = decodeSegment(parts[1]);
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError("invalid_id_token");
  }
  if (!header || header.alg !== "RS256" || typeof header.kid !== "string")
    throw new OidcError("unsupported_alg");
  const keys = Array.isArray(jwks) ? jwks : jwks?.keys;
  const jwk = Array.isArray(keys)
    ? keys.find(
        (key) =>
          key &&
          key.kid === header.kid &&
          key.kty === "RSA" &&
          !key.d &&
          (key.use === undefined || key.use === "sig") &&
          (key.alg === undefined || key.alg === "RS256"),
      )
    : null;
  if (!jwk) throw new OidcError("unknown_key");
  let valid = false;
  try {
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    verifier.end();
    valid = verifier.verify(
      createPublicKey({ key: jwk, format: "jwk" }),
      Buffer.from(parts[2], "base64url"),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new OidcError("signature_invalid");

  if (
    typeof payload.iss !== "string" ||
    payload.iss !== issuer
  )
    throw new OidcError("issuer_mismatch");
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(clientId)) throw new OidcError("audience_mismatch");
  const multipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
  // Authorized party must name this client whenever it is present, and it is
  // mandatory when the audience is shared.
  if (
    (multipleAudiences && typeof payload.azp !== "string") ||
    (payload.azp !== undefined && payload.azp !== clientId)
  )
    throw new OidcError("audience_mismatch");
  if (!Number.isInteger(payload.exp)) throw new OidcError("invalid_expiry");
  const nowSeconds = Math.floor(now / 1000);
  if (nowSeconds > payload.exp + skewSeconds)
    throw new OidcError("expired");
  if (
    Number.isInteger(payload.nbf) &&
    nowSeconds + skewSeconds < payload.nbf
  )
    throw new OidcError("not_yet_valid");
  if (!Number.isInteger(payload.iat)) throw new OidcError("invalid_iat");
  if (payload.iat > nowSeconds + skewSeconds)
    throw new OidcError("issued_in_future");
  if (nonce !== undefined) {
    if (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, nonce))
      throw new OidcError("nonce_mismatch");
  }
  if (typeof payload.sub !== "string" || !payload.sub)
    throw new OidcError("missing_subject");
  return payload;
}

export async function verifyIdTokenForConfig(config, idToken, { nonce, now, allowLocal } = {}) {
  const discovery = await discoverProvider(config, { allowLocal });
  let jwks = await loadJwks(discovery.jwksUri, { allowLocal });
  try {
    return verifyIdToken(idToken, {
      // The ID token issuer must match the discovered issuer exactly.
      issuer: discovery.issuer,
      clientId: config.clientId,
      nonce,
      jwks,
      now,
    });
  } catch (error) {
    // A rotated signing key arrives with a new kid; refresh JWKS once.
    if (error instanceof OidcError && error.reason === "unknown_key") {
      jwks = await loadJwks(discovery.jwksUri, { force: true, allowLocal });
      return verifyIdToken(idToken, {
        issuer: discovery.issuer,
        clientId: config.clientId,
        nonce,
        jwks,
        now,
      });
    }
    throw error;
  }
}

const asText = (value, limit) =>
  typeof value === "string" ? value.slice(0, limit) : "";

export function identityFromClaims(claims, idTokenClaims = {}) {
  const idClaims =
    idTokenClaims && typeof idTokenClaims === "object" ? idTokenClaims : {};
  const userinfo = claims && typeof claims === "object" ? claims : null;
  const merged = userinfo ? { ...idClaims, ...userinfo } : { ...idClaims };
  // Email verification never travels across a changed address.
  if (
    userinfo &&
    userinfo.email !== undefined &&
    userinfo.email !== idClaims.email
  )
    merged.email_verified = userinfo.email_verified === true;
  // Subject and email feed allowlist checks, so they are never truncated. An
  // over-long subject cannot prefix-match a registered account.
  const sub = merged.sub;
  if (typeof sub !== "string" || !sub || sub.length > 200)
    throw new OidcError("invalid_subject");
  const email =
    typeof merged.email === "string" && merged.email.length <= 320
      ? merged.email
      : "";
  const name =
    asText(merged.name, 120) ||
    asText(merged.preferred_username ?? merged.username, 120) ||
    sub;
  return {
    sub,
    name,
    email,
    emailVerified: merged.email_verified === true,
    picture: asText(merged.picture, 2000),
  };
}

export function isAllowed(identity, sso) {
  if (identity.sub && sso.allowedSubjects.includes(identity.sub)) return true;
  if (!identity.email) return false;
  // Email allowlists only trust claims the provider marked as verified.
  if (!identity.emailVerified) return false;
  return sso.allowedEmails.includes(identity.email.toLowerCase());
}

export function createTransaction() {
  const pkce = createPkce();
  return {
    txid: randomBytes(24).toString("base64url"),
    state: randomBytes(16).toString("base64url"),
    nonce: randomBytes(16).toString("base64url"),
    verifier: pkce.verifier,
    challenge: pkce.challenge,
  };
}

export { safeEqual, normalizeIssuer, asText, validateEndpoint };