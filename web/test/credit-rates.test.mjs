// Unit tests for the Credits rate formatting and empty states. Run with
// `node --test test/*.test.mjs` inside web/.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  accountRateLine,
  billingText,
  DEVIATION_HINT,
  deviationHint,
  formatDeviation,
  formatRate,
  INSUFFICIENT_LABEL,
  reportedText,
  tokensLeftText,
} from '../src/credit-rates.ts'

const row = (fields = {}) => ({
  accountId: 'a',
  accountName: 'a',
  org: 'org',
  sharedOrg: false,
  windowStart: null,
  windowEnd: null,
  deltaCredits: null,
  deltaTokens: null,
  billing: null,
  reported: null,
  reportedStatus: 'missing',
  deviation: null,
  remainingCredits: null,
  tokensLeft: null,
  status: 'no_data',
  ...fields,
})

test('rates keep more decimals for small prices', () => {
  assert.equal(formatRate(1234.567), '1,234.6')
  assert.equal(formatRate(12.345), '12.35')
  assert.equal(formatRate(0.123456), '0.1235')
  assert.equal(formatRate(null), '—')
  assert.equal(formatRate(Number.NaN), '—')
})

test('billing and reported values show clear empty states', () => {
  assert.equal(billingText(row({ status: 'insufficient' })), INSUFFICIENT_LABEL)
  assert.equal(INSUFFICIENT_LABEL, '数据不足（需至少 10 万 tokens）')
  assert.equal(billingText(row({ org: null })), '未填写仓库')
  assert.equal(billingText(null), INSUFFICIENT_LABEL)
  assert.equal(
    billingText(row({ status: 'ok', billing: { rate: 2.5, inputRate: null, outputRate: null, r2: null } })),
    '2.5',
  )
  assert.equal(reportedText(row()), '未上报')
  assert.equal(reportedText(row({ reportedStatus: 'insufficient' })), INSUFFICIENT_LABEL)
  assert.equal(reportedText(row({ reportedStatus: 'ok', reported: { rate: 3, partial: false } })), '3')
})

test('deviation is a signed percentage with a hint above twenty percent', () => {
  assert.equal(formatDeviation(0.1234), '+12.3%')
  assert.equal(formatDeviation(-0.05), '-5.0%')
  assert.equal(formatDeviation(null), '—')
  assert.equal(deviationHint(0.2), '')
  assert.equal(deviationHint(0.21), DEVIATION_HINT)
  assert.equal(deviationHint(-0.3), DEVIATION_HINT)
  assert.equal(deviationHint(null), '')
})

test('tokens left uses the short count form', () => {
  assert.equal(tokensLeftText(23_019_762), '约可用 23.02M tokens')
  assert.equal(tokensLeftText(500), '约可用 500 tokens')
  assert.equal(tokensLeftText(null), '')
})

test('the account line marks shared organizations and partial reports', () => {
  assert.equal(accountRateLine(undefined), '')
  assert.equal(accountRateLine(row()), `单价 ${INSUFFICIENT_LABEL}`)
  assert.equal(
    accountRateLine(
      row({
        sharedOrg: true,
        status: 'ok',
        billing: { rate: 10, inputRate: null, outputRate: null, r2: null },
        reported: { rate: 11, partial: true },
        reportedStatus: 'partial',
      }),
    ),
    '单价 10 · 上报 11（部分上报） · 组织共享',
  )
})
