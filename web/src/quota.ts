import type { Account, Quota } from './types'

export function formatRemainingQuotaPercent(credits: {
  total: number | null
  used: number | null
  freeze: number | null
}) {
  const { total, used, freeze } = credits
  if (total == null || total <= 0 || used == null || freeze == null) return '—'
  const remaining = Math.max(0, Math.min(total, total - used - freeze))
  return `${((remaining / total) * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
}

export function summarizeQuota(accounts: Account[]) {
  const snapshots = new Map<string, Quota>()
  const syncs = new Map<string, NonNullable<Account['quotaSync']>>()
  const configured = new Set<string>()
  for (const account of accounts.filter((item) => item.enabled)) {
    if (account.quota) {
      const previous = snapshots.get(account.quota.org)
      if (!previous || account.quota.syncedAt > previous.syncedAt)
        snapshots.set(account.quota.org, account.quota)
    }
    if (account.repo && account.hasPat) configured.add(account.repo.split('/')[0]!)
    if (account.repo && account.quotaSync) {
      const org = account.repo.split('/')[0]!
      const previous = syncs.get(org)
      if (!previous || account.quotaSync.lastAttemptAt > previous.lastAttemptAt)
        syncs.set(org, account.quotaSync)
    }
  }
  const quotas = [...snapshots.values()]
  const times = quotas.map((item) => item.syncedAt).sort()
  return {
    configured: configured.size,
    organizations: quotas.length,
    syncedAt: times[0] ?? null,
    syncing: [...syncs.values()].filter((item) => item.status === 'syncing').length,
    errors: [...syncs.values()].filter((item) => item.status === 'error').length,
    total: quotas.length ? quotas.reduce((sum, item) => sum + item.credits.total, 0) : null,
    used: quotas.length ? quotas.reduce((sum, item) => sum + item.credits.used, 0) : null,
    freeze: quotas.length ? quotas.reduce((sum, item) => sum + item.credits.freeze, 0) : null,
  }
}
