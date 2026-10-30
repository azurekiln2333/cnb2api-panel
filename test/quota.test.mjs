// 测试：mock CNB charge API，不打真实接口。运行：node --test test/quota.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetchQuota, normalize, render, renderLine, QuotaError, quotaFailure } from '../src/quota.mjs';

// Real CNB shapes (trimmed to the fields the CLI reads).
const QUOTA = {
  credit_in_milli: { total: 1_166_000, free: 500_000 },
  dev_in_sec: { total: 5_760_000, free: 5_760_000 }, // 1600 core-h
  ci_in_sec: { total: 576_000, free: 576_000 },       // 160 core-h
};
const VOLUME = {
  credit_in_milli: 85_710,
  dev_in_sec: 382_155,
  ci_in_sec: 43_480,
  freeze_dev_in_sec: 4_800,
  freeze_credit_in_milli: 2_390,
};

function mockCnb(handler) {
  return http.createServer((req, res) => {
    const kind = req.url.split('/').pop();
    res.setHeader('Content-Type', 'application/json');
    handler(kind, req, res);
  });
}

async function withServer(handler, run) {
  const srv = mockCnb(handler);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { return await run(base); } finally { srv.close(); }
}

// ---- unit-normalization contract ---------------------------------------

test('normalize: milli→credits, sec→core-hours, missing→0', () => {
  const s = normalize('acme', QUOTA, VOLUME);
  assert.equal(s.org, 'acme');
  assert.equal(s.credits.total, 1166);
  assert.equal(s.credits.used, 85.71);
  assert.equal(s.credits.freeze, 2.39);
  assert.equal(s.dev.total, 1600);
  assert.equal(Math.round(s.dev.used), 106); // 382155/3600
  assert.equal(s.ci.total, 160);
  // A field the account lacks must degrade to 0, not NaN/throw.
  const bare = normalize('x', { credit_in_milli: { total: 1000 } }, {});
  assert.equal(bare.credits.total, 1);
  assert.equal(bare.credits.used, 0);
  assert.equal(bare.dev.total, 0);
});

// ---- fetch (both endpoints, concurrent) --------------------------------

test('fetchQuota: folds quota+volume into one snapshot', async () => {
  await withServer((kind, req, res) => {
    // Both must carry the bearer token.
    assert.ok((req.headers.authorization || '').startsWith('Bearer '));
    res.end(JSON.stringify(kind === 'quota' ? QUOTA : VOLUME));
  }, async (base) => {
    const s = await fetchQuota({ org: 'acme', token: 't', base });
    assert.equal(s.credits.total, 1166);
    assert.equal(s.credits.used, 85.71);
    assert.equal(s.credits.freeze, 2.39);
    assert.equal(s.ci.used, 43480 / 3600);
  });
});

test('fetchQuota: accepts explicit zero and numeric credit strings', async () => {
  await withServer((kind, req, res) => {
    res.end(JSON.stringify(kind === 'quota'
      ? { credit_in_milli: { total: '100000' } }
      : { credit_in_milli: '0', freeze_credit_in_milli: 0 }));
  }, async (base) => {
    const s = await fetchQuota({ org: 'acme', token: 't', base });
    assert.deepEqual(s.credits, { total: 100, used: 0, freeze: 0 });
  });
});

test('fetchQuota: omitted optional frozen credits are zero without discarding real usage', async () => {
  await withServer((kind, req, res) => {
    res.end(JSON.stringify(kind === 'quota' ? QUOTA : { credit_in_milli: 85_710 }));
  }, async (base) => {
    const s = await fetchQuota({ org: 'acme', token: 't', base });
    assert.deepEqual(s.credits, { total: 1166, used: 85.71, freeze: 0 });
  });
});

test('fetchQuota: rejects missing or invalid credit data instead of fabricating zero', async (t) => {
  const cases = [
    ['missing allowance', {}, VOLUME],
    ['missing usage', QUOTA, { freeze_credit_in_milli: 0 }],
    ['empty usage', QUOTA, {}],
    ['null quota', null, VOLUME],
    ['array quota', [], VOLUME],
    ['null usage', QUOTA, null],
    ['array usage object', QUOTA, []],
    ['scalar usage', QUOTA, 0],
    ['null allowance', { credit_in_milli: { total: null } }, VOLUME],
    ['negative allowance', { credit_in_milli: { total: -1 } }, VOLUME],
    ['blank usage', QUOTA, { ...VOLUME, credit_in_milli: ' ' }],
    ['boolean usage', QUOTA, { ...VOLUME, credit_in_milli: false }],
    ['array usage', QUOTA, { ...VOLUME, credit_in_milli: [] }],
    ['nonfinite usage', QUOTA, { ...VOLUME, credit_in_milli: 'Infinity' }],
    ['null frozen usage', QUOTA, { ...VOLUME, freeze_credit_in_milli: null }],
    ['blank frozen usage', QUOTA, { ...VOLUME, freeze_credit_in_milli: '' }],
    ['boolean frozen usage', QUOTA, { ...VOLUME, freeze_credit_in_milli: false }],
    ['array frozen usage', QUOTA, { ...VOLUME, freeze_credit_in_milli: [] }],
    ['nonnumeric frozen usage', QUOTA, { ...VOLUME, freeze_credit_in_milli: 'unknown' }],
    ['negative frozen usage', QUOTA, { ...VOLUME, freeze_credit_in_milli: -1 }],
  ];
  for (const [name, quota, volume] of cases) await t.test(name, async () => {
    await withServer((kind, req, res) => {
      res.end(JSON.stringify(kind === 'quota' ? quota : volume));
    }, async (base) => {
      await assert.rejects(() => fetchQuota({ org: 'acme', token: 't', base }),
        /invalid credit quota response/);
    });
  });
});

test('quotaFailure: preserves only safe error metadata and never arbitrary exception details', () => {
  const secret = 'private-token-or-response';
  for (const status of [401, 403, 404, 429, 502]) {
    const error = new QuotaError('quota_upstream_http', {
      resource: 'volume', status, field: secret, cause: new Error(secret),
    });
    const detail = quotaFailure(error);
    assert.equal(error.status, status);
    assert.equal(detail.status, 502);
    assert.equal(detail.code, 'quota_upstream_http');
    assert.match(detail.message, new RegExp(`额度用量.*HTTP ${status}`));
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!JSON.stringify(detail).includes(secret));
  }
  const error = new QuotaError('quota_invalid_response', {
    resource: secret, status: secret, field: secret, cause: secret,
  });
  assert.equal(error.resource, undefined);
  assert.equal(error.status, undefined);
  assert.equal(error.field, undefined);
  assert.ok(!JSON.stringify(quotaFailure(error)).includes(secret));
  const unknown = quotaFailure(Object.assign(new Error(secret), {
    code: 'quota_upstream_http', status: 403, resource: secret,
  }));
  assert.equal(unknown.code, 'quota_sync_failed');
  assert.equal(unknown.status, 502);
  assert.ok(!JSON.stringify(unknown).includes(secret));
});

test('quotaFailure: distinguishes timeout, network, JSON and credit validation failures', () => {
  const cases = [
    ['quota_timeout', 504, /超时/],
    ['quota_network', 502, /无法连接/],
    ['quota_invalid_json', 502, /非 JSON/],
    ['quota_invalid_response', 502, /冻结额度.*无效/],
  ];
  for (const [code, status, message] of cases) {
    const detail = quotaFailure(new QuotaError(code, {
      resource: 'volume', field: 'freeze_credit_in_milli',
    }));
    assert.equal(detail.code, code);
    assert.equal(detail.status, status);
    assert.match(detail.message, message);
  }
});

test('fetchQuota: missing org/token fail fast with a clear message', async () => {
  await assert.rejects(() => fetchQuota({ org: '', token: 't' }), /org slug is required/);
  await assert.rejects(() => fetchQuota({ org: 'acme', token: '' }), /CNB_TOKEN is required/);
});

test('fetchQuota: HTTP 401 surfaces a token hint', async () => {
  await withServer((kind, req, res) => {
    res.writeHead(401);
    res.end('{"message":"unauthorized"}');
  }, async (base) => {
    await assert.rejects(() => fetchQuota({ org: 'acme', token: 'bad', base }), /HTTP 401.*CNB_TOKEN/s);
  });
});

test('fetchQuota: HTTP 404 surfaces an org hint', async () => {
  await withServer((kind, req, res) => { res.writeHead(404); res.end('nope'); },
    async (base) => {
      await assert.rejects(() => fetchQuota({ org: 'ghost', token: 't', base }), /HTTP 404.*org slug/s);
    });
});

// ---- rendering ----------------------------------------------------------

test('render: shows org, all resources, remaining, and no ANSI when NO_COLOR', () => {
  const prev = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
  try {
    const s = normalize('acme', QUOTA, VOLUME);
    const out = render(s, { now: new Date('2026-09-05T12:00:00Z') });
    assert.ok(out.includes('CNB quota'));
    assert.ok(out.includes('acme'));
    assert.ok(out.includes('Credits'));
    assert.ok(out.includes('Dev'));
    assert.ok(out.includes('CI'));
    assert.ok(out.includes('1,166'));            // thousands separator
    assert.ok(out.includes('in-flight'));         // freeze values present
    assert.ok(out.includes('2026-09-05 12:00:00 UTC'));
    assert.ok(!out.includes('\x1b['), 'NO_COLOR must suppress ANSI');
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev;
  }
});

test('render: hides CI row when the org has no CI quota', () => {
  const prev = process.env.NO_COLOR; process.env.NO_COLOR = '1';
  try {
    const s = normalize('acme', { credit_in_milli: { total: 1000 }, dev_in_sec: { total: 3600 } }, {});
    const out = render(s);
    assert.ok(!out.includes(' CI '));
    assert.ok(!out.includes('in-flight'));
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev;
  }
});

test('renderLine: compact summary carries used/total/left', () => {
  const s = normalize('acme', QUOTA, VOLUME);
  const line = renderLine(s);
  assert.ok(line.includes('credits'));
  assert.ok(line.includes('85.7'));
  assert.ok(line.includes('1,166'));
  assert.ok(line.includes('left'));
  assert.ok(line.includes('core-h'));
});
