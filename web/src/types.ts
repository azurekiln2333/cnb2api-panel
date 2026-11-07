export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  reportedRequests: number
  missingRequests: number
  partialRequests: number
  cacheReadReported?: number
  cacheWriteReported?: number
}
export type TokenMetric = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'total'
export type NullableTokenMetrics = Record<TokenMetric, number | null>
export interface UsageComparison {
  accountId: string
  accountName: string
  status: 'ok' | 'pending' | 'unsupported' | 'unavailable'
  message: string
  syncedAt: string | null
  bootedAt: string | null
  bootId: string | null
  startedAt: string | null
  workspaceTotals: NullableTokenMetrics | null
  local: TokenTotals | null
  // Inference probe share of `local`; the worker counts these requests too.
  probe?: ProbeUsage | null
  workspace: NullableTokenMetrics | null
  difference: NullableTokenMetrics | null
  upstream: UpstreamUsage | null
  supportsCredit: boolean
  schemaVersion?: number | null
}
// Real upstream counters reported by the workspace /usage endpoint, already
// diffed against the same baseline as the token comparison.
export interface UpstreamUsage {
  prompt: number | null
  completion: number | null
  requests: number
  errors: number
  partialRequests?: number | null
  credit: number | null
  cacheHit: number | null
  cacheMiss: number | null
  cacheWrite?: number | null
  coverage?: Partial<Record<UpstreamMetric, number | null>>
}
export type UpstreamMetric =
  'prompt' | 'completion' | 'credit' | 'cacheHit' | 'cacheMiss' | 'cacheWrite'
export interface Quota {
  org: string
  credits: { total: number; used: number; freeze: number }
  dev: { total: number; used: number; freeze: number }
  ci: { total: number; used: number }
  syncedAt: string
}
export interface QuotaProtectionState {
  suspended: boolean
  reason: 'disabled' | 'unknown' | 'sync-error' | 'invalid' | 'low' | 'override' | null
  remainingPercent: number | null
  thresholdPercent: number
}
export type UpstreamMode = 'inherit' | 'auto' | 'ide' | 'classic'
// What the worker actually used. 'legacy' means a successful inference response
// carried no applied mode, i.e. an old worker pinned to classic.
export type UpstreamModeApplied = 'ide' | 'classic' | 'legacy' | null
export interface Account {
  id: string
  name: string
  repo: string
  group: string
  endpoint: string
  weight: number
  priority: number
  enabled: boolean
  quotaProtectionOverride: boolean
  autoWake: boolean
  branch: string
  upstreamMode: UpstreamMode
  upstreamModeApplied: UpstreamModeApplied
  upstreamModeAppliedAt: string | null
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
  quotaProtection?: QuotaProtectionState
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
  inferenceProbe?: InferenceProbeResult | null
  probeUsage?: ProbeUsage
}
// Last optional real inference probe of an account.
export interface InferenceProbeResult {
  at: string
  ok: boolean
  status: number | null
  latencyMs: number | null
  model: string
  error: string
  usage: { prompt: number; completion: number } | null
}
export interface ProbeUsage {
  requests: number
  prompt: number
  completion: number
}
export interface Settings {
  strategy: 'weighted' | 'least-connections' | 'failover'
  sessionAffinity: boolean
  maxAttempts: number
  cooldownSeconds: number
  healthIntervalSeconds: number
  connectTimeoutSeconds: number
  idleTimeoutSeconds: number
  dshCompat: boolean
  claudeCodeCompat: boolean
  requestOverrides: { operations: Array<Record<string, unknown>> }
  upstreamHeaders: Record<string, string>
  registrationRelay: RegistrationRelayConfig
  quotaProtection: { enabled: boolean; thresholdPercent: number }
  inferenceProbe: { enabled: boolean; intervalMinutes: number }
}
export interface RegistrationRelayServer {
  id: string
  name: string
  origin: string
  enabled: boolean
}
export interface RegistrationRelayConfig {
  enabled: boolean
  servers: RegistrationRelayServer[]
}
export interface RegistrationRelayServerStatus extends RegistrationRelayServer {
  status: 'disabled' | 'idle' | 'pending' | 'success' | 'failed'
  pending: number
  failed: number
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string
}
export interface RegistrationRelayStatus {
  enabled: boolean
  servers: RegistrationRelayServerStatus[]
}
export interface ModelAccount {
  id: string
  name: string
}
export interface ModelInventoryEntry {
  id: string
  listed: boolean
  configuredAccounts: ModelAccount[]
  discoveredAccounts: ModelAccount[]
  eligibleAccounts: ModelAccount[]
}
export interface ModelInventory {
  models: ModelInventoryEntry[]
}
export interface RequestShape {
  fields: string[]
  messageCount: number
  messages: Array<{
    index: number
    role: string
    contentType: string
    length: number | null
  }>
  truncated: boolean
}
export interface RequestDiagnostics {
  received: RequestShape
  forwarded: RequestShape
  rules: Array<{
    name: string
    mode: string
    path: string
    outcome: 'applied' | 'unmatched' | 'skipped'
    count?: number
    changed?: boolean
  }>
  headers: {
    configured: string[]
    supported: boolean | null
    attempts?: Array<{ attempt: number; status: number; supported: boolean | null }>
  }
}
export interface HourBucket {
  at: string
  requests: number
  errors: number
  durationMs: number
  accounts: Record<string, number>
  tokenUsage?: TokenTotals
}
// One UTC+8 day from /api/usage/history. The daily rollup outlives the hourly window.
export interface UsageHistoryDay {
  date: string
  requests: number
  errors: number
  tokenUsage: TokenTotals
  // Rebuilt from hourly data saved before the rollup: the per-account split is unknown.
  partial: boolean
}
export interface UsageHistoryAccount {
  accountId: string
  // Empty for an account deleted after it recorded usage.
  name: string
  tokenUsage: TokenTotals
  requests: number
  // Some days in the range have no per-account token split for this account.
  partial: boolean
}
export interface UsageHistory {
  range: { days: number; from: string; to: string }
  days: UsageHistoryDay[]
  accounts: UsageHistoryAccount[]
  totals: {
    requests: number
    errors: number
    tokenUsage: TokenTotals
    partial: boolean
  }
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
  requestDiagnostics?: RequestDiagnostics
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
export interface LogQuery {
  offset: number
  q: string
  outcome: 'all' | 'success' | 'failure'
  kind: string
}
export interface LogPage {
  logs: LogEntry[]
  total: number
  limit: number
  offset: number
}
export type Page =
  'accounts' | 'overview' | 'models' | 'routing' | 'activity' | 'audit' | 'system' | 'access'
