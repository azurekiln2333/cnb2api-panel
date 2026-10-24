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
      `${l.accountName} ${l.model ?? ''} ${l.message} ${l.requestId ?? ''}`
        .toLowerCase()
        .includes(search.value.toLowerCase()),
  ),
)
const pages = computed(() => Math.max(1, Math.ceil(filtered.value.length / 20)))
const rows = computed(() => filtered.value.slice((page.value - 1) * 20, page.value * 20))
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
          placeholder="搜索账号、模型或请求 ID…"
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
        >共 {{ filtered.length }} 条记录<span class="footer-dot">·</span
        >不记录提示词与响应正文</span
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
    title="事件详情"
    :subtitle="time(selected.at, true)"
    @close="selected = null"
    ><div class="modal-body">
      <dl class="detail-list">
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
          <dd class="mono">{{ selected.path }}</dd>
        </div>
        <div v-if="selected.requestId">
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
        <div>
          <dt>事件说明</dt>
          <dd>{{ selected.message }}</dd>
        </div>
      </dl>
    </div>
    <footer class="modal-footer">
      <span /><button class="button" @click="selected = null">关闭</button>
    </footer></ModalShell
  >
</template>
