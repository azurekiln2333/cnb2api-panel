<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { Search, RefreshCw, ArrowUpRight, ScrollText, X, Copy } from '@lucide/vue'
import { useConsole, time, number, copy } from '../console'
import type { LogEntry } from '../types'
import ModalShell from '../components/ModalShell.vue'
const { logs, refreshLogs } = useConsole()
const search = ref('')
const kind = ref('all')
const page = ref(1)
const selected = ref<LogEntry | null>(null)
const refreshing = ref(false)
const labels: Record<LogEntry['kind'], string> = {
  request: 'API 请求',
  account: '账号变更',
  register: '域名注册',
  health: '探活异常',
  failover: '路由切换',
  wake: '工作区唤醒',
}
const filtered = computed(() =>
  logs.value.filter(
    (l) =>
      (kind.value === 'all' || l.kind === kind.value) &&
      `${l.accountName} ${l.model ?? ''} ${l.message} ${l.requestId ?? ''} ${l.initialMessage?.text ?? ''}`
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
function bytes(value: number) {
  if (value < 1024) return `${number(value)} B`
  const unit = value < 1024 * 1024 ? 'KiB' : 'MiB'
  const divisor = unit === 'KiB' ? 1024 : 1024 * 1024
  return `${(value / divisor).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${unit}`
}
function copyDetails() {
  if (selected.value) void copy(JSON.stringify(selected.value, null, 2))
}
watch([search, kind], () => {
  page.value = 1
})
async function refresh() {
  refreshing.value = true
  await refreshLogs()
  refreshing.value = false
}
onMounted(refresh)
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />REQUESTS & EVENTS</div>
      <h1>请求与事件</h1>
      <p>追踪请求、域名更新和路由切换，保留最近 1,000 条事件。</p>
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
          placeholder="搜索账号、模型、请求 ID 或消息…"
          aria-label="搜索事件"
        /><button v-if="search" class="icon-button" aria-label="清空搜索" @click="search = ''">
          <X :size="13" />
        </button>
      </div>
      <select v-model="kind" class="filter-select" aria-label="事件类型">
        <option value="all">全部事件</option>
        <option v-for="(label, value) in labels" :key="value" :value="value">{{ label }}</option>
      </select>
    </div>
    <div v-if="rows.length" class="table-scroll">
      <table class="activity-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>账号 / 模型</th>
            <th>结果</th>
            <th>详情</th>
            <th class="right-align">耗时</th>
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
            </td>
            <td>
              <span class="http-status" :class="log.status < 400 ? 'ok' : 'failed'"
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
            <td class="right-align mono">
              {{ log.durationMs != null ? `${number(log.durationMs)} ms` : '—' }}
            </td>
            <td>
              <button class="icon-button" aria-label="查看事件详情" @click="selected = log">
                <ArrowUpRight :size="16" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="empty-filter">
      <ScrollText :size="30" />
      <h3>{{ logs.length ? '没有匹配的事件' : '这里会记下每一次变化' }}</h3>
      <p>
        {{
          logs.length
            ? '试试其他关键词或事件类型。'
            : '添加账号、注册工作区或发送 API 请求后，即可查看记录。'
        }}
      </p>
    </div>
    <footer class="table-footer">
      <span
        >共 {{ filtered.length }} 条记录<span class="footer-dot">·</span>首条用户消息最多保留 4,000
        字符</span
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
    :title="selected.kind === 'request' ? 'API 请求详情' : '事件详情'"
    :subtitle="time(selected.at, true)"
    :wide="selected.kind === 'request'"
    @close="selected = null"
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
        <button class="button" @click="copyDetails"><Copy :size="14" />复制详情</button>
        <button class="button" @click="selected = null">关闭</button>
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
