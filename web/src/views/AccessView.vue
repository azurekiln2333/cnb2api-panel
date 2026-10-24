<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  Braces,
  Copy,
  Eye,
  EyeOff,
  ShieldCheck,
  ArrowRight,
  Terminal,
  Plug,
  Check,
  LoaderCircle,
} from '@lucide/vue'
import { api } from '../api'
import { useConsole, copy, notify } from '../console'
import SsoSettings from '../components/SsoSettings.vue'
const { accounts } = useConsole()
const profile = ref({ publicUrl: '', maskedKey: '••••••••••••••••••••••••' })
const actualKey = ref('')
const reveal = ref(false)
const keyLoading = ref(false)
const protocol = ref<'openai' | 'anthropic' | 'newapi'>('openai')
const baseUrl = computed(() => profile.value.publicUrl || location.origin)
const model = computed(
  () =>
    accounts.value.flatMap((a) => (a.models.length ? a.models : a.discoveredModels))[0] ||
    'deepseek-v4.1-flash',
)
const example = computed(() =>
  protocol.value === 'openai'
    ? `curl ${baseUrl.value}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_GATEWAY_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model.value}",\n    "messages": [{"role": "user", "content": "你好"}],\n    "stream": true\n  }'`
    : protocol.value === 'anthropic'
      ? `export ANTHROPIC_BASE_URL="${baseUrl.value}"\nexport ANTHROPIC_AUTH_TOKEN="YOUR_GATEWAY_KEY"\nexport ANTHROPIC_MODEL="${model.value}"\n\nclaude`
      : `渠道类型    OpenAI\n代理地址    ${baseUrl.value}\n密钥        YOUR_GATEWAY_KEY\n模型        ${model.value}`,
)
onMounted(async () => {
  try {
    profile.value = await api('/access')
  } catch (error) {
    notify(error instanceof Error ? error.message : '接入配置加载失败', true)
  }
})
async function getKey() {
  if (!actualKey.value)
    actualKey.value = (await api<{ key: string }>('/access/key', 'POST', {})).key
  return actualKey.value
}
async function showKey() {
  if (reveal.value) {
    reveal.value = false
    actualKey.value = ''
    return
  }
  keyLoading.value = true
  try {
    await getKey()
    reveal.value = true
  } catch (e) {
    notify(e instanceof Error ? e.message : '读取失败', true)
  } finally {
    keyLoading.value = false
  }
}
async function copyKey() {
  keyLoading.value = true
  try {
    await copy(await getKey())
    if (!reveal.value) actualKey.value = ''
  } catch (e) {
    notify(e instanceof Error ? e.message : '读取失败', true)
  } finally {
    keyLoading.value = false
  }
}
</script>

<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow"><span class="blue-line" />ONE ENDPOINT</div>
      <h1>接入配置</h1>
      <p>在客户端填入固定地址和网关 Key，账号切换由网关自动处理。</p>
    </div>
    <span class="protocol-label"><ShieldCheck :size="15" />标准协议兼容</span>
  </div>
  <section class="access-hero">
    <div class="access-hero-icon"><Braces :size="29" /></div>
    <div>
      <span class="eyebrow">YOUR UNIFIED ENDPOINT</span>
      <h2>一个地址，连起整个号池。</h2>
      <p>兼容 OpenAI 客户端与 Claude Code，支持流式响应和工具调用。</p>
    </div>
    <div class="access-hero-tags">
      <span><Check :size="12" />OpenAI</span><span><Check :size="12" />Anthropic</span>
    </div>
  </section>
  <div class="access-grid">
    <section class="section-panel">
      <header class="section-heading">
        <Plug :size="20" />
        <div>
          <h2>连接信息</h2>
          <p>网关地址固定，工作区随机域名可以自动跟随。</p>
        </div>
      </header>
      <div class="connection-fields">
        <label
          >OpenAI Base URL
          <div class="copy-field">
            <code>{{ baseUrl }}/v1</code
            ><button
              class="icon-button"
              aria-label="复制 OpenAI 地址"
              @click="copy(`${baseUrl}/v1`)"
            >
              <Copy :size="15" />
            </button></div></label
        ><label
          >Anthropic Base URL
          <div class="copy-field">
            <code>{{ baseUrl }}</code
            ><button class="icon-button" aria-label="复制 Anthropic 地址" @click="copy(baseUrl)">
              <Copy :size="15" />
            </button></div></label
        ><label
          >统一网关 API Key
          <div class="copy-field">
            <code>{{ reveal ? actualKey : profile.maskedKey }}</code
            ><button
              class="icon-button"
              :disabled="keyLoading"
              :aria-label="reveal ? '隐藏网关密钥' : '显示网关密钥'"
              @click="showKey"
            >
              <LoaderCircle v-if="keyLoading" :size="15" class="spin" /><EyeOff
                v-else-if="reveal"
                :size="15"
              /><Eye v-else :size="15" /></button
            ><button
              class="icon-button"
              :disabled="keyLoading"
              aria-label="复制网关密钥"
              @click="copyKey"
            >
              <Copy :size="15" />
            </button>
          </div>
          <small>由主机 GATEWAY_KEY 配置，修改后重启主机面板服务。</small></label
        >
      </div>
      <div class="access-security">
        <ShieldCheck :size="16" /><span
          >客户端使用网关 Key；工作区 Key、CNB 个人令牌和注册密钥分别独立。</span
        >
      </div>
    </section>
    <section class="section-panel client-guide">
      <header class="section-heading">
        <Terminal :size="20" />
        <div>
          <h2>快速开始</h2>
          <p>选择客户端，复制对应配置。</p>
        </div>
      </header>
      <div class="client-tabs" role="tablist" aria-label="客户端类型">
        <button
          role="tab"
          :aria-selected="protocol === 'openai'"
          :class="{ active: protocol === 'openai' }"
          @click="protocol = 'openai'"
        >
          OpenAI / cURL</button
        ><button
          role="tab"
          :aria-selected="protocol === 'anthropic'"
          :class="{ active: protocol === 'anthropic' }"
          @click="protocol = 'anthropic'"
        >
          Claude Code</button
        ><button
          role="tab"
          :aria-selected="protocol === 'newapi'"
          :class="{ active: protocol === 'newapi' }"
          @click="protocol = 'newapi'"
        >
          New API
        </button>
      </div>
      <div class="code-block">
        <div class="code-header">
          <span><Terminal :size="13" />{{ protocol === 'newapi' ? '渠道配置' : 'Terminal' }}</span
          ><button class="icon-button" aria-label="复制调用示例" @click="copy(example)">
            <Copy :size="14" />
          </button>
        </div>
        <pre>{{ example }}</pre>
      </div>
      <p class="inline-hint">
        将 YOUR_GATEWAY_KEY 替换为左侧的统一网关 Key。模型须在 CNB 工作区中实际可用。
      </p>
    </section>
  </div>
  <section class="section-panel access-flow">
    <span class="eyebrow">HOW IT CONNECTS</span>
    <div>
      <span
        ><span class="flow-step">01</span><strong>你的客户端</strong
        ><small>固定域名 + 网关 Key</small></span
      ><ArrowRight :size="20" /><span
        ><span class="flow-step">02</span><strong>主机统一网关</strong
        ><small>账号选择 / 故障切换</small></span
      ><ArrowRight :size="20" /><span
        ><span class="flow-step">03</span><strong>CNB 工作区</strong
        ><small>随机域名 / 自动注册</small></span
      ><ArrowRight :size="20" /><span
        ><span class="flow-step">04</span><strong>CNB 内网 AI</strong
        ><small>官方临时令牌</small></span
      >
    </div>
  </section>
  <SsoSettings />
</template>
