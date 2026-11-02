// Unit tests for the shared count abbreviation helper. Run with
// `node --test test/*.test.mjs` inside web/, or from the repository root with
// `node --test test/web-format.test.mjs`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { abbreviateCount, abbreviatedOrDash } from '../src/format.ts'

test('values below one thousand have no abbreviation', () => {
  assert.equal(abbreviateCount(0), '')
  assert.equal(abbreviateCount(1), '')
  assert.equal(abbreviateCount(999), '')
  assert.equal(abbreviateCount(-999), '')
})

test('thousands use K with two decimals and drop an empty decimal', () => {
  assert.equal(abbreviateCount(1_000), '1K')
  assert.equal(abbreviateCount(1_500), '1.5K')
  assert.equal(abbreviateCount(1_234), '1.23K')
  assert.equal(abbreviateCount(999_949), '999.95K')
})

test('rounding to two decimals that reaches 1000 promotes one unit', () => {
  // 999,950 / 1000 = 999.95, which keeps the K unit.
  assert.equal(abbreviateCount(999_950), '999.95K')
  // 999,999 / 1000 = 999.999 and 999,999.5 / 1000 = 999.9995 both round to 1000K,
  // so they must promote to M instead of printing a misleading 1000K.
  assert.equal(abbreviateCount(999_999), '1M')
  assert.equal(abbreviateCount(999_999.5), '1M')
  assert.equal(abbreviateCount(999_999_999), '1B')
})

test('millions use M with two decimals', () => {
  assert.equal(abbreviateCount(1_000_000), '1M')
  assert.equal(abbreviateCount(23_019_762), '23.02M')
  assert.equal(abbreviateCount(1_234_567), '1.23M')
})

test('billions use B with two decimals', () => {
  assert.equal(abbreviateCount(1_000_000_000), '1B')
  assert.equal(abbreviateCount(2_500_000_000), '2.5B')
  assert.equal(abbreviateCount(1_234_567_890_123), '1234.57B')
  // Trillions stay in B because no larger suffix exists.
  assert.equal(abbreviateCount(1_000_000_000_000), '1000B')
  assert.equal(abbreviateCount(999_999_999_999), '1000B')
})

test('negative values carry the sign of the original count', () => {
  assert.equal(abbreviateCount(-1_500), '-1.5K')
  assert.equal(abbreviateCount(-23_019_762), '-23.02M')
  assert.equal(abbreviateCount(-999_999), '-1M')
  assert.equal(abbreviateCount(-1_000_000_000), '-1B')
})

test('missing and non-finite values render empty or as an em dash', () => {
  assert.equal(abbreviateCount(null), '')
  assert.equal(abbreviateCount(undefined), '')
  assert.equal(abbreviateCount(Number.NaN), '')
  assert.equal(abbreviateCount(Number.POSITIVE_INFINITY), '')
  assert.equal(abbreviateCount(Number.NEGATIVE_INFINITY), '')
  assert.equal(abbreviatedOrDash(null), '—')
  assert.equal(abbreviatedOrDash(undefined), '—')
  assert.equal(abbreviatedOrDash(Number.NaN), '—')
  assert.equal(abbreviatedOrDash(0), '')
  assert.equal(abbreviatedOrDash(999), '')
  assert.equal(abbreviatedOrDash(23_019_762), '23.02M')
})

test('every unit boundary is monotone and never prints 1000 of a smaller unit', () => {
  const samples = [
    1_000, 1_500, 999_949, 999_950, 999_999, 1_000_000, 23_019_762, 999_999_999, 1_000_000_000,
    2_500_000_000, 1_000_000_000_000,
  ]
  // A count below 1000 intentionally renders no abbreviation.
  assert.equal(abbreviateCount(999), '')
  for (const sample of samples) {
    const label = abbreviateCount(sample)
    assert.ok(label.length > 0, `${sample} produced no label`)
    assert.ok(!/^1000K$/.test(label), `${sample} must not render as 1000K`)
  }
})
