export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  reportedRequests: number
  missingRequests: number
  partialRequests: number
}
export interface UsageComparison {
  accountId: string
  accountName: string
  status: 'ok' | 'pending' | 'unsupported' | 'unavailable'
  message: string
  syncedAt: string | null
  bootedAt: string | null
  bootId: string | null
  startedAt: string | null
  workspaceTotals:
    | (Omit<TokenTotals, 'cacheRead' | 'cacheWrite'> & {
        cacheRead: number | null
        cacheWrite: number | null
      })
    | null
  local: TokenTotals | null
  workspace:
    | (Omit<TokenTotals, 'cacheRead' | 'cacheWrite'> & {
        cacheRead: number | null
        cacheWrite: number | null
      })
    | null
  difference: {
    input: number
    output: number
    cacheRead: number | null
    cacheWrite: number | null
    total: number
  } | null
}
export interface Quota {
  org: string
  credits: { total: number; used: number; freeze: number }
  dev: { total: number; used: number; freeze: number }
  ci: { total: number; used: number }
  syncedAt: string
}
export interface Account {
  id: string
  name: string
  repo: string
  group: string
  endpoint: string
  weight: number
  priority: number
  enabled: boolean
  autoWake: boolean
  branch: string
  models: string[]
  discoveredModels: string[]
  status: 'pending' | 'healthy' | 'unhealthy'
  checkedAt: string | null
  registeredAt: string | null
  cooldownUntil: string | null
  failures: number
  latencyMs: number | null
  lastError: string
  quota: Quota | null
  quotaSync: {
    status: 'syncing' | 'ok' | 'error'
    lastAttemptAt: string
    nextAttemptAt: string | null
    error: string
  } | null
  requests: number
  errors: number
  activeRequests: number
  hasProxyKey: boolean
  hasPat: boolean
  createdAt: string
  updatedAt: string
  lastWakeAt: string | null
  tokenUsage: TokenTotals
}
export interface Settings {
  strategy: 'weighted' | 'least-connections' | 'failover'
  sessionAffinity: boolean
  maxAttempts: number
  cooldownSeconds: number
  healthIntervalSeconds: number
  connectTimeoutSeconds: number
  idleTimeoutSeconds: number
}
export interface HourBucket {
  at: string
  requests: number
  errors: number
  durationMs: number
  accounts: Record<string, number>
  tokenUsage?: TokenTotals
}
export interface Stats {
  total: number
  ready: number
  cooling: number
  requests: number
  errors: number
  successRate: number | null
  remainingCredits: number | null
  quotaOrganizations: number
  averageDurationMs: number | null
  activeRequests: number
  tokenUsage: { today: TokenTotals; total: TokenTotals; startedAt: string }
}
export interface LogEntry {
  id: string
  at: string
  kind: 'request' | 'audit' | 'account' | 'register' | 'health' | 'failover' | 'wake'
  accountId: string | null
  accountName: string
  status: number
  message: string
  action?: string
  actor?: { name: string; provider: string; subject?: string }
  ip?: string
  requestId?: string
  model?: string
  path?: string
  attempts?: number
  durationMs?: number
  method?: string
  stream?: boolean
  requestBytes?: number
  responseBytes?: number
  firstByteMs?: number | null
  upstreamEndpoint?: string
  initialMessage?: { role: 'user'; text: string; truncated: boolean }
  tokenUsage?: TokenTotals
}
export interface Overview {
  accounts: Account[]
  settings: Settings
  hourly: HourBucket[]
  stats: Stats
}
export interface SsoSettings {
  ssoEnabled: boolean
  keyLoginEnabled: boolean
  issuer: string
  clientId: string
  hasClientSecret: boolean
  scope: string
  providerName: string
  allowedSubjects: string[]
  allowedEmails: string[]
  callbackUrl: string
}
export interface AuthConfig {
  keyLoginEnabled: boolean
  sso: { enabled: boolean; providerName: string; loginUrl: string }
}
export interface SessionUser {
  name: string
  email: string
  picture: string
  provider: 'key' | 'oidc'
}
export type LogChannel = 'requests' | 'audit' | 'system'
export type Page = 'accounts' | 'overview' | 'routing' | 'activity' | 'audit' | 'system' | 'access'
