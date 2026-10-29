<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, Info, Layers, LoaderCircle, RefreshCw, Search, X } from '@lucide/vue'
import { api } from '../api'
import { copy } from '../console'
import type { ModelInventory, ModelInventoryEntry } from '../types'

const models = ref<ModelInventoryEntry[]>([])
const search = ref('')
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
let active = false
let generation = 0
let poll: number | undefined

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase()
  return models.value.filter((model) =>
    [
      model.id,
      ...(model.configuredAccounts.length ? ['配置声明'] : []),
      ...(model.discoveredAccounts.length ? ['上游发现'] : []),
      ...model.configuredAccounts.flatMap((account) => [account.id, account.name]),
      ...model.discoveredAccounts.flatMap((account) => [account.id, account.name]),
      ...model.eligibleAccounts.flatMap((account) => [account.id, account.name]),
    ]
      .join(' ')
      .toLowerCase()
      .includes(query),
  )
})

async function refresh() {
  if (!active || document.hidden || loading.value) return
  const request = ++generation
  loading.value = true
  try {
    const result = await api<ModelInventory>('/models')
    if (!active || request !== generation) return
    if (!Array.isArray(result.models)) throw new Error('模型列表格式不正确。')
    models.value = result.models
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation)
      error.value = cause instanceof Error ? cause.message : '无法读取模型列表。'
  } finally {
    if (active && request === generation) loading.value = false
  }
}
onMounted(() => {
  active = true
  void refresh()
  poll = window.setInterval(() => void refresh(), 15000)
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
})
onBeforeUnmount(() => {
  active = false
  generation++
  window.clearInterval(poll)
  window.removeEventListener('focus', refresh)
  document.removeEventListener('visibilitychange', refresh)
})
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />MODEL CATALOG</div>
      <h1>模型列表</h1>
      <p>查看账号声明、上游发现和当前路由状态。</p>
    </div>
    <button type="button" class="button" :disabled="loading" @click="refresh">
      <RefreshCw :size="15" :class="{ spin: loading }" />刷新模型
    </button>
  </div>
  <div class="note-box models-note">
    <Info :size="16" />
    <span>
      上游发现不代表推理已验证。配置声明表示账号允许使用该模型。公开列表对应 /v1/models。
      路由就绪账号已通过当前路由检查，可能包含未限制模型的账号。
    </span>
  </div>
  <section class="pool-panel models-panel" aria-label="模型目录">
    <div class="table-toolbar">
      <div class="search-field">
        <Search :size="16" />
        <input v-model="search" aria-label="搜索模型" placeholder="搜索模型 ID、账号或来源…" />
        <button
          v-if="search"
          type="button"
          class="icon-button"
          aria-label="清空模型搜索"
          @click="search = ''"
        >
          <X :size="13" />
        </button>
      </div>
      <span class="subtle models-count">{{ filtered.length }} / {{ models.length }} 个模型</span>
    </div>
    <div v-if="error" class="models-error" role="alert">
      <span>{{ error }}</span>
      <button type="button" class="button small" :disabled="loading" @click="refresh">
        重试读取模型
      </button>
    </div>
    <div v-if="loading && !loaded" class="empty-filter" role="status">
      <LoaderCircle :size="28" class="spin" />
      <h3>正在读取模型列表</h3>
    </div>
    <table v-else-if="filtered.length" class="models-table">
      <thead>
        <tr>
          <th>模型 ID</th>
          <th>来源及账号</th>
          <th>公开列表</th>
          <th>当前路由</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="model in filtered" :key="model.id" :data-model-id="model.id">
          <td data-label="模型 ID">
            <div class="model-id">
              <strong class="mono">{{ model.id }}</strong>
              <button
                type="button"
                class="icon-button"
                :aria-label="`复制模型 ID ${model.id}`"
                @click="copy(model.id)"
              >
                <Copy :size="15" />
              </button>
            </div>
          </td>
          <td data-label="来源及账号">
            <div v-if="model.discoveredAccounts.length" class="model-source">
              <span class="model-tag discovered">上游发现</span>
              <span>{{ model.discoveredAccounts.map((account) => account.name).join('、') }}</span>
            </div>
            <div v-if="model.configuredAccounts.length" class="model-source">
              <span class="model-tag">配置声明</span>
              <span>{{ model.configuredAccounts.map((account) => account.name).join('、') }}</span>
            </div>
          </td>
          <td data-label="公开列表">
            <span class="model-listed" :class="{ listed: model.listed }">{{
              model.listed ? '已收录' : '未收录'
            }}</span>
          </td>
          <td data-label="当前路由">
            <strong class="model-ready" :class="{ ready: model.eligibleAccounts.length }"
              >{{ model.eligibleAccounts.length }} 个就绪账号</strong
            >
            <p class="model-accounts">
              {{
                model.eligibleAccounts.map((account) => account.name).join('、') || '暂无就绪账号'
              }}
            </p>
          </td>
        </tr>
      </tbody>
    </table>
    <div v-else-if="loaded" class="empty-filter">
      <Layers :size="30" />
      <h3>{{ search.trim() ? '没有匹配的模型' : '暂无模型' }}</h3>
      <p>
        {{
          search.trim()
            ? '更换模型 ID、账号或来源后重试。'
            : '先配置账号模型，或探活工作区以发现模型。'
        }}
      </p>
      <button v-if="search.trim()" type="button" class="button" @click="search = ''">
        清空模型搜索
      </button>
    </div>
  </section>
</template>

<style scoped>
.models-note {
  margin-bottom: 20px;
}
.models-note > span {
  line-height: 1.8;
}
.models-count {
  font-size: 12px;
  white-space: nowrap;
}
.models-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--line);
  color: var(--red);
  font-size: 13px;
  overflow-wrap: anywhere;
}
.models-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  text-align: left;
  font-size: 13px;
}
.models-table th,
.models-table td {
  padding: 18px 20px;
  border-top: 1px solid var(--line);
  vertical-align: top;
  overflow-wrap: anywhere;
}
.models-table th {
  color: var(--muted);
  background: var(--surface-subtle);
  font-size: 12px;
  font-weight: 500;
}
.models-table th:nth-child(1) {
  width: 28%;
}
.models-table th:nth-child(2) {
  width: 31%;
}
.models-table th:nth-child(3) {
  width: 13%;
}
.model-id {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  line-height: 1.8;
}
.model-id > strong {
  min-width: 0;
}
.model-id > button {
  flex-shrink: 0;
}
.model-source {
  display: grid;
  justify-items: start;
  gap: 7px;
  line-height: 1.7;
}
.model-source + .model-source {
  margin-top: 14px;
}
.model-tag {
  padding: 2px 6px;
  border: 1px solid var(--line);
  border-radius: var(--radius-xs);
  color: var(--secondary);
  font-size: 11px;
}
.model-tag.discovered {
  background: var(--primary-soft);
  border-color: transparent;
  color: var(--primary);
}
.model-listed,
.model-ready {
  color: var(--muted);
  line-height: 1.8;
}
.model-listed.listed,
.model-ready.ready {
  color: var(--green);
}
.model-accounts {
  margin: 7px 0 0;
  line-height: 1.8;
  color: var(--secondary);
}
@media (max-width: 700px) {
  .models-panel .table-toolbar {
    flex-wrap: wrap;
  }
  .models-panel .search-field {
    max-width: none;
    min-width: 0;
  }
  .models-error {
    align-items: flex-start;
    flex-direction: column;
  }
  .models-table,
  .models-table tbody {
    display: block;
  }
  .models-table thead {
    display: none;
  }
  .models-table tr {
    display: grid;
    gap: 18px;
    padding: 20px;
    border-top: 1px solid var(--line);
  }
  .models-table td {
    padding: 0;
    border: 0;
  }
  .models-table td::before {
    display: block;
    margin-bottom: 7px;
    color: var(--muted);
    content: attr(data-label);
    font-size: 12px;
  }
}
</style>
