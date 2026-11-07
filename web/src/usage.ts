import type { TokenMetric, TokenTotals, UpstreamMetric, UpstreamUsage } from './types.ts'

export type CoverageState = 'empty' | 'complete' | 'partial' | 'unknown'

/** Coverage counts inference attempts, including retries, rather than client requests. */
export function tokenCoverage(
  usage: TokenTotals | null | undefined,
  key: TokenMetric,
): CoverageState {
  if (!usage) return 'empty'
  const attempts = usage.reportedRequests + usage.missingRequests
  const value = usage[key]
  if (
    !attempts &&
    !usage.input &&
    !usage.output &&
    !usage.cacheRead &&
    !usage.cacheWrite &&
    !usage.total
  )
    return 'empty'
  const reported =
    key === 'cacheRead'
      ? usage.cacheReadReported
      : key === 'cacheWrite'
        ? usage.cacheWriteReported
        : usage.reportedRequests
  if (!reported) return value > 0 ? 'partial' : 'unknown'
  return reported === attempts && !usage.partialRequests ? 'complete' : 'partial'
}

export function tokenValue(usage: TokenTotals | null | undefined, key: TokenMetric) {
  return tokenCoverage(usage, key) === 'unknown' ? null : (usage?.[key] ?? 0)
}

export function tokenCoverageLabel(usage: TokenTotals | null | undefined, key: TokenMetric) {
  const state = tokenCoverage(usage, key)
  if (state === 'unknown') return '未上报'
  if (state !== 'partial') return ''
  const count =
    key === 'cacheRead'
      ? usage?.cacheReadReported
      : key === 'cacheWrite'
        ? usage?.cacheWriteReported
        : usage?.reportedRequests
  return count
    ? `部分上报（${count}/${(usage?.reportedRequests ?? 0) + (usage?.missingRequests ?? 0)} 次尝试）`
    : '覆盖范围未知'
}

export function upstreamComplete(
  upstream: UpstreamUsage | null | undefined,
  ...keys: UpstreamMetric[]
) {
  return (
    !!upstream &&
    upstream.partialRequests === 0 &&
    keys.every(
      (key) =>
        upstream[key] != null &&
        upstream.coverage?.[key] != null &&
        upstream.coverage[key] === upstream.requests &&
        (upstream.requests > 0 || upstream[key] === 0),
    )
  )
}

export function upstreamValue(upstream: UpstreamUsage | null | undefined, key: UpstreamMetric) {
  const value = upstream?.[key]
  if (value == null) return null
  if (upstream?.requests === 0 || (upstream?.coverage?.[key] ?? 0) > 0 || value > 0) return value
  return null
}
