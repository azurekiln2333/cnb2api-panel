<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import {
  LayoutDashboard,
  UsersRound,
  Waypoints,
  ScrollText,
  Braces,
  ArrowUpRight,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Sun,
  Moon,
  LogOut,
  ArrowRight,
  Check,
  CircleAlert,
  LoaderCircle,
  ShieldCheck,
  Cloud,
  UserRound,
  X,
} from '@lucide/vue'
import { api, formatApiDiagnostics, type ApiDiagnostics } from './api'
import { copy, notify, strategyLabels, useConsole } from './console'
import type { Page } from './types'
import AccountsView from './views/AccountsView.vue'
import OverviewView from './views/OverviewView.vue'
import RoutingView from './views/RoutingView.vue'
import ActivityView from './views/ActivityView.vue'
import AccessView from './views/AccessView.vue'
import RegistrationDialog from './components/RegistrationDialog.vue'
import ModalShell from './components/ModalShell.vue'

const appVersion = __APP_VERSION__

interface SessionUser {
  name: string
  email: string
  picture: string
  provider: 'key' | 'oidc'
}
interface AuthConfig {
  keyLoginEnabled: boolean
  sso: { enabled: boolean; providerName: string; loginUrl: string }
}

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  keyLoginEnabled: true,
  sso: { enabled: false, providerName: '', loginUrl: '' },
}
const AUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: '登录被取消，请重新登录。',
  invalid_request: '登录请求无效，请重新登录。',
  invalid_state: '登录会话已失效，请重新登录。',
  state_mismatch: '登录状态校验失败，请重新登录。',
  nonce_mismatch: '登录校验失败，请重新登录。',
  missing_code: '单点登录未返回授权码，请重新登录。',
  token_exchange_failed: '无法完成单点登录，请稍后重试。',
  discovery_failed: '无法连接单点登录服务，请稍后重试或联系管理员。',
  provider_error: '单点登录服务返回错误，请稍后重试。',
  provider_unavailable: '单点登录服务暂时不可用，请稍后重试。',
  sso_disabled: '单点登录已关闭，请使用管理密钥登录。',
  transaction_expired: '登录会话已过期，请重新登录。',
  expired: '登录凭证已过期，请重新登录。',
  invalid_expiry: '登录凭证有效期异常，请重新登录。',
  signature_invalid: '登录凭证签名无效，请联系管理员检查单点登录配置。',
  unknown_key: '登录凭证无法识别，请重新登录或联系管理员。',
  userinfo_mismatch: '单点登录身份与允许列表不一致，请联系管理员。',
  userinfo_failed: '无法读取单点登录身份，请稍后重试。',
  id_token_invalid: '单点登录身份校验失败，请重新登录。',
  issuer_mismatch: '单点登录签发方不匹配，请联系管理员。',
  audience_mismatch: '单点登录客户端不匹配，请联系管理员。',
  not_allowed: '当前账号不在管理员允许列表内。',
  email_not_allowed: '当前邮箱不在管理员允许列表内。',
  email_unverified: '单点登录邮箱未验证，无法登录。',
  configuration_error: '单点登录尚未配置完整，请联系管理员。',
}

const {
  overview,
  loading,
  refreshError,
  refreshDiagnostics,
  lastUpdated,
  toasts,
  registration,
  refresh,
  refreshLogs,
  reset,
} = useConsole()
const nav = [
  { id: 'overview', label: '运行概览', icon: LayoutDashboard },
  { id: 'accounts', label: '账号管理', icon: UsersRound },
  { id: 'routing', label: '路由策略', icon: Waypoints },
  { id: 'activity', label: '请求与事件', icon: ScrollText },
  { id: 'access', label: '接入配置', icon: Braces },
] as const
const initialPage = location.hash.slice(1)
const page = ref<Page>(nav.some((n) => n.id === initialPage) ? (initialPage as Page) : 'accounts')
const title = computed(() => nav.find((n) => n.id === page.value)?.label)
const authenticated = ref(false)
const checkingSession = ref(true)
const loginKey = ref('')
const loginError = ref('')
const authNotice = ref('')
const signingIn = ref(false)
const authConfig = ref<AuthConfig>(DEFAULT_AUTH_CONFIG)
const sessionUser = ref<SessionUser | null>(null)
const userMenuOpen = ref(false)
const diagnostics = ref<ApiDiagnostics | null>(null)
const mobileOpen = ref(false)
const collapsed = ref(false)
const contentPane = ref<HTMLElement | null>(null)
const dark = ref(localStorage.getItem('cnb-theme') === 'dark')
let poll: number | undefined
let lastLifecycleRefresh = -Infinity

const ssoLabel = computed(() => authConfig.value.sso.providerName.trim() || '单点登录')
const loginHint = computed(() => {
  if (!authConfig.value.keyLoginEnabled) return '使用组织单点登录进入控制台。'
  if (authConfig.value.sso.enabled) return '使用主机上配置的管理密钥登录，或使用单点登录。'
  return '使用主机上配置的管理密钥登录。'
})
const userInitial = computed(() => {
  const name = sessionUser.value?.name.trim()
  return name ? Array.from(name)[0]!.toUpperCase() : ''
})
const identityName = computed(() => sessionUser.value?.name.trim() || '管理面板')
const identityDetail = computed(() => {
  const user = sessionUser.value
  if (!user) return '密钥登录'
  if (user.email) return user.email
  return user.provider === 'oidc' ? '单点登录' : '密钥登录'
})

function refreshPage() {
  if (!authenticated.value || document.hidden) return
  void refresh()
  if (page.value === 'activity') void refreshLogs()
}
function resumeRefresh() {
  if (!authenticated.value || document.hidden) return
  const now = Date.now()
  if (now - lastLifecycleRefresh < 250) return
  lastLifecycleRefresh = now
  refreshPage()
}
watch(
  page,
  () => {
    refreshPage()
    contentPane.value?.scrollTo({ top: 0, left: 0 })
  },
  { flush: 'post' },
)

function setTheme() {
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light'
  localStorage.setItem('cnb-theme', dark.value ? 'dark' : 'light')
}
function toggleTheme() {
  dark.value = !dark.value
  setTheme()
}
setTheme()
function navigate(id: Page) {
  if (page.value === id) refreshPage()
  page.value = id
  location.hash = id
  mobileOpen.value = false
}
function hashChanged() {
  const id = location.hash.slice(1)
  if (nav.some((n) => n.id === id)) page.value = id as Page
}
function readAuthNotice() {
  const url = new URL(location.href)
  if (!url.searchParams.has('auth_error')) return
  const raw = url.searchParams.get('auth_error')?.trim().toLowerCase() ?? ''
  url.searchParams.delete('auth_error')
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  authNotice.value = AUTH_ERROR_MESSAGES[raw] || '单点登录失败，请重新登录或联系管理员。'
}
async function loadAuthConfig() {
  try {
    const config = await api<AuthConfig>('/auth/config')
    if (!config || typeof config.keyLoginEnabled !== 'boolean' || !config.sso) return
    authConfig.value = {
      keyLoginEnabled: config.keyLoginEnabled,
      sso: {
        enabled: config.sso.enabled === true,
        providerName: typeof config.sso.providerName === 'string' ? config.sso.providerName : '',
        loginUrl: typeof config.sso.loginUrl === 'string' ? config.sso.loginUrl : '',
      },
    }
  } catch {
    authConfig.value = DEFAULT_AUTH_CONFIG
  }
}
function ssoSignIn() {
  loginError.value = ''
  const url = authConfig.value.sso.loginUrl
  if (!url) {
    loginError.value = '单点登录尚未配置登录地址，请联系管理员。'
    return
  }
  window.location.assign(url)
}
function expired() {
  authenticated.value = false
  sessionUser.value = null
  userMenuOpen.value = false
  diagnostics.value = null
  reset()
  void loadAuthConfig()
}
async function establishSession() {
  const session = await api<{ authenticated: boolean; user?: SessionUser }>('/session')
  sessionUser.value = session.user ?? null
  authenticated.value = true
  await refresh()
  await refreshLogs()
}
async function signIn() {
  signingIn.value = true
  loginError.value = ''
  try {
    await api('/session', 'POST', { key: loginKey.value })
    loginKey.value = ''
    await establishSession()
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '登录失败'
  } finally {
    signingIn.value = false
  }
}
async function signOut() {
  userMenuOpen.value = false
  try {
    await api('/session', 'DELETE')
    expired()
  } catch (error) {
    notify(error instanceof Error ? error.message : '退出失败', true)
  }
}
function toggleUserMenu() {
  userMenuOpen.value = !userMenuOpen.value
}
function closeUserMenu() {
  userMenuOpen.value = false
}
function shortcuts(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    mobileOpen.value = false
    userMenuOpen.value = false
  }
}
onMounted(async () => {
  readAuthNotice()
  await loadAuthConfig()
  window.addEventListener('hashchange', hashChanged)
  window.addEventListener('session-expired', expired)
  window.addEventListener('keydown', shortcuts)
  window.addEventListener('click', closeUserMenu)
  document.addEventListener('visibilitychange', resumeRefresh)
  window.addEventListener('focus', resumeRefresh)
  window.addEventListener('online', resumeRefresh)
  poll = window.setInterval(refreshPage, 15000)
  try {
    await establishSession()
  } catch {
    /* login form handles an absent session */
  } finally {
    checkingSession.value = false
  }
})
onBeforeUnmount(() => {
  clearInterval(poll)
  window.removeEventListener('hashchange', hashChanged)
  window.removeEventListener('session-expired', expired)
  window.removeEventListener('keydown', shortcuts)
  window.removeEventListener('click', closeUserMenu)
  document.removeEventListener('visibilitychange', resumeRefresh)
  window.removeEventListener('focus', resumeRefresh)
  window.removeEventListener('online', resumeRefresh)
})
</script>

<template>
  <div v-if="checkingSession" class="boot-screen">
    <span class="brand-icon"><Braces :size="22" /></span
    ><LoaderCircle :size="20" class="spin" /><span>正在连接控制台</span>
  </div>
  <div v-else-if="!authenticated" class="login-shell">
    <section class="login-story">
      <a class="brand" href="#overview"
        ><span class="brand-icon"><Braces :size="23" /></span
        ><span>cnb<span class="brand-two">2</span>api</span
        ><span class="brand-tag">CONSOLE</span></a
      >
      <div class="login-story-content">
        <span class="eyebrow"><i class="blue-dot" /> ONE ENDPOINT. YOUR WHOLE POOL.</span>
        <h1>把分散的算力，<br />连成一条稳定的路。</h1>
        <div class="network-art" aria-hidden="true">
          <div class="network-center"><Braces :size="26" /><span>统一网关</span></div>
          <svg viewBox="0 0 440 200">
            <path
              d="M110 100H210Q240 100 240 50T280 25H335M210 100H335M210 100Q240 100 240 150T280 175H335"
            />
          </svg>
          <div class="network-node node-1"><Cloud :size="19" />工作区 01<i /></div>
          <div class="network-node node-2"><Cloud :size="19" />工作区 02<i /></div>
          <div class="network-node node-3"><Cloud :size="19" />工作区 03<i /></div>
        </div>
      </div>
      <div class="login-story-footer">
        <span>少一点维护，多一点专注。↗</span>
      </div>
    </section>
    <main class="login-main">
      <button class="icon-button login-theme" aria-label="切换明暗主题" @click="toggleTheme">
        <Sun v-if="dark" :size="20" /><Moon v-else :size="20" />
      </button>
      <form class="login-form" @submit.prevent="signIn">
        <span class="login-lock"><ShieldCheck :size="25" /></span
        ><span class="eyebrow">WORKSPACE CONSOLE</span>
        <h2>欢迎回到控制台</h2>
        <p>{{ loginHint }}</p>
        <p v-if="authNotice" class="form-error" role="alert">{{ authNotice }}</p>
        <template v-if="authConfig.keyLoginEnabled">
          <label for="admin-key"
            >管理密钥<input
              id="admin-key"
              v-model="loginKey"
              type="password"
              required
              autofocus
              autocomplete="current-password"
              placeholder="输入 PANEL_ADMIN_KEY"
          /></label>
          <p v-if="loginError" class="form-error" role="alert">{{ loginError }}</p>
          <button class="button primary login-submit" :disabled="signingIn">
            <LoaderCircle v-if="signingIn" :size="17" class="spin" /><span>{{
              signingIn ? '正在验证' : '进入控制台'
            }}</span
            ><ArrowRight :size="17" />
          </button>
        </template>
        <p v-else-if="loginError" class="form-error" role="alert">{{ loginError }}</p>
        <template v-if="authConfig.sso.enabled">
          <div v-if="authConfig.keyLoginEnabled" class="login-divider"><span>或</span></div>
          <button type="button" class="button login-sso" @click="ssoSignIn">
            <ShieldCheck :size="16" /><span>使用 {{ ssoLabel }} 登录</span
            ><ArrowUpRight :size="15" />
          </button>
        </template>
        <p
          v-if="!authConfig.keyLoginEnabled && !authConfig.sso.enabled"
          class="form-error"
          role="alert"
        >
          登录方式未配置，请联系管理员开启密钥登录或单点登录。
        </p>
      </form>
    </main>
  </div>
  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': collapsed }">
    <header class="topbar">
      <div class="topbar-leading">
        <button
          class="icon-button collapse-button"
          :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
          :aria-expanded="!collapsed"
          @click="collapsed = !collapsed"
        >
          <PanelLeftOpen v-if="collapsed" :size="19" /><PanelLeftClose v-else :size="19" />
        </button>
        <button
          class="icon-button mobile-toggle"
          aria-label="展开导航"
          :aria-expanded="mobileOpen"
          @click="mobileOpen = !mobileOpen"
        >
          <PanelLeftOpen :size="19" />
        </button>
        <a href="#overview" class="brand topbar-brand" @click="navigate('overview')">
          <span class="brand-icon"><Braces :size="20" /></span>
          <span>cnb<span class="brand-two">2</span>api</span>
        </a>
        <div class="breadcrumbs">
          <span>控制台</span><ChevronRight :size="13" /><strong>{{ title }}</strong>
        </div>
      </div>
      <div class="topbar-actions">
        <button
          class="icon-button"
          :aria-label="dark ? '切换浅色主题' : '切换深色主题'"
          @click="toggleTheme"
        >
          <Sun v-if="dark" :size="18" /><Moon v-else :size="18" /></button
        ><span class="topbar-separator" />
        <div class="user-menu" @click.stop>
          <button
            class="user-trigger"
            aria-label="用户菜单"
            :aria-expanded="userMenuOpen"
            aria-haspopup="menu"
            @click="toggleUserMenu"
          >
            <span class="user-avatar"
              ><img
                v-if="sessionUser?.picture"
                :src="sessionUser.picture"
                @error="sessionUser && (sessionUser.picture = '')"
                alt=""
                referrerpolicy="no-referrer" /><template v-else-if="userInitial">{{
                userInitial
              }}</template
              ><UserRound v-else :size="15" /></span
            ><ChevronDown :size="14" />
          </button>
          <div v-if="userMenuOpen" class="user-panel" role="menu">
            <div class="user-identity">
              <span class="user-avatar large"
                ><img
                  v-if="sessionUser?.picture"
                  :src="sessionUser.picture"
                  @error="sessionUser && (sessionUser.picture = '')"
                  alt=""
                  referrerpolicy="no-referrer" /><template v-else-if="userInitial">{{
                  userInitial
                }}</template
                ><UserRound v-else :size="17"
              /></span>
              <span class="user-identity-text"
                ><strong>{{ identityName }}</strong
                ><small>{{ identityDetail }}</small></span
              >
            </div>
            <div class="user-menu-sep" />
            <button class="user-logout" role="menuitem" @click="signOut">
              <LogOut :size="15" /><span>退出登录</span>
            </button>
          </div>
        </div>
      </div>
    </header>
    <button
      v-if="mobileOpen"
      class="mobile-backdrop"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    />
    <aside class="sidebar" :class="{ 'mobile-open': mobileOpen }">
      <div class="nav-caption">控制台<span>CONSOLE</span></div>
      <nav class="main-nav" aria-label="主导航">
        <a
          v-for="item in nav.slice(0, 3)"
          :key="item.id"
          :href="`#${item.id}`"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :title="item.label"
          @click="navigate(item.id)"
          ><component :is="item.icon" :size="17" /><span>{{ item.label }}</span
          ><small v-if="item.id === 'accounts'">{{ overview?.stats.total ?? 0 }}</small></a
        >
      </nav>
      <div class="nav-caption">管理与接入</div>
      <nav class="main-nav" aria-label="管理导航">
        <a
          v-for="item in nav.slice(3)"
          :key="item.id"
          :href="`#${item.id}`"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :title="item.label"
          @click="navigate(item.id)"
          ><component :is="item.icon" :size="17" /><span>{{ item.label }}</span></a
        >
      </nav>
      <div class="sidebar-bottom">
        <a
          href="https://github.com/azurekiln2333/cnb2api-panel"
          target="_blank"
          rel="noopener noreferrer"
          class="sidebar-help"
          ><Braces :size="16" /><span>项目与文档</span><ArrowUpRight :size="14"
        /></a>
      </div>
    </aside>
    <div ref="contentPane" class="main-shell">
      <main class="main-content" id="main-content">
        <div v-if="refreshError" class="error-banner" role="alert">
          <CircleAlert :size="16" /><span
            >{{ refreshError }}。{{ overview ? '当前显示上次成功更新的数据。' : '' }}</span
          ><button v-if="refreshDiagnostics" @click="diagnostics = refreshDiagnostics">
            诊断详情</button
          ><button @click="refresh">重试</button>
        </div>
        <div v-if="!overview && loading" class="page-loading">
          <LoaderCircle :size="24" class="spin" /><span>正在读取账号池…</span>
        </div>
        <template v-else-if="overview"
          ><AccountsView v-if="page === 'accounts'" @navigate="navigate" /><OverviewView
            v-else-if="page === 'overview'"
            @navigate="navigate" /><RoutingView v-else-if="page === 'routing'" /><ActivityView
            v-else-if="page === 'activity'" /><AccessView v-else
        /></template>
        <div v-else-if="!refreshError" class="page-loading">等待网关数据</div>
      </main>
      <footer class="page-footer">
        <span
          ><i class="blue-dot" /><span class="footer-gateway">CNB CLOUD GATEWAY</span
          ><span class="footer-dot">·</span
          ><span class="footer-product"
            >cnb2api <small>v{{ appVersion }}</small></span
          ><span class="footer-dot">·</span
          >{{ overview ? strategyLabels[overview.settings.strategy] : '—' }}</span
        ><button @click="refresh">
          <RefreshCw :size="12" :class="{ spin: loading }" /><span>{{
            lastUpdated
              ? `每15秒刷新 · ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}`
              : '等待同步'
          }}</span>
        </button>
      </footer>
    </div>
    <RegistrationDialog
      v-if="registration"
      :account="registration.account"
      :token="registration.token"
      @close="registration = null"
    />
  </div>
  <ModalShell
    v-if="diagnostics"
    title="接口诊断详情"
    subtitle="包含错误说明、请求路径和响应信息，可复制给服务器维护者排查。"
    @close="diagnostics = null"
  >
    <div class="modal-body">
      <pre class="api-diagnostics" data-testid="api-diagnostics">{{
        formatApiDiagnostics(diagnostics)
      }}</pre>
    </div>
    <footer class="modal-footer">
      <span />
      <div class="button-group">
        <button class="button" @click="diagnostics = null">关闭</button
        ><button class="button primary" @click="copy(formatApiDiagnostics(diagnostics))">
          复制诊断
        </button>
      </div>
    </footer>
  </ModalShell>
  <div class="toast-stack" aria-live="polite">
    <div v-for="toast in toasts" :key="toast.id" class="toast" :class="{ error: toast.error }">
      <CircleAlert v-if="toast.error" :size="17" /><Check v-else :size="17" /><span>{{
        toast.text
      }}</span
      ><button
        v-if="toast.diagnostics"
        class="text-link toast-diagnostics"
        @click="diagnostics = toast.diagnostics"
      >
        诊断详情</button
      ><button
        class="icon-button"
        aria-label="关闭通知"
        @click="toasts = toasts.filter((t) => t.id !== toast.id)"
      >
        <X :size="14" />
      </button>
    </div>
  </div>
</template>
