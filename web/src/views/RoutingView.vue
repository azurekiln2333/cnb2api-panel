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
} from '@lucide/vue'
import { api } from '../api'
import { notify, useConsole, accountState } from '../console'
import type { Settings } from '../types'

const { overview, accounts, refresh } = useConsole()
const form = reactive<Settings>({ ...overview.value!.settings })
const saving = ref(false)
const error = ref('')
const dirty = computed(() => JSON.stringify(form) !== JSON.stringify(overview.value?.settings))
watch(
  () => overview.value?.settings,
  (value, previous) => {
    if (value && JSON.stringify(form) === JSON.stringify(previous)) Object.assign(form, value)
  },
)
const strategies = [
  {
    id: 'weighted',
    title: '加权轮询',
    english: 'WEIGHTED ROUND ROBIN',
    icon: Scale,
    description: '按权重平滑分配请求，让多个账号共同承担流量。',
    tag: '适合日常使用',
  },
  {
    id: 'least-connections',
    title: '最少连接',
    english: 'LEAST CONNECTIONS',
    icon: ArrowDownUp,
    description: '优先选择当前并发相对权重最低的工作区。',
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
  saving.value = true
  try {
    await api('/settings', 'PATCH', form)
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
