// Compact Chinese magnitude suffixes for large counts. Two decimal places keep
// 23,019,762 readable as 23.02M without losing the order of magnitude.
const UNITS = [
  { limit: 1_000_000_000, divisor: 1_000_000_000, suffix: 'B' },
  { limit: 1_000_000, divisor: 1_000_000, suffix: 'M' },
  { limit: 1_000, divisor: 1_000, suffix: 'K' },
] as const

const round2 = (value: number) => Math.round(value * 100) / 100

/**
 * Abbreviate a count with the K (thousand), M (million) or B (billion) suffix.
 *
 * Returns an empty string for missing values and for counts below 1000, so the
 * caller renders nothing beside a small exact number. Larger values round to two
 * decimals first; when that rounding reaches 1000 the value promotes one unit, so
 * 999,999 renders as 1M instead of 1000K. An all-zero decimal part is dropped
 * because 1.00M reads better as 1M.
 */
export function abbreviateCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return ''
  const amount = Math.abs(value)
  if (amount < 1_000) return ''
  // Walk from the smallest unit upward and promote whenever rounding overflows.
  for (let index = 2; index >= 0; index--) {
    const unit = UNITS[index]
    const rounded = round2(amount / unit.divisor)
    if (rounded < 1_000) {
      const fixed = rounded.toFixed(2).replace(/\.?0+$/, '')
      return `${value < 0 ? '-' : ''}${fixed}${unit.suffix}`
    }
  }
  // Only reachable for magnitudes beyond the largest unit, which never happen
  // for token counts; the promotion loop above always resolves them to B.
  const rounded = round2(amount / 1_000_000_000)
  return `${value < 0 ? '-' : ''}${rounded.toFixed(2).replace(/\.?0+$/, '')}B`
}

/** Render a count with its abbreviation, or an em dash when nothing was reported. */
export function abbreviatedOrDash(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return abbreviateCount(value)
}
