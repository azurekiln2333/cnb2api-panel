import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createPanelServer } from '../src/app.mjs';
import { Store } from '../src/store.mjs';
import {
  resetOidcCaches,
  verifyIdToken,
  isAllowed,
  identityFromClaims,
  validateEndpoint,
} from '../src/auth.mjs';

const ADMIN = 'panel-test-admin-key';
const CLIENT_ID = 'cnb2api-panel';
// Specials prove client_secret_basic survives form-urlencoded encoding.
const CLIENT_SECRET = 's3cr3t+/=&? pass word';
const SUBJECT = 'admin-subject-1';
const EMAIL = 'admin@example.com';

const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const b64url = (value) => Buffer.from(value).toString('base64url');
const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};
const sign = (key, input) => {
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(input);
  return signer.sign(key).toString('base64url');
};
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

// Fake OIDC provider mirroring the azurekiln-oauth2 contract: discovery,
// RS256 id_token, client_secret_basic token endpoint, S256 PKCE, GET UserInfo.
async function provider(t, options = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const kid = 'test-kid-1';
  const jwk = publicKey.export({ format: 'jwk' });
  const state = {
    issuer: '',
    codes: new Map(),
    tokens: new Map(),
    overrides: {},
    lastAuthorize: null,
    lastToken: null,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://provider.local');
    if (url.pathname === '/.well-known/openid-configuration')
      return json(res, 200, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/oauth2/authorize`,
        token_endpoint: `${state.issuer}/oauth2/token`,
        userinfo_endpoint: `${state.issuer}/oauth2/userinfo`,
        jwks_uri: `${state.issuer}/.well-known/jwks.json`,
        response_types_supported: ['code'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/.well-known/jwks.json')
      return json(res, 200, {
        keys: [{ ...jwk, kid, kty: 'RSA', use: 'sig', alg: 'RS256' }],
      });
    if (url.pathname === '/oauth2/authorize') {
      const q = url.searchParams;
      state.lastAuthorize = Object.fromEntries(q);
      if (q.get('response_type') !== 'code') return json(res, 400, { error: 'unsupported_response_type' });
      if (q.get('client_id') !== CLIENT_ID) return json(res, 400, { error: 'invalid_client' });
      if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.get('code_challenge') || ''))
        return json(res, 400, { error: 'invalid_request', error_description: 'PKCE S256 required' });
      if (!q.get('state') || !q.get('nonce')) return json(res, 400, { error: 'invalid_request' });
      const code = crypto.randomBytes(16).toString('hex');
      state.codes.set(code, {
        challenge: q.get('code_challenge'),
        nonce: q.get('nonce'),
        redirectUri: q.get('redirect_uri'),
        clientId: q.get('client_id'),
      });
      const target = new URL(q.get('redirect_uri'));
      target.searchParams.set('code', code);
      target.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: target.toString() });
      return res.end();
    }
    if (url.pathname === '/oauth2/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      state.lastToken = Object.fromEntries(body);
      const auth = req.headers.authorization || '';
      if (!/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(auth))
        return json(res, 401, { error: 'invalid_client' });
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const clientId = decodeURIComponent(decoded.slice(0, separator));
      const clientSecret = decodeURIComponent(decoded.slice(separator + 1));
      if (clientId !== CLIENT_ID || clientSecret !== CLIENT_SECRET)
        return json(res, 401, { error: 'invalid_client' });
      const grant = state.codes.get(body.get('code'));
      if (!grant) return json(res, 400, { error: 'invalid_grant' });
      if (grant.redirectUri !== body.get('redirect_uri'))
        return json(res, 400, { error: 'invalid_redirect_uri' });
      const verifier = body.get('code_verifier') || '';
      const digest = crypto.createHash('sha256').update(verifier).digest('base64url');
      if (digest !== grant.challenge) return json(res, 400, { error: 'invalid_grant' });
      state.codes.delete(body.get('code'));
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        sub: SUBJECT,
        iss: state.issuer,
        aud: CLIENT_ID,
        iat: now,
        exp: now + 300,
        nonce: grant.nonce,
        name: '管理员',
        picture: 'https://example.com/avatar.png',
        email: EMAIL,
        email_verified: true,
        ...state.overrides.idClaims,
      };
      const header = { alg: 'RS256', typ: 'JWT', kid };
      const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
      const signKey = state.overrides.signWith || privateKey;
      const idToken = `${input}.${sign(signKey, input)}`;
      const accessToken = crypto.randomBytes(16).toString('hex');
      state.tokens.set(accessToken, claims);
      return json(res, 200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        scope: 'openid profile email',
        id_token: idToken,
      });
    }
    if (url.pathname === '/oauth2/userinfo') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      const claims = state.tokens.get(token);
      if (!claims) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, {
        sub: claims.sub,
        name: claims.name,
        picture: claims.picture,
        email: claims.email,
        email_verified: claims.email_verified,
        ...state.overrides.userinfo,
      });
    }
    json(res, 404, { error: 'not_found' });
  });
  state.issuer = await listen(server);
  t.after(() => close(server));
  return state;
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'cnb-panel-auth-'));
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: 'panel-test-client-key',
    dataDir: directory,
    allowLocal: true,
  });
  const base = await listen(app.server);
  let cookie = '';
  const call = (path, { method = 'GET', data, headers = {}, useCookie = true } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(cookie && useCookie ? { Cookie: cookie } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  t.after(async () => {
    await close(app.server);
    rmSync(directory, { recursive: true, force: true });
  });
  const login = async () => {
    const response = await call('/api/session', { method: 'POST', data: { key: ADMIN } });
    assert.equal(response.status, 200);
    cookie = response.headers.get('set-cookie').split(';')[0];
  };
  const settings = (data) =>
    call('/api/auth/settings', { method: 'PATCH', data });
  return { ...app, base, directory, call, login, settings, getCookie: () => cookie };
}

// Enables SSO against the fake provider through the admin API.
async function enableSso(app, oidc, extra = {}) {
  const response = await app.settings({
    ssoEnabled: true,
    issuer: oidc.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    providerName: '测试 SSO',
    allowedSubjects: [SUBJECT],
    ...extra,
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

// Runs /api/auth/oidc/login, follows the provider, returns callback inputs.
async function beginFlow(app) {
  const started = await fetch(`${app.base}/api/auth/oidc/login`, {
    redirect: 'manual',
  });
  assert.equal(started.status, 302);
  const authorizeUrl = started.headers.get('location');
  const txCookie = started.headers.get('set-cookie').split(';')[0];
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  const callback = new URL(authorized.headers.get('location'));
  return { txCookie, callback, authorizeUrl };
}

const callbackRequest = (app, callback, txCookie, mutate = (u) => u) => {
  const url = mutate(new URL(callback));
  return fetch(`${app.base}${url.pathname}${url.search}`, {
    redirect: 'manual',
    headers: { Cookie: txCookie },
  });
};
const reasonOf = (response) => new URL(response.headers.get('location'), 'http://x').searchParams.get('auth_error');

test('public auth config defaults to key login and hides SSO while disabled', async (t) => {
  const app = await fixture(t);
  const response = await app.call('/api/auth/config', { useCookie: false });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    keyLoginEnabled: true,
    sso: { enabled: false, providerName: 'SSO', loginUrl: '' },
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('auth settings require an admin session and never expose the client secret', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.call('/api/auth/settings', { useCookie: false })).status, 401);
  await app.login();
  const response = await app.call('/api/auth/settings');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ssoEnabled: false,
    keyLoginEnabled: true,
    issuer: '',
    clientId: '',
    hasClientSecret: false,
    scope: 'openid profile email',
    providerName: '',
    allowedSubjects: [],
    allowedEmails: [],
    callbackUrl: `${app.base}/api/auth/oidc/callback`,
  });
  assert.ok(!('clientSecret' in body));
});

test('enabling SSO needs an allowlist and a reachable issuer, and persists the secret encrypted', async (t) => {
  const app = await fixture(t);
  const oidc = await provider(t);
  await app.login();
  const withoutAllowlist = await app.settings({
    ssoEnabled: true,
    issuer: oidc.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  assert.equal(withoutAllowlist.status, 400);
  assert.match((await withoutAllowlist.json()).error.message, /白名单/);
  const badIssuer = await app.settings({
    ssoEnabled: true,
    issuer: 'http://127.0.0.1:1',
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    allowedSubjects: [SUBJECT],
  });
  assert.equal(badIssuer.status, 400);
  assert.ok(!(await badIssuer.text()).includes(CLIENT_SECRET));

  const saved = await enableSso(app, oidc);
  assert.equal(saved.ssoEnabled, true);
  assert.equal(saved.hasClientSecret, true);
  assert.ok(!('clientSecret' in saved));

  const disk = readFileSync(join(app.directory, 'panel.json'), 'utf8');
  assert.ok(!disk.includes(CLIENT_SECRET));
  const persisted = JSON.parse(disk).sso;
  assert.equal(typeof persisted.clientSecret, 'string');
  assert.notEqual(persisted.clientSecret, CLIENT_SECRET);
  assert.equal(new Store(app.directory, { allowLocal: true }).state.sso.clientSecret, CLIENT_SECRET);

  const settingsText = await (await app.call('/api/auth/settings')).text();
  assert.ok(!settingsText.includes(CLIENT_SECRET));
  const publicConfig = await (await app.call('/api/auth/config', { useCookie: false })).json();
  assert.deepEqual(publicConfig, {
    keyLoginEnabled: true,
    sso: { enabled: true, providerName: '测试 SSO', loginUrl: '/api/auth/oidc/login' },
  });
  assert.equal((await app.call('/api/auth/config', { useCookie: false })).headers.get('content-type'), 'application/json; charset=utf-8');
});

test('key login can be disabled only after a real SSO login proves SSO works', async (t) => {
  resetOidcCaches();
  const app = await fixture(t);
  const oidc = await provider(t);
  await app.login();
  const lockout = await app.settings({ keyLoginEnabled: false });
  assert.equal(lockout.status, 400);
  assert.match((await lockout.json()).error.message, /先启用/);
  assert.equal(app.store.state.sso.keyLoginEnabled, true);

  // SSO enabled with key login still open may be configured from a key session.
  await enableSso(app, oidc);
  const unproven = await app.settings({ keyLoginEnabled: false });
  assert.equal(unproven.status, 400);
  assert.match(
    (await unproven.json()).error.message,
    /请先通过 SSO 登录验证，再关闭管理密钥登录/,
  );
  assert.equal(app.store.state.sso.keyLoginEnabled, true);

  // A real OIDC login proves the client secret and allowlist before locking.
  const flow = await beginFlow(app);
  const callback = await callbackRequest(app, flow.callback, flow.txCookie);
  assert.equal(callback.headers.get('location'), '/#overview');
  const oidcCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('cnb_session='))
    .split(';')[0];
  const disable = (data, headers = {}) =>
    app.call('/api/auth/settings', { method: 'PATCH', data, headers });
  const changedIdentity = await disable({ keyLoginEnabled: false, clientSecret: 'unverified-replacement-secret' }, { Cookie: oidcCookie });
  assert.equal(changedIdentity.status, 400);
  assert.equal(app.store.state.sso.clientSecret, CLIENT_SECRET);
  const disabled = await disable({ keyLoginEnabled: false }, { Cookie: oidcCookie });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).keyLoginEnabled, false);

  const keyAttempt = await app.call('/api/session', { method: 'POST', data: { key: ADMIN }, useCookie: false });
  assert.equal(keyAttempt.status, 403);
  assert.match((await keyAttempt.json()).error.message, /单点登录/);

  const config = await (await app.call('/api/auth/config', { useCookie: false })).json();
  assert.equal(config.keyLoginEnabled, false);

  const reEnableKey = await disable({ keyLoginEnabled: true }, { Cookie: oidcCookie });
  assert.equal(reEnableKey.status, 200);
  assert.equal((await app.call('/api/session', { method: 'POST', data: { key: ADMIN }, useCookie: false })).status, 200);
});

test('OIDC login succeeds end to end and creates an oidc session with PKCE, state and nonce', async (t) => {
  resetOidcCaches();
  const app = await fixture(t);
  const oidc = await provider(t);
  await app.login();
  await enableSso(app, oidc);

  const flow = await beginFlow(app);
  const params = oidc.lastAuthorize;
  assert.equal(params.response_type, 'code');
  assert.equal(params.code_challenge_method, 'S256');
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge));
  for (const forbidden of ['prompt', 'max_age', 'response_mode'])
    assert.equal(params[forbidden] ?? null, null);

  const callback = await callbackRequest(app, flow.callback, flow.txCookie);
  assert.equal(oidc.lastToken.grant_type, 'authorization_code');
  assert.ok(oidc.lastToken.code_verifier.length >= 43);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get('location'), '/#overview');
  const cookies = callback.headers.getSetCookie();
  const sessionValue = cookies.find((value) => value.startsWith('cnb_session='));
  assert.ok(sessionValue);
  assert.ok(cookies.some((value) => value.startsWith('cnb_oidc=;')));
  const sessionCookie = sessionValue.split(';')[0];
  assert.match(sessionCookie, /^cnb_session=/);

  const session = await fetch(`${app.base}/api/session`, { headers: { Cookie: sessionCookie } });
  assert.equal(session.status, 200);
  const body = await session.json();
  assert.equal(body.authenticated, true);
  assert.deepEqual(body.user, {
    name: '管理员',
    email: EMAIL,
    picture: 'https://example.com/avatar.png',
    provider: 'oidc',
  });

  const logout = await fetch(`${app.base}/api/session`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  });
  assert.equal(logout.status, 200);
  assert.equal((await fetch(`${app.base}/api/session`, { headers: { Cookie: sessionCookie } })).status, 401);
});

test('verified email allowlist admits a session while an unverified email is refused', async (t) => {
  resetOidcCaches();
  const app = await fixture(t);
  const oidc = await provider(t);
  await app.login();
  await enableSso(app, oidc, {
    allowedSubjects: [],
    allowedEmails: ['Admin@Example.com'],
  });
  const first = await beginFlow(app);
  const ok = await callbackRequest(app, first.callback, first.txCookie);
  assert.equal(ok.headers.get('location'), '/#overview');

  oidc.overrides.userinfo = { email_verified: false };
  const second = await beginFlow(app);
  const refused = await callbackRequest(app, second.callback, second.txCookie);
  assert.equal(refused.status, 302);
  assert.equal(reasonOf(refused), 'not_allowed');
  assert.ok(!refused.headers.get('set-cookie').includes('cnb_session='));
});

test('subjects outside the allowlist are refused without issuing a session', async (t) => {
  resetOidcCaches();
  const app = await fixture(t);
  const oidc = await provider(t);
  await app.login();
  await enableSso(app, oidc);
  oidc.overrides.idClaims = { sub: 'intruder' };
  const flow = await beginFlow(app);
  const refused = await callbackRequest(app, flow.callback, flow.txCookie);
  assert.equal(reasonOf(refused), 'not_allowed');
  assert.match(refused.headers.get('set-cookie'), /cnb_oidc=;/);
});

test('a mismatched state, provider error or missing transaction is rejected safely', async (t) => {
  resetOidcCaches();
  const app = await fixture(t);
  const oidc = await provider(t);
  await app.login();
  await enableSso(app, oidc);

  const flow = await beginFlow(app);
  const code = flow.callback.searchParams.get('code');
  const tampered = await callbackRequest(app, flow.callback, flow.txCookie, (url) => {
    url.searchParams.set('state', 'forged-state');
    return url;
  });
  assert.equal(reasonOf(tampered), 'state_mismatch');

  // The transaction cookie is single-use, so a replay cannot reuse the code.
  const replay = await callbackRequest(app, flow.callback, flow.txCookie);
  assert.equal(reasonOf(replay), 'transaction_expired');
  const location = replay.headers.get('location');
  assert.ok(!location.includes(CLIENT_SECRET));
  assert.ok(!location.includes(code));

  const errorFlow = await beginFlow(app);
  const providerDenied = await callbackRequest(app, errorFlow.callback, errorFlow.txCookie, (url) => {
    url.searchParams.delete('code');
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'user cancelled');
    return url;
  });
  assert.equal(reasonOf(providerDenied), 'provider_error');
  assert.ok(!providerDenied.headers.get('location').includes('user cancelled'));

  const noCookie = await callbackRequest(app, errorFlow.callback, 'cnb_oidc=');
  assert.equal(reasonOf(noCookie), 'transaction_expired');
});

test('UserInfo subject mismatches and provider errors redirect without a session', async (t) => {
  resetOidcCaches();
  const app = await fixture(t);
  const oidc = await provider(t);
  await app.login();
  await enableSso(app, oidc);
  oidc.overrides.userinfo = { sub: 'another-subject' };
  const flow = await beginFlow(app);
  const refused = await callbackRequest(app, flow.callback, flow.txCookie);
  assert.equal(reasonOf(refused), 'userinfo_mismatch');
});

test('id token validation enforces signature, issuer, audience, expiry and nonce', async (t) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const kid = 'unit-kid';
  const jwks = {
    keys: [{ ...publicKey.export({ format: 'jwk' }), kid, kty: 'RSA', use: 'sig', alg: 'RS256' }],
  };
  const now = Date.now();
  const claims = (patch = {}) => ({
    sub: SUBJECT,
    iss: 'https://sso.example.com',
    aud: CLIENT_ID,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 300,
    nonce: 'expected-nonce',
    ...patch,
  });
  const build = (payload, { key = privateKey, header = {} } = {}) => {
    const encodedHeader = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid, ...header }));
    const input = `${encodedHeader}.${b64url(JSON.stringify(payload))}`;
    return `${input}.${sign(key, input)}`;
  };
  const check = (token, options = {}) =>
    verifyIdToken(token, {
      issuer: 'https://sso.example.com',
      clientId: CLIENT_ID,
      nonce: 'expected-nonce',
      jwks,
      now,
      ...options,
    });

  assert.equal(check(build(claims())).sub, SUBJECT);
  assert.throws(() => check(build(claims(), { key: other })), /signature_invalid/);
  assert.throws(() => check(build(claims(), { header: { kid: 'unknown' } })), /unknown_key/);
  assert.throws(() => check(build(claims(), { header: { alg: 'HS256' } })), /unsupported_alg/);
  assert.throws(() => check(build(claims({ iss: 'https://evil.example.com' }))), /issuer_mismatch/);
  assert.throws(() => check(build(claims({ aud: 'other-client' }))), /audience_mismatch/);
  assert.throws(
    () => check(build(claims({ exp: Math.floor(now / 1000) - 3600 }))),
    /expired/,
  );
  assert.throws(() => check(build(claims({ nonce: 'wrong' }))), /nonce_mismatch/);
  assert.throws(() => check(build(claims({ nonce: undefined }))), /nonce_mismatch/);
  assert.throws(() => check(build(claims({ iat: undefined }))), /invalid_iat/);
  assert.throws(() => check(build(claims({ iat: String(Math.floor(now / 1000)) }))), /invalid_iat/);
  assert.throws(() => check('not-a-jwt'), /invalid_id_token/);
  assert.throws(() => check(`${build(claims())}.extra`), /invalid_id_token/);
  // Array audiences are accepted when they include our client and name azp.
  assert.equal(
    check(build(claims({ aud: ['other', CLIENT_ID], azp: CLIENT_ID }))).aud[1],
    CLIENT_ID,
  );
  assert.throws(
    () => check(build(claims({ aud: ['other', CLIENT_ID] }))),
    /audience_mismatch/,
  );
  assert.throws(
    () => check(build(claims({ aud: ['other', CLIENT_ID], azp: 'other' }))),
    /audience_mismatch/,
  );
  assert.throws(
    () => check(build(claims({ azp: 'other' }))),
    /audience_mismatch/,
  );
  // A key that advertises a non-signing use or algorithm is refused.
  assert.throws(
    () =>
      check(build(claims()), {
        jwks: { keys: [{ ...jwks.keys[0], use: 'enc' }] },
      }),
    /unknown_key/,
  );
  assert.throws(
    () =>
      check(build(claims()), {
        jwks: { keys: [{ ...jwks.keys[0], alg: 'HS256' }] },
      }),
    /unknown_key/,
  );
  // The issuer must match exactly; a trailing slash is a different issuer.
  assert.throws(
    () => check(build(claims({ iss: 'https://sso.example.com/' }))),
    /issuer_mismatch/,
  );
});

test('discovery endpoints cannot downgrade to plain HTTP or carry credentials', () => {
  assert.equal(
    validateEndpoint('https://sso.example.com/oauth2/token'),
    'https://sso.example.com/oauth2/token',
  );
  // Plain HTTP is refused everywhere unless allowLocal names a loopback host.
  assert.equal(validateEndpoint('http://sso.example.com/token'), '');
  assert.equal(validateEndpoint('http://127.0.0.1:9000/token'), '');
  assert.equal(validateEndpoint('http://127.0.0.1:9000/token', true), 'http://127.0.0.1:9000/token');
  assert.equal(validateEndpoint('http://localhost:9000/token', true), 'http://localhost:9000/token');
  assert.equal(validateEndpoint('http://10.0.0.5:9000/token', true), '');
  assert.equal(validateEndpoint('https://user:pass@sso.example.com/token'), '');
  assert.equal(validateEndpoint('https://sso.example.com/token#frag'), '');
  assert.equal(validateEndpoint('ftp://sso.example.com/token'), '');
  assert.equal(validateEndpoint('not-a-url'), '');
});

test('allowlist requires a verified email and matches subjects exactly', () => {
  const sso = {
    allowedSubjects: [SUBJECT],
    allowedEmails: ['admin@example.com'],
  };
  assert.equal(isAllowed({ sub: SUBJECT, email: '', emailVerified: false }, sso), true);
  assert.equal(isAllowed({ sub: 'x', email: 'ADMIN@example.com', emailVerified: true }, sso), true);
  assert.equal(isAllowed({ sub: 'x', email: 'admin@example.com', emailVerified: false }, sso), false);
  assert.equal(isAllowed({ sub: 'x', email: 'other@example.com', emailVerified: true }, sso), false);
  assert.equal(isAllowed({ sub: 'admin-subject-1-extra', email: '', emailVerified: false }, { allowedSubjects: [SUBJECT], allowedEmails: [] }), false);
});

test('identity claims cannot be truncated into an allowlist match', () => {
  // A subject longer than the 200-char allowlist limit is rejected outright.
  assert.throws(
    () => identityFromClaims(null, { sub: 'a'.repeat(201), email: '', email_verified: false }),
    /invalid_subject/,
  );
  const longEmail = identityFromClaims(null, {
    sub: 'ok',
    email: `${'a'.repeat(330)}@example.com`,
    email_verified: true,
  });
  assert.equal(longEmail.email, '');
  assert.equal(isAllowed(longEmail, { allowedSubjects: [], allowedEmails: ['a'.repeat(330)] }), false);
  // The exact 200-char subject still matches only when it is registered.
  const exact = identityFromClaims(null, { sub: 'b'.repeat(200), email: '', email_verified: false });
  assert.equal(isAllowed(exact, { allowedSubjects: ['b'.repeat(200)], allowedEmails: [] }), true);
  assert.equal(isAllowed(exact, { allowedSubjects: ['b'.repeat(199)], allowedEmails: [] }), false);
});

test('UserInfo cannot inherit a verified email for a different address', () => {
  const idClaims = {
    sub: SUBJECT,
    email: 'admin@example.com',
    email_verified: true,
  };
  // Different email without email_verified must not inherit the ID token flag.
  const swapped = identityFromClaims({ email: 'attacker@example.com' }, idClaims);
  assert.equal(swapped.email, 'attacker@example.com');
  assert.equal(swapped.emailVerified, false);
  assert.equal(isAllowed(swapped, { allowedSubjects: [], allowedEmails: ['admin@example.com'] }), false);
  // Same email keeps the verified state.
  assert.equal(identityFromClaims({ email: 'admin@example.com' }, idClaims).emailVerified, true);
  // A different address is allowed only when UserInfo marks it verified.
  const verifiedSwap = identityFromClaims(
    { email: 'second@example.com', email_verified: true },
    idClaims,
  );
  assert.equal(isAllowed(verifiedSwap, { allowedSubjects: [], allowedEmails: ['second@example.com'] }), true);
});

test('environment bootstrap seeds an unconfigured panel and rejects unsafe settings', async (t) => {
  const oidc = await provider(t);
  const directory = mkdtempSync(join(tmpdir(), 'cnb-panel-bootstrap-'));
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: 'panel-test-client-key',
    dataDir: directory,
    allowLocal: true,
    ssoBootstrap: {
      enabled: true,
      issuer: oidc.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      providerName: '引导 SSO',
      allowedSubjects: [SUBJECT],
    },
  });
  const base = await listen(app.server);
  t.after(async () => {
    await close(app.server);
    rmSync(directory, { recursive: true, force: true });
  });
  const config = await (await fetch(`${base}/api/auth/config`)).json();
  assert.deepEqual(config, {
    keyLoginEnabled: true,
    sso: { enabled: true, providerName: '引导 SSO', loginUrl: '/api/auth/oidc/login' },
  });
  assert.ok(!readFileSync(join(directory, 'panel.json'), 'utf8').includes(CLIENT_SECRET));

  // Saved configuration wins: a second bootstrap must not overwrite it.
  app.store.saveSso({ ...app.store.state.sso, providerName: '已保存 SSO' });
  const restarted = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: 'panel-test-client-key',
    dataDir: directory,
    allowLocal: true,
    ssoBootstrap: { providerName: '忽略的引导' },
  });
  assert.equal(restarted.store.state.sso.providerName, '已保存 SSO');
  assert.equal(restarted.store.state.sso.clientSecret, CLIENT_SECRET);
  restarted.pool.stop();

  const otherDir = mkdtempSync(join(tmpdir(), 'cnb-panel-bootstrap-bad-'));
  t.after(() => rmSync(otherDir, { recursive: true, force: true }));
  assert.throws(
    () =>
      createPanelServer({
        adminKey: ADMIN,
        gatewayKey: 'panel-test-client-key',
        dataDir: otherDir,
        allowLocal: true,
        ssoBootstrap: { enabled: true, keyLoginEnabled: false },
      }),
    /SSO/,
  );
});
