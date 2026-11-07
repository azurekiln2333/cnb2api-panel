import { abbreviateCount } from './format.ts'
import type { TokenMetric, TokenTotals, UsageHistoryDay } from './types.ts'
import { tokenCoverageLabel, tokenValue } from './usage.ts'

/** Ranges offered by the history card, in days. */
export const HISTORY_RANGES = [7, 30, 90, 365] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]
export const DEFAULT_HISTORY_RANGE: HistoryRange = 30

export interface HistoryBar {
  date: string
  tokenUsage: TokenTotals
  requests: number
  errors: number
  partial: boolean
  /** Heights as a share of the tallest input + output day. */
  inputShare: number
  outputShare: number
  /** Cache reads are part of input, so they share the same scale. */
  cacheShare: number
}

/** Bars scaled against the tallest day, so the chart stays unit independent. */
export function historyBars(days: UsageHistoryDay[]): HistoryBar[] {
  const peak = Math.max(1, ...days.map((day) => day.tokenUsage.input + day.tokenUsage.output))
  return days.map((day) => ({
    date: day.date,
    tokenUsage: day.tokenUsage,
    requests: day.requests,
    errors: day.errors,
    partial: day.partial,
    inputShare: day.tokenUsage.input / peak,
    outputShare: day.tokenUsage.output / peak,
    cacheShare: (day.tokenUsage.cacheRead ?? 0) / peak,
  }))
}

/** The cache-read series only appears once some day actually reported it. */
export function historyHasCache(days: UsageHistoryDay[]) {
  return days.some(
    (day) => (day.tokenUsage.cacheReadReported ?? 0) > 0 || day.tokenUsage.cacheRead > 0,
  )
}

/** No requests and no tokens means there is nothing to chart. */
export function historyIsEmpty(days: UsageHistoryDay[]) {
  return !days.some(
    (day) => day.requests > 0 || day.tokenUsage.total > 0 || day.tokenUsage.missingRequests > 0,
  )
}

export function historyPartialDays(days: UsageHistoryDay[]) {
  return days.filter((day) => day.partial).length
}

export interface HistoryAmount {
  /** K/M/B abbreviation, the exact count below 1000, or an em dash when unknown. */
  text: string
  /** Exact count plus the coverage note, for a title attribute. */
  title: string
}

/** Format one token metric with the shared abbreviation and coverage rules. */
export function historyAmount(
  usage: TokenTotals | null | undefined,
  key: TokenMetric,
): HistoryAmount {
  const value = tokenValue(usage, key)
  const note = tokenCoverageLabel(usage, key)
  if (value == null) return { text: '—', title: note || '未上报' }
  const exact = value.toLocaleString('zh-CN')
  return {
    text: abbreviateCount(value) || exact,
    title: note ? `${exact} · ${note}` : exact,
  }
}

/** Plain counts such as requests use the same abbreviation. */
export function historyCount(value: number) {
  return abbreviateCount(value) || value.toLocaleString('zh-CN')
}

/** `MM-DD` axis label. The range already implies the year. */
export function historyTick(date: string) {
  return date.slice(5)
}

/** At most `limit` evenly spaced axis ticks, ending on the newest day. */
export function historyTicks(
  days: UsageHistoryDay[],
  limit = 6,
): { index: number; label: string }[] {
  if (!days.length) return []
  const step = Math.max(1, Math.ceil(days.length / limit))
  const ticks: { index: number; label: string }[] = []
  for (let index = days.length - 1; index >= 0; index -= step)
    ticks.push({ index, label: historyTick(days[index].date) })
  return ticks.reverse()
}

/** Bar index under a pointer, clamped to the available days. */
export function historyIndexAt(ratio: number, count: number) {
  if (!count) return null
  if (!Number.isFinite(ratio)) return 0
  return Math.min(count - 1, Math.max(0, Math.floor(ratio * count)))
}

/** Index after moving `step` bars from `current`. Starts at the newest bar. */
export function historyStep(current: number | null, step: number, count: number) {
  if (!count) return null
  if (current == null) return count - 1
  return Math.min(count - 1, Math.max(0, current + step))
}
