<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  Search,
  RefreshCw,
  ArrowUpRight,
  ScrollText,
  X,
  Copy,
  LoaderCircle,
  Download,
} from '@lucide/vue'
import { api } from '../api'
import { useConsole, time, number, copy } from '../console'
import type { LogChannel, LogEntry, RequestShape } from '../types'
import ModalShell from '../components/ModalShell.vue'
const props = withDefaults(defineProps<{ channel?: LogChannel }>(), { channel: 'requests' })
const { logStreams, refreshLogs } = useConsole()
const logs = computed(() => logStreams[props.channel].value)
const pageInfo = computed(
  () =>
    ({
      requests: {
        title: '请求日志',
        english: 'API REQUESTS',
        description: '仅显示 API 请求，保留最近 1,000 条请求记录。',
      },
      audit: {
        title: '审计日志',
        english: 'AUDIT LOG',
        description: '记录登录、账号变更、凭据查看和配置操作，保留最近 1,000 条审计记录。',
      },
      system: {
        title: '运行事件',
        english: 'SYSTEM EVENTS',
        description: '记录工作区注册、探活异常、唤醒和路由切换，保留最近 1,000 条运行事件。',
      },
    })[props.channel],
)
const search = ref('')
const kind = ref('all')
const outcome = ref<'all' | 'success' | 'failure'>('all')
const page = ref(1)
const selected = ref<LogEntry | null>(null)
const refreshing = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
let detailGeneration = 0
const labels: Record<LogEntry['kind'], string> = {
  request: 'API 请求',
  audit: '管理操作',
  account: '账号变更',
  register: '域名注册',
  health: '探活异常',
  failover: '路由切换',
  wake: '工作区唤醒',
}
const kindOptions = computed(() =>
  Object.entries(labels).filter(([value]) =>
    props.channel === 'requests'
      ? value === 'request'
      : props.channel === 'audit'
        ? ['audit', 'account'].includes(value)
        : !['request', 'audit', 'account'].includes(value),
  ),
)
const successful = (log: LogEntry) => log.status >= 200 && log.status < 400
const filtered = computed(() =>
  logs.value.filter(
    (l) =>
      (kind.value === 'all' || l.kind === kind.value) &&
      (props.channel !== 'requests' ||
        outcome.value === 'all' ||
        successful(l) === (outcome.value === 'success')) &&
      `${l.accountName} ${l.actor?.name ?? ''} ${l.action ?? ''} ${l.ip ?? ''} ${l.model ?? ''} ${l.message} ${l.requestId ?? ''} ${l.initialMessage?.text ?? ''}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
)
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 20)))
const rows = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20))
const tokenFields = [
  { key: 'input', label: '输入' },
  { key: 'output', label: '输出' },
  { key: 'cacheRead', label: '缓存读取' },
  { key: 'cacheWrite', label: '缓存写入' },
  { key: 'total', label: '合计' },
] as const
const ruleOutcomes = { applied: '已应用', unmatched: '未匹配', skipped: '已跳过' } as const
const supportLabel = (supported: boolean | null) =>
  supported === true ? '工作区确认支持' : supported === false ? '工作区不支持' : '暂无工作区确认'
const diagnosticShapes = computed(() => {
  const diagnostics = selected.value?.requestDiagnostics
  return diagnostics
    ? [
        { label: '接收的请求', key: 'received', shape: diagnostics.received },
        { label: '转发的请求', key: 'forwarded', shape: diagnostics.forwarded },
      ]
    : []
})
function bytes(value: number) {
  if (value < 1024) return `${number(value)} B`
  const unit = value < 1024 * 1024 ? 'KiB' : 'MiB'
  const divisor = unit === 'KiB' ? 1024 : 1024 * 1024
  return `${(value / divisor).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${unit}`
}
function safeShape(shape: RequestShape): RequestShape {
  return {
    fields: shape.fields,
    messageCount: shape.messageCount,
    messages: shape.messages.map(({ index, role, contentType, length }) => ({
      index,
      role,
      contentType,
      length,
    })),
    truncated: shape.truncated,
  }
}
function copyDetails() {
  if (!selected.value) return
  const { requestDiagnostics, ...entry } = selected.value
  const diagnostics = requestDiagnostics && {
    received: safeShape(requestDiagnostics.received),
    forwarded: safeShape(requestDiagnostics.forwarded),
    rules: requestDiagnostics.rules.map(({ name, mode, path, outcome, count, changed }) => ({
      name,
      mode,
      path,
      outcome,
      ...(count == null ? {} : { count }),
      ...(changed == null ? {} : { changed }),
    })),
    headers: {
      configured: requestDiagnostics.headers.configured,
      supported: requestDiagnostics.headers.supported,
      ...(requestDiagnostics.headers.attempts
        ? {
            attempts: requestDiagnostics.headers.attempts.map(({ attempt, status, supported }) => ({
              attempt,
              status,
              supported,
            })),
          }
        : {}),
    },
  }
  void copy(
    JSON.stringify(
      { ...entry, ...(diagnostics ? { requestDiagnostics: diagnostics } : {}) },
      null,
      2,
    ),
  )
}
function exportLogs() {
  if (!filtered.value.length) return
  const file = new Blob([JSON.stringify(filtered.value, null, 2)], {
    type: 'application/json;charset=utf-8',
  })
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = `${props.channel}-logs-${new Date().toISOString().replaceAll(':', '-')}.json`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function closeDetails() {
  detailGeneration++
  selected.value = null
  detailLoading.value = false
  detailError.value = ''
}
async function openDetails(log: LogEntry) {
  const generation = ++detailGeneration
  selected.value = log
  detailError.value = ''
  detailLoading.value = log.kind === 'request'
  if (log.kind !== 'request') return
  try {
    const result = await api<{ log: LogEntry }>(`/logs/requests/${encodeURIComponent(log.id)}`)
    if (!result.log || result.log.id !== log.id) throw new Error('invalid request detail')
    if (generation === detailGeneration && selected.value?.id === log.id)
      selected.value = { ...selected.value, ...result.log }
  } catch {
    if (generation === detailGeneration) detailError.value = '读取请求详情失败，请重试。'
  } finally {
    if (generation === detailGeneration) detailLoading.value = false
  }
}
watch([search, kind, outcome], () => {
  page.value = 1
})
async function refresh() {
  refreshing.value = true
  await refreshLogs(props.channel)
  refreshing.value = false
}
onMounted(refresh)
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />{{ pageInfo.english }}</div>
      <h1>{{ pageInfo.title }}</h1>
      <p>{{ pageInfo.description }}</p>
    </div>
    <button class="button" :disabled="refreshing" @click="refresh">
      <RefreshCw :size="15" :class="{ spin: refreshing }" />刷新记录
    </button>
  </div>
  <section class="pool-panel">
    <div class="table-toolbar">
      <div class="search-field">
        <Search :size="16" /><input
          v-model="search"
          :placeholder="
            channel === 'audit'
              ? '搜索操作人、账号、操作或来源 IP…'
              : channel === 'system'
                ? '搜索账号或运行事件…'
                : '搜索账号、模型、请求 ID 或消息…'
          "
          aria-label="搜索事件"
        /><button v-if="search" class="icon-button" aria-label="清空搜索" @click="search = ''">
          <X :size="13" />
        </button>
      </div>
      <select
        v-if="channel === 'requests'"
        v-model="outcome"
        class="filter-select"
        aria-label="请求结果"
      >
        <option value="all">全部请求</option>
        <option value="success">成功请求</option>
        <option value="failure">失败请求</option>
      </select>
      <select v-else v-model="kind" class="filter-select" aria-label="事件类型">
        <option value="all">全部事件</option>
        <option v-for="[value, label] in kindOptions" :key="value" :value="value">
          {{ label }}
        </option>
      </select>
      <button
        class="button"
        :disabled="!filtered.length"
        :title="`导出当前筛选的 ${filtered.length} 条记录`"
        @click="exportLogs"
      >
        <Download :size="15" />导出筛选记录
      </button>
    </div>
    <div v-if="rows.length" class="table-scroll">
      <table class="activity-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>
              {{
                channel === 'audit'
                  ? '对象 / 操作人'
                  : channel === 'requests'
                    ? '账号 / 模型'
                    : '账号'
              }}
            </th>
            <th>结果</th>
            <th>详情</th>
            <th v-if="channel !== 'audit'" class="right-align">耗时</th>
            <th />
          </tr>
        </thead>
        <tbody>
          <tr v-for="log in rows" :key="log.id">
            <td class="mono">{{ time(log.at, true) }}</td>
            <td>
              <span class="event-type" :class="log.kind">{{ labels[log.kind] }}</span>
            </td>
            <td>
              <strong>{{ log.accountName }}</strong
              ><span v-if="log.model" class="cell-secondary mono">{{ log.model }}</span>
              <span v-if="log.actor" class="cell-secondary">操作人：{{ log.actor.name }}</span>
            </td>
            <td>
              <span class="http-status" :class="successful(log) ? 'ok' : 'failed'"
                ><i />{{ log.status }}</span
              >
            </td>
            <td class="event-message" :title="log.message">
              {{ log.message
              }}<span v-if="log.attempts && log.attempts > 1" class="cell-secondary"
                >已尝试 {{ log.attempts }} 个账号</span
              >
              <span
                v-if="log.initialMessage"
                class="cell-secondary request-preview"
                data-testid="initial-message-preview"
                >首条消息：{{ log.initialMessage.text || '（空消息）' }}</span
              >
            </td>
            <td v-if="channel !== 'audit'" class="right-align mono">
              {{ log.durationMs != null ? `${number(log.durationMs)} ms` : '—' }}
            </td>
            <td>
              <button class="icon-button" aria-label="查看事件详情" @click="openDetails(log)">
                <ArrowUpRight :size="16" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-filter">
      <ScrollText :size="30" />
      <h3>{{ logs.length ? '没有匹配的记录' : `暂无${pageInfo.title}` }}</h3>
      <p>
        {{ logs.length ? '试试其他关键词或事件类型。' : pageInfo.description }}
      </p>
    </div>
    <footer class="table-footer">
      <span
        >共 {{ filtered.length }} 条记录<template v-if="channel === 'requests'"
          ><span class="footer-dot">·</span>首条用户消息最多保留 4,000 字符</template
        ></span
      >
      <div class="pagination">
        <button class="button" :disabled="page <= 1" @click="page--">上一页</button
        ><span
          >{{ page }}<small>/ {{ pages }}</small></span
        ><button class="button" :disabled="page >= pages" @click="page++">下一页</button>
      </div>
    </footer>
  </section>
  <ModalShell
    v-if="selected"
    :title="
      selected.kind === 'request'
        ? 'API 请求详情'
        : channel === 'audit'
          ? '审计详情'
          : '运行事件详情'
    "
    :subtitle="time(selected.at, true)"
    :wide="selected.kind === 'request'"
    @close="closeDetails"
    ><div class="modal-body">
      <dl class="detail-list" :class="{ 'request-details': selected.kind === 'request' }">
        <div>
          <dt>事件类型</dt>
          <dd>{{ labels[selected.kind] }}</dd>
        </div>
        <div>
          <dt>账号</dt>
          <dd>{{ selected.accountName }}</dd>
        </div>
        <div>
          <dt>HTTP 状态</dt>
          <dd>{{ selected.status }}</dd>
        </div>
        <div v-if="selected.model">
          <dt>模型</dt>
          <dd class="mono">{{ selected.model }}</dd>
        </div>
        <div v-if="selected.actor">
          <dt>操作人</dt>
          <dd>{{ selected.actor.name }}（{{ selected.actor.provider }}）</dd>
        </div>
        <div v-if="selected.action">
          <dt>操作</dt>
          <dd class="mono wrap-anywhere">{{ selected.action }}</dd>
        </div>
        <div v-if="selected.ip">
          <dt>来源 IP</dt>
          <dd class="mono wrap-anywhere">{{ selected.ip }}</dd>
        </div>
        <div v-if="selected.path">
          <dt>请求路径</dt>
          <dd class="mono wrap-anywhere">{{ selected.path }}</dd>
        </div>
        <div v-if="selected.method">
          <dt>请求方式</dt>
          <dd>{{ selected.method }}</dd>
        </div>
        <div v-if="selected.stream != null">
          <dt>响应模式</dt>
          <dd>{{ selected.stream ? '流式响应' : '非流式响应' }}</dd>
        </div>
        <div v-if="selected.upstreamEndpoint" class="detail-wide">
          <dt>目标工作区</dt>
          <dd class="mono wrap-anywhere">{{ selected.upstreamEndpoint }}</dd>
        </div>
        <div v-if="selected.requestId" class="detail-wide">
          <dt>请求 ID</dt>
          <dd class="mono wrap-anywhere">
            {{ selected.requestId
            }}<button
              class="icon-button"
              aria-label="复制请求 ID"
              @click="copy(selected.requestId!)"
            >
              <Copy :size="13" />
            </button>
          </dd>
        </div>
        <div v-if="selected.attempts != null">
          <dt>尝试次数</dt>
          <dd>{{ selected.attempts }}</dd>
        </div>
        <div v-if="selected.durationMs != null">
          <dt>完整耗时</dt>
          <dd>{{ number(selected.durationMs) }} ms</dd>
        </div>
        <div v-if="selected.firstByteMs !== undefined">
          <dt>首字节耗时</dt>
          <dd>
            {{
              selected.firstByteMs != null ? `${number(selected.firstByteMs)} ms` : '无首字节记录'
            }}
          </dd>
        </div>
        <div v-if="selected.requestBytes != null">
          <dt>请求大小</dt>
          <dd>{{ bytes(selected.requestBytes) }}</dd>
        </div>
        <div v-if="selected.responseBytes != null">
          <dt>上游正文大小</dt>
          <dd>{{ bytes(selected.responseBytes) }}</dd>
        </div>
        <div class="detail-wide">
          <dt>事件说明</dt>
          <dd>{{ selected.message }}</dd>
        </div>
      </dl>
      <template v-if="selected.kind === 'request'">
        <section class="request-section" aria-label="请求结构与覆盖结果">
          <div class="request-section-heading"><h3>请求结构与覆盖结果</h3></div>
          <p v-if="detailLoading" class="request-note diagnostic-loading" role="status">
            <LoaderCircle :size="14" class="spin" />正在读取请求详情
          </p>
          <div v-else-if="detailError" class="diagnostic-error" role="alert">
            <span>{{ detailError }}</span>
            <button class="text-link" @click="openDetails(selected)">重试</button>
          </div>
          <template v-else-if="selected.requestDiagnostics">
            <div
              v-for="item in diagnosticShapes"
              :key="item.key"
              class="diagnostic-shape"
              :data-testid="`request-shape-${item.key}`"
            >
              <h4>{{ item.label }}</h4>
              <dl class="diagnostic-summary">
                <div>
                  <dt>字段</dt>
                  <dd>
                    <template v-if="item.shape.fields.length">
                      <code v-for="field in item.shape.fields" :key="field">{{ field }}</code>
                    </template>
                    <span v-else>无</span>
                  </dd>
                </div>
                <div>
                  <dt>消息数</dt>
                  <dd>{{ number(item.shape.messageCount) }}</dd>
                </div>
              </dl>
              <ul v-if="item.shape.messages.length" class="diagnostic-messages">
                <li v-for="message in item.shape.messages" :key="message.index">
                  <span
                    ><code>#{{ message.index }}</code> <strong>{{ message.role }}</strong></span
                  >
                  <span
                    >{{ message.contentType }} · 长度
                    {{ message.length == null ? '未知' : number(message.length) }}</span
                  >
                </li>
              </ul>
              <p v-if="item.shape.truncated" class="request-note usage-incomplete">
                结构记录已截断。
              </p>
            </div>
            <div class="diagnostic-group" data-testid="request-rules">
              <h4>规则结果</h4>
              <ul v-if="selected.requestDiagnostics.rules.length" class="diagnostic-rules">
                <li v-for="(rule, index) in selected.requestDiagnostics.rules" :key="index">
                  <div>
                    <strong>{{ rule.name }}</strong
                    ><span class="diagnostic-outcome">{{ ruleOutcomes[rule.outcome] }}</span>
                  </div>
                  <p>
                    <code>{{ rule.mode }}</code> · <code>{{ rule.path || '—' }}</code
                    ><template v-if="rule.count != null"> · 次数 {{ number(rule.count) }}</template
                    ><template v-if="rule.changed != null">
                      · {{ rule.changed ? '字段已改变' : '字段未改变' }}</template
                    >
                  </p>
                </li>
              </ul>
              <p v-else class="request-note">没有规则结果。</p>
            </div>
            <div class="diagnostic-group" data-testid="request-headers">
              <h4>请求头覆盖</h4>
              <p class="request-note diagnostic-header-status">
                {{ supportLabel(selected.requestDiagnostics.headers.supported) }}。
                工作区确认不代表服务商已收到请求头。
              </p>
              <p class="diagnostic-header-names">
                <template v-if="selected.requestDiagnostics.headers.configured.length">
                  <code
                    v-for="name in selected.requestDiagnostics.headers.configured"
                    :key="name"
                    >{{ name }}</code
                  >
                </template>
                <span v-else>未配置请求头。</span>
              </p>
              <ul
                v-if="selected.requestDiagnostics.headers.attempts?.length"
                class="diagnostic-messages"
              >
                <li
                  v-for="attempt in selected.requestDiagnostics.headers.attempts"
                  :key="attempt.attempt"
                >
                  <span>第 {{ number(attempt.attempt) }} 次 · HTTP {{ attempt.status }}</span>
                  <span>{{ supportLabel(attempt.supported) }}</span>
                </li>
              </ul>
            </div>
          </template>
          <p v-else class="request-note">此记录未保存请求结构。</p>
        </section>
        <section class="request-section" aria-label="请求 Token 用量">
          <div class="request-section-heading"><h3>Token 用量</h3></div>
          <template v-if="selected.tokenUsage">
            <dl class="request-token-grid">
              <div v-for="field in tokenFields" :key="field.key">
                <dt>{{ field.label }}</dt>
                <dd :data-testid="`request-token-${field.key}`">
                  {{
                    selected.tokenUsage.reportedRequests
                      ? number(selected.tokenUsage[field.key])
                      : '—'
                  }}
                </dd>
              </div>
            </dl>
            <p
              class="request-note"
              :class="{ 'usage-incomplete': selected.tokenUsage.partialRequests }"
            >
              {{
                !selected.tokenUsage.reportedRequests
                  ? '上游未上报 Token 用量。'
                  : selected.tokenUsage.partialRequests
                    ? '用量不完整，当前数据仅含已上报部分。'
                    : '缓存已包含在输入中，不重复相加。'
              }}
            </p>
          </template>
          <p v-else class="request-note">此记录未保存 Token 用量。</p>
        </section>
        <section class="request-section" aria-label="首条用户消息">
          <div class="request-section-heading">
            <h3>首条用户消息</h3>
            <button
              v-if="selected.initialMessage"
              class="text-link"
              aria-label="复制首条用户消息"
              @click="copy(selected.initialMessage.text)"
            >
              <Copy :size="14" />复制
            </button>
          </div>
          <template v-if="selected.initialMessage">
            <pre class="request-initial-message" data-testid="initial-message">{{
              selected.initialMessage.text || '（空消息）'
            }}</pre>
            <p v-if="selected.initialMessage.truncated" class="request-note usage-incomplete">
              消息过长，仅保留前 4,000 字符。
            </p>
          </template>
          <p v-else class="request-note">此记录未保存首条用户消息。</p>
        </section>
      </template>
    </div>
    <footer class="modal-footer">
      <span />
      <div class="button-group">
        <button class="button" :disabled="detailLoading" @click="copyDetails">
          <Copy :size="14" />复制详情
        </button>
        <button class="button" @click="closeDetails">关闭</button>
      </div>
    </footer></ModalShell
  >
</template>

<style scoped>
.request-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.request-details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 20px;
}
.request-details > div {
  grid-template-columns: 85px minmax(0, 1fr);
  gap: 10px;
  padding: 9px 0;
  min-width: 0;
}
.request-details dd {
  overflow-wrap: anywhere;
}
.detail-wide {
  grid-column: 1 / -1;
}
.request-section {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--line);
}
.request-section-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.request-section-heading h3 {
  font-size: 14px;
}
.request-section-heading .text-link {
  font-size: 12px;
}
.request-token-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 12px;
  margin: 0 0 10px;
}
.request-token-grid dt {
  color: var(--secondary);
  font-size: 12px;
}
.request-token-grid dd {
  margin: 5px 0 0;
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.request-note {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.7;
}
.diagnostic-loading,
.diagnostic-error {
  display: flex;
  align-items: center;
  gap: 8px;
}
.diagnostic-error {
  color: var(--red);
  font-size: 12px;
}
.diagnostic-shape,
.diagnostic-group {
  margin-top: 16px;
  min-width: 0;
}
.diagnostic-shape h4,
.diagnostic-group h4 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 600;
}
.diagnostic-summary {
  margin: 0;
  font-size: 12px;
}
.diagnostic-summary > div {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr);
  gap: 8px;
  margin: 5px 0;
}
.diagnostic-summary dt {
  color: var(--muted);
}
.diagnostic-summary dd {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  min-width: 0;
  margin: 0;
  overflow-wrap: anywhere;
}
.diagnostic-messages,
.diagnostic-rules {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--line);
  font-size: 12px;
}
.diagnostic-messages li,
.diagnostic-rules li {
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.diagnostic-messages li,
.diagnostic-rules li > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
}
.diagnostic-messages li > span,
.diagnostic-rules li > div > * {
  min-width: 0;
}
.diagnostic-messages li > span:last-child,
.diagnostic-rules li > p {
  color: var(--secondary);
}
.diagnostic-rules li > p {
  margin-top: 3px;
  line-height: 1.6;
}
.diagnostic-outcome {
  color: var(--primary);
  white-space: nowrap;
}
.diagnostic-header-names {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 6px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.usage-incomplete {
  color: var(--amber);
}
.request-initial-message {
  margin: 0 0 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-subtle);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 320px;
  overflow: auto;
}
@media (max-width: 600px) {
  .request-details {
    grid-template-columns: minmax(0, 1fr);
  }
  .request-details > div {
    grid-template-columns: 82px minmax(0, 1fr);
  }
  .request-token-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .request-token-grid > div:last-child {
    grid-column: 1 / -1;
  }
}
</style>
