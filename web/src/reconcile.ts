import { abbreviateCount } from './format.ts'
import type { TokenMetric, TokenTotals, UpstreamMetric, UpstreamUsage } from './types.ts'
import { tokenCoverage, tokenValue, upstreamComplete, upstreamValue } from './usage.ts'

/** A single account's reconciliation inputs, taken from /api/usage/comparison. */
export interface ReconcileSource {
  accountId: string
  accountName: string
  status: 'ok' | 'pending' | 'unsupported' | 'unavailable'
  local: TokenTotals | null
  upstream: UpstreamUsage | null
}

type LocalField = TokenMetric | 'cacheMiss'
type UpstreamField = UpstreamMetric | 'total'
export interface ReconcileTotals {
  local: Record<LocalField, number | null>
  upstream: Record<UpstreamField, number | null>
  localComplete: Record<LocalField, boolean>
  upstreamComplete: Record<UpstreamField, boolean>
}

/**
 * Share of prompt tokens served from the prefix cache.
 *
 * Returns null when the workspace reported no cache counters at all, because a
 * missing denominator is not the same observation as a zero hit rate.
 */
export function cacheHitRate(hit: number | null | undefined, miss: number | null | undefined) {
  if (hit == null || miss == null) return null
  if (!Number.isFinite(hit) || !Number.isFinite(miss)) return null
  const total = hit + miss
  if (total <= 0) return null
  return hit / total
}

/** Render a cache hit rate as a percentage, or an em dash when unknown. */
export function formatHitRate(hit: number | null | undefined, miss: number | null | undefined) {
  const rate = cacheHitRate(hit, miss)
  if (rate == null) return '—'
  return `${(rate * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
}

/**
 * Credit spent per thousand upstream tokens.
 *
 * Only compare counters covering the same observation interval and attempts.
 * This ratio does not establish a provider price or the cause of credit use.
 */
export function creditPerThousand(
  credit: number | null | undefined,
  tokens: number | null | undefined,
) {
  if (credit == null || tokens == null) return null
  if (!Number.isFinite(credit) || !Number.isFinite(tokens)) return null
  if (tokens <= 0) return null
  return (credit * 1000) / tokens
}

/** Render credit with a magnitude suffix when large and significant digits when small. */
export function formatCredit(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const amount = Math.abs(value)
  if (amount >= 1_000) return abbreviateCount(value)
  if (amount >= 1) return value.toFixed(2).replace(/\.?0+$/, '')
  // Very small credits must keep significant digits instead of rounding to 0.
  return value.toPrecision(3)
}

/** Render credit per thousand tokens, or an em dash when there is no token data. */
export function formatCreditPerThousand(
  credit: number | null | undefined,
  tokens: number | null | undefined,
) {
  const value = creditPerThousand(credit, tokens)
  if (value == null) return '—'
  return formatCredit(value)
}

const LOCAL_FIELDS: LocalField[] = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'cacheMiss',
  'total',
]
const UPSTREAM_FIELDS: UpstreamField[] = [
  'prompt',
  'completion',
  'credit',
  'cacheHit',
  'cacheMiss',
  'cacheWrite',
  'total',
]

/** A derived miss requires complete matching input and cache-read coverage. */
export function localCacheMiss(local: TokenTotals | null | undefined) {
  if (
    !local ||
    tokenCoverage(local, 'input') !== 'complete' ||
    tokenCoverage(local, 'cacheRead') !== 'complete'
  )
    return null
  return Math.max(0, local.input - local.cacheRead)
}

const record = <K extends string, V>(keys: K[], value: V) =>
  Object.fromEntries(keys.map((key) => [key, value])) as Record<K, V>
const add = <K extends string>(target: Record<K, number | null>, key: K, value: number | null) => {
  if (value !== null) target[key] = (target[key] ?? 0) + value
}

/** Sum only synchronized windows; retain partial subtotals without inventing coverage. */
export function sumReconcile(sources: ReconcileSource[]): ReconcileTotals {
  const rows = syncedSources(sources)
  const totals: ReconcileTotals = {
    local: record(LOCAL_FIELDS, rows.length ? null : 0),
    upstream: record(UPSTREAM_FIELDS, rows.length ? null : 0),
    localComplete: record(LOCAL_FIELDS, rows.length > 0),
    upstreamComplete: record(UPSTREAM_FIELDS, rows.length > 0),
  }
  for (const { local, upstream } of rows) {
    for (const field of LOCAL_FIELDS) {
      const value =
        field === 'cacheMiss' ? localCacheMiss(local) : local ? tokenValue(local, field) : null
      const complete =
        field === 'cacheMiss'
          ? value !== null
          : !!local && ['empty', 'complete'].includes(tokenCoverage(local, field))
      add(totals.local, field, value)
      totals.localComplete[field] &&= complete
    }
    for (const field of UPSTREAM_FIELDS) {
      const prompt = upstreamValue(upstream, 'prompt')
      const completion = upstreamValue(upstream, 'completion')
      const value =
        field === 'total'
          ? prompt === null || completion === null
            ? null
            : prompt + completion
          : upstreamValue(upstream, field)
      add(totals.upstream, field, value)
      totals.upstreamComplete[field] &&=
        field === 'total'
          ? upstreamComplete(upstream, 'prompt', 'completion')
          : upstreamComplete(upstream, field)
    }
  }
  return totals
}

/** Accounts that returned a current snapshot, in the original order. */
export function syncedSources(sources: ReconcileSource[]) {
  return sources.filter((source) => source.status === 'ok' && source.upstream)
}
