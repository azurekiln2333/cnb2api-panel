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
import { tokenValue, tokenCoverage, tokenCoverageLabel, upstreamComplete } from '../src/usage.ts'

const local = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  total: input + output,
  reportedRequests: 1,
  missingRequests: 0,
  partialRequests: 0,
  cacheReadReported: 1,
  cacheWriteReported: 1,
})

const upstream = (prompt, completion, credit, cacheHit, cacheMiss) => ({
  prompt,
  completion,
  requests: 1,
  errors: 0,
  partialRequests: 0,
  credit,
  cacheHit,
  cacheMiss,
  cacheWrite: null,
  coverage: { prompt: 1, completion: 1, credit: 1, cacheHit: 1, cacheMiss: 1, cacheWrite: 0 },
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
  assert.equal(localCacheMiss(null), null)
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
    cacheWrite: null,
    total: 3300,
  })
  // Local misses must reconcile with the workspace's own miss counter.
  assert.equal(totals.local.cacheMiss, totals.upstream.cacheMiss)
  assert.equal(formatHitRate(totals.upstream.cacheHit, totals.upstream.cacheMiss), '36.7%')
  assert.equal(formatCreditPerThousand(totals.upstream.credit, totals.upstream.total), '2.12')
})

test('an empty pool has zero values but no measured ratio coverage', () => {
  const totals = sumReconcile([])
  assert.equal(totals.local.total, 0)
  assert.equal(totals.upstream.credit, 0)
  assert.equal(totals.upstreamComplete.credit, false)
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

test('cache availability distinguishes missing, explicit zero and historical positive values', () => {
  const missing = { ...local(100, 10), cacheReadReported: 0, cacheWriteReported: 0 }
  assert.equal(tokenValue(missing, 'cacheRead'), null)
  assert.equal(tokenCoverageLabel(missing, 'cacheRead'), '未上报')
  assert.equal(localCacheMiss(missing), null)
  assert.equal(tokenValue(local(100, 10), 'cacheRead'), 0)
  assert.equal(tokenCoverage(local(100, 10), 'cacheRead'), 'complete')
  const historical = { ...missing, cacheRead: 50 }
  assert.equal(tokenValue(historical, 'cacheRead'), 50)
  assert.equal(tokenCoverage(historical, 'cacheRead'), 'partial')
  assert.equal(localCacheMiss(historical), null)
  assert.equal(tokenValue({ ...missing, reportedRequests: 0 }, 'cacheRead'), null)
  assert.equal(
    tokenValue({ ...missing, input: 0, output: 0, total: 0, reportedRequests: 0 }, 'cacheRead'),
    0,
  )
})

test('partial attempt coverage suppresses rates and excludes unavailable stale snapshots', () => {
  const partial = { ...local(1000, 100, 300), reportedRequests: 2, cacheReadReported: 1 }
  assert.equal(localCacheMiss(partial), null)
  assert.equal(tokenCoverageLabel(partial, 'cacheRead'), '部分上报（1/2 次尝试）')
  const measured = upstream(1000, 100, 1, 300, 700)
  const old = { ...upstream(200, 20, 0, 0, 0), coverage: undefined }
  const rows = [
    { accountId: 'a', accountName: 'A', status: 'ok', local: partial, upstream: measured },
    { accountId: 'b', accountName: 'B', status: 'ok', local: null, upstream: old },
    {
      accountId: 'c',
      accountName: 'C',
      status: 'unavailable',
      local: local(9000, 900),
      upstream: upstream(9000, 900, 99, 0, 9000),
    },
  ]
  const result = sumReconcile(rows)
  assert.equal(result.upstream.credit, 1)
  assert.equal(result.upstream.prompt, 1200)
  assert.equal(result.upstreamComplete.credit, false)
  assert.equal(result.upstreamComplete.cacheHit, false)
  assert.equal(result.localComplete.cacheRead, false)
  assert.equal(result.local.cacheMiss, null)
  assert.equal(upstreamComplete(old, 'credit', 'prompt', 'completion'), false)
  assert.equal(upstreamComplete(measured, 'credit', 'prompt', 'completion'), true)
})

test('interrupted and legacy completion counts suppress ratios without hiding subtotals', () => {
  for (const partialRequests of [1, null, undefined]) {
    const observed = { ...upstream(1000, 100, 0.25, 800, 200), partialRequests }
    const result = sumReconcile([
      {
        accountId: 'a',
        accountName: 'A',
        status: 'ok',
        local: local(1000, 100, 800),
        upstream: observed,
      },
    ])
    assert.equal(result.upstream.credit, 0.25)
    assert.equal(result.upstream.cacheHit, 800)
    assert.equal(result.upstreamComplete.credit, false)
    assert.equal(result.upstreamComplete.cacheHit, false)
    assert.equal(result.upstreamComplete.total, false)
    assert.equal(upstreamComplete(observed, 'credit', 'prompt', 'completion'), false)
  }
})
