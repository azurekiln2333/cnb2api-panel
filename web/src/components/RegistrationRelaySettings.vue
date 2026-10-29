<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Info, LoaderCircle, Plus, RefreshCw, Server, Trash2 } from '@lucide/vue'
import { api } from '../api'
import { notify } from '../console'
import type {
  RegistrationRelayConfig,
  RegistrationRelayServer,
  RegistrationRelayServerStatus,
  RegistrationRelayStatus,
} from '../types'

const props = defineProps<{
  modelValue: RegistrationRelayConfig
  savedConfig: RegistrationRelayConfig
  unsaved: boolean
  saving: boolean
  validationError: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: RegistrationRelayConfig] }>()
const status = ref<RegistrationRelayStatus | null>(null)
const loading = ref(false)
const syncing = ref(false)
const statusError = ref('')
let active = false
let generation = 0
let pending = false
let poll: number | undefined
const statuses: Record<RegistrationRelayServerStatus['status'], string> = {
  disabled: '已停用',
  idle: '等待注册',
  pending: '同步中',
  success: '同步成功',
  failed: '同步失败',
}
const savedServers = computed(() =>
  (status.value?.servers ?? []).filter((server) =>
    props.savedConfig.servers.some(
      (saved) => saved.id === server.id && saved.origin === server.origin,
    ),
  ),
)
const canSync = computed(
  () =>
    props.savedConfig.enabled &&
    props.savedConfig.servers.some((server) => server.enabled) &&
    !props.unsaved &&
    !props.saving &&
    !syncing.value,
)
const timestamp = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'

function editConfig(patch: Partial<RegistrationRelayConfig>) {
  emit('update:modelValue', { ...props.modelValue, ...patch })
}
function editServer(id: string, patch: Partial<RegistrationRelayServer>) {
  editConfig({
    servers: props.modelValue.servers.map((server) =>
      server.id === id ? { ...server, ...patch } : server,
    ),
  })
}
function addServer() {
  if (props.modelValue.servers.length >= 20) return
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const id = `peer-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  editConfig({
    servers: [...props.modelValue.servers, { id, name: '', origin: '', enabled: true }],
  })
}
function removeServer(id: string) {
  editConfig({ servers: props.modelValue.servers.filter((server) => server.id !== id) })
}
async function loadStatus() {
  if (!active || document.hidden || pending) return
  const request = generation
  pending = true
  loading.value = true
  try {
    const result = await api<RegistrationRelayStatus>('/registration-relay')
    if (!active || request !== generation) return
    if (!Array.isArray(result.servers)) throw new Error('注册联动状态格式不正确。')
    status.value = result
    statusError.value = ''
  } catch (error) {
    if (active && request === generation)
      statusError.value = error instanceof Error ? error.message : '无法读取注册联动状态。'
  } finally {
    if (active && request === generation) {
      pending = false
      loading.value = false
    }
  }
}
function reloadStatus() {
  generation++
  pending = false
  void loadStatus()
}
async function synchronize() {
  if (!canSync.value) return
  const request = generation
  syncing.value = true
  statusError.value = ''
  try {
    const result = await api<{ scheduled: number }>('/registration-relay/sync', 'POST', {})
    if (!active || request !== generation) return
    notify(`已安排 ${result.scheduled} 次同步`)
    reloadStatus()
  } catch (error) {
    if (active && request === generation)
      statusError.value = error instanceof Error ? error.message : '注册同步失败。'
  } finally {
    if (active) syncing.value = false
  }
}
watch(() => JSON.stringify(props.savedConfig), reloadStatus)
onMounted(() => {
  active = true
  void loadStatus()
  poll = window.setInterval(() => void loadStatus(), 5000)
  window.addEventListener('focus', loadStatus)
  document.addEventListener('visibilitychange', loadStatus)
})
onBeforeUnmount(() => {
  active = false
  generation++
  window.clearInterval(poll)
  window.removeEventListener('focus', loadStatus)
  document.removeEventListener('visibilitychange', loadStatus)
})
</script>

<template>
  <section class="section-panel relay-panel" aria-labelledby="registration-relay-title">
    <header class="section-heading">
      <Server :size="20" />
      <div>
        <h2 id="registration-relay-title">注册联动</h2>
        <p>主服务器保存工作区地址，再同步到其他服务器。</p>
      </div>
    </header>
    <div class="relay-content">
      <label class="affinity-toggle">
        <input
          :checked="modelValue.enabled"
          type="checkbox"
          @change="editConfig({ enabled: ($event.target as HTMLInputElement).checked })"
        />
        <span>
          <strong>主服务器注册联动</strong>
          <small>仅主服务器开启。工作区只向主服务器注册。</small>
        </span>
      </label>
      <div class="note-box relay-note">
        <Info :size="15" />
        <span>
          各服务器先添加对应账号。填写相同 REG_TOKEN 和正确 PROXY_KEY。账号 ID 可以不同。
          从服务器需使用支持注册联动的版本。
        </span>
      </div>
      <div class="relay-list-heading">
        <strong>目标服务器</strong>
        <button
          type="button"
          class="button small"
          :disabled="modelValue.servers.length >= 20"
          @click="addServer"
        >
          <Plus :size="15" />添加服务器
        </button>
      </div>
      <p v-if="!modelValue.servers.length" class="subtle relay-empty">尚未添加服务器。</p>
      <div
        v-for="(server, index) in modelValue.servers"
        :key="server.id"
        class="relay-server"
        :data-server-id="server.id"
      >
        <label :for="`relay-name-${server.id}`">
          <span>服务器名称</span>
          <input
            :id="`relay-name-${server.id}`"
            :value="server.name"
            :aria-label="`服务器名称 ${index + 1}`"
            maxlength="80"
            placeholder="例如：香港服务器"
            @input="editServer(server.id, { name: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label :for="`relay-origin-${server.id}`">
          <span>服务器域名</span>
          <input
            :id="`relay-origin-${server.id}`"
            :value="server.origin"
            :aria-label="`服务器域名 ${index + 1}`"
            type="url"
            maxlength="500"
            placeholder="https://panel.example.com"
            autocomplete="off"
            spellcheck="false"
            @input="editServer(server.id, { origin: ($event.target as HTMLInputElement).value })"
          />
        </label>
        <label class="relay-server-enabled">
          <input
            :checked="server.enabled"
            :aria-label="`启用服务器 ${server.name || index + 1}`"
            type="checkbox"
            @change="
              editServer(server.id, { enabled: ($event.target as HTMLInputElement).checked })
            "
          />启用
        </label>
        <button
          type="button"
          class="button danger small"
          :aria-label="`删除服务器 ${server.name || index + 1}`"
          @click="removeServer(server.id)"
        >
          <Trash2 :size="15" />删除
        </button>
      </div>
      <p class="subtle relay-hint">最多 20 台。域名使用 HTTPS，不含路径或参数。</p>
      <p v-if="validationError" class="form-error" role="alert">{{ validationError }}</p>

      <div class="relay-list-heading relay-status-heading">
        <div>
          <strong>已保存服务器的同步状态</strong>
          <p class="subtle">失败后自动重试。手动同步会重新提交当前工作区地址。</p>
        </div>
        <button type="button" class="button small" :disabled="!canSync" @click="synchronize">
          <LoaderCircle v-if="syncing" :size="15" class="spin" />
          <RefreshCw v-else :size="15" />同步现有工作区
        </button>
      </div>
      <p v-if="unsaved" class="subtle relay-hint">保存配置后可手动同步。</p>
      <p v-if="statusError" class="form-error" role="alert">
        {{ statusError }}
        <button type="button" class="text-link" @click="reloadStatus">重试读取状态</button>
      </p>
      <p v-if="loading && !status" class="subtle relay-empty" role="status">正在读取同步状态…</p>
      <div v-for="server in savedServers" :key="server.id" class="relay-status">
        <div class="relay-status-top">
          <div>
            <strong>{{ server.name }}</strong>
            <p class="mono subtle">{{ server.origin }}</p>
          </div>
          <span class="relay-state" :class="server.status">{{ statuses[server.status] }}</span>
        </div>
        <dl class="relay-status-details">
          <div>
            <dt>待同步</dt>
            <dd>{{ server.pending }}</dd>
          </div>
          <div>
            <dt>失败</dt>
            <dd>{{ server.failed }}</dd>
          </div>
          <div>
            <dt>最近成功</dt>
            <dd>{{ timestamp(server.lastSuccessAt) }}</dd>
          </div>
          <div>
            <dt>最近尝试</dt>
            <dd>{{ timestamp(server.lastAttemptAt) }}</dd>
          </div>
        </dl>
        <p v-if="server.lastError" class="form-error relay-delivery-error">
          {{ server.lastError }}
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.relay-content {
  padding: 0 23px 23px;
}
.relay-note {
  margin-top: 16px;
}
.relay-list-heading,
.relay-status-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.relay-list-heading {
  margin-top: 22px;
}
.relay-list-heading p {
  margin: 6px 0 0;
  line-height: 1.7;
}
.relay-server {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.7fr) auto auto;
  align-items: end;
  gap: 12px;
  padding: 16px 0;
  border-bottom: 1px solid var(--line);
}
.relay-server > label:not(.relay-server-enabled) {
  display: grid;
  gap: 7px;
  min-width: 0;
  font-size: 12px;
}
.relay-server input:not([type='checkbox']) {
  width: 100%;
  min-width: 0;
}
.relay-server-enabled {
  display: flex;
  align-items: center;
  align-self: center;
  gap: 7px;
  padding-top: 20px;
  font-size: 13px;
}
.relay-hint,
.relay-empty {
  margin: 13px 0 0;
  line-height: 1.7;
}
.relay-status-heading {
  padding-top: 20px;
  border-top: 1px solid var(--line);
}
.relay-status {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.relay-status-top > div {
  min-width: 0;
}
.relay-status-top p {
  margin: 6px 0 0;
  overflow-wrap: anywhere;
}
.relay-state {
  flex-shrink: 0;
  padding: 4px 8px;
  background: var(--surface-subtle);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.relay-state.success {
  color: var(--green);
}
.relay-state.failed {
  color: var(--red);
}
.relay-state.pending {
  color: var(--primary);
}
.relay-status-details {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 22px;
  margin: 16px 0 0;
  font-size: 12px;
}
.relay-status-details > div {
  display: grid;
  gap: 5px;
}
.relay-status-details dt {
  color: var(--muted);
}
.relay-status-details dd {
  margin: 0;
}
.relay-delivery-error {
  margin: 12px 0 0;
  overflow-wrap: anywhere;
}
@media (max-width: 700px) {
  .relay-content {
    padding: 0 16px 16px;
  }
  .relay-server {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .relay-server > label:not(.relay-server-enabled) {
    grid-column: 1 / -1;
  }
  .relay-server-enabled {
    padding-top: 0;
  }
  .relay-list-heading {
    align-items: flex-start;
    flex-wrap: wrap;
  }
}
</style>
