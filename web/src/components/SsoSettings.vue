<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Check,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  LoaderCircle,
  Save,
  ShieldCheck,
} from '@lucide/vue'
import { api } from '../api'
import { copy, notify } from '../console'
import { authConfig, loadAuthConfig } from '../auth'
import type { SsoSettings } from '../types'

const loading = ref(true)
const saving = ref(false)
const error = ref('')
const loadError = ref('')
const dirty = ref(false)
const showSecret = ref(false)
const hasStoredSecret = ref(false)
const callbackUrl = ref('')
let snapshot = ''

const form = reactive({
  ssoEnabled: false,
  keyLoginEnabled: true,
  issuer: '',
  clientId: '',
  clientSecret: '',
  scope: 'openid profile email',
  providerName: '',
  allowedSubjects: '',
  allowedEmails: '',
})

const list = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)

const secretReady = computed(() => hasStoredSecret.value || form.clientSecret.trim().length > 0)
const subjects = computed(() => list(form.allowedSubjects))
const emails = computed(() => list(form.allowedEmails))
const ssoReady = computed(
  () =>
    form.ssoEnabled &&
    Boolean(form.issuer.trim()) &&
    Boolean(form.clientId.trim()) &&
    secretReady.value &&
    (subjects.value.length > 0 || emails.value.length > 0),
)
const ssoLoginUrl = computed(() => authConfig.value?.sso?.loginUrl?.trim() || '')
const ssoActive = computed(() => authConfig.value?.sso?.enabled ?? form.ssoEnabled)

function editable(includeSecret: boolean) {
  const body: Record<string, unknown> = {
    ssoEnabled: form.ssoEnabled,
    keyLoginEnabled: form.keyLoginEnabled,
    issuer: form.issuer.trim(),
    clientId: form.clientId.trim(),
    scope: form.scope.trim(),
    providerName: form.providerName.trim(),
    allowedSubjects: list(form.allowedSubjects),
    allowedEmails: list(form.allowedEmails),
  }
  if (includeSecret && form.clientSecret) body.clientSecret = form.clientSecret
  return body
}

function apply(config: SsoSettings) {
  form.ssoEnabled = Boolean(config.ssoEnabled)
  form.keyLoginEnabled = config.keyLoginEnabled !== false
  form.issuer = config.issuer ?? ''
  form.clientId = config.clientId ?? ''
  form.clientSecret = ''
  form.scope = config.scope || 'openid profile email'
  form.providerName = config.providerName ?? ''
  form.allowedSubjects = (config.allowedSubjects ?? []).join('\n')
  form.allowedEmails = (config.allowedEmails ?? []).join('\n')
  hasStoredSecret.value = Boolean(config.hasClientSecret)
  callbackUrl.value = config.callbackUrl ?? ''
  showSecret.value = false
  snapshot = JSON.stringify(editable(false))
  dirty.value = false
}

async function load() {
  loading.value = true
  loadError.value = ''
  error.value = ''
  try {
    apply(await api<SsoSettings>('/auth/settings'))
    void loadAuthConfig()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : 'SSO 配置读取失败'
  } finally {
    loading.value = false
  }
}

function validate(): string {
  if (form.ssoEnabled) {
    if (!form.issuer.trim()) return '启用 SSO 需要填写 Issuer 地址'
    if (!/^https?:\/\/\S+$/i.test(form.issuer.trim()))
      return 'Issuer 需要完整的 http(s) 地址，例如 https://sso.example.com'
    if (!form.clientId.trim()) return '启用 SSO 需要填写 Client ID'
    if (!secretReady.value) return '启用 SSO 需要填写 Client Secret'
    if (!subjects.value.length && !emails.value.length)
      return '启用 SSO 需要至少一个管理员 subject 或 email 白名单'
  }
  const badEmail = emails.value.find((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
  if (badEmail) return `邮箱白名单里的 ${badEmail} 不是有效邮箱地址`
  if (!form.keyLoginEnabled && !ssoReady.value)
    return '禁用管理密钥登录需要先启用有效的 SSO，否则会无法登录面板'
  return ''
}

async function save() {
  error.value = ''
  const problem = validate()
  if (problem) {
    error.value = problem
    return
  }
  saving.value = true
  try {
    const result = await api<SsoSettings>('/auth/settings', 'PATCH', editable(true))
    apply(result)
    notify('SSO 配置已保存')
    void loadAuthConfig(true)
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'SSO 配置保存失败'
  } finally {
    saving.value = false
  }
}

function updateDirty() {
  dirty.value = JSON.stringify(editable(false)) !== snapshot
}

onMounted(load)
</script>

<template>
  <section
    class="section-panel sso-panel"
    data-testid="sso-settings"
    @input="updateDirty"
    @change="updateDirty"
  >
    <header class="section-heading">
      <ShieldCheck :size="20" />
      <div>
        <h2>单点登录 SSO</h2>
        <p>用外部 OIDC 提供方登录本控制台，与客户端网关 Key 分开管理。</p>
      </div>
      <span v-if="ssoActive" class="sso-chip"><KeyRound :size="12" />已启用</span>
    </header>

    <div v-if="loading" class="sso-state">
      <LoaderCircle :size="17" class="spin" /><span>正在读取 SSO 配置…</span>
    </div>
    <div v-else-if="loadError" class="sso-state sso-state-error" role="alert">
      <CircleAlert :size="17" /><span>{{ loadError }}</span
      ><button type="button" class="button" @click="load">重试</button>
    </div>
    <form v-else class="sso-body" @submit.prevent="save">
      <div class="sso-switches">
        <label class="sso-switch">
          <input
            v-model="form.ssoEnabled"
            type="checkbox"
            data-testid="sso-enabled"
            aria-label="启用 SSO"
          />
          <span class="sso-track" aria-hidden="true" />
          <span class="sso-switch-text"
            ><strong>启用 SSO</strong><small>允许管理员通过外部 OIDC 提供方登录面板。</small></span
          >
        </label>
        <label class="sso-switch">
          <input
            v-model="form.keyLoginEnabled"
            type="checkbox"
            data-testid="key-login-enabled"
            aria-label="允许普通管理 Key 登录"
          />
          <span class="sso-track" aria-hidden="true" />
          <span class="sso-switch-text"
            ><strong>允许普通管理 Key 登录</strong
            ><small>用主机上的面板管理密钥登录，不涉及客户端网关 Key。</small
            ><small class="sso-warn"
              >先通过 SSO 登录验证，再关闭管理密钥登录。若当前是 Key 会话，关闭会被拒绝。</small
            ></span
          >
        </label>
      </div>
      <p v-if="!form.keyLoginEnabled && !ssoReady" class="sso-inline" role="alert">
        <CircleAlert :size="13" />禁用管理 Key 登录需要先启用有效的 SSO。
      </p>

      <div class="sso-grid">
        <label class="sso-field sso-wide">
          <span class="sso-label"
            >Issuer<small>OIDC 发现地址的签发方，例如 https://sso.example.com</small></span
          >
          <input
            v-model="form.issuer"
            type="url"
            aria-label="Issuer"
            placeholder="https://sso.example.com"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <label class="sso-field">
          <span class="sso-label">Client ID<small>在 SSO 提供方登记的客户端编号。</small></span>
          <input
            v-model="form.clientId"
            type="text"
            aria-label="Client ID"
            placeholder="客户端编号"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <div class="sso-field">
          <label class="sso-label" for="sso-client-secret"
            >Client Secret<small>{{
              hasStoredSecret ? '已保存，留空表示不修改。' : '首次配置时填写。'
            }}</small></label
          >
          <span class="sso-secret">
            <input
              id="sso-client-secret"
              v-model="form.clientSecret"
              :type="showSecret ? 'text' : 'password'"
              aria-label="Client Secret"
              :placeholder="hasStoredSecret ? '留空保留已保存的 Secret' : '客户端密钥'"
              autocomplete="new-password"
              spellcheck="false"
            />
            <button
              type="button"
              class="icon-button"
              :aria-label="showSecret ? '隐藏 Client Secret' : '显示 Client Secret'"
              @click="showSecret = !showSecret"
            >
              <EyeOff v-if="showSecret" :size="15" /><Eye v-else :size="15" />
            </button>
          </span>
        </div>
        <label class="sso-field">
          <span class="sso-label"
            >授权 scope<small>至少包含 openid。邮箱白名单需要 email。</small></span
          >
          <input
            v-model="form.scope"
            type="text"
            aria-label="授权 scope"
            placeholder="openid profile email"
            autocomplete="off"
            spellcheck="false"
          />
        </label>
        <label class="sso-field">
          <span class="sso-label">提供方名<small>登录页显示的名称，留空显示 SSO。</small></span>
          <input
            v-model="form.providerName"
            type="text"
            aria-label="提供方名"
            placeholder="例如 AzureKiln SSO"
            autocomplete="off"
          />
        </label>
        <label class="sso-field">
          <span class="sso-label"
            >管理员 subject 白名单<small>每行一个 sub，精确匹配，区分大小写。</small></span
          >
          <textarea
            v-model="form.allowedSubjects"
            rows="3"
            aria-label="管理员 subject 白名单"
            placeholder="每行一个 subject"
            spellcheck="false"
          />
        </label>
        <label class="sso-field">
          <span class="sso-label"
            >管理员 email 白名单<small>每行一个邮箱，仅接受已验证邮箱。</small></span
          >
          <textarea
            v-model="form.allowedEmails"
            rows="3"
            aria-label="管理员 email 白名单"
            placeholder="每行一个邮箱"
            spellcheck="false"
          />
        </label>
        <div class="sso-field sso-wide">
          <span class="sso-label">回调地址<small>在 SSO 提供方登记此地址，只读。</small></span>
          <div class="sso-copy">
            <code>{{ callbackUrl || '保存后由面板生成' }}</code>
            <button
              type="button"
              class="icon-button"
              aria-label="复制回调地址"
              :disabled="!callbackUrl"
              @click="copy(callbackUrl)"
            >
              <Copy :size="15" />
            </button>
          </div>
        </div>
        <div v-if="ssoLoginUrl" class="sso-field sso-wide">
          <span class="sso-label">SSO 登录入口<small>启用后可直接用它开始登录。</small></span>
          <div class="sso-copy">
            <code>{{ ssoLoginUrl }}</code>
            <button
              type="button"
              class="icon-button"
              aria-label="复制 SSO 登录入口"
              @click="copy(ssoLoginUrl)"
            >
              <Copy :size="15" />
            </button>
          </div>
        </div>
      </div>

      <div class="sso-tip">
        <Info :size="14" />
        <ul>
          <li>回调地址必须与提供方登记一致，生产环境使用 HTTPS。</li>
          <li>令牌端点用 client_secret_basic，userinfo 用 GET Bearer，JWKS 用 RS256。</li>
          <li>兼容 azurekiln-oauth2 的授权码流程，必须支持 PKCE S256。</li>
        </ul>
      </div>
      <div class="sso-note">
        <ShieldCheck :size="14" />
        <span
          >SSO 只用于登录本控制台。它不等于统一网关 Key，也不等于工作区 Key 或 CNB 个人令牌。</span
        >
      </div>

      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer class="sso-actions">
        <span class="sso-secret-state">
          <Check v-if="hasStoredSecret" :size="13" />Client Secret
          {{ hasStoredSecret ? '已保存' : '未保存' }}
          <template v-if="dirty"> · 有未保存修改</template>
        </span>
        <div class="button-group">
          <button type="button" class="button" :disabled="saving" @click="load">重新读取</button>
          <button
            type="submit"
            class="button primary"
            data-testid="sso-save"
            :disabled="saving || loading"
          >
            <LoaderCircle v-if="saving" :size="16" class="spin" /><Save v-else :size="16" />{{
              saving ? '正在保存' : '保存 SSO 配置'
            }}
          </button>
        </div>
      </footer>
    </form>
  </section>
</template>

<style scoped>
.sso-panel {
  margin-bottom: 22px;
}
.sso-chip {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: var(--radius-full);
  background: var(--primary-soft);
  color: var(--primary);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.2px;
}
.sso-state {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 22px 23px;
  color: var(--muted);
  font-size: 14px;
}
.sso-state-error {
  color: var(--red);
  flex-wrap: wrap;
}
.sso-state-error .button {
  margin-left: auto;
}
.sso-body {
  border-top: 1px solid var(--line);
  padding: 18px 23px 20px;
}
.sso-switches {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 16px;
}
.sso-switch {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-subtle);
  cursor: pointer;
}
.sso-switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.sso-track {
  position: relative;
  flex-shrink: 0;
  width: 32px;
  height: 18px;
  margin-top: 1px;
  border-radius: var(--radius-full);
  background: var(--line-strong);
  transition: background 0.15s ease;
}
.sso-track:after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: 0 1px 2px #1c315030;
  transition: transform 0.15s ease;
}
.sso-switch input:checked + .sso-track {
  background: var(--primary);
}
.sso-switch input:checked + .sso-track:after {
  transform: translateX(14px);
}
.sso-switch input:focus-visible + .sso-track {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.sso-switch-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.sso-switch-text strong {
  font-size: 14px;
  font-weight: 550;
}
.sso-switch-text small {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}
.sso-warn {
  color: var(--amber);
}
.sso-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 14px;
  font-size: 12px;
  color: var(--red);
}
.sso-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 13px 16px;
  margin-bottom: 16px;
}
.sso-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.sso-wide {
  grid-column: 1 / -1;
}
.sso-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  font-weight: 550;
  color: var(--secondary);
}
.sso-label small {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  line-height: 1.7;
}
.sso-field input,
.sso-field textarea {
  width: 100%;
  font-size: 14px;
  padding: 7px 9px;
  border-radius: var(--radius-xs);
}
.sso-field textarea {
  resize: vertical;
  min-height: 62px;
  line-height: 1.7;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}
.sso-secret {
  display: flex;
  align-items: center;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  background: var(--surface);
  padding-right: 3px;
}
.sso-secret:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 9%, transparent);
}
.sso-secret input {
  border: 0;
  background: transparent;
  box-shadow: none;
}
.sso-secret input:focus {
  box-shadow: none;
}
.sso-copy {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 5px 4px 9px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  background: var(--surface-subtle);
}
.sso-copy code {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow-wrap: anywhere;
  line-height: 1.7;
}
.sso-tip,
.sso-note {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 10px 12px;
  border-radius: var(--radius-xs);
  font-size: 12px;
  line-height: 1.8;
}
.sso-tip {
  background: var(--surface-subtle);
  border: 1px solid var(--line);
  color: var(--secondary);
  margin-bottom: 8px;
}
.sso-tip svg {
  color: var(--primary);
  margin-top: 2px;
  flex-shrink: 0;
}
.sso-tip ul {
  margin: 0;
  padding-left: 14px;
}
.sso-note {
  background: var(--green-soft);
  color: var(--secondary);
}
.sso-note svg {
  color: var(--green);
  margin-top: 2px;
  flex-shrink: 0;
}
.sso-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line);
}
.sso-secret-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted);
}
.sso-secret-state svg {
  color: var(--green);
}
.sso-actions .button-group {
  margin-left: auto;
}
@media (max-width: 1050px) {
  .sso-switches,
  .sso-grid {
    grid-template-columns: 1fr;
  }
  .sso-wide {
    grid-column: auto;
  }
}
@media (max-width: 600px) {
  .sso-body {
    padding: 15px 16px 17px;
  }
  .sso-actions .button-group {
    margin-left: 0;
    width: 100%;
  }
  .sso-actions .button-group .button {
    flex: 1;
  }
}
</style>
