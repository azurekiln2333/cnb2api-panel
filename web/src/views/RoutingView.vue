<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import {
  Waypoints,
  Scale,
  GitBranch,
  ArrowDownUp,
  Check,
  Save,
  ShieldCheck,
  Timer,
  ArrowRight,
  Server,
  LoaderCircle,
  Info,
  Braces,
} from '@lucide/vue'
import { api } from '../api'
import { notify, useConsole, accountState } from '../console'
import type { Settings } from '../types'
import RegistrationRelaySettings from '../components/RegistrationRelaySettings.vue'

const { overview, accounts, refresh } = useConsole()
type RoutingFields = Omit<Settings, 'requestOverrides' | 'upstreamHeaders'>

const allowedHeaders = [
  'user-agent',
  'accept',
  'x-product-code',
  'x-ide-name',
  'x-ide-type',
  'x-ide-version',
  'x-agent-intent',
  'x-agent-type',
]
const json = (value: unknown) => JSON.stringify(value, null, 2)
const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function normalized(settings: Settings): Settings {
  return JSON.parse(
    JSON.stringify({
      ...settings,
      dshCompat: settings.dshCompat ?? true,
      requestOverrides: settings.requestOverrides ?? { operations: [] },
      upstreamHeaders: settings.upstreamHeaders ?? {},
      registrationRelay: settings.registrationRelay ?? { enabled: false, servers: [] },
    }),
  ) as Settings
}
function routingFields(settings: Settings): RoutingFields {
  const { requestOverrides: _overrides, upstreamHeaders: _headers, ...fields } = settings
  return fields
}
const saved = ref(normalized(overview.value!.settings))
const form = reactive<RoutingFields>(routingFields(saved.value))
const overridesText = ref(json(saved.value.requestOverrides))
const headersText = ref(json(saved.value.upstreamHeaders))
const saving = ref(false)
const error = ref('')
const attempted = ref(false)
const overridesTouched = ref(false)
const headersTouched = ref(false)
const dirty = computed(
  () =>
    JSON.stringify(form) !== JSON.stringify(routingFields(saved.value)) ||
    overridesText.value !== json(saved.value.requestOverrides) ||
    headersText.value !== json(saved.value.upstreamHeaders),
)
function applyDraft(settings: Settings) {
  Object.assign(form, routingFields(settings))
  overridesText.value = json(settings.requestOverrides)
  headersText.value = json(settings.upstreamHeaders)
  attempted.value = false
  overridesTouched.value = false
  headersTouched.value = false
}
const overridesValidation = computed(() => {
  let value: unknown
  try {
    value = JSON.parse(overridesText.value)
  } catch {
    return { value: null, error: '参数覆盖不是有效的 JSON。' }
  }
  if (!isObject(value) || !Array.isArray(value.operations) || !value.operations.every(isObject))
    return { value: null, error: '参数覆盖须包含 operations 对象数组。' }
  return { value: value as Settings['requestOverrides'], error: '' }
})
const headersValidation = computed(() => {
  let value: unknown
  try {
    value = JSON.parse(headersText.value)
  } catch {
    return { value: null, error: '请求头覆盖不是有效的 JSON。' }
  }
  if (!isObject(value)) return { value: null, error: '请求头覆盖须为 JSON 对象。' }
  if (Object.keys(value).some((name) => !allowedHeaders.includes(name.toLowerCase())))
    return { value: null, error: '请求头名称不在允许列表中。' }
  if (Object.values(value).some((header) => typeof header !== 'string'))
    return { value: null, error: '请求头的值须为字符串。' }
  return { value: value as Settings['upstreamHeaders'], error: '' }
})
const relayValidation = computed(() => {
  const relay = form.registrationRelay
  if (relay.servers.length > 20) return { value: null, error: '最多添加 20 台服务器。' }
  const origins = new Set<string>()
  const servers = []
  for (const [index, server] of relay.servers.entries()) {
    const label = `第 ${index + 1} 台服务器`
    const name = server.name.trim()
    if (!name || name.length > 80) return { value: null, error: `${label}的名称须为 1 至 80 字。` }
    let url: URL
    try {
      url = new URL(server.origin.trim())
    } catch {
      return { value: null, error: `${label}的域名须为完整 HTTPS 地址。` }
    }
    const loopback =
      url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (
      (url.protocol !== 'https:' && !loopback) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      server.origin.length > 500
    )
      return { value: null, error: `${label}的域名不能包含路径、参数或凭据。` }
    if (origins.has(url.origin)) return { value: null, error: '服务器域名不能重复。' }
    origins.add(url.origin)
    servers.push({ ...server, name, origin: url.origin })
  }
  return { value: { enabled: relay.enabled, servers }, error: '' }
})
watch(
  () => overview.value?.settings,
  (value) => {
    // The PATCH response is authoritative while an older overview request may still be in flight.
    if (!value || saving.value) return
    const wasDirty = dirty.value
    saved.value = normalized(value)
    if (!wasDirty) applyDraft(saved.value)
  },
)
const strategies = [
  {
    id: 'weighted',
    title: '加权轮询',
    english: 'WEIGHTED ROUND ROBIN',
    icon: Scale,
    description: '按权重分配新会话，让多个账号共同承担流量。',
    tag: '适合日常使用',
  },
  {
    id: 'least-connections',
    title: '最少连接',
    english: 'LEAST CONNECTIONS',
    icon: ArrowDownUp,
    description: '新会话优先选择当前并发相对权重最低的工作区。',
    tag: '适合长连接',
  },
  {
    id: 'failover',
    title: '优先故障转移',
    english: 'PRIORITY FAILOVER',
    icon: GitBranch,
    description: '固定优先使用高权重账号，故障时切到下一个。',
    tag: '适合主备部署',
  },
] as const
const eligible = computed(() =>
  accounts.value
    .filter((a) => accountState(a) === 'healthy')
    .sort((a, b) => b.priority - a.priority || b.weight - a.weight),
)
async function save() {
  error.value = ''
  attempted.value = true
  const overrides = overridesValidation.value.value
  const headers = headersValidation.value.value
  const relay = relayValidation.value.value
  if (!overrides || !headers || !relay) return
  const submitted = JSON.stringify([form, overridesText.value, headersText.value])
  saving.value = true
  try {
    const result = await api<{ settings: Settings }>('/settings', 'PATCH', {
      ...form,
      requestOverrides: overrides,
      upstreamHeaders: headers,
      registrationRelay: relay,
    })
    const unchanged = submitted === JSON.stringify([form, overridesText.value, headersText.value])
    saved.value = normalized(result.settings)
    if (unchanged) applyDraft(saved.value)
    await refresh()
    notify('路由配置已保存并即时生效')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />TRAFFIC CONTROL</div>
      <h1>路由策略</h1>
      <p>决定请求怎样进入号池，以及发生故障时如何继续。</p>
    </div>
    <button class="button primary" :disabled="!dirty || saving" @click="save">
      <LoaderCircle v-if="saving" :size="16" class="spin" /><Save v-else :size="16" />{{
        saving ? '正在保存' : '保存配置'
      }}
    </button>
  </div>
  <form @submit.prevent="save">
    <section class="section-panel">
      <header class="section-heading">
        <span class="section-number">01</span>
        <div>
          <h2>请求分配方式</h2>
          <p>所有策略均优先使用数值最高的优先级；该层不可用时，自动向下选择。</p>
        </div>
      </header>
      <div class="strategy-grid" role="radiogroup" aria-label="路由策略">
        <button
          v-for="strategy in strategies"
          :key="strategy.id"
          type="button"
          class="strategy-card"
          :class="{ selected: form.strategy === strategy.id }"
          role="radio"
          :aria-checked="form.strategy === strategy.id"
          @click="form.strategy = strategy.id"
        >
          <span class="strategy-card-top"
            ><component :is="strategy.icon" :size="23" /><span class="radio-indicator"
              ><Check v-if="form.strategy === strategy.id" :size="12" /></span></span
          ><span class="eyebrow">{{ strategy.english }}</span
          ><strong>{{ strategy.title }}</strong>
          <p>{{ strategy.description }}</p>
          <span class="strategy-tag">{{ strategy.tag }}</span>
        </button>
      </div>
      <div class="affinity-settings">
        <label class="affinity-toggle">
          <input v-model="form.sessionAffinity" type="checkbox" />
          <span
            ><strong>会话粘性</strong
            ><small>同一会话优先沿用原账号，减少切换对上游缓存的影响。</small></span
          >
        </label>
        <p class="subtle">
          优先识别会话 ID。没有 ID 时，匹配系统提示和首条用户消息。绑定空闲 1 小时后失效。
        </p>
        <p class="subtle">账号不可用或优先级改变时重新分配。关闭后，每次请求都按所选策略分配。</p>
      </div>
    </section>
    <div class="routing-settings-grid">
      <section class="section-panel">
        <header class="section-heading">
          <ShieldCheck :size="20" />
          <div>
            <h2>失败切换与冷却</h2>
            <p>仅在尚未向客户端发送响应时重试。</p>
          </div>
        </header>
        <div class="settings-fields">
          <label
            ><span>最大尝试次数<small>包括首次请求；每次选择不同账号。</small></span>
            <div class="unit-input">
              <input
                v-model.number="form.maxAttempts"
                type="number"
                min="1"
                max="10"
                required
              /><span>次</span>
            </div></label
          ><label
            ><span>基础冷却时间<small>连续失败时指数增长，最长 1 小时。</small></span>
            <div class="unit-input">
              <input
                v-model.number="form.cooldownSeconds"
                type="number"
                min="5"
                max="3600"
                required
              /><span>秒</span>
            </div></label
          >
          <div class="note-box">
            <Info :size="15" /><span
              >连接故障、401 / 402 / 403 / 408 / 429 与 5xx
              会触发切换。已开始的流式响应中断后会结束连接。</span
            >
          </div>
        </div>
      </section>
      <section class="section-panel">
        <header class="section-heading">
          <Timer :size="20" />
          <div>
            <h2>探活与连接</h2>
            <p>验证工作区鉴权和模型接口的可用性。</p>
          </div>
        </header>
        <div class="settings-fields">
          <label
            ><span>自动探活间隔<small>仅检查启用且已结束冷却的账号。</small></span>
            <div class="unit-input">
              <input
                v-model.number="form.healthIntervalSeconds"
                type="number"
                min="15"
                max="3600"
                required
              /><span>秒</span>
            </div></label
          ><label
            ><span>连接等待超时<small>等待工作区首次返回响应头。</small></span>
            <div class="unit-input">
              <input
                v-model.number="form.connectTimeoutSeconds"
                type="number"
                min="1"
                max="120"
                required
              /><span>秒</span>
            </div></label
          ><label
            ><span>流式空闲超时<small>上游持续无数据时主动结束连接。</small></span>
            <div class="unit-input">
              <input
                v-model.number="form.idleTimeoutSeconds"
                type="number"
                min="10"
                max="1800"
                required
              /><span>秒</span>
            </div></label
          >
        </div>
      </section>
    </div>
    <RegistrationRelaySettings
      v-model="form.registrationRelay"
      :saved-config="saved.registrationRelay"
      :unsaved="dirty"
      :saving="saving"
      :validation-error="attempted ? relayValidation.error : ''"
    />
    <section class="section-panel overrides-panel">
      <header class="section-heading">
        <Braces :size="20" />
        <div>
          <h2>请求覆盖</h2>
          <p>配置全局参数规则和上游请求头。</p>
        </div>
      </header>
      <div class="override-settings">
        <label class="affinity-toggle">
          <input v-model="form.dshCompat" type="checkbox" />
          <span>
            <strong>CNB / DSH 兼容预设</strong>
            <small>
              预设把 Chat Completions 请求的所有 developer 角色改为 system。 这项转换不依赖 DSH
              标识。角色转换会改变消息优先级。检测到 DSH 标识时，预设会改写 system / developer 的
              DSH 身份、名称和路径提示。预设也会替换 assistant 历史中的两种 DSH 身份句。
              模型收到改写后的内容。用户和工具内容不变。
            </small>
          </span>
        </label>
        <div class="override-grid">
          <div class="override-field">
            <div class="override-field-heading">
              <label for="request-overrides">参数覆盖</label>
              <div class="override-actions">
                <button
                  type="button"
                  class="text-link"
                  @click="overridesText = json({ operations: [] })"
                >
                  清空规则
                </button>
                <button
                  type="button"
                  class="text-link"
                  @click="overridesText = json(saved.requestOverrides)"
                >
                  恢复已保存的规则
                </button>
              </div>
            </div>
            <p class="subtle">按 operations 数组顺序应用规则。</p>
            <textarea
              id="request-overrides"
              v-model="overridesText"
              class="mono"
              spellcheck="false"
              rows="9"
              :aria-invalid="(attempted || overridesTouched) && !!overridesValidation.error"
              aria-describedby="request-overrides-error"
              @blur="overridesTouched = true"
            />
            <p
              v-if="(attempted || overridesTouched) && overridesValidation.error"
              id="request-overrides-error"
              class="form-error"
              role="alert"
            >
              {{ overridesValidation.error }}
            </p>
          </div>
          <div class="override-field">
            <div class="override-field-heading">
              <label for="upstream-headers">请求头覆盖</label>
              <div class="override-actions">
                <button type="button" class="text-link" @click="headersText = json({})">
                  清空请求头
                </button>
                <button
                  type="button"
                  class="text-link"
                  @click="headersText = json(saved.upstreamHeaders)"
                >
                  恢复已保存的请求头
                </button>
              </div>
            </div>
            <p class="subtle">仅允许以下请求头名称：</p>
            <p class="override-header-names">
              <code v-for="name in allowedHeaders" :key="name">{{ name }}</code>
            </p>
            <textarea
              id="upstream-headers"
              v-model="headersText"
              class="mono"
              spellcheck="false"
              rows="9"
              :aria-invalid="(attempted || headersTouched) && !!headersValidation.error"
              aria-describedby="upstream-headers-error"
              @blur="headersTouched = true"
            />
            <p
              v-if="(attempted || headersTouched) && headersValidation.error"
              id="upstream-headers-error"
              class="form-error"
              role="alert"
            >
              {{ headersValidation.error }}
            </p>
            <p class="subtle">工作区支持不代表服务商已收到请求头。</p>
          </div>
        </div>
      </div>
    </section>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </form>
  <section class="section-panel route-map-panel">
    <header class="section-heading">
      <Waypoints :size="20" />
      <div>
        <h2>当前可用的路由路径</h2>
        <p>账号的模型范围还会进一步筛选每一次请求。</p>
      </div>
      <span class="subtle">{{ eligible.length }} 个可用工作区</span>
    </header>
    <div class="route-map">
      <div class="route-source">
        <span class="stat-icon blue"><Waypoints :size="22" /></span><strong>统一 API 入口</strong
        ><code>/v1/*</code>
      </div>
      <ArrowRight class="route-map-arrow" :size="25" />
      <div class="route-targets">
        <div v-for="a in eligible.slice(0, 6)" :key="a.id">
          <Server :size="17" /><strong>{{ a.name }}</strong
          ><span>P{{ a.priority }}</span
          ><span>权重 {{ a.weight }}</span
          ><i class="status-dot green" />
        </div>
        <p v-if="!eligible.length" class="subtle">工作区探活通过后，路由路径会出现在这里。</p>
        <p v-if="eligible.length > 6" class="subtle">还有 {{ eligible.length - 6 }} 个可用账号</p>
      </div>
    </div>
  </section>
</template>
