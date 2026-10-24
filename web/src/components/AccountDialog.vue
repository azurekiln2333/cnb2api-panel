<script setup lang="ts">
import { onBeforeUnmount, reactive, ref } from 'vue'
import {
  KeyRound,
  Server,
  SlidersHorizontal,
  LoaderCircle,
  Info,
  RefreshCw,
  Eye,
  EyeOff,
  Copy,
} from '@lucide/vue'
import { api } from '../api'
import { copy, notify, useConsole } from '../console'
import type { Account } from '../types'
import ModalShell from './ModalShell.vue'

const props = defineProps<{ account: Account | null }>()
const emit = defineEmits<{ close: [] }>()
const { refresh, registration } = useConsole()
const a = props.account
const form = reactive({
  name: a?.name ?? '',
  repo: a?.repo ?? '',
  group: a?.group ?? '默认分组',
  endpoint: a?.endpoint ?? '',
  proxyKey: '',
  registrationToken: '',
  pat: '',
  models: a?.models.join(', ') ?? '',
  weight: a?.weight ?? 1,
  priority: a?.priority ?? 0,
  enabled: a?.enabled ?? true,
  autoWake: a?.autoWake ?? false,
  branch: a?.branch ?? 'main',
})
const advanced = ref(Boolean(a?.hasPat || a?.models.length || a?.priority))
const removePat = ref(false)
const saving = ref(false)
const error = ref('')
const generatedToken = ref('')
const registrationVisible = ref(false)
const proxyVisible = ref(false)
const patVisible = ref(false)
type SecretField = 'proxyKey' | 'registrationToken' | 'pat'
type Credentials = Record<SecretField, string>
const savedCredentials: Credentials = { proxyKey: '', registrationToken: '', pat: '' }
const credentialLoading = reactive<Record<SecretField, boolean>>({
  proxyKey: false,
  registrationToken: false,
  pat: false,
})
const edits: Record<SecretField, number> = { proxyKey: 0, registrationToken: 0, pat: 0 }
const visibility = {
  proxyKey: proxyVisible,
  registrationToken: registrationVisible,
  pat: patVisible,
}
let credentialsLoaded = false
let credentialsRequest: Promise<void> | null = null
let disposed = false

function hasSavedCredential(field: SecretField) {
  return Boolean(a && (field === 'pat' ? a.hasPat : field === 'proxyKey' ? a.hasProxyKey : true))
}

function canReadCredential(field: SecretField) {
  return (
    !saving.value &&
    !credentialLoading[field] &&
    !(field === 'pat' && removePat.value) &&
    Boolean(form[field] || hasSavedCredential(field))
  )
}

async function readCredential(field: SecretField) {
  if (form[field] || !hasSavedCredential(field)) return form[field]
  const revision = edits[field]
  if (!credentialsLoaded && a) {
    credentialsRequest ??= api<Credentials>(`/accounts/${a.id}/credentials`, 'POST', {})
      .then((result) => {
        if (disposed) return
        for (const key of ['proxyKey', 'registrationToken', 'pat'] as const)
          savedCredentials[key] = result[key] || ''
        credentialsLoaded = true
      })
      .finally(() => {
        credentialsRequest = null
      })
    await credentialsRequest
  }
  if (disposed || (field === 'pat' && removePat.value)) return ''
  // An operator may edit or clear the input while the saved value is loading.
  if (edits[field] === revision && !form[field]) form[field] = savedCredentials[field]
  return form[field]
}

async function useCredential(field: SecretField, operation: 'toggle' | 'copy') {
  if (!canReadCredential(field)) return
  const visible = visibility[field]
  if (operation === 'toggle' && visible.value) {
    visible.value = false
    return
  }
  credentialLoading[field] = true
  try {
    const value = await readCredential(field)
    if (disposed || (field === 'pat' && removePat.value)) return
    if (operation === 'copy') {
      if (value) await copy(value)
    } else if (value) visible.value = true
  } catch (e) {
    if (!disposed) notify(e instanceof Error ? e.message : '账号凭据读取失败', true)
  } finally {
    credentialLoading[field] = false
  }
}

onBeforeUnmount(() => {
  disposed = true
  for (const field of ['proxyKey', 'registrationToken', 'pat'] as const) {
    form[field] = ''
    savedCredentials[field] = ''
    visibility[field].value = false
  }
  generatedToken.value = ''
})

function generateRegistrationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  generatedToken.value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  edits.registrationToken++
  form.registrationToken = generatedToken.value
  registrationVisible.value = true
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    const payload = {
      ...form,
      models: form.models
        .split(/[,，\n]/)
        .map((m) => m.trim())
        .filter(Boolean),
      proxyKey:
        form.proxyKey && form.proxyKey !== savedCredentials.proxyKey ? form.proxyKey : undefined,
      registrationToken:
        form.registrationToken && form.registrationToken !== savedCredentials.registrationToken
          ? form.registrationToken
          : undefined,
      pat: removePat.value
        ? ''
        : form.pat && form.pat !== savedCredentials.pat
          ? form.pat
          : undefined,
    }
    const generated = Boolean(
      generatedToken.value && payload.registrationToken === generatedToken.value,
    )
    const result = await api<{ account: Account; registrationToken?: string }>(
      a ? `/accounts/${a.id}` : '/accounts',
      a ? 'PATCH' : 'POST',
      payload,
    )
    await refresh()
    notify(
      a
        ? payload.registrationToken
          ? '注册密钥已更新，请同步工作区配置'
          : '账号配置已保存'
        : generated
          ? '账号已添加，请保存工作区注册配置'
          : '账号已添加，已沿用原有注册密钥',
    )
    emit('close')
    const token = a ? payload.registrationToken : result.registrationToken
    if (token && (a || generated)) registration.value = { account: result.account, token }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ModalShell
    :title="a ? '编辑账号' : '接入 CNB 账号'"
    subtitle="一个 CNB 工作区对应一条独立通道，共享统一的 API 入口。"
    wide
    @close="!saving && emit('close')"
  >
    <form @submit.prevent="save">
      <div class="modal-body account-form">
        <div class="form-section-title"><Server :size="16" /><span>工作区信息</span></div>
        <div class="form-grid">
          <label
            >账号名称 <span class="required">*</span
            ><input
              v-model="form.name"
              autofocus
              required
              maxlength="60"
              placeholder="例如：主力账号"
          /></label>
          <label
            >所属分组<input v-model="form.group" maxlength="40" placeholder="默认分组"
          /></label>
          <label class="span-2"
            >CNB 仓库路径（选填）<input
              v-model="form.repo"
              maxlength="200"
              placeholder="your-org / ai-proxy（不含空格）"
            /><small>仅同步额度或唤醒工作区时需要，普通注册和 API 转发可留空。</small></label
          >
          <label class="span-2"
            >工作区地址<input
              v-model="form.endpoint"
              placeholder="https://xxxxxxxx-9001.cnb.run"
              maxlength="500"
            /><small>可暂时留空。工作区启动后会用独立注册密钥自动更新地址。</small></label
          >
        </div>
        <div class="form-section-title"><KeyRound :size="16" /><span>工作区凭据</span></div>
        <p v-if="a" class="inline-hint">已保存的密钥可点击右侧眼睛查看或复制。</p>
        <div class="registration-field">
          <label for="account-proxy-key"
            >工作区 PROXY_KEY <span v-if="!a" class="required">*</span></label
          >
          <div class="input-with-action">
            <input
              id="account-proxy-key"
              v-model="form.proxyKey"
              @input="edits.proxyKey++"
              :type="proxyVisible ? 'text' : 'password'"
              :required="!a"
              autocomplete="new-password"
              aria-describedby="account-proxy-hint"
              :placeholder="a ? '已配置 · 留空保留原密钥' : '与云机 proxy.yml 中的 PROXY_KEY 一致'"
            /><button
              type="button"
              class="icon-button secret-action"
              :aria-label="proxyVisible ? '隐藏工作区密钥' : '显示工作区密钥'"
              :title="proxyVisible ? '隐藏工作区密钥' : '显示工作区密钥'"
              :aria-pressed="proxyVisible"
              :disabled="!canReadCredential('proxyKey')"
              @click="useCredential('proxyKey', 'toggle')"
            >
              <LoaderCircle v-if="credentialLoading.proxyKey" class="spin" :size="16" />
              <EyeOff v-else-if="proxyVisible" :size="16" /><Eye v-else :size="16" /></button
            ><button
              type="button"
              class="icon-button secret-action"
              aria-label="复制工作区密钥"
              title="复制工作区密钥"
              :disabled="!canReadCredential('proxyKey')"
              @click="useCredential('proxyKey', 'copy')"
            >
              <Copy :size="16" />
            </button>
          </div>
          <small id="account-proxy-hint" class="field-hint"
            >网关会用它访问该工作区；客户端使用的是统一网关 Key。</small
          >
        </div>
        <div class="registration-field">
          <label for="account-registration-token"
            >注册密钥 REG_TOKEN <span v-if="!a" class="required">*</span></label
          >
          <div class="input-with-action">
            <input
              id="account-registration-token"
              v-model="form.registrationToken"
              @input="edits.registrationToken++"
              :type="registrationVisible ? 'text' : 'password'"
              :required="!a"
              maxlength="4096"
              autocomplete="new-password"
              aria-describedby="account-registration-hint"
              :placeholder="a ? '留空保留原注册密钥' : '填写云机原有 REG_TOKEN，或点击右侧随机生成'"
            />
            <button
              type="button"
              class="icon-button secret-action"
              :aria-label="registrationVisible ? '隐藏注册密钥' : '显示注册密钥'"
              :title="registrationVisible ? '隐藏注册密钥' : '显示注册密钥'"
              :aria-pressed="registrationVisible"
              :disabled="!canReadCredential('registrationToken')"
              @click="useCredential('registrationToken', 'toggle')"
            >
              <LoaderCircle v-if="credentialLoading.registrationToken" class="spin" :size="16" />
              <EyeOff v-else-if="registrationVisible" :size="16" />
              <Eye v-else :size="16" />
            </button>
            <button
              type="button"
              class="icon-button secret-action"
              aria-label="复制注册密钥"
              title="复制注册密钥"
              :disabled="!canReadCredential('registrationToken')"
              @click="useCredential('registrationToken', 'copy')"
            >
              <Copy :size="16" />
            </button>
            <button
              type="button"
              class="button"
              :disabled="saving"
              @click="generateRegistrationToken"
            >
              <RefreshCw :size="14" />随机生成
            </button>
          </div>
          <small id="account-registration-hint" class="field-hint">{{
            a
              ? '留空保留原密钥；修改或随机生成后，保存时会替换旧密钥，请同步云机 REG_TOKEN。'
              : generatedToken && form.registrationToken === generatedToken
                ? '已生成随机密钥，可直接查看或点击复制；请将相同的 REG_TOKEN 填入云机。'
                : '已有工作区填写原 REG_TOKEN；新工作区可随机生成。每个工作区使用不同的密钥。'
          }}</small>
        </div>
        <div class="form-grid compact-grid">
          <label
            >路由权重<input
              v-model.number="form.weight"
              type="number"
              min="1"
              max="100"
              required
            /><small>同优先级下，权重越高分配越多。</small></label
          ><label
            >优先级<input
              v-model.number="form.priority"
              type="number"
              min="0"
              max="100"
              required
            /><small>数值大的先使用，故障后向下切换。</small></label
          >
        </div>
        <button
          type="button"
          class="advanced-toggle"
          :aria-expanded="advanced"
          @click="advanced = !advanced"
        >
          <SlidersHorizontal :size="15" />高级配置<span>{{ advanced ? '收起 −' : '展开 +' }}</span>
        </button>
        <div v-if="advanced" class="advanced-fields">
          <label
            >可路由模型<input
              v-model="form.models"
              placeholder="deepseek-v4.1-flash, glm-5.3-flash"
            /><small>用逗号分隔；留空允许该工作区的所有模型，模型列表会通过探活发现。</small></label
          >
          <div>
            <label for="account-personal-token">CNB 个人令牌（可选）</label>
            <div class="input-with-action">
              <input
                id="account-personal-token"
                v-model="form.pat"
                @input="edits.pat++"
                :type="patVisible && !removePat ? 'text' : 'password'"
                autocomplete="new-password"
                :disabled="removePat"
                :placeholder="
                  a?.hasPat ? '已配置 · 留空保留原令牌' : '用于同步额度、手动或自动唤醒工作区'
                "
              />
              <button
                type="button"
                class="icon-button secret-action"
                :aria-label="patVisible && !removePat ? '隐藏个人令牌' : '显示个人令牌'"
                :title="patVisible && !removePat ? '隐藏个人令牌' : '显示个人令牌'"
                :aria-pressed="patVisible && !removePat"
                :disabled="!canReadCredential('pat')"
                @click="useCredential('pat', 'toggle')"
              >
                <LoaderCircle v-if="credentialLoading.pat" class="spin" :size="16" />
                <EyeOff v-else-if="patVisible && !removePat" :size="16" />
                <Eye v-else :size="16" />
              </button>
              <button
                type="button"
                class="icon-button secret-action"
                aria-label="复制个人令牌"
                title="复制个人令牌"
                :disabled="!canReadCredential('pat')"
                @click="useCredential('pat', 'copy')"
              >
                <Copy :size="16" />
              </button>
            </div>
          </div>
          <label v-if="a?.hasPat" class="check-label"
            ><input v-model="removePat" type="checkbox" />移除已保存的个人令牌</label
          >
          <div class="form-grid">
            <label>启动分支<input v-model="form.branch" required maxlength="120" /></label
            ><label class="check-label align-bottom"
              ><input v-model="form.autoWake" type="checkbox" />故障后自动唤醒</label
            >
          </div>
          <p class="inline-hint">
            <Info
              :size="14"
            />额度查询和唤醒需填写仓库路径及个人令牌。自动唤醒有30分钟间隔，手动唤醒可立即重试。
          </p>
        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </div>
      <footer class="modal-footer">
        <span class="subtle">凭据在服务端加密保存</span>
        <div class="button-group">
          <button type="button" class="button" :disabled="saving" @click="emit('close')">
            取消</button
          ><button class="button primary" :disabled="saving">
            <LoaderCircle v-if="saving" class="spin" :size="15" />{{
              saving ? '正在保存' : a ? '保存修改' : '添加账号'
            }}
          </button>
        </div>
      </footer>
    </form>
  </ModalShell>
</template>
