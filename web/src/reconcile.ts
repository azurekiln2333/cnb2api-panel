import { abbreviateCount } from './format.ts'
import type { TokenTotals, UpstreamUsage } from './types.ts'

/** A single account's reconciliation inputs, taken from /api/usage/comparison. */
export interface ReconcileSource {
  accountId: string
  accountName: string
  status: 'ok' | 'pending' | 'unsupported' | 'unavailable'
  local: TokenTotals | null
  upstream: UpstreamUsage | null
}

export interface ReconcileTotals {
  local: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cacheMiss: number
    total: number
  }
  upstream: {
    prompt: number
    completion: number
    credit: number
    cacheHit: number
    cacheMiss: number
    total: number
  }
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
 * This is the number that explains a quota burning faster than the token count:
 * a cache miss costs far more credit per token than a cache hit.
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

const emptyTotals = (): ReconcileTotals => ({
  local: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheMiss: 0, total: 0 },
  upstream: { prompt: 0, completion: 0, credit: 0, cacheHit: 0, cacheMiss: 0, total: 0 },
})

/** Local cache misses: prompt tokens the workspace did not serve from cache. */
export function localCacheMiss(local: TokenTotals | null | undefined) {
  if (!local) return 0
  return Math.max(0, local.input - local.cacheRead)
}

/**
 * Sum every synced account into one row, so the panel can show a pool-wide
 * total next to the per-account breakdown.
 */
export function sumReconcile(sources: ReconcileSource[]): ReconcileTotals {
  const totals = emptyTotals()
  for (const source of sources) {
    const local = source.local
    if (local) {
      totals.local.input += local.input
      totals.local.output += local.output
      totals.local.cacheRead += local.cacheRead
      totals.local.cacheWrite += local.cacheWrite
      totals.local.cacheMiss += localCacheMiss(local)
      totals.local.total += local.total
    }
    const upstream = source.upstream
    if (upstream) {
      totals.upstream.prompt += upstream.prompt
      totals.upstream.completion += upstream.completion
      totals.upstream.credit += upstream.credit
      totals.upstream.cacheHit += upstream.cacheHit
      totals.upstream.cacheMiss += upstream.cacheMiss
      totals.upstream.total += upstream.prompt + upstream.completion
    }
  }
  return totals
}

/** Accounts that actually returned a workspace snapshot, in the original order. */
export function syncedSources(sources: ReconcileSource[]) {
  return sources.filter((source) => source.status === 'ok' && source.upstream)
}
