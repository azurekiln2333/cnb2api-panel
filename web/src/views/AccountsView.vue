<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  Plus,
  RefreshCw,
  Search,
  ChevronDown,
  ArrowUpRight,
  ArrowDownUp,
  UsersRound,
  CircleCheck,
  Activity,
  Wallet,
  MoreHorizontal,
  Pencil,
  Radio,
  Copy,
  Server,
  KeyRound,
  Trash2,
  Power,
  LoaderCircle,
  Check,
  X,
  ArrowRight,
  Zap,
  Layers,
  FilterX,
  Waypoints,
  Coins,
} from '@lucide/vue'
import { api } from '../api'
import {
  useConsole,
  accountState,
  number,
  compact,
  quotaPercent,
  quotaProtectionMessage,
  time,
  copy,
  notify,
  strategyLabels,
} from '../console'
import type { Account, Page } from '../types'
import { formatRemainingQuotaPercent, summarizeQuota } from '../quota'
import AccountDialog from '../components/AccountDialog.vue'
import StatusBadge from '../components/StatusBadge.vue'
import ModalShell from '../components/ModalShell.vue'

const emit = defineEmits<{ navigate: [page: Page] }>()
const { overview, accounts, loading, busy, registration, refresh, action, setEnabled } =
  useConsole()
const search = ref('')
const tab = ref('all')
const group = ref('all')
const selected = ref(new Set<string>())
const showEditor = ref(false)
const editingAccount = ref<Account | null>(null)
const managing = ref<Account | null>(null)
const confirming = ref<{ action: 'delete' | 'rotate'; account: Account } | null>(null)
const confirmingBusy = ref(false)
const page = ref(1)
const sortBy = ref<'created' | 'name'>('created')
const groups = computed(() => [...new Set(accounts.value.map((a) => a.group))])
const credits = computed(() => summarizeQuota(accounts.value))
const tabs = computed(() => [
  { id: 'all', label: '全部账号', count: accounts.value.length },
  {
    id: 'healthy',
    label: '可用',
    count: accounts.value.filter((a) => accountState(a) === 'healthy').length,
  },
  {
    id: 'attention',
    label: '需关注',
    count: accounts.value.filter((a) =>
      ['pending', 'offline', 'cooling', 'quota'].includes(accountState(a)),
    ).length,
  },
  { id: 'disabled', label: '已停用', count: accounts.value.filter((a) => !a.enabled).length },
])
const filtered = computed(() =>
  accounts.value
    .filter((a) => {
      const matches = `${a.name} ${a.repo} ${a.endpoint}`
        .toLowerCase()
        .includes(search.value.toLowerCase())
      const state = accountState(a)
      return (
        matches &&
        (group.value === 'all' || a.group === group.value) &&
        (tab.value === 'all' ||
          tab.value === state ||
          (tab.value === 'attention' && ['pending', 'offline', 'cooling', 'quota'].includes(state)))
      )
    })
    .sort((a, b) =>
      sortBy.value === 'name'
        ? a.name.localeCompare(b.name, 'zh-CN')
        : b.createdAt.localeCompare(a.createdAt),
    ),
)
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 10)))
const rows = computed(() => filtered.value.slice((page.value - 1) * 10, page.value * 10))
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every((a) => selected.value.has(a.id)),
)
watch([search, group, tab], () => {
  page.value = 1
  selected.value.clear()
})
watch(accounts, () => {
  selected.value = new Set(
    [...selected.value].filter((id) => accounts.value.some((a) => a.id === id)),
  )
  page.value = Math.min(page.value, pages.value)
})
const totalToday = (id: string) => {
  const today = Math.floor((Date.now() + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
  return (
    overview.value?.hourly
      .filter((b) => Date.parse(b.at) >= today)
      .reduce((n, b) => n + (b.accounts[id] || 0), 0) ?? 0
  )
}
const rowOps = ref<Record<string, 'probe' | 'wake' | 'quota' | undefined>>({})
const probingAll = ref(false)
const probeCandidates = computed(() =>
  accounts.value.filter((a) => a.enabled && a.endpoint && !busy.value.has(a.id)),
)
const wakeBlockedReason = (a: Account) =>
  !a.repo ? '需先填写 CNB 仓库路径' : !a.hasPat ? '需先配置 CNB 个人令牌' : ''
async function rowAction(id: string, operation: 'probe' | 'wake' | 'quota') {
  if (busy.value.has(id)) return
  rowOps.value[id] = operation
  try {
    await action(id, operation)
  } finally {
    if (rowOps.value[id] === operation) delete rowOps.value[id]
  }
}
function edit(account: Account | null = null) {
  editingAccount.value = account
  showEditor.value = true
  managing.value = null
}
function toggleAll() {
  if (allSelected.value) rows.value.forEach((a) => selected.value.delete(a.id))
  else rows.value.forEach((a) => selected.value.add(a.id))
}
function clearFilters() {
  search.value = ''
  tab.value = 'all'
  group.value = 'all'
}
function manageEnable() {
  if (!managing.value) return
  void setEnabled(managing.value, !managing.value.enabled)
  managing.value = null
}
function manageAction(operation: 'quota' | 'wake') {
  if (!managing.value) return
  void action(managing.value.id, operation)
  managing.value = null
}
function confirmAction(operation: 'rotate' | 'delete') {
  if (!managing.value) return
  confirming.value = { action: operation, account: managing.value }
  managing.value = null
}
async function probeAll() {
  if (probingAll.value || !probeCandidates.value.length) return
  const candidates = [...probeCandidates.value]
  probingAll.value = true
  try {
    await Promise.all(candidates.map((a) => rowAction(a.id, 'probe')))
  } finally {
    probingAll.value = false
  }
}
async function batch(enabled: boolean) {
  await Promise.all(
    accounts.value.filter((a) => selected.value.has(a.id)).map((a) => setEnabled(a, enabled)),
  )
  selected.value.clear()
}
async function confirm() {
  if (!confirming.value) return
  const { account, action: operation } = confirming.value
  confirmingBusy.value = true
  try {
    if (operation === 'delete') {
      await api(`/accounts/${account.id}`, 'DELETE')
      notify('账号已移除')
      await refresh()
    } else {
      const data = await api<{ registrationToken: string }>(
        `/accounts/${account.id}/registration`,
        'POST',
        {},
      )
      registration.value = { account, token: data.registrationToken }
    }
    confirming.value = null
  } catch (error) {
    notify(error instanceof Error ? error.message : '操作失败', true)
  } finally {
    confirmingBusy.value = false
  }
}
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />ACCOUNT POOL</div>
      <h1>
        账号池<span class="heading-count">{{ accounts.length }}</span>
      </h1>
      <p>把多个 CNB 工作区连接起来，让请求总有去处。</p>
    </div>
    <div class="heading-actions">
      <button class="button token-shortcut" @click="emit('navigate', 'overview')">
        <Coins :size="15" />Token统计
      </button>
      <button
        class="button probe-all"
        :disabled="probingAll || !probeCandidates.length"
        @click="probeAll"
      >
        <RefreshCw :size="15" :class="{ spin: probingAll }" />全部探活</button
      ><button class="button primary" @click="edit()"><Plus :size="17" />接入账号</button>
    </div>
  </div>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-top">
        <span>已接入账号</span><span class="stat-icon blue"><UsersRound :size="17" /></span>
      </div>
      <div class="stat-value">{{ number(overview?.stats.total) }}<small>个</small></div>
      <div class="stat-bottom">
        <span class="stat-dots"><i /><i /><i /></span>独立工作区 · 统一入口
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>当前可用</span><span class="stat-icon green"><CircleCheck :size="17" /></span>
      </div>
      <div class="stat-value">
        {{ number(overview?.stats.ready) }}<small>/ {{ accounts.length }}</small
        ><span class="stat-tag" :class="{ warning: !overview?.stats.ready }">{{
          overview?.stats.ready ? '可以接收请求' : '等待工作区就绪'
        }}</span>
      </div>
      <div class="stat-bottom">
        <i class="status-dot" :class="{ green: overview?.stats.ready }" />{{
          overview?.stats.cooling
            ? `${overview.stats.cooling} 个账号冷却中`
            : '探活通过后自动加入路由'
        }}
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>今日请求</span><span class="stat-icon violet"><Activity :size="17" /></span>
      </div>
      <div class="stat-value">{{ compact(overview?.stats.requests ?? 0) }}<small>次</small></div>
      <div class="stat-bottom">
        <span v-if="overview?.stats.successRate != null" class="success-text"
          >{{ number(overview.stats.successRate, 1) }}% 成功率</span
        ><span v-else>等待第一条请求</span><span class="stat-meta">UTC+8</span>
      </div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>组织剩余额度</span><span class="stat-icon amber"><Wallet :size="17" /></span>
      </div>
      <div class="stat-value">
        {{ number(overview?.stats.remainingCredits, 1) }}<small>Credits</small>
        <small data-testid="accounts-credits-percent">{{
          formatRemainingQuotaPercent(credits)
        }}</small>
      </div>
      <div class="stat-bottom">
        <span>{{
          overview?.stats.quotaOrganizations
            ? `已同步 ${overview.stats.quotaOrganizations} 个组织 · 已扣除冻结额度`
            : credits.configured
              ? '等待后台自动同步组织额度'
              : '配置仓库和个人令牌后自动同步'
        }}</span
        ><ArrowUpRight :size="13" />
      </div>
      <div class="quota-card-status" :class="{ error: credits.errors > 0 }">
        {{
          credits.errors
            ? `${credits.errors} 个组织同步失败，保留上次额度`
            : credits.syncing
              ? '后台正在同步额度…'
              : '后台每60秒同步 · 同组织不重复累计'
        }}
        <span v-if="credits.syncedAt">额度更新于 {{ time(credits.syncedAt, true) }}</span>
      </div>
    </div>
  </div>
  <section class="pool-panel">
    <div class="pool-panel-header">
      <div class="pool-tabs" role="tablist" aria-label="按账号状态筛选">
        <button
          v-for="item in tabs"
          :key="item.id"
          role="tab"
          :aria-selected="tab === item.id"
          :class="{ active: tab === item.id }"
          @click="tab = item.id"
        >
          {{ item.label }}<span>{{ item.count }}</span>
        </button>
      </div>
      <button class="quiet-button route-shortcut" @click="emit('navigate', 'routing')">
        <span class="status-dot green" />{{
          overview ? strategyLabels[overview.settings.strategy] : '自动路由'
        }}<ChevronDown :size="13" />
      </button>
    </div>
    <div class="table-toolbar">
      <div class="search-field">
        <Search :size="16" /><input
          id="account-search"
          v-model="search"
          placeholder="搜索账号、仓库或域名…"
          aria-label="搜索账号"
        /><button v-if="search" class="icon-button" aria-label="清空搜索" @click="search = ''">
          <X :size="13" />
        </button>
      </div>
      <div class="toolbar-filters">
        <label class="select-wrap"
          ><Layers :size="14" /><select v-model="group" aria-label="账号分组">
            <option value="all">全部分组</option>
            <option v-for="g in groups" :key="g" :value="g">{{ g }}</option></select
          ><ChevronDown :size="12" /></label
        ><button
          class="button sort-button"
          :title="sortBy === 'created' ? '按名称排序' : '按接入时间排序'"
          @click="sortBy = sortBy === 'created' ? 'name' : 'created'"
        >
          <ArrowDownUp :size="14" /><span>{{
            sortBy === 'created' ? '最近接入' : '账号名称'
          }}</span></button
        ><button
          class="icon-button table-refresh"
          aria-label="刷新账号列表"
          :disabled="loading"
          @click="refresh"
        >
          <RefreshCw :size="15" :class="{ spin: loading }" />
        </button>
      </div>
    </div>
    <div v-if="selected.size" class="batch-bar">
      <span><Check :size="14" />已选择 {{ selected.size }} 个账号</span
      ><button @click="batch(true)">启用所选</button><button @click="batch(false)">停用所选</button
      ><button class="batch-cancel" @click="selected.clear()">取消选择</button>
    </div>
    <div v-if="rows.length" class="table-scroll">
      <table class="account-table">
        <thead>
          <tr>
            <th class="checkbox-cell">
              <input
                type="checkbox"
                :checked="allSelected"
                aria-label="选择当前页全部账号"
                @change="toggleAll"
              />
            </th>
            <th>账号 / 工作区</th>
            <th>运行状态</th>
            <th>组织额度<span class="th-note">Credits</span></th>
            <th>今日请求</th>
            <th>权重 / 优先级</th>
            <th class="right-align">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(account, index) in rows"
            :key="account.id"
            :class="{
              selected: selected.has(account.id),
              muted: !account.enabled || account.quotaProtection?.suspended,
            }"
          >
            <td class="checkbox-cell">
              <input
                type="checkbox"
                :checked="selected.has(account.id)"
                :aria-label="`选择${account.name}`"
                @change="
                  selected.has(account.id) ? selected.delete(account.id) : selected.add(account.id)
                "
              />
            </td>
            <td>
              <div class="account-identity">
                <span class="account-avatar" :class="`avatar-${index % 5}`">{{
                  account.name.slice(0, 1).toUpperCase()
                }}</span>
                <div>
                  <button class="account-name" @click="edit(account)">
                    {{ account.name }}<span class="group-tag">{{ account.group }}</span>
                  </button>
                  <a
                    class="account-repo account-repo-link"
                    :href="account.repo ? `https://cnb.cool/${account.repo}` : 'https://cnb.cool/'"
                    target="_blank"
                    rel="noopener noreferrer"
                    :aria-label="account.repo ? `打开 CNB 仓库 ${account.repo}` : '打开 CNB 首页'"
                    :title="account.repo ? `前往 CNB：${account.repo}` : '前往 CNB 首页'"
                  >
                    <Server :size="11" /><span>{{ account.repo || 'CNB 首页' }}</span
                    ><ArrowUpRight :size="11" />
                  </a>
                </div>
              </div>
              <button
                class="account-endpoint"
                :title="account.endpoint || '等待云机自注册'"
                :disabled="!account.endpoint"
                @click="copy(account.endpoint)"
              >
                <span class="endpoint-prefix">↳</span
                ><span>{{
                  account.endpoint
                    ? account.endpoint.replace('https://', '').replace('http://', '')
                    : '等待工作区自注册'
                }}</span
                ><Copy v-if="account.endpoint" :size="10" />
              </button>
            </td>
            <td :data-testid="`health-${account.id}`">
              <StatusBadge :account="account" />
              <template v-if="accountState(account) === 'quota'">
                <div class="cell-secondary account-health-detail">
                  {{ quotaProtectionMessage(account) }}
                </div>
              </template>
              <template v-else-if="accountState(account) === 'cooling'">
                <div class="cell-secondary account-health-detail account-health-error">
                  {{ account.lastError || '工作区请求失败，暂时停止分配' }}
                </div>
                <div class="cell-secondary account-health-detail">
                  冷却至 {{ time(account.cooldownUntil) }} · 到期后按探活周期重试
                </div>
              </template>
              <div
                v-else
                class="cell-secondary account-health-detail"
                :title="account.lastError || `最近探活 ${time(account.checkedAt, true)}`"
              >
                <span v-if="accountState(account) === 'healthy'" class="latency-bars"
                  ><i /><i /><i /></span
                >{{
                  accountState(account) === 'healthy'
                    ? `${number(account.latencyMs)} ms`
                    : account.enabled
                      ? account.lastError || '等待首次探活'
                      : '不再分配新请求'
                }}
              </div>
            </td>
            <td class="quota-cell" :data-testid="`quota-${account.id}`">
              <template v-if="account.quota"
                ><div class="quota-numbers">
                  <strong>{{
                    number(
                      Math.max(
                        0,
                        account.quota.credits.total -
                          account.quota.credits.used -
                          account.quota.credits.freeze,
                      ),
                      1,
                    )
                  }}</strong
                  ><span>/ {{ number(account.quota.credits.total) }}</span>
                  <span class="quota-percentage">{{
                    formatRemainingQuotaPercent(account.quota.credits)
                  }}</span>
                </div>
                <div class="quota-track">
                  <i
                    :class="{ low: quotaPercent(account) > 85 }"
                    :style="{ width: `${100 - quotaPercent(account)}%` }"
                  />
                </div>
                <span
                  class="quota-updated"
                  :title="`同步于 ${time(account.quota.syncedAt, true)}，同组织共享`"
                  >上次成功 {{ time(account.quota.syncedAt, true) }} · 组织共享</span
                ></template
              ><template v-else
                ><span class="unsynced">— <small>未同步</small></span
                ><button
                  v-if="account.hasPat && account.repo"
                  class="text-link small-link"
                  :disabled="busy.has(account.id)"
                  @click="rowAction(account.id, 'quota')"
                >
                  同步额度<ArrowUpRight :size="11" /></button
                ><small v-else class="cell-secondary">需要组织读取权限</small></template
              >
              <small
                v-if="account.enabled && account.quotaProtection?.suspended"
                class="quota-sync-state error"
              >
                {{ quotaProtectionMessage(account) }}
              </small>
              <small v-if="account.quotaSync?.status === 'syncing'" class="quota-sync-state"
                >后台同步中…</small
              >
              <small
                v-else-if="account.quotaSync?.status === 'error'"
                class="quota-sync-state error"
                :title="account.quotaSync.error"
                >同步失败{{ account.quota ? '，保留上次额度' : ''
                }}<span v-if="account.quotaSync.nextAttemptAt">
                  · {{ time(account.quotaSync.nextAttemptAt) }} 重试</span
                ><span class="quota-error-detail">{{ account.quotaSync.error }}</span></small
              >
              <small
                v-else-if="account.enabled && account.repo && account.hasPat"
                class="quota-sync-state"
                >{{
                  account.quotaSync?.nextAttemptAt
                    ? `下次同步 ${time(account.quotaSync.nextAttemptAt)}`
                    : '等待自动同步'
                }}</small
              >
            </td>
            <td>
              <span class="request-number">{{ number(totalToday(account.id)) }}</span>
              <div class="cell-secondary">{{ account.activeRequests }} 个进行中</div>
            </td>
            <td>
              <div class="weight-cell">
                <span class="weight-number">{{ account.weight }}</span
                ><span>/</span><span class="priority-number">P{{ account.priority }}</span>
              </div>
              <div class="cell-secondary">
                {{ account.models.length ? `${account.models.length} 个指定模型` : '全部模型' }}
              </div>
            </td>
            <td>
              <div class="row-actions">
                <button
                  class="icon-button"
                  :disabled="busy.has(account.id) || !account.endpoint"
                  :aria-label="`探活${account.name}`"
                  :aria-busy="rowOps[account.id] === 'probe'"
                  title="立即探活"
                  @click="rowAction(account.id, 'probe')"
                >
                  <LoaderCircle
                    v-if="rowOps[account.id] === 'probe'"
                    :size="15"
                    class="spin"
                  /><Radio v-else :size="15" /></button
                ><button
                  class="icon-button wake-button"
                  :disabled="busy.has(account.id) || !!wakeBlockedReason(account)"
                  :aria-label="`唤醒${account.name}`"
                  :aria-busy="rowOps[account.id] === 'wake'"
                  :title="wakeBlockedReason(account) || '向 CNB 提交启动请求，工作区启动后自动注册'"
                  @click="rowAction(account.id, 'wake')"
                >
                  <LoaderCircle v-if="rowOps[account.id] === 'wake'" :size="15" class="spin" /><Zap
                    v-else
                    :size="15"
                  /></button
                ><button
                  class="icon-button"
                  :aria-label="`编辑${account.name}`"
                  title="编辑账号"
                  @click="edit(account)"
                >
                  <Pencil :size="14" /></button
                ><button
                  class="icon-button"
                  :aria-label="`管理${account.name}`"
                  title="更多操作"
                  @click="managing = account"
                >
                  <MoreHorizontal :size="17" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="accounts.length" class="empty-filter">
      <Search :size="30" />
      <h3>没有找到匹配的账号</h3>
      <p>试试其他关键词，或清除筛选条件。</p>
      <button class="button" @click="clearFilters"><FilterX :size="14" />清除筛选</button>
    </div>
    <div v-else class="pool-empty">
      <div class="empty-illustration" aria-hidden="true">
        <span class="empty-node left"><Server :size="20" /></span><span class="empty-path" /><span
          class="empty-main"
          ><UsersRound :size="29" /></span
        ><span class="empty-path" /><span class="empty-node right"><Plus :size="20" /></span>
      </div>
      <span class="eyebrow">YOUR POOL STARTS HERE</span>
      <h2>从第一个 CNB 账号开始</h2>
      <p>
        接入你的工作区，剩下的域名跟随、探活和请求分配，<br
          class="desktop-only"
        />交给网关自动完成。
      </p>
      <button class="button primary" @click="edit()"><Plus :size="16" />接入第一个账号</button>
      <div class="empty-steps">
        <span><b>1</b>添加账号</span><ArrowRight :size="13" /><span><b>2</b>配置自注册</span
        ><ArrowRight :size="13" /><span><b>3</b>统一 API 调用</span>
      </div>
    </div>
    <footer v-if="accounts.length" class="table-footer">
      <span
        >{{ selected.size ? `已选择 ${selected.size} 个账号` : `共 ${filtered.length} 个账号`
        }}<span class="footer-dot">·</span>每页 10 条</span
      >
      <div class="pagination">
        <button class="button" :disabled="page <= 1" @click="page--">上一页</button
        ><span
          >{{ page }}<small>/ {{ pages }}</small></span
        ><button class="button" :disabled="page >= pages" @click="page++">下一页</button>
      </div>
    </footer>
  </section>
  <div class="pool-bottom-grid">
    <section class="routing-note">
      <span class="note-icon"><Waypoints /></span>
      <div>
        <strong>一个入口，自动找到可用账号</strong>
        <p>独立密钥注册动态域名，优先级与权重共同决定请求去向。</p>
        <button class="text-link" @click="emit('navigate', 'routing')">
          查看路由策略<ArrowRight :size="13" />
        </button>
      </div>
      <span class="note-decoration">↗</span>
    </section>
    <section class="endpoint-note">
      <span class="eyebrow">READY FOR YOUR CLIENT</span><strong>兼容你正在使用的工具</strong>
      <p>OpenAI & Anthropic 双协议，一份网关 Key。</p>
      <div>
        <span class="protocol-tag">OpenAI</span><span class="protocol-tag">Anthropic</span
        ><button class="text-link" @click="emit('navigate', 'access')">
          获取接入配置<ArrowUpRight :size="13" />
        </button>
      </div>
    </section>
  </div>
  <AccountDialog v-if="showEditor" :account="editingAccount" @close="showEditor = false" />
  <ModalShell
    v-if="managing"
    :title="managing.name"
    :subtitle="managing.repo"
    @close="managing = null"
    ><div class="modal-body account-actions-grid">
      <button @click="edit(managing)">
        <Pencil :size="19" /><strong>编辑账号</strong
        ><small>查看密钥与令牌、修改工作区配置</small></button
      ><button :disabled="busy.has(managing.id)" @click="manageEnable">
        <Power :size="19" /><strong>{{ managing.enabled ? '停用账号' : '启用账号' }}</strong
        ><small>{{ managing.enabled ? '停止分配新请求' : '重新加入自动路由' }}</small></button
      ><button
        :disabled="!managing.repo || !managing.hasPat || busy.has(managing.id)"
        @click="manageAction('quota')"
      >
        <Wallet :size="19" /><strong>同步组织额度</strong
        ><small>{{
          !managing.repo
            ? '需先填写仓库路径'
            : managing.hasPat
              ? '读取 CNB 计费额度'
              : '需先配置个人令牌'
        }}</small></button
      ><button
        :disabled="!managing.repo || !managing.hasPat || busy.has(managing.id)"
        @click="manageAction('wake')"
      >
        <Zap :size="19" /><strong>唤醒工作区</strong
        ><small>{{
          !managing.repo
            ? '需先填写仓库路径'
            : managing.hasPat
              ? '向 CNB 提交启动请求'
              : '需先配置个人令牌'
        }}</small></button
      ><button @click="confirmAction('rotate')">
        <KeyRound :size="19" /><strong>重置注册密钥</strong
        ><small>生成新的自注册配置</small></button
      ><button class="danger-action" @click="confirmAction('delete')">
        <Trash2 :size="19" /><strong>移除账号</strong><small>从当前号池中移除</small>
      </button>
    </div></ModalShell
  >
  <ModalShell
    v-if="confirming"
    :title="confirming.action === 'delete' ? '移除这个账号？' : '重置注册密钥？'"
    @close="!confirmingBusy && (confirming = null)"
    ><div class="modal-body">
      <p class="confirmation-text">
        {{
          confirming.action === 'delete'
            ? `「${confirming.account.name}」的本地配置和凭据将被删除。CNB 上的仓库与工作区不会被删除，正在处理的请求会继续完成。`
            : `「${confirming.account.name}」的旧注册密钥将立即失效。请把生成的新配置同步到 CNB 工作区。`
        }}
      </p>
    </div>
    <footer class="modal-footer">
      <span />
      <div class="button-group">
        <button class="button" :disabled="confirmingBusy" @click="confirming = null">取消</button
        ><button
          class="button"
          :class="confirming.action === 'delete' ? 'danger' : 'primary'"
          :disabled="confirmingBusy"
          @click="confirm"
        >
          <LoaderCircle v-if="confirmingBusy" class="spin" :size="14" />{{
            confirming.action === 'delete' ? '确认移除' : '重置并查看配置'
          }}
        </button>
      </div>
    </footer></ModalShell
  >
</template>

<style scoped>
/* Compact console: dense rows, tight cards, no oversized whitespace. */
.page-heading {
  align-items: flex-end;
  gap: 12px;
  margin-bottom: 14px;
}
.page-heading h1 {
  margin-top: 3px;
  margin-bottom: 2px;
  gap: 9px;
  font-size: 24px;
  letter-spacing: -0.5px;
}
.page-heading .eyebrow {
  font-size: 11px;
  letter-spacing: 1.3px;
}
.page-heading p {
  font-size: 14px;
  line-height: 1.6;
}
.heading-actions {
  padding-top: 0;
  gap: 7px;
}
.heading-actions > .button {
  min-height: 32px;
  padding: 6px 11px;
  font-size: 14px;
}
.stats-grid {
  gap: 10px;
  margin-bottom: 13px;
}
.stat-card {
  min-height: 0;
  padding: 12px 14px 11px;
}
.stat-top {
  font-size: 12px;
}
.stat-icon {
  width: 24px;
  height: 24px;
}
.stat-icon svg {
  width: 14px;
}
.stat-value {
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 24px;
  letter-spacing: -0.7px;
}
.stat-bottom {
  gap: 5px;
  margin-top: 6px;
}
.quota-card-status {
  gap: 2px;
  margin-top: 6px;
  font-size: 11px;
}
.pool-panel-header {
  height: 46px;
  padding: 0 15px;
  gap: 12px;
}
.table-toolbar {
  padding: 11px 15px;
  gap: 10px;
}
.search-field {
  height: 30px;
  max-width: 300px;
  padding: 0 9px;
}
.account-table {
  min-width: 960px;
}
.account-table th {
  padding: 8px 12px;
}
.account-table th:last-child {
  width: 130px;
  padding-right: 13px;
}
.account-table td {
  padding: 9px 12px;
}
.account-table td:last-child {
  padding-right: 13px;
}
.account-table .checkbox-cell {
  padding-left: 15px;
}
.account-identity {
  gap: 8px;
}
.account-avatar {
  width: 26px;
  height: 26px;
  font-size: 14px;
}
.account-name {
  font-size: 14px;
  line-height: 1.45;
}
.account-repo {
  margin-top: 2px;
}
.account-endpoint {
  margin: 3px 0 0 34px;
  max-width: calc(100% - 34px);
}
.cell-secondary {
  margin-top: 3px;
  line-height: 1.4;
}
.cell-secondary.account-health-detail {
  max-width: 190px;
  line-height: 1.4;
}
.quota-numbers > strong {
  font-size: 14px;
}
.quota-track {
  margin-top: 5px;
}
.quota-updated {
  margin-top: 3px;
}
.quota-sync-state {
  margin-top: 2px;
  max-width: 170px;
  line-height: 1.5;
}
.request-number {
  font-size: 14px;
}
.weight-cell {
  gap: 6px;
}
.row-actions {
  gap: 1px;
}
.row-actions .icon-button {
  width: 25px;
  height: 26px;
}
.wake-button:hover:not(:disabled) {
  background: var(--amber-soft);
  color: var(--amber);
}
.batch-bar {
  gap: 12px;
  padding: 6px 15px;
}
.table-footer {
  min-height: 40px;
  padding: 8px 15px;
}
.pool-bottom-grid {
  gap: 12px;
  margin-top: 13px;
}
.routing-note,
.endpoint-note {
  padding: 12px 15px;
}
.routing-note {
  gap: 11px;
}
.note-icon {
  width: 30px;
  height: 30px;
}
.note-icon > svg {
  width: 16px;
  height: 16px;
}
.routing-note p,
.endpoint-note > p {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.6;
}
.routing-note .text-link {
  margin-top: 6px;
}
.note-decoration {
  display: none;
}
.endpoint-note .eyebrow {
  margin-bottom: 3px;
}
.endpoint-note > div {
  margin-top: 8px;
}
.pool-empty {
  padding: 26px 17px 22px;
}
.empty-illustration {
  margin-bottom: 15px;
}
.empty-filter {
  min-height: 200px;
  padding: 28px 20px;
}
@media (max-width: 600px) {
  .page-heading {
    align-items: flex-start;
    gap: 10px;
    margin-bottom: 16px;
  }
  .page-heading h1 {
    font-size: 24px;
  }
  .heading-actions {
    padding-top: 22px;
  }
  .heading-actions > .button {
    padding: 6px 9px;
    font-size: 12px;
  }
  .stats-grid {
    gap: 8px;
    margin-bottom: 12px;
  }
  .stat-card {
    padding: 11px 12px 10px;
  }
  .stat-value {
    font-size: 22px;
  }
  .search-field {
    max-width: none;
  }
  .row-actions .icon-button {
    width: 27px;
    height: 29px;
  }
  .pool-bottom-grid {
    margin-top: 12px;
  }
  .routing-note,
  .endpoint-note {
    padding: 14px 15px;
  }
}
</style>
