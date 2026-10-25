import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Store, normalizeEndpoint } from '../src/store.mjs';
import { createPanelServer } from '../src/app.mjs';

const ADMIN = 'panel-test-admin-key';
const GATEWAY = 'panel-test-client-key';
const WORKER = 'worker-test-private-key';
const listen = async (server) => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

async function fixture(t, { logDirectoryName } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'cnb-panel-test-'));
  const directory = join(fixtureRoot, 'data');
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: GATEWAY,
    dataDir: directory,
    logDir: logDirectoryName ? join(fixtureRoot, logDirectoryName) : undefined,
    allowLocal: true,
  });
  const base = await listen(app.server);
  let cookie = '';
  const call = async (
    path,
    { method = 'GET', data, auth, headers = {} } = {},
  ) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  const login = await call('/api/session', {
    method: 'POST',
    data: { key: ADMIN },
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  t.after(async () => {
    await close(app.server);
    rmSync(fixtureRoot, { recursive: true, force: true });
  });
  return { ...app, base, directory, call };
}

async function worker(t, name, handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      assert.equal(req.headers.authorization, `Bearer ${WORKER}`);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    calls.push({
      path: req.url,
      payload,
      authorization: req.headers.authorization,
    });
    if (handler) {
      await handler(req, res, payload);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'test-model',
        worker: name,
        choices: [{ message: { content: name } }],
      }),
    );
  });
  const endpoint = await listen(server);
  t.after(() => close(server));
  return { endpoint, calls, server };
}

async function account(app, upstream, fields = {}) {
  const response = await app.call('/api/accounts', {
    method: 'POST',
    data: {
      name: '测试工作区',
      repo: `org/repo-${app.store.state.accounts.length}`,
      proxyKey: WORKER,
      endpoint: upstream?.endpoint || '',
      ...fields,
    },
  });
  assert.equal(response.status, 201);
  const data = await response.json();
  if (upstream) await app.pool.probe(data.account.id);
  return data;
}

const completion = (
  app,
  { session = randomUUID(), data = {}, headers = {} } = {},
) =>
  app.call('/v1/chat/completions', {
    method: 'POST',
    auth: GATEWAY,
    headers: { ...(session ? { 'x-session-id': session } : {}), ...headers },
    data: {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      ...data,
    },
  });

test('the server writes and reads audit logs from an explicitly configured directory outside data', async (t) => {
  const app = await fixture(t, { logDirectoryName: 'operator-logs' });
  const auditFile = join(app.directory, '../operator-logs/audit.log');
  assert.equal(app.store.logFiles.audit, auditFile);
  const audit = await (await app.call('/api/logs/audit')).json();
  assert.ok(audit.logs.some((entry) => entry.action === 'auth.login'));
  assert.ok(readFileSync(auditFile, 'utf8').includes('auth.login'));
  assert.equal(existsSync(join(app.directory, 'audit.log')), false);
});

test('account secrets survive restart encrypted, remain hidden in reads, and edits preserve blank credentials', async (t) => {
  const app = await fixture(t);
  const created = await account(app, null, { pat: 'private-personal-token' });
  assert.equal(created.account.hasPat, true);
  const disk = readFileSync(join(app.directory, 'accounts.json'), 'utf8');
  for (const secret of [
    WORKER,
    'private-personal-token',
    created.registrationToken,
  ])
    assert.ok(!disk.includes(secret));
  const list = await (await app.call('/api/accounts')).text();
  assert.ok(!list.includes(WORKER));
  assert.ok(!list.includes(created.registrationToken));
  const restored = new Store(app.directory, { allowLocal: true });
  assert.equal(restored.get(created.account.id).secrets.proxyKey, WORKER);
  const patched = await app.call(`/api/accounts/${created.account.id}`, {
    method: 'PATCH',
    data: { name: '更新账号', proxyKey: '' },
  });
  assert.equal(patched.status, 200);
  assert.equal(app.store.get(created.account.id).secrets.proxyKey, WORKER);
  const removed = await app.call(`/api/accounts/${created.account.id}`, {
    method: 'DELETE',
  });
  assert.equal(removed.status, 200);
  assert.equal(
    (await app.call(`/api/accounts/${created.account.id}`)).status,
    404,
  );
});

test('management and client credentials are isolated, origins are checked, and sessions can be revoked', async (t) => {
  const app = await fixture(t);
  assert.equal(
    (
      await fetch(`${app.base}/api/accounts`, {
        headers: { Authorization: `Bearer ${GATEWAY}` },
      })
    ).status,
    401,
  );
  assert.equal((await app.call('/v1/models', { auth: ADMIN })).status, 401);
  assert.equal(
    (
      await app.call('/api/settings', {
        method: 'PATCH',
        data: { strategy: 'failover' },
        headers: { Origin: 'https://other.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await app.call('/api/access/key', { method: 'POST', data: {} })).status,
    200,
  );
  assert.equal(
    (await app.call('/api/session', { method: 'DELETE' })).status,
    200,
  );
  assert.equal((await app.call('/api/accounts')).status, 401);
});

test('saved credentials require an explicit authenticated same-origin read and stay out of ordinary responses', async (t) => {
  const app = await fixture(t);
  const first = await account(app, null, {
    pat: 'saved-private-personal-token',
    registrationToken: 'saved-private-registration-token',
  });
  const route = `/api/accounts/${first.account.id}/credentials`;
  for (const headers of [{}, { Authorization: `Bearer ${GATEWAY}` }]) {
    const response = await fetch(`${app.base}${route}`, { method: 'POST', headers });
    assert.equal(response.status, 401);
    assert.ok(!(await response.text()).includes(WORKER));
  }
  const rejected = await app.call(route, {
    method: 'POST',
    headers: { Origin: 'https://other.example' },
  });
  assert.equal(rejected.status, 403);
  const expected = {
    proxyKey: WORKER,
    registrationToken: first.registrationToken,
    pat: 'saved-private-personal-token',
  };
  const revealed = await app.call(route, { method: 'POST', data: {} });
  assert.equal(revealed.status, 200);
  assert.equal(revealed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await revealed.json(), expected);
  for (const path of [
    '/api/accounts',
    `/api/accounts/${first.account.id}`,
    '/api/overview',
    '/api/logs',
    route,
  ]) {
    const response = await app.call(path);
    if (path === route) assert.equal(response.status, 404);
    const visible = await response.text();
    for (const secret of Object.values(expected)) assert.ok(!visible.includes(secret));
  }
  const rotated = await app.call(`/api/accounts/${first.account.id}/registration`, {
    method: 'POST', data: {},
  });
  const replacement = await rotated.json();
  await app.call(`/api/accounts/${first.account.id}`, { method: 'PATCH', data: { pat: '' } });
  assert.deepEqual(await (await app.call(route, { method: 'POST' })).json(), {
    ...expected, registrationToken: replacement.registrationToken, pat: '',
  });
});

test('workspace registration updates only its own account, rotates tokens, and disabled accounts stay excluded', async (t) => {
  const app = await fixture(t);
  const up = await worker(t, 'registered');
  const first = await account(app);
  const second = await account(app, null, { enabled: false });
  const register = (id, token) =>
    app.call(`/ops/register/${id}`, {
      method: 'POST',
      headers: { 'X-Reg-Token': token },
      data: { uri: up.endpoint },
    });
  assert.equal(
    (await register(first.account.id, second.registrationToken)).status,
    403,
  );
  assert.equal(
    (await register(first.account.id, first.registrationToken)).status,
    200,
  );
  await app.pool.probe(first.account.id);
  assert.equal(app.store.get(second.account.id).endpoint, '');
  assert.equal(
    (await register(second.account.id, second.registrationToken)).status,
    200,
  );
  await app.pool.probe(second.account.id);
  assert.equal(app.pool.eligible().length, 1);
  const rotated = await (
    await app.call(`/api/accounts/${first.account.id}/registration`, {
      method: 'POST',
      data: {},
    })
  ).json();
  assert.equal(
    (await register(first.account.id, first.registrationToken)).status,
    403,
  );
  assert.equal(
    (await register(first.account.id, rotated.registrationToken)).status,
    200,
  );
  const health = await app.call('/health');
  assert.equal(health.status, 200);
});

test('existing registration tokens are imported, encrypted, preserved on blank edits, and unique per account', async (t) => {
  const app = await fixture(t);
  const token = '123456789';
  const first = await account(app, null, { registrationToken: token });
  const second = await account(app);
  assert.equal(first.registrationToken, token);
  assert.equal(
    new Store(app.directory).get(first.account.id).secrets.registrationToken,
    token,
  );
  assert.ok(
    !readFileSync(join(app.directory, 'accounts.json'), 'utf8').includes(token),
  );
  for (const input of [{ name: '保留原密钥' }, { registrationToken: '' }]) {
    const edited = await app.call(`/api/accounts/${first.account.id}`, {
      method: 'PATCH',
      data: input,
    });
    assert.equal(edited.status, 200);
    assert.ok(!(await edited.text()).includes(token));
    assert.equal(
      app.store.get(first.account.id).secrets.registrationToken,
      token,
    );
  }
  for (const [path, method, data] of [
    [
      '/api/accounts',
      'POST',
      {
        name: '重复密钥',
        repo: 'org/duplicate-token',
        proxyKey: WORKER,
        registrationToken: token,
      },
    ],
    [
      `/api/accounts/${second.account.id}`,
      'PATCH',
      {
        name: '不应保存的名称',
        registrationToken: token,
      },
    ],
  ]) {
    const response = await app.call(path, { method, data });
    assert.equal(response.status, 400);
    const message = await response.text();
    assert.match(message, /注册密钥.*其他账号/);
    assert.ok(!message.includes(token));
  }
  assert.equal(app.store.state.accounts.length, 2);
  assert.equal(app.store.get(second.account.id).name, second.account.name);
  assert.equal(
    app.store.get(second.account.id).secrets.registrationToken,
    second.registrationToken,
  );
  for (const registrationToken of [
    null,
    123456789,
    ['token'],
    'bad\ntoken',
    '含中文',
    'has space',
    'x'.repeat(4097),
  ]) {
    assert.equal(
      (
        await app.call(`/api/accounts/${first.account.id}`, {
          method: 'PATCH',
          data: { registrationToken },
        })
      ).status,
      400,
    );
  }
  for (const path of ['/api/accounts', '/api/overview', '/api/logs'])
    assert.ok(!(await (await app.call(path)).text()).includes(token));
});

test('legacy /register accepts the unchanged cloud payload and routes distinct tokens to distinct accounts', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'legacy-a');
  const b = await worker(t, 'legacy-b');
  const first = await account(app, null, { registrationToken: '123456789' });
  const second = await account(app, null, {
    registrationToken: 'existing-second-token',
  });
  const register = (token, uri) =>
    fetch(`${app.base}/register`, {
      method: 'POST',
      headers: { 'X-Reg-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    });
  assert.equal((await app.call('/register')).status, 405);
  assert.equal((await register('unknown-token', a.endpoint)).status, 403);
  assert.equal((await register('', a.endpoint)).status, 403);
  assert.equal(
    (await register(first.registrationToken, a.endpoint)).status,
    200,
  );
  assert.equal(app.store.get(first.account.id).endpoint, a.endpoint);
  assert.equal(app.store.get(second.account.id).endpoint, '');
  assert.equal(
    (await register(second.registrationToken, b.endpoint)).status,
    200,
  );
  assert.equal(app.store.get(first.account.id).endpoint, a.endpoint);
  assert.equal(app.store.get(second.account.id).endpoint, b.endpoint);
  await app.pool.probe(first.account.id);
  await app.pool.probe(second.account.id);
  const destinations = [];
  for (let i = 0; i < 2; i++)
    destinations.push((await (await completion(app)).json()).worker);
  assert.deepEqual(destinations.sort(), ['legacy-a', 'legacy-b']);
});

test('repository-free accounts register with distinct tokens and route to their own workspaces', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'without-repo-a');
  const b = await worker(t, 'without-repo-b');
  const response = await app.call('/api/accounts', {
    method: 'POST',
    data: {
      name: '无需仓库路径',
      proxyKey: WORKER,
      registrationToken: 'existing-repository-free-token',
    },
  });
  assert.equal(response.status, 201);
  const first = await response.json();
  const second = await account(app, null, { repo: '   ' });
  assert.equal(first.account.repo, '');
  assert.equal(second.account.repo, '');
  assert.notEqual(first.registrationToken, second.registrationToken);
  for (const [created, upstream] of [[first, a], [second, b]]) {
    const registered = await app.call('/register', {
      method: 'POST',
      headers: { 'X-Reg-Token': created.registrationToken },
      data: { uri: upstream.endpoint },
    });
    assert.equal(registered.status, 200);
    await app.pool.probe(created.account.id);
    assert.equal(app.store.get(created.account.id).endpoint, upstream.endpoint);
  }
  const destinations = [];
  for (let i = 0; i < 2; i++)
    destinations.push((await (await completion(app)).json()).worker);
  assert.deepEqual(destinations.sort(), ['without-repo-a', 'without-repo-b']);
  const overview = await (await app.call('/api/overview')).json();
  assert.equal(overview.stats.quotaOrganizations, 0);
});

test('optional repositories still validate nonempty paths and reject duplicate repositories', async (t) => {
  const app = await fixture(t);
  const first = await account(app, null, { repo: '' });
  const second = await account(app, null, { repo: '' });
  const edit = (id, repo) => app.call(`/api/accounts/${id}`, {
    method: 'PATCH',
    data: { repo },
  });
  assert.equal((await edit(first.account.id, ' org/worker ')).status, 200);
  assert.equal(app.store.get(first.account.id).repo, 'org/worker');
  const duplicate = await edit(second.account.id, 'org/worker');
  assert.equal(duplicate.status, 400);
  assert.match((await duplicate.json()).error.message, /该仓库已接入/);
  for (const repo of ['only-org', 'org / worker', 'https://cnb.cool/org/worker']) {
    const invalid = await edit(second.account.id, repo);
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error.message, /仓库路径格式/);
  }
  assert.equal((await edit(first.account.id, '')).status, 200);
  assert.equal((await edit(second.account.id, 'org/worker')).status, 200);
});

test('repository-only operations fail locally without a path and automatic wake requires a repository', async (t) => {
  const app = await fixture(t);
  const created = await account(app, null, {
    repo: '',
    pat: 'test-personal-token',
  });
  const id = created.account.id;
  let remoteCalls = 0;
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input, options) => {
    if (new URL(input).hostname === 'api.cnb.cool') {
      remoteCalls++;
      throw new Error('Repository-free operations must not contact CNB');
    }
    return originalFetch(input, options);
  });
  for (const action of ['quota', 'wake']) {
    const response = await app.call(`/api/accounts/${id}/${action}`, {
      method: 'POST',
      data: {},
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /填写 CNB 仓库路径/);
  }
  assert.equal(remoteCalls, 0);
  const edit = (data) => app.call(`/api/accounts/${id}`, {
    method: 'PATCH',
    data,
  });
  const missingRepo = await edit({ autoWake: true });
  assert.equal(missingRepo.status, 400);
  assert.match((await missingRepo.json()).error.message, /自动唤醒需要填写 CNB 仓库路径/);
  assert.equal((await edit({ repo: 'org/worker', autoWake: true })).status, 200);
  assert.equal((await edit({ repo: '' })).status, 400);
  assert.equal(app.store.get(id).repo, 'org/worker');
  app.store.patch(id, {
    quota: {
      org: 'org',
      syncedAt: new Date().toISOString(),
      credits: { total: 500, used: 100, freeze: 20 },
    },
    lastWakeAt: new Date().toISOString(),
  });
  assert.equal((await edit({ repo: '', autoWake: false })).status, 200);
  assert.equal(app.store.get(id).quota, null);
  assert.equal(app.store.get(id).lastWakeAt, null);
  const overview = await (await app.call('/api/overview')).json();
  assert.equal(overview.stats.quotaOrganizations, 0);
  // Also protect the background loop from incomplete state loaded from old data.
  app.store.patch(id, { autoWake: true });
  const wake = t.mock.method(app.pool, 'wake', async () => {
    throw new Error('Missing repositories must not be automatically woken');
  });
  await app.pool.cycle();
  assert.equal(wake.mock.callCount(), 0);
  assert.equal(remoteCalls, 0);
});

test('editing and rotating imported tokens invalidates old credentials on every registration path', async (t) => {
  const app = await fixture(t);
  const up = await worker(t, 'legacy');
  const first = await account(app, null, { registrationToken: '123456789' });
  const paths = [
    '/register',
    '/ops/register',
    `/ops/register/${first.account.id}`,
  ];
  const register = (path, token) =>
    app.call(path, {
      method: 'POST',
      headers: { 'X-Reg-Token': token },
      data: { uri: up.endpoint },
    });
  const edited = await app.call(`/api/accounts/${first.account.id}`, {
    method: 'PATCH',
    data: { registrationToken: 'replacement-legacy-token' },
  });
  assert.equal(edited.status, 200);
  for (const path of paths) {
    assert.equal((await register(path, first.registrationToken)).status, 403);
    assert.equal(
      (await register(path, 'replacement-legacy-token')).status,
      200,
    );
  }
  const response = await app.call(
    `/api/accounts/${first.account.id}/registration`,
    {
      method: 'POST',
      data: {},
    },
  );
  assert.equal(response.status, 200);
  const { registrationToken } = await response.json();
  assert.notEqual(registrationToken, 'replacement-legacy-token');
  for (const path of paths) {
    assert.equal(
      (await register(path, 'replacement-legacy-token')).status,
      403,
    );
    assert.equal((await register(path, registrationToken)).status, 200);
  }
});

test('request, audit and system APIs remain separate and audits include successful and failed management actions', async (t) => {
  const app = await fixture(t);
  const up = await worker(t, 'a');
  const { account: a } = await account(app, up);
  for (const [path, method, data, status] of [
    [`/api/accounts/${a.id}`, 'PATCH', { name: '审计目标' }, 200],
    [`/api/accounts/${a.id}/credentials`, 'POST', {}, 200],
    [`/api/accounts/${a.id}/registration`, 'POST', {}, 200],
    ['/api/settings', 'PATCH', { maxAttempts: 4 }, 200],
    ['/api/settings', 'PATCH', { maxAttempts: 0 }, 400],
  ]) {
    const response = await app.call(path, { method, data });
    assert.equal(response.status, status);
    await response.text();
  }
  const denied = await fetch(`${app.base}/api/settings`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(denied.status, 401);
  await denied.text();
  await app.pool.register(a.id, up.endpoint);
  await (await completion(app)).text();
  const requestLogs = (await (await app.call('/api/logs')).json()).logs;
  const audits = (await (await app.call('/api/logs/audit')).json()).logs;
  const system = (await (await app.call('/api/logs/system')).json()).logs;
  assert.equal(requestLogs.length, 1);
  assert.ok(requestLogs.every((entry) => entry.kind === 'request'));
  assert.ok(audits.every((entry) => entry.kind === 'audit'));
  assert.ok(system.some((entry) => entry.kind === 'register'));
  assert.ok(system.every((entry) => !['request', 'audit', 'account'].includes(entry.kind)));
  for (const action of ['auth.login', 'account.create', 'account.update', 'account.credentials.read', 'account.token.rotate', 'routing.settings'])
    assert.ok(audits.some((entry) => entry.action === action), action);
  assert.ok(audits.some((entry) => entry.action === 'routing.settings' && entry.status === 400));
  const anonymous = audits.find((entry) => entry.status === 401);
  assert.equal(anonymous.actor.provider, 'anonymous');
  const revealed = audits.find((entry) => entry.action === 'account.credentials.read');
  assert.equal(revealed.actor.name, '管理员');
  assert.equal(revealed.actor.provider, 'key');
  assert.equal(revealed.accountId, a.id);
  assert.ok(revealed.ip);
  for (const secret of [WORKER, ADMIN, GATEWAY, app.store.get(a.id).secrets.registrationToken])
    assert.ok(!JSON.stringify(audits).includes(secret));
  for (const channel of ['requests', 'audit', 'system']) {
    assert.equal((await fetch(`${app.base}/api/logs/${channel}`)).status, 401);
    const persisted = readFileSync(app.store.logFiles[channel], 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(persisted.every((entry) => channel === 'requests' ? entry.kind === 'request' : channel === 'audit' ? entry.kind === 'audit' : !['request', 'audit'].includes(entry.kind)));
  }
});

test('weighted routing distributes 2:1, replaces client authorization, and records durable request statistics', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'a');
  const b = await worker(t, 'b');
  await account(app, a, { weight: 2 });
  await account(app, b);
  for (let i = 0; i < 6; i++) {
    const response = await completion(app);
    assert.equal(response.status, 200);
    await response.json();
  }
  assert.equal(a.calls.length, 4);
  assert.equal(b.calls.length, 2);
  assert.ok(
    [...a.calls, ...b.calls].every(
      (c) => c.authorization === `Bearer ${WORKER}`,
    ),
  );
  const overview = await (await app.call('/api/overview')).json();
  assert.equal(overview.stats.requests, 6);
  assert.equal(overview.stats.successRate, 100);
  assert.equal(
    new Store(app.directory).state.hourly.reduce((n, h) => n + h.requests, 0),
    6,
  );
});

test('session affinity keeps subsequent turns on their account and preserves payload fields with usage enabled', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'a');
  const b = await worker(t, 'b');
  await account(app, a);
  await account(app, b);
  const first = await (
    await completion(app, { session: 'conversation-a' })
  ).json();
  assert.equal(first.worker, 'a');
  assert.equal(
    (await (await completion(app, { session: 'conversation-b' })).json())
      .worker,
    'b',
  );
  const data = {
    model: 'test-model',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'continue' },
    ],
    metadata: { user_id: 'unchanged-user' },
    temperature: 0.7,
  };
  assert.equal(
    (await (await completion(app, { session: 'conversation-a', data })).json())
      .worker,
    'a',
  );
  assert.deepEqual(a.calls.at(-1).payload, {
    ...data,
    stream_options: { include_usage: true },
  });
  const cors = await app.call('/v1/chat/completions', { method: 'OPTIONS' });
  assert.match(
    cors.headers.get('access-control-allow-headers'),
    /x-session-id/,
  );
  assert.match(
    cors.headers.get('access-control-allow-headers'),
    /x-conversation-id/,
  );
});

test('requests without session IDs reuse the first-message fingerprint across turns', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'a');
  const b = await worker(t, 'b');
  await account(app, a);
  await account(app, b);
  assert.equal(
    (await (await completion(app, { session: null })).json()).worker,
    'a',
  );
  const data = {
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'continue' },
    ],
  };
  assert.equal(
    (await (await completion(app, { session: null, data })).json()).worker,
    'a',
  );
  assert.equal(
    (
      await (
        await completion(app, {
          session: null,
          data: {
            messages: [{ role: 'user', content: 'another conversation' }],
          },
        })
      ).json()
    ).worker,
    'b',
  );
});

test('concurrent requests for a new session bind before the upstream responds', async (t) => {
  const app = await fixture(t);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let received;
  const bothReceived = new Promise((resolve) => {
    received = resolve;
  });
  let count = 0;
  const handler = (name) => async (_req, res) => {
    if (++count === 2) received();
    await held;
    res.end(JSON.stringify({ worker: name }));
  };
  const a = await worker(t, 'a', handler('a'));
  const b = await worker(t, 'b', handler('b'));
  await account(app, a);
  await account(app, b);
  const requests = [
    completion(app, { session: 'concurrent' }),
    completion(app, { session: 'concurrent' }),
  ];
  try {
    await bothReceived;
  } finally {
    release();
  }
  const results = await Promise.all(
    requests.map(async (request) => (await (await request).json()).worker),
  );
  assert.deepEqual(results, ['a', 'a']);
});

test('failed sessions rebind and stay with a healthy replacement after same-priority recovery', async (t) => {
  const app = await fixture(t);
  let failing = true;
  const a = await worker(t, 'a', (_req, res) => {
    res.writeHead(failing ? 429 : 200);
    res.end(JSON.stringify({ worker: 'a' }));
  });
  const b = await worker(t, 'b');
  const first = await account(app, a);
  await account(app, b);
  assert.equal(
    (await (await completion(app, { session: 'failover' })).json()).worker,
    'b',
  );
  failing = false;
  await app.pool.probe(first.account.id);
  assert.equal(
    (await (await completion(app, { session: 'failover' })).json()).worker,
    'b',
  );
  assert.equal(a.calls.length, 1);
});

for (const reason of [
  'disabled',
  'deleted',
  'incompatible',
  'cooling',
  'unhealthy',
  'priority',
]) {
  test(`session affinity rechecks account eligibility: ${reason}`, async (t) => {
    const app = await fixture(t);
    const a = await worker(t, 'a');
    const b = await worker(t, 'b');
    const first = (await account(app, a)).account;
    const second = (await account(app, b)).account;
    assert.equal(
      (await (await completion(app, { session: reason })).json()).worker,
      'a',
    );
    if (reason === 'deleted') app.store.remove(first.id);
    else if (reason === 'priority')
      app.store.patch(second.id, { priority: 10 });
    else
      app.store.patch(first.id, {
        ...{
          disabled: { enabled: false },
          incompatible: { models: ['other-model'] },
          cooling: {
            cooldownUntil: new Date(Date.now() + 60000).toISOString(),
          },
          unhealthy: { status: 'unhealthy' },
        }[reason],
      });
    assert.equal(
      (await (await completion(app, { session: reason })).json()).worker,
      'b',
    );
  });
}

test('disabling session affinity restores per-request balancing and persists across restart', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'a');
  const b = await worker(t, 'b');
  await account(app, a);
  await account(app, b);
  assert.equal(
    (await (await completion(app, { session: 'toggle' })).json()).worker,
    'a',
  );
  const invalid = await app.call('/api/settings', {
    method: 'PATCH',
    data: { sessionAffinity: 'false' },
  });
  assert.equal(invalid.status, 400);
  const saved = await app.call('/api/settings', {
    method: 'PATCH',
    data: { sessionAffinity: false },
  });
  assert.equal(saved.status, 200);
  assert.equal(
    (await (await completion(app, { session: 'toggle' })).json()).worker,
    'b',
  );
  assert.equal(
    (await (await completion(app, { session: 'toggle' })).json()).worker,
    'a',
  );
  assert.equal(new Store(app.directory).state.settings.sessionAffinity, false);
});

test('existing saved settings receive new defaults while preserving configured values', async (t) => {
  const app = await fixture(t);
  app.store.settings({ strategy: 'failover', maxAttempts: 5 });
  const saved = JSON.parse(readFileSync(app.store.file, 'utf8'));
  delete saved.settings.sessionAffinity;
  writeFileSync(app.store.file, JSON.stringify(saved));
  const restored = new Store(app.directory);
  assert.equal(restored.state.settings.sessionAffinity, true);
  assert.equal(restored.state.settings.strategy, 'failover');
  assert.equal(restored.state.settings.maxAttempts, 5);
});

test('429 triggers cooldown and switches to a lower priority account without leaking upstream error bodies', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'a', (_req, res) => {
    res.writeHead(429);
    res.end('sensitive upstream detail');
  });
  const b = await worker(t, 'b');
  const first = await account(app, a, { priority: 10 });
  await account(app, b);
  const result = await completion(app);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).worker, 'b');
  assert.equal(app.store.get(first.account.id).status, 'unhealthy');
  assert.ok(
    Date.parse(app.store.get(first.account.id).cooldownUntil) > Date.now(),
  );
  await (await completion(app)).json();
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 2);
  assert.ok(
    !JSON.stringify(app.store.state.logs).includes('sensitive upstream detail'),
  );
});

test('invalid client requests pass through once without retrying or cooling the healthy account', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'a', (_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"invalid messages"}}');
  });
  const b = await worker(t, 'b');
  const first = await account(app, a, { priority: 2 });
  await account(app, b);
  const result = await completion(app);
  assert.equal(result.status, 400);
  assert.equal((await result.json()).error.message, 'invalid messages');
  assert.equal(b.calls.length, 0);
  assert.equal(app.store.get(first.account.id).status, 'healthy');
});

test('OpenAI and Anthropic streams pass through byte-for-byte and preserve paths', async (t) => {
  const app = await fixture(t);
  const wire =
    'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const up = await worker(t, 'stream', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(wire.slice(0, 30));
    res.end(wire.slice(30));
  });
  await account(app, up);
  for (const path of [
    '/v1/chat/completions',
    '/v1/messages',
    '/v1/messages/count_tokens',
  ]) {
    const response = await app.call(path, {
      method: 'POST',
      headers: { 'x-api-key': GATEWAY },
      data: { model: 'test-model', stream: true, messages: [] },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), wire);
    assert.ok(response.headers.get('x-request-id'));
  }
  assert.deepEqual(
    up.calls.map((c) => c.path),
    ['/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens'],
  );
});

test('least-connections sends a concurrent request to the idle account', async (t) => {
  const app = await fixture(t);
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let received;
  const requestReceived = new Promise((resolve) => {
    received = resolve;
  });
  const a = await worker(t, 'a', async (_req, res) => {
    received();
    await held;
    res.end('{"worker":"a"}');
  });
  const b = await worker(t, 'b');
  await account(app, a);
  await account(app, b);
  app.store.settings({ strategy: 'least-connections' });
  // The first tie is deliberately resolved using the account's measured latency.
  for (const acc of app.store.state.accounts)
    app.store.patch(acc.id, {
      latencyMs: acc.endpoint === a.endpoint ? 1 : 20,
    });
  const first = completion(app);
  await requestReceived;
  try {
    assert.equal((await (await completion(app)).json()).worker, 'b');
  } finally {
    release();
    await (await first).text();
  }
});

test('disconnect cancels a streaming upstream and never replays to another account', async (t) => {
  const app = await fixture(t);
  let disconnected;
  const gone = new Promise((resolve) => {
    disconnected = resolve;
  });
  const a = await worker(t, 'a', (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    res.on('close', () => disconnected());
  });
  const b = await worker(t, 'b');
  await account(app, a, { priority: 10 });
  await account(app, b);
  const controller = new AbortController();
  const response = await fetch(`${app.base}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GATEWAY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'test-model', stream: true }),
    signal: controller.signal,
  });
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length);
  controller.abort();
  await gone;
  assert.equal(b.calls.length, 0);
});

test('empty and model-incompatible pools fail promptly and settings reject invalid values', async (t) => {
  const app = await fixture(t);
  assert.equal((await app.call('/health')).status, 503);
  assert.equal((await completion(app)).status, 503);
  const up = await worker(t, 'a');
  await account(app, up, { models: ['other-model'] });
  assert.equal((await completion(app)).status, 503);
  assert.equal(up.calls.length, 0);
  const invalid = await app.call('/api/settings', {
    method: 'PATCH',
    data: { maxAttempts: 0 },
  });
  assert.equal(invalid.status, 400);
  const invalidAccount = await app.call('/api/accounts', {
    method: 'POST',
    data: { name: 'bad', repo: 'org/invalid', proxyKey: WORKER, weight: -1 },
  });
  assert.equal(invalidAccount.status, 400);
  assert.equal(
    (
      await app.call('/api/accounts', {
        method: 'POST',
        data: {
          name: 'bad',
          repo: 'org/ssrf',
          proxyKey: WORKER,
          endpoint: 'https://169.254.169.254',
        },
      })
    ).status,
    400,
  );
  assert.throws(() => normalizeEndpoint('http://127.0.0.1:1234'));
  assert.equal(
    normalizeEndpoint('https://abc-{{port}}.cnb.run'),
    'https://abc-9001.cnb.run',
  );
  assert.throws(() =>
    normalizeEndpoint('https://abc-9001.cnb.run@evil.example'),
  );
});

test('quota totals deduplicate the same organization and subtract frozen credits', async (t) => {
  const app = await fixture(t);
  const first = await account(app);
  const second = await account(app);
  for (const a of [first, second])
    app.store.patch(a.account.id, {
      quota: {
        org: 'org',
        syncedAt: new Date().toISOString(),
        credits: { total: 500, used: 100, freeze: 20 },
      },
    });
  const overview = await (await app.call('/api/overview')).json();
  assert.equal(overview.stats.remainingCredits, 380);
  assert.equal(overview.stats.quotaOrganizations, 1);
});

test('oversized and primitive JSON requests return errors without hanging; client CORS does not expose management APIs', async (t) => {
  const app = await fixture(t);
  const large = await app.call('/v1/chat/completions', {
    method: 'POST',
    auth: GATEWAY,
    data: { padding: 'x'.repeat(4 * 1024 * 1024 + 1) },
  });
  assert.equal(large.status, 413);
  assert.ok((await large.json()).error.message);
  for (const input of [null, [], 12, 'invalid'])
    assert.equal(
      (
        await app.call('/v1/messages', {
          method: 'POST',
          auth: GATEWAY,
          data: input,
        })
      ).status,
      400,
    );
  const cors = await app.call('/v1/messages', {
    method: 'OPTIONS',
    headers: { Origin: 'https://client.example' },
  });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get('access-control-allow-origin'), '*');
  assert.equal(
    (await app.call('/api/accounts')).headers.get(
      'access-control-allow-origin',
    ),
    null,
  );
});

test('an in-flight failure of an old endpoint cannot cool a newly registered address', async (t) => {
  const app = await fixture(t);
  const a = await worker(t, 'a');
  const b = await worker(t, 'b');
  const created = await account(app, a);
  const old = app.store.get(created.account.id);
  app.store.update(old.id, { endpoint: b.endpoint });
  await app.pool.probe(old.id);
  app.pool.fail(old.id, 'stale connection failure', 502, old);
  assert.equal(app.store.get(old.id).status, 'healthy');
  assert.equal(app.store.get(old.id).endpoint, b.endpoint);
});

test('request attempt limits stop retries and a recovered probe clears the circuit', async (t) => {
  const app = await fixture(t);
  let failing = true;
  const a = await worker(t, 'a', (_req, res) => {
    res.writeHead(failing ? 503 : 200);
    res.end('{}');
  });
  const b = await worker(t, 'b');
  const first = await account(app, a, { priority: 10 });
  await account(app, b);
  app.store.settings({ maxAttempts: 1 });
  assert.equal((await completion(app)).status, 503);
  assert.equal(b.calls.length, 0);
  failing = false;
  await app.pool.probe(first.account.id);
  assert.equal(app.store.get(first.account.id).cooldownUntil, null);
  assert.equal((await completion(app)).status, 200);
  assert.equal(a.calls.length, 2);
});
