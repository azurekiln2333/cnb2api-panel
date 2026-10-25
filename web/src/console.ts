import { computed, ref } from 'vue'
import { api, ApiError, type ApiDiagnostics } from './api'
import type { Account, LogChannel, LogEntry, Overview, Settings } from './types'

const overview = ref<Overview | null>(null)
const logs = ref<LogEntry[]>([])
const logStreams = { requests: logs, audit: ref<LogEntry[]>([]), system: ref<LogEntry[]>([]) }
const loading = ref(false)
const refreshError = ref('')
const refreshDiagnostics = ref<ApiDiagnostics | null>(null)
const lastUpdated = ref<Date | null>(null)
const busy = ref(new Set<string>())
const toasts = ref<{ id: number; text: string; error: boolean; diagnostics?: ApiDiagnostics }[]>([])
const registration = ref<{ account: Account; token: string } | null>(null)
let notificationId = 0
let refreshPromise: Promise<void> | null = null
const logsPromises: Partial<Record<LogChannel, Promise<void>>> = {}
let sessionGeneration = 0

function reset() {
  sessionGeneration++
  overview.value = null
  logs.value = []
  logStreams.audit.value = []
  logStreams.system.value = []
  registration.value = null
  lastUpdated.value = null
  refreshError.value = ''
  refreshDiagnostics.value = null
  loading.value = false
  refreshPromise = null
  for (const channel of ['requests', 'audit', 'system'] as const) delete logsPromises[channel]
}

export function notify(text: string, error = false, diagnostics?: ApiDiagnostics) {
  const id = ++notificationId
  toasts.value.push({ id, text, error, diagnostics })
  window.setTimeout(
    () => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    },
    diagnostics ? 15000 : 4500,
  )
}

async function refresh() {
  if (refreshPromise) return refreshPromise
  const generation = sessionGeneration
  loading.value = true
  refreshPromise = (async () => {
    try {
      const data = await api<Overview>('/overview')
      if (generation !== sessionGeneration) return
      if (!data || !Array.isArray(data.accounts) || !data.stats || !data.settings)
        throw new Error('面板返回的数据格式不正确')
      overview.value = data
      lastUpdated.value = new Date()
      refreshError.value = ''
      refreshDiagnostics.value = null
    } catch (error) {
      if (generation !== sessionGeneration) return
      refreshError.value = error instanceof Error ? error.message : '数据加载失败'
      refreshDiagnostics.value = error instanceof ApiError ? (error.diagnostics ?? null) : null
    } finally {
      if (generation === sessionGeneration) {
        loading.value = false
        refreshPromise = null
      }
    }
  })()
  return refreshPromise
}

async function refreshLogs(channel: LogChannel = 'requests') {
  if (logsPromises[channel]) return logsPromises[channel]
  const generation = sessionGeneration
  logsPromises[channel] = (async () => {
    try {
      const result = await api<{ logs: LogEntry[] }>(
        channel === 'requests' ? '/logs' : `/logs/${channel}`,
      )
      if (generation === sessionGeneration) logStreams[channel].value = result.logs
    } catch (error) {
      if (generation === sessionGeneration)
        notify(
          error instanceof Error ? error.message : '日志加载失败',
          true,
          error instanceof ApiError ? error.diagnostics : undefined,
        )
    } finally {
      if (generation === sessionGeneration) delete logsPromises[channel]
    }
  })()
  return logsPromises[channel]
}

async function action(id: string, operation: 'probe' | 'quota' | 'wake') {
  if (busy.value.has(id)) return
  busy.value.add(id)
  try {
    const result = await api<{ account?: Account }>(`/accounts/${id}/${operation}`, 'POST', {})
    if (operation === 'probe') {
      const healthy = result.account?.status === 'healthy'
      notify(
        healthy ? '探活通过，工作区已就绪' : result.account?.lastError || '工作区尚未注册地址',
        !healthy,
      )
    } else notify(operation === 'quota' ? '组织额度已同步' : '已发起唤醒，工作区启动后会自动注册')
    await refresh()
  } catch (error) {
    notify(
      error instanceof Error ? error.message : '操作失败',
      true,
      error instanceof ApiError ? error.diagnostics : undefined,
    )
  } finally {
    busy.value.delete(id)
  }
}

async function setEnabled(account: Account, enabled: boolean) {
  busy.value.add(account.id)
  try {
    await api(`/accounts/${account.id}`, 'PATCH', { enabled })
    await refresh()
    notify(enabled ? '账号已启用' : '账号已暂停分配新请求')
  } catch (error) {
    notify(
      error instanceof Error ? error.message : '状态更新失败',
      true,
      error instanceof ApiError ? error.diagnostics : undefined,
    )
  } finally {
    busy.value.delete(account.id)
  }
}

export function accountState(a: Account) {
  if (!a.enabled) return 'disabled'
  if (a.cooldownUntil && Date.parse(a.cooldownUntil) > Date.now()) return 'cooling'
  if (a.status === 'healthy' && a.endpoint) return 'healthy'
  if (a.status === 'unhealthy') return 'offline'
  return 'pending'
}
export const stateLabels: Record<string, string> = {
  healthy: '可用',
  cooling: '冷却中',
  offline: '离线',
  pending: '待接入',
  disabled: '已停用',
}
export const strategyLabels: Record<Settings['strategy'], string> = {
  weighted: '加权轮询',
  'least-connections': '最少连接',
  failover: '优先故障转移',
}
export const number = (n: number | null | undefined, digits = 0) =>
  n == null ? '—' : n.toLocaleString('zh-CN', { maximumFractionDigits: digits })
export const compact = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(1)}万` : number(n))
export const time = (value: string | null, full = false) =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        ...(full ? ({ month: '2-digit', day: '2-digit' } as const) : {}),
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '尚未探活'
export const quotaPercent = (a: Account) =>
  a.quota?.credits.total
    ? Math.min(100, ((a.quota.credits.used + a.quota.credits.freeze) / a.quota.credits.total) * 100)
    : 0

export async function copy(text: string) {
  try {
    let copied = false
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text)
        copied = true
      } catch {
        // Browsers may deny the Clipboard API while still allowing a user-initiated copy.
      }
    }
    if (!copied) {
      const previousFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
      const previousInput =
        previousFocus instanceof HTMLInputElement || previousFocus instanceof HTMLTextAreaElement
          ? previousFocus
          : null
      const selection = previousInput
        ? {
            start: previousInput.selectionStart,
            end: previousInput.selectionEnd,
            direction: previousInput.selectionDirection,
          }
        : null
      const input = document.createElement('textarea')
      input.value = text
      input.readOnly = true
      input.tabIndex = -1
      input.style.position = 'fixed'
      input.style.top = '0'
      input.style.left = '0'
      input.style.opacity = '0'
      // A modal makes the rest of the document inert, including a textarea in body.
      const dialogs = document.querySelectorAll('dialog[open]')
      const container =
        previousFocus?.closest('dialog[open]') || dialogs.item(dialogs.length - 1) || document.body
      try {
        container.appendChild(input)
        input.focus({ preventScroll: true })
        input.select()
        input.setSelectionRange(0, text.length)
        copied = document.execCommand('copy')
      } finally {
        input.remove()
        previousFocus?.focus({ preventScroll: true })
        if (previousInput && selection?.start != null && selection.end != null)
          previousInput.setSelectionRange(
            selection.start,
            selection.end,
            selection.direction ?? undefined,
          )
      }
      if (!copied) throw new Error('clipboard unavailable')
    }
    notify('已复制到剪贴板')
  } catch {
    notify('复制失败，请手动选择内容复制', true)
  }
}

export function useConsole() {
  return {
    overview,
    logs,
    logStreams,
    loading,
    refreshError,
    refreshDiagnostics,
    lastUpdated,
    busy,
    toasts,
    registration,
    accounts: computed(() => overview.value?.accounts ?? []),
    refresh,
    refreshLogs,
    reset,
    action,
    setEnabled,
  }
}
