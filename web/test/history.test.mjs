import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HISTORY_RANGE,
  HISTORY_RANGES,
  historyAmount,
  historyBars,
  historyCount,
  historyHasCache,
  historyIndexAt,
  historyIsEmpty,
  historyPartialDays,
  historyStep,
  historyTick,
  historyTicks,
} from '../src/history.ts'

const day = (date, input, output, extra = {}) => ({
  date,
  requests: 1,
  errors: 0,
  partial: false,
  tokenUsage: {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    total: input + output,
    reportedRequests: 1,
    missingRequests: 0,
    partialRequests: 0,
    cacheReadReported: 0,
    cacheWriteReported: 0,
    ...extra,
  },
})

test('history bars scale against the tallest day and stack output on input', () => {
  const bars = historyBars([
    day('2026-03-01', 0, 0),
    day('2026-03-02', 300, 100, { cacheRead: 200, cacheReadReported: 1 }),
    day('2026-03-03', 100, 100),
  ])
  assert.equal(bars.length, 3)
  // 400 is the peak, so the third day reaches half of it.
  assert.equal(bars[1].inputShare, 0.75)
  assert.equal(bars[1].outputShare, 0.25)
  assert.equal(bars[1].cacheShare, 0.5)
  assert.equal(bars[2].inputShare + bars[2].outputShare, 0.5)
  assert.equal(bars[0].inputShare, 0)
  assert.equal(bars[1].tokenUsage.cacheRead, 200)
  // An all-zero range divides by one instead of by zero.
  assert.deepEqual(
    historyBars([day('2026-03-04', 0, 0)]).map((bar) => bar.inputShare),
    [0],
  )
})

test('cache series, empty state and partial days read the reported fields', () => {
  const days = [
    day('2026-03-01', 100, 20),
    day('2026-03-02', 50, 10, { cacheRead: 0, cacheReadReported: 1 }),
    { ...day('2026-03-03', 0, 0), partial: true, requests: 0 },
  ]
  // A reported zero still counts as a measured cache series.
  assert.equal(historyHasCache(days), true)
  assert.equal(historyHasCache([day('2026-03-01', 100, 20)]), false)
  assert.equal(historyPartialDays(days), 1)
  assert.equal(historyIsEmpty([]), true)
  const idle = { ...day('2026-03-01', 0, 0), requests: 0 }
  idle.tokenUsage.reportedRequests = 0
  assert.equal(historyIsEmpty([idle]), true)
  assert.equal(historyIsEmpty(days), false)
})

test('amounts reuse the K/M/B abbreviation and the coverage labels', () => {
  const usage = day('2026-03-01', 1_234_567, 999).tokenUsage
  assert.deepEqual(historyAmount(usage, 'input'), { text: '1.23M', title: '1,234,567' })
  assert.deepEqual(historyAmount(usage, 'output'), { text: '999', title: '999' })
  // A cache counter nobody reported is unknown, not zero.
  assert.deepEqual(historyAmount(usage, 'cacheRead'), { text: '—', title: '未上报' })
  const partial = { ...usage, cacheRead: 5_000, cacheReadReported: 1, missingRequests: 1 }
  assert.deepEqual(historyAmount(partial, 'cacheRead'), {
    text: '5K',
    title: '5,000 · 部分上报（1/2 次尝试）',
  })
  assert.deepEqual(historyAmount(null, 'input'), { text: '0', title: '0' })
  assert.equal(historyCount(12), '12')
  assert.equal(historyCount(12_500), '12.5K')
})

test('axis ticks stay evenly spaced and labelled by month and day', () => {
  const days = Array.from({ length: 30 }, (_, index) =>
    day(`2026-03-${String(index + 1).padStart(2, '0')}`, index, 0),
  )
  const ticks = historyTicks(days)
  // ceil(30 / 6) = 5 days apart, ending on the newest day.
  assert.deepEqual(
    ticks.map((tick) => tick.index),
    [4, 9, 14, 19, 24, 29],
  )
  assert.equal(ticks.at(-1).label, '03-30')
  assert.equal(historyTick('2026-12-31'), '12-31')
  assert.deepEqual(historyTicks([]), [])
  // A short range keeps every day.
  assert.deepEqual(
    historyTicks([day('2026-03-01', 1, 0), day('2026-03-02', 1, 0)]).map((tick) => tick.label),
    ['03-01', '03-02'],
  )
  assert.ok(historyTicks(Array.from({ length: 365 }, () => day('2026-03-01', 1, 0))).length <= 6)
})

test('pointer ratios and arrow keys map to a bar inside the range', () => {
  assert.equal(historyIndexAt(0, 7), 0)
  assert.equal(historyIndexAt(0.5, 7), 3)
  assert.equal(historyIndexAt(0.999, 7), 6)
  assert.equal(historyIndexAt(1, 7), 6)
  assert.equal(historyIndexAt(-1, 7), 0)
  assert.equal(historyIndexAt(Number.NaN, 7), 0)
  assert.equal(historyIndexAt(0.5, 0), null)
  // The first key press selects the newest day.
  assert.equal(historyStep(null, -1, 7), 6)
  assert.equal(historyStep(6, -1, 7), 5)
  assert.equal(historyStep(0, -1, 7), 0)
  assert.equal(historyStep(6, 1, 7), 6)
  assert.equal(historyStep(null, 1, 0), null)
})

test('the range switch offers the four documented windows', () => {
  assert.deepEqual([...HISTORY_RANGES], [7, 30, 90, 365])
  assert.equal(DEFAULT_HISTORY_RANGE, 30)
})
