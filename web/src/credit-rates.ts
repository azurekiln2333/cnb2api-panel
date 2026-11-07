import type { CreditRateBase, CreditRateRow } from './types.ts'
import { abbreviateCount } from './format.ts'

export const RATE_UNIT = 'Credits / 百万 tokens'
export const INSUFFICIENT_LABEL = '数据不足（需至少 10 万 tokens）'
export const MISSING_LABEL = '未上报'
export const PARTIAL_LABEL = '部分上报'
export const SHARED_ORG_LABEL = '组织共享'
export const DEVIATION_HINT = '差异较大：组织内可能有其他消耗，或估算区间过短'

const plain = (value: number, digits: number) =>
  value.toLocaleString('zh-CN', { maximumFractionDigits: digits })

/** Credits per million tokens. Small prices keep more decimals. */
export function formatRate(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  const size = Math.abs(value)
  return plain(value, size >= 100 ? 1 : size >= 1 ? 2 : 4)
}

const hasOrg = (row: CreditRateBase) => !('org' in row) || !!(row as CreditRateRow).org

export function billingText(row: CreditRateBase | null | undefined) {
  if (!row) return INSUFFICIENT_LABEL
  if (row.billing) return formatRate(row.billing.rate)
  return hasOrg(row) ? INSUFFICIENT_LABEL : '未填写仓库'
}

export function reportedText(row: CreditRateBase | null | undefined) {
  if (row?.reported) return formatRate(row.reported.rate)
  return row?.reportedStatus === 'insufficient' ? INSUFFICIENT_LABEL : MISSING_LABEL
}

export function formatDeviation(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '—'
  const percent = value * 100
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`
}

export function deviationHint(value: number | null | undefined) {
  return value != null && Math.abs(value) > 0.2 ? DEVIATION_HINT : ''
}

export function tokensLeftText(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return ''
  return `约可用 ${abbreviateCount(value) || plain(value, 0)} tokens`
}

/** Compact secondary line for one account in the account list. */
export function accountRateLine(row: CreditRateRow | null | undefined) {
  if (!row) return ''
  const parts = [`单价 ${billingText(row)}`]
  if (row.reported)
    parts.push(
      `上报 ${formatRate(row.reported.rate)}${row.reported.partial ? `（${PARTIAL_LABEL}）` : ''}`,
    )
  if (row.sharedOrg) parts.push(SHARED_ORG_LABEL)
  return parts.join(' · ')
}
