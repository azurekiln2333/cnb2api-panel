<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  ArrowUpRight,
  Activity,
  Timer,
  CircleCheck,
  UsersRound,
  Radio,
  ArrowRight,
  RefreshCw,
  Coins,
  Wallet,
} from '@lucide/vue'
import { number, compact, useConsole, accountState, time } from '../console'
import { api } from '../api'
import type { Page, TokenTotals, UsageComparison } from '../types'
import { summarizeQuota } from '../quota'
import StatusBadge from '../components/StatusBadge.vue'
const emit = defineEmits<{ navigate: [page: Page] }>()
const { overview, accounts, lastUpdated } = useConsole()
const metric = ref<'requests' | 'errors'>('requests')
const tokenPeriod = ref<'today' | 'total'>('today')
const credits = computed(() => summarizeQuota(accounts.value))
const tokens = computed(() => overview.value?.stats.tokenUsage?.[tokenPeriod.value])
const todayTokens = computed(() => overview.value?.stats.tokenUsage?.today)
const unreported = (usage: TokenTotals | null | undefined) =>
  !!usage && !usage.reportedRequests && usage.missingRequests > 0
const tokenNumber = (usage: TokenTotals | null | undefined, key: keyof TokenTotals) =>
  unreported(usage) ? '—' : number(usage?.[key])
const tokenSummaryStatus = computed(() => {
  const usage = todayTokens.value
  if (!usage) return '暂无用量数据，等待请求上报。'
  if (!usage.reportedRequests && !usage.missingRequests)
    return '今日暂无请求，调用统一入口后自动统计。'
  if (!usage.reportedRequests)
    return `${number(usage.missingRequests)} 次请求未上报用量，缺失部分不估算。`
  return `${number(usage.reportedRequests)} 次已上报${usage.partialRequests ? `，${number(usage.partialRequests)} 次字段不完整` : ''}${usage.missingRequests ? ` · ${number(usage.missingRequests)} 次未上报` : ''}`
})
const creditSummaryStatus = computed(() => {
  if (credits.value.errors) return `${credits.value.errors} 个组织同步失败，保留上次额度`
  if (credits.value.syncing) return '正在同步 CNB 组织额度…'
  if (!credits.value.organizations)
    return credits.value.configured ? '等待首次自动同步额度' : '尚未配置额度同步'
  return `已同步 ${credits.value.organizations} 个组织 · 后台每60秒同步`
})
const tokenMetrics = [
  { key: 'input', label: '输入 Tokens', hint: '包含缓存读取与写入' },
  { key: 'output', label: '输出 Tokens', hint: '模型生成的内容' },
  { key: 'cacheRead', label: '缓存读取', hint: '输入中命中缓存的部分' },
  { key: 'cacheWrite', label: '缓存写入', hint: '输入中创建缓存的部分' },
  { key: 'total', label: 'Tokens 合计', hint: '输入 + 输出' },
] as const
const comparisonMetrics = tokenMetrics.filter((item) => item.key !== 'cacheWrite')
const comparisons = ref<UsageComparison[]>([])
const comparing = ref(false)
const comparisonError = ref('')
const comparisonLabels = {
  ok: '已同步',
  pending: '待同步',
  unsupported: '不支持',
  unavailable: '读取失败',
}
const signed = (value: number | null | undefined) =>
  value == null ? '—' : `${value > 0 ? '+' : ''}${number(value)}`
async function loadComparison(refresh = false) {
  if (comparing.value) return
  comparing.value = true
  try {
    const result = await api<{ accounts: UsageComparison[] }>(
      '/usage/comparison',
      refresh ? 'POST' : 'GET',
      refresh ? {} : undefined,
    )
    comparisons.value = result.accounts
    comparisonError.value = ''
  } catch (error) {
    comparisonError.value = error instanceof Error ? error.message : '用量读取失败'
  } finally {
    comparing.value = false
  }
}
onMounted(() => loadComparison())
watch(overview, () => loadComparison())
const today = computed(() => {
  const now = lastUpdated.value?.getTime() ?? Date.now()
  return Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000
})
const buckets = computed(() =>
  Array.from({ length: 24 }, (_, i) => {
    const b = overview.value?.hourly.find((h) => Date.parse(h.at) === today.value + i * 3600000)
    return { hour: i, requests: b?.requests ?? 0, errors: b?.errors ?? 0 }
  }),
)
const max = computed(() => Math.max(4, ...buckets.value.map((b) => b[metric.value])))
const points = computed(() =>
  buckets.value.map((b, i) => `${42 + i * 35},${205 - (b[metric.value] / max.value) * 170}`),
)
const line = computed(() => `M${points.value.join(' L')}`)
const area = computed(() => `${line.value} L847,205 L42,205 Z`)
const chartHasData = computed(() => buckets.value.some((b) => b.requests > 0))
const ranked = computed(() =>
  accounts.value
    .map((a) => ({
      ...a,
      today:
        overview.value?.hourly
          .filter((b) => Date.parse(b.at) >= today.value)
          .reduce((n, b) => n + (b.accounts[a.id] || 0), 0) ?? 0,
    }))
    .sort((a, b) => b.today - a.today)
    .slice(0, 5),
)
const maxAccount = computed(() => Math.max(1, ...ranked.value.map((a) => a.today)))
const states = computed(() => [
  {
    label: '可用',
    count: accounts.value.filter((a) => accountState(a) === 'healthy').length,
    class: 'green',
  },
  {
    label: '待接入 / 离线',
    count: accounts.value.filter((a) => ['pending', 'offline'].includes(accountState(a))).length,
    class: 'gray',
  },
  {
    label: '冷却中',
    count: accounts.value.filter((a) => accountState(a) === 'cooling').length,
    class: 'amber',
  },
  { label: '已停用', count: accounts.value.filter((a) => !a.enabled).length, class: 'slate' },
])
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />AT A GLANCE</div>
      <h1>
        运行概览<span class="live-label"><i class="status-dot green" />实时同步</span>
      </h1>
    </div>
    <button class="button" @click="emit('navigate', 'accounts')">
      管理账号池<ArrowUpRight :size="15" />
    </button>
  </div>
  <div class="overview-summary-grid">
    <section
      class="stat-card overview-summary-card token-summary-card"
      aria-labelledby="overview-token-summary-heading"
      data-testid="overview-token-summary"
    >
      <div class="stat-top">
        <h2 id="overview-token-summary-heading">今日 Token 用量</h2>
        <span class="stat-icon blue"><Coins :size="19" /></span>
      </div>
      <div class="overview-summary-value">
        <strong data-testid="summary-token-total">{{ tokenNumber(todayTokens, 'total') }}</strong
        ><span>Tokens</span>
      </div>
      <dl class="overview-summary-breakdown">
        <div>
          <dt>输入</dt>
          <dd>{{ tokenNumber(todayTokens, 'input') }}</dd>
        </div>
        <div>
          <dt>输出</dt>
          <dd>{{ tokenNumber(todayTokens, 'output') }}</dd>
        </div>
        <div>
          <dt>缓存读取</dt>
          <dd>{{ tokenNumber(todayTokens, 'cacheRead') }}</dd>
        </div>
        <div>
          <dt>缓存写入</dt>
          <dd>{{ tokenNumber(todayTokens, 'cacheWrite') }}</dd>
        </div>
      </dl>
      <p class="overview-summary-state">{{ tokenSummaryStatus }}</p>
      <p class="overview-summary-note">缓存已包含在输入中 · 今日按 UTC+8 统计</p>
    </section>
    <section
      class="stat-card overview-summary-card credits-summary-card"
      aria-labelledby="overview-credits-summary-heading"
      data-testid="overview-credits-summary"
    >
      <div class="stat-top">
        <h2 id="overview-credits-summary-heading">剩余 Credits 额度</h2>
        <span class="stat-icon amber"><Wallet :size="19" /></span>
      </div>
      <div class="overview-summary-value">
        <strong data-testid="summary-credits-remaining">{{
          number(overview?.stats.remainingCredits, 1)
        }}</strong
        ><span>Credits</span>
      </div>
      <dl class="overview-summary-breakdown">
        <div>
          <dt>已使用</dt>
          <dd>{{ number(credits.used, 1) }}</dd>
        </div>
        <div>
          <dt>总额度</dt>
          <dd>{{ number(credits.total, 1) }}</dd>
        </div>
        <div>
          <dt>冻结额度</dt>
          <dd>{{ number(credits.freeze, 1) }}</dd>
        </div>
        <div>
          <dt>已同步组织</dt>
          <dd>{{ number(credits.organizations) }}</dd>
        </div>
      </dl>
      <p class="overview-summary-state" :class="{ 'quota-error-text': credits.errors > 0 }">
        {{ creditSummaryStatus }}
      </p>
      <p class="overview-summary-note">
        {{
          credits.syncedAt
            ? `额度更新于 ${time(credits.syncedAt, true)} · 同组织不重复累计`
            : credits.configured
              ? '首次读取成功后显示额度，暂不显示估算值。'
              : '在账号池配置仓库与个人令牌后自动读取。'
        }}
      </p>
    </section>
  </div>
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-top">
        <span>今日请求</span><span class="stat-icon blue"><Activity :size="17" /></span>
      </div>
      <div class="stat-value">{{ compact(overview!.stats.requests) }}<small>次</small></div>
      <div class="stat-bottom">{{ overview!.stats.activeRequests }} 个请求正在处理</div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>请求成功率</span><span class="stat-icon green"><CircleCheck :size="17" /></span>
      </div>
      <div class="stat-value">{{ number(overview!.stats.successRate, 1) }}<small>%</small></div>
      <div class="stat-bottom">{{ number(overview!.stats.errors) }} 次未成功完成</div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>平均请求耗时</span><span class="stat-icon amber"><Timer :size="17" /></span>
      </div>
      <div class="stat-value">{{ number(overview!.stats.averageDurationMs) }}<small>ms</small></div>
      <div class="stat-bottom">含完整流式响应时长</div>
    </div>
    <div class="stat-card">
      <div class="stat-top">
        <span>可用工作区</span><span class="stat-icon violet"><UsersRound :size="17" /></span>
      </div>
      <div class="stat-value">
        {{ overview!.stats.ready }}<small>/ {{ accounts.length }}</small>
      </div>
      <div class="stat-bottom">启用、探活通过且未在冷却中</div>
    </div>
  </div>
  <section class="section-panel token-panel" aria-labelledby="token-usage-heading">
    <header class="chart-heading">
      <div>
        <h2 id="token-usage-heading"><Coins :size="17" />Token 用量</h2>
        <p>面板本地记录 · 今日以 UTC+8 为界</p>
      </div>
      <div class="segmented" aria-label="Token 统计范围">
        <button
          :class="{ active: tokenPeriod === 'today' }"
          :aria-pressed="tokenPeriod === 'today'"
          @click="tokenPeriod = 'today'"
        >
          今日
        </button>
        <button
          :class="{ active: tokenPeriod === 'total' }"
          :aria-pressed="tokenPeriod === 'total'"
          @click="tokenPeriod = 'total'"
        >
          累计
        </button>
      </div>
    </header>
    <div class="token-metrics">
      <div
        v-for="item in tokenMetrics"
        :key="item.key"
        class="token-metric"
        :data-testid="`token-${item.key}`"
      >
        <span>{{ item.label }}</span>
        <strong>{{ tokenNumber(tokens, item.key) }}</strong>
        <small>{{ item.hint }}</small>
      </div>
    </div>
    <div class="token-accounting-note">
      <span
        >{{ number(tokens?.reportedRequests) }} 次用量已上报<span v-if="tokens?.partialRequests"
          >，其中 {{ number(tokens.partialRequests) }} 次仅有部分字段</span
        >；{{ number(tokens?.missingRequests) }} 次未上报。</span
      >
      <span>缓存已包含在输入中，不重复相加。缺失用量不估算，部分字段可能导致统计偏低。</span>
      <span v-if="overview?.stats.tokenUsage?.startedAt"
        >累计自 {{ time(overview.stats.tokenUsage.startedAt, true) }} 开始记录，重启后保留。</span
      >
    </div>
  </section>
  <section
    class="section-panel credits-panel"
    aria-labelledby="credits-usage-heading"
    data-testid="overview-credits"
  >
    <header class="chart-heading">
      <div>
        <h2 id="credits-usage-heading"><Wallet :size="17" />Credits 额度</h2>
        <p>CNB 组织计费额度 · 同组织共享，不重复累计</p>
      </div>
      <button class="quiet-button" @click="emit('navigate', 'accounts')">
        管理额度<ArrowUpRight :size="14" />
      </button>
    </header>
    <div class="credits-metrics">
      <div class="token-metric" data-testid="overview-credits-remaining">
        <span>剩余 Credits</span><strong>{{ number(overview?.stats.remainingCredits, 1) }}</strong
        ><small>已扣除使用和冻结额度</small>
      </div>
      <div class="token-metric">
        <span>总额度</span><strong>{{ number(credits.total, 1) }}</strong
        ><small>{{ credits.organizations }} 个已同步组织</small>
      </div>
      <div class="token-metric">
        <span>已使用</span><strong>{{ number(credits.used, 1) }}</strong
        ><small>CNB 上报的组织用量</small>
      </div>
      <div class="token-metric">
        <span>冻结额度</span><strong>{{ number(credits.freeze, 1) }}</strong
        ><small>尚未结算的占用</small>
      </div>
    </div>
    <div class="token-accounting-note">
      <span :class="{ 'quota-error-text': credits.errors > 0 }">{{
        credits.errors
          ? `${credits.errors} 个组织同步失败，继续显示上次成功额度，请在账号池查看原因和重试时间。`
          : credits.syncing
            ? '后台正在读取 CNB 组织额度。'
            : credits.configured
              ? '后台每60秒向 CNB 同步额度；页面每15秒读取面板数据。'
              : '填写仓库路径和有组织计费读取权限的个人令牌后，后台自动同步额度。'
      }}</span>
      <span v-if="credits.syncedAt"
        >额度上次成功更新：{{ time(credits.syncedAt, true)
        }}{{
          credits.organizations > 1 ? '（各组织中最早的一次）' : ''
        }}。失败时保留已保存的数值，按退避时间重试。</span
      >
      <span v-else>还没有成功读取额度，暂不显示估算值。</span>
    </div>
  </section>
  <div class="overview-main-grid">
    <section class="section-panel chart-panel">
      <header class="chart-heading">
        <div>
          <h2>请求流量</h2>
          <p>今日每小时请求量 · UTC+8</p>
        </div>
        <div class="segmented">
          <button :class="{ active: metric === 'requests' }" @click="metric = 'requests'">
            全部请求</button
          ><button :class="{ active: metric === 'errors' }" @click="metric = 'errors'">
            失败请求
          </button>
        </div>
      </header>
      <div class="traffic-chart">
        <svg
          viewBox="0 0 890 250"
          role="img"
          :aria-label="`今日${metric === 'requests' ? '全部' : '失败'}请求，最高每小时 ${max} 次`"
        >
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--primary)" stop-opacity=".14" />
              <stop offset="100%" stop-color="var(--primary)" stop-opacity="0" />
            </linearGradient>
          </defs>
          <g v-for="i in 5" :key="i">
            <line
              x1="42"
              x2="847"
              :y1="35 + (i - 1) * 42.5"
              :y2="35 + (i - 1) * 42.5"
              class="chart-grid"
            />
            <text x="28" :y="39 + (i - 1) * 42.5" text-anchor="end">
              {{ Math.round((max * (5 - i)) / 4) }}
            </text>
          </g>
          <template v-if="chartHasData">
            <path :d="area" fill="url(#chart-fill)" />
            <path
              :d="line"
              fill="none"
              stroke="var(--primary)"
              stroke-width="2.5"
              stroke-linejoin="round"
            />
            <circle
              v-for="(point, i) in points"
              :key="i"
              :cx="point.split(',')[0]"
              :cy="point.split(',')[1]"
              r="3"
              fill="var(--surface)"
              stroke="var(--primary)"
              stroke-width="1.5"
            >
              <title>{{ i }}:00 · {{ buckets[i]![metric] }} 次</title>
            </circle>
          </template>
          <text
            v-for="i in [0, 4, 8, 12, 16, 20, 23]"
            :key="i"
            :x="42 + i * 35"
            y="236"
            text-anchor="middle"
          >
            {{ String(i).padStart(2, '0') }}:00
          </text>
        </svg>
        <div v-if="!chartHasData" class="chart-empty">
          <Activity :size="23" /><strong>还没有请求流量</strong
          ><span>客户端通过统一入口调用后，这里会开始记录。</span>
        </div>
      </div>
      <footer class="chart-footer">
        <span><i class="blue-dot" />{{ metric === 'requests' ? '全部请求' : '失败请求' }}</span
        ><span>每 15 秒更新</span>
      </footer>
    </section>
    <section class="section-panel pool-health">
      <header class="chart-heading">
        <div>
          <h2>号池健康度</h2>
          <p>当前工作区状态分布</p>
        </div>
        <Radio :size="17" />
      </header>
      <div class="health-number">
        {{ accounts.length ? Math.round((overview!.stats.ready / accounts.length) * 100) : '—'
        }}<small>%</small><span>可用比例</span>
      </div>
      <div class="health-distribution">
        <i
          v-for="state in states"
          :key="state.label"
          :class="state.class"
          :style="{ width: `${accounts.length ? (state.count / accounts.length) * 100 : 0}%` }"
        />
      </div>
      <div class="health-legend">
        <div v-for="state in states" :key="state.label">
          <i class="status-dot" :class="state.class" /><span>{{ state.label }}</span
          ><strong>{{ state.count }}</strong>
        </div>
      </div>
      <button class="text-link" @click="emit('navigate', 'accounts')">
        查看全部账号<ArrowRight :size="13" />
      </button>
    </section>
  </div>
  <section class="section-panel comparison-panel" aria-labelledby="worker-comparison-heading">
    <header class="chart-heading">
      <div>
        <h2 id="worker-comparison-heading">工作区用量比对</h2>
        <p>本地与工作区从同一基线开始的增量</p>
      </div>
      <button class="button" :disabled="comparing" @click="loadComparison(true)">
        <RefreshCw :size="14" :class="{ spin: comparing }" />{{
          comparing ? '正在同步' : '同步工作区用量'
        }}
      </button>
    </header>
    <p v-if="comparisonError" class="comparison-error" role="alert">{{ comparisonError }}</p>
    <div v-if="!comparisons.length && !comparisonError" class="compact-empty">
      {{ comparing ? '正在读取工作区用量…' : '接入工作区后，可以在这里比对用量。' }}
    </div>
    <div v-else class="comparison-accounts">
      <article
        v-for="row in comparisons"
        :key="row.accountId"
        class="comparison-account"
        :data-testid="`usage-comparison-${row.accountId}`"
      >
        <div class="comparison-account-heading">
          <strong>{{ row.accountName }}</strong>
          <span class="comparison-status" :class="row.status">{{
            comparisonLabels[row.status]
          }}</span>
        </div>
        <p class="comparison-message">
          {{ row.message
          }}<template v-if="row.status !== 'ok' && row.syncedAt">
            · 以下为上次成功同步数据</template
          >
        </p>
        <div class="comparison-totals">
          <div>
            <span>本地合计</span
            ><strong data-testid="comparison-local">{{ tokenNumber(row.local, 'total') }}</strong>
          </div>
          <div>
            <span>工作区合计</span
            ><strong data-testid="comparison-workspace">{{ number(row.workspace?.total) }}</strong>
          </div>
          <div>
            <span>差值（工作区 − 本地）</span
            ><strong data-testid="comparison-difference">{{
              unreported(row.local) ? '—' : signed(row.difference?.total)
            }}</strong>
          </div>
        </div>
        <details v-if="row.workspaceTotals" class="comparison-details">
          <summary>查看输入、输出与缓存明细</summary>
          <table>
            <thead>
              <tr>
                <th>Tokens</th>
                <th>本地</th>
                <th>工作区</th>
                <th>差值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in comparisonMetrics" :key="item.key">
                <th>{{ item.label }}</th>
                <td>{{ tokenNumber(row.local, item.key) }}</td>
                <td>{{ number(row.workspace?.[item.key]) }}</td>
                <td>{{ unreported(row.local) ? '—' : signed(row.difference?.[item.key]) }}</td>
              </tr>
            </tbody>
          </table>
          <p>
            工作区本次启动累计：{{ number(row.workspaceTotals.total) }} Tokens（{{
              time(row.bootedAt, true)
            }}
            启动）。工作区接口未提供缓存写入数据。
          </p>
        </details>
        <p v-if="row.local?.missingRequests" class="comparison-message">
          {{ number(row.local.missingRequests) }} 次本地请求未上报用量，缺失部分不估算。
        </p>
        <div v-if="row.startedAt || row.syncedAt" class="comparison-timestamps">
          <span v-if="row.startedAt">基线 {{ time(row.startedAt, true) }}</span
          ><span v-if="row.syncedAt">同步 {{ time(row.syncedAt, true) }}</span>
        </div>
      </article>
    </div>
    <div class="token-accounting-note">
      <span
        >首次同步建立基线，后续显示增量；工作区重启或计数重置后重新建立。工作区数据可能包含直连请求，差值为正表示工作区更多。</span
      >
      <span>比对结果独立显示，不计入本地统计。同步时仍在进行的请求和缺失用量可能产生差异。</span>
    </div>
  </section>
  <section class="section-panel">
    <header class="chart-heading">
      <div>
        <h2>账号流量分布</h2>
        <p>今日请求量前 5 个工作区</p>
      </div>
      <button class="quiet-button" @click="emit('navigate', 'activity')">
        查看请求记录<ArrowUpRight :size="14" />
      </button>
    </header>
    <div v-if="!ranked.length" class="compact-empty">
      接入第一个账号后，在这里查看流量如何分配。
    </div>
    <div v-else class="ranked-accounts">
      <div v-for="(a, i) in ranked" :key="a.id">
        <span class="rank-number">{{ String(i + 1).padStart(2, '0') }}</span
        ><span class="rank-name"
          ><strong>{{ a.name }}</strong
          ><small>{{ a.repo || '未填写仓库' }}</small></span
        ><StatusBadge :account="a" />
        <div class="rank-bar"><i :style="{ width: `${(a.today / maxAccount) * 100}%` }" /></div>
        <strong class="rank-count">{{ number(a.today) }}<small>次</small></strong
        ><span class="rank-checked">{{ time(a.checkedAt) }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.overview-summary-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-bottom: 13px;
}
.overview-summary-card {
  min-width: 0;
  padding: 12px 15px 11px;
  border-top: 2px solid var(--primary);
}
.credits-summary-card {
  border-top-color: var(--amber);
}
.overview-summary-card h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}
.overview-summary-value {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 7px;
  margin: 6px 0 9px;
}
.overview-summary-value strong {
  font-size: 30px;
  line-height: 1.2;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.overview-summary-value > span {
  font-size: 12px;
  color: var(--muted);
}
.overview-summary-breakdown {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 4px 12px;
  margin: 0 0 8px;
}
.overview-summary-breakdown > div {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.overview-summary-breakdown dt {
  font-size: 12px;
  color: var(--secondary);
}
.overview-summary-breakdown dd {
  margin: 0;
  font-size: 14px;
  font-weight: 550;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.overview-summary-state {
  margin: 0;
  font-size: 12px;
  color: var(--secondary);
  line-height: 1.5;
}
.overview-summary-note {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.overview-summary-state.quota-error-text {
  color: var(--red);
}
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
.page-heading > .button {
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
  margin-top: 4px;
  font-size: 24px;
  letter-spacing: -0.7px;
}
.stat-bottom {
  gap: 5px;
  margin-top: 6px;
}
.section-panel {
  margin-bottom: 13px;
}
.chart-heading {
  padding: 13px 16px 9px;
  gap: 12px;
}
.chart-heading h2 {
  font-size: 14px;
}
.chart-heading p {
  margin-top: 3px;
  line-height: 1.5;
}
.token-metrics,
.credits-metrics {
  gap: 12px;
  padding: 2px 16px 13px;
}
.token-metric {
  gap: 5px;
}
.token-metric > span {
  font-size: 12px;
}
.token-metric > strong {
  font-size: clamp(20px, 1.7vw, 26px);
}
.token-metric > small {
  font-size: 12px;
}
.token-accounting-note {
  gap: 3px;
  padding: 9px 16px;
  font-size: 12px;
  line-height: 1.5;
}
.traffic-chart {
  padding: 6px 14px 0;
  min-height: 184px;
}
.traffic-chart > svg {
  min-height: 184px;
}
.chart-footer {
  padding: 9px 16px 13px;
}
.pool-health .health-number {
  font-size: 34px;
  padding: 6px 16px 10px;
}
.health-number small {
  font-size: 17px;
}
.health-number span {
  margin-top: 2px;
}
.health-distribution {
  margin: 0 16px 12px;
}
.health-legend {
  padding: 0 16px;
  gap: 8px 12px;
}
.pool-health > .text-link {
  margin: 12px 16px 13px;
}
.overview-main-grid {
  gap: 13px;
}
.comparison-accounts {
  gap: 10px;
  padding: 0 16px 13px;
}
.comparison-account {
  padding: 12px;
}
.comparison-message {
  margin: 6px 0 10px;
}
.comparison-totals {
  gap: 10px;
}
.comparison-totals strong {
  font-size: 18px;
}
.comparison-details {
  margin-top: 10px;
}
.comparison-details table {
  margin: 8px 0;
}
.comparison-timestamps {
  margin-top: 8px;
}
.compact-empty {
  padding: 26px 16px 30px;
}
.ranked-accounts {
  padding: 0 16px 4px;
}
.ranked-accounts > div {
  gap: 14px;
  padding: 10px 0;
}
.rank-name {
  width: 160px;
}
.rank-name > small {
  margin-top: 2px;
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
  .page-heading > .button {
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
  .overview-summary-grid {
    gap: 8px;
    margin-bottom: 12px;
  }
  .overview-summary-card {
    padding: 11px 12px 10px;
  }
  .overview-summary-card .stat-icon {
    width: 22px;
    height: 22px;
  }
  .overview-summary-card .stat-icon svg {
    width: 14px;
  }
  .overview-summary-value {
    gap: 5px;
    margin: 6px 0 8px;
  }
  .overview-summary-value strong {
    font-size: 22px;
  }
  .overview-summary-value > span {
    font-size: 12px;
  }
  .overview-summary-breakdown {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 3px 10px;
    margin-bottom: 7px;
  }
  .overview-summary-breakdown dt {
    font-size: 12px;
  }
  .overview-summary-breakdown dd {
    font-size: 14px;
  }
  .overview-summary-state {
    font-size: 12px;
  }
  .overview-summary-note {
    font-size: 11px;
  }
  .chart-heading {
    padding: 11px 13px 8px;
  }
  .token-metrics,
  .credits-metrics {
    padding: 2px 13px 11px;
    gap: 10px;
  }
  .token-accounting-note {
    padding: 8px 13px;
  }
  .comparison-accounts {
    padding: 0 13px 11px;
  }
  .comparison-account {
    padding: 11px;
  }
  .ranked-accounts {
    padding: 0 13px 2px;
  }
  .rank-name {
    width: 104px;
  }
}
</style>
