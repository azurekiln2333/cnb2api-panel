// Unit tests for the upstream reconciliation helpers. Run with
// `node --test test/*.test.mjs` inside web/.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cacheHitRate,
  creditPerThousand,
  formatCredit,
  formatCreditPerThousand,
  formatHitRate,
  localCacheMiss,
  sumReconcile,
  syncedSources,
} from '../src/reconcile.ts'

const local = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  total: input + output,
  reportedRequests: 1,
  missingRequests: 0,
  partialRequests: 0,
})

const upstream = (prompt, completion, credit, cacheHit, cacheMiss) => ({
  prompt,
  completion,
  requests: 1,
  errors: 0,
  credit,
  cacheHit,
  cacheMiss,
})

test('cache hit rate divides hits by hits plus misses', () => {
  assert.equal(cacheHitRate(3840, 960), 0.8)
  assert.equal(formatHitRate(3840, 960), '80%')
  assert.equal(formatHitRate(1, 2), '33.3%')
  assert.equal(formatHitRate(4007, 0), '100%')
  // A cache that never hit is a zero rate, which is a real observation.
  assert.equal(formatHitRate(0, 4007), '0%')
})

test('cache hit rate is unknown without a denominator', () => {
  assert.equal(cacheHitRate(0, 0), null)
  assert.equal(cacheHitRate(null, 10), null)
  assert.equal(cacheHitRate(10, null), null)
  assert.equal(cacheHitRate(Number.NaN, 10), null)
  assert.equal(formatHitRate(0, 0), '—')
})

test('credit per thousand tokens divides credit by thousands of tokens', () => {
  assert.equal(creditPerThousand(7.5, 7500), 1)
  assert.equal(creditPerThousand(0.000125, 100), 0.00125)
  assert.equal(formatCreditPerThousand(7.5, 7500), '1')
  assert.equal(formatCreditPerThousand(1.25, 1000), '1.25')
})

test('credit per thousand tokens is unknown without tokens', () => {
  assert.equal(creditPerThousand(1, 0), null)
  assert.equal(creditPerThousand(1, null), null)
  assert.equal(creditPerThousand(null, 100), null)
  assert.equal(creditPerThousand(1, Number.NaN), null)
  assert.equal(formatCreditPerThousand(1, 0), '—')
})

test('credit formatting keeps small values significant and abbreviates large ones', () => {
  assert.equal(formatCredit(null), '—')
  assert.equal(formatCredit(0), '0')
  assert.equal(formatCredit(1.5), '1.5')
  assert.equal(formatCredit(7.5), '7.5')
  assert.equal(formatCredit(0.000125), '0.000125')
  assert.equal(formatCredit(1_500), '1.5K')
  assert.equal(formatCredit(23_019_762), '23.02M')
  assert.equal(formatCredit(-0.000125), '-0.000125')
})

test('local cache misses are the prompt tokens served without a cache hit', () => {
  assert.equal(localCacheMiss(local(1000, 10, 300)), 700)
  assert.equal(localCacheMiss(local(1000, 10, 1000)), 0)
  // A broken upstream count must not produce a negative miss count.
  assert.equal(localCacheMiss(local(100, 10, 500)), 0)
  assert.equal(localCacheMiss(null), 0)
})

test('totals sum every synced account and skip rows without a snapshot', () => {
  const sources = [
    {
      accountId: 'a',
      accountName: 'A',
      status: 'ok',
      local: local(1000, 100, 300, 50),
      upstream: upstream(1000, 100, 2, 300, 700),
    },
    {
      accountId: 'b',
      accountName: 'B',
      status: 'ok',
      local: local(2000, 200, 800, 0),
      upstream: upstream(2000, 200, 5, 800, 1200),
    },
    {
      accountId: 'c',
      accountName: 'C',
      status: 'unavailable',
      local: null,
      upstream: null,
    },
  ]
  const totals = sumReconcile(sources)
  assert.deepEqual(totals.local, {
    input: 3000,
    output: 300,
    cacheRead: 1100,
    cacheWrite: 50,
    cacheMiss: 1900,
    total: 3300,
  })
  assert.deepEqual(totals.upstream, {
    prompt: 3000,
    completion: 300,
    credit: 7,
    cacheHit: 1100,
    cacheMiss: 1900,
    total: 3300,
  })
  // Local misses must reconcile with the workspace's own miss counter.
  assert.equal(totals.local.cacheMiss, totals.upstream.cacheMiss)
  assert.equal(formatHitRate(totals.upstream.cacheHit, totals.upstream.cacheMiss), '36.7%')
  assert.equal(formatCreditPerThousand(totals.upstream.credit, totals.upstream.total), '2.12')
})

test('an empty pool produces zero totals instead of null values', () => {
  assert.deepEqual(sumReconcile([]), {
    local: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheMiss: 0, total: 0 },
    upstream: { prompt: 0, completion: 0, credit: 0, cacheHit: 0, cacheMiss: 0, total: 0 },
  })
  assert.equal(formatHitRate(0, 0), '—')
})

test('only rows with a real snapshot feed the reconciliation totals', () => {
  const sources = [
    {
      accountId: 'a',
      accountName: 'A',
      status: 'ok',
      local: local(1, 1),
      upstream: upstream(1, 1, 1, 1, 0),
    },
    { accountId: 'b', accountName: 'B', status: 'pending', local: null, upstream: null },
    { accountId: 'c', accountName: 'C', status: 'unsupported', local: null, upstream: null },
  ]
  assert.deepEqual(
    syncedSources(sources).map((source) => source.accountId),
    ['a'],
  )
  assert.equal(sumReconcile(sources).upstream.total, 2)
})
