import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import {
  OIDC_ISSUER,
  OIDC_CLIENT_ID,
  OIDC_CLIENT_SECRET,
  OIDC_SUBJECT,
  OIDC_AVATAR_URL,
} from './support/oidc.mjs'

const ADMIN = 'browser-test-admin-key'

async function keyLogin(page: Page) {
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeVisible()
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
  await expect(page.getByRole('heading', { name: '欢迎回到控制台' })).toBeVisible()
}

async function restoreKeyLogin(page: Page, request: APIRequestContext) {
  const login = await request.post('/api/session', { data: { key: ADMIN } })
  if (login.ok()) {
    expect(
      (
        await request.patch('/api/auth/settings', {
          data: { keyLoginEnabled: true, ssoEnabled: false },
        })
      ).ok(),
    ).toBeTruthy()
    return
  }
  // A failed assertion must not leave the shared fixture in SSO-only mode.
  await page.goto('/api/auth/oidc/login')
  await expect(page).toHaveURL(/\/#overview$/)
  expect(
    (
      await page.request.patch('/api/auth/settings', {
        data: { keyLoginEnabled: true, ssoEnabled: false },
      })
    ).ok(),
  ).toBeTruthy()
}

test.afterEach(async ({ page, request }) => {
  await restoreKeyLogin(page, request)
})

test('compact shell removes workspace clutter and exposes user identity and the project link', async ({
  page,
  request,
}) => {
  const config = await (await request.get('/api/auth/config')).json()
  expect(config).toMatchObject({ keyLoginEnabled: true, sso: { enabled: false } })
  await keyLogin(page)
  await expect(page.getByText('默认工作空间', { exact: true })).toHaveCount(0)
  await expect(page.getByText('快速查找', { exact: true })).toHaveCount(0)
  await expect(page.getByText('网关正在服务', { exact: true })).toHaveCount(0)
  await expect(page.locator('.sidebar .workspace-switcher')).toHaveCount(0)
  await expect(
    page.locator('a[href="https://github.com/azurekiln2333/cnb2api-panel"]'),
  ).toBeVisible()
  const sidebar = await page.locator('.sidebar').boundingBox()
  expect(sidebar?.width).toBeLessThanOrEqual(190)
  const navRow = await page
    .getByRole('navigation', { name: '主导航', exact: true })
    .getByRole('link', { name: '运行概览', exact: true })
    .boundingBox()
  expect(navRow?.height).toBeLessThanOrEqual(40)
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await expect(page.getByRole('menu')).toContainText('管理员')
  await expect(page.getByRole('menuitem', { name: '退出登录', exact: true })).toBeVisible()
  await page.screenshot({ path: '../test-results/compact-shell-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await expect(page.locator('.page-footer')).toContainText('cnb2api v1.0')
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBe(64)
  await expect(page.getByRole('heading', { name: '账号池' })).toBeInViewport()
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
  await expect.poll(async () => (await page.locator('.sidebar').boundingBox())?.width).toBe(180)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '展开导航', exact: true }).click()
  await expect(page.getByRole('link', { name: '运行概览', exact: true })).toBeInViewport()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await expect(page.getByRole('heading', { name: '账号池' })).toBeInViewport()
  await expect(page.getByRole('button', { name: '关闭导航', exact: true })).toBeHidden()
  await page.getByRole('link', { name: 'cnb2api', exact: true }).click()
  await expect(page).toHaveURL(/\/#overview$/)
  await expect(page.getByRole('heading', { name: '运行概览' })).toBeInViewport()
})

test('wake is available in the visible account action row without opening a menu', async ({
  page,
  request,
}) => {
  await request.post('/api/session', { data: { key: ADMIN } })
  const created = await request.post('/api/accounts', {
    data: {
      name: 'Wake icon fixture',
      repo: 'browser-wake/cnb2api',
      pat: 'browser-wake-personal-token',
      proxyKey: 'test-worker-key',
      endpoint: 'http://127.0.0.1:19221',
    },
  })
  expect(created.ok()).toBeTruthy()
  const { account } = await created.json()
  let wakeRequests = 0
  await page.route(`**/api/accounts/${account.id}/wake`, async (route) => {
    wakeRequests++
    await route.fulfill({ json: { account } })
  })
  try {
    await keyLogin(page)
    await page.getByLabel('搜索账号', { exact: true }).fill(account.name)
    const wake = page.getByRole('button', { name: `唤醒${account.name}`, exact: true })
    await expect(wake).toBeVisible()
    await expect(wake).toBeEnabled()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await wake.click()
    await expect.poll(() => wakeRequests).toBe(1)
    await expect(page.getByText('已发起唤醒，工作区启动后会自动注册')).toBeVisible()
  } finally {
    await request.delete(`/api/accounts/${account.id}`)
  }
})

test('SSO settings support exclusive SSO login, real PKCE exchange and a named user avatar', async ({
  page,
  request,
}) => {
  test.setTimeout(60000)
  const avatarBody = await (await request.get(`${OIDC_ISSUER}/avatar.svg`)).text()
  await page.route(OIDC_AVATAR_URL, async (route) => {
    await route.fulfill({ contentType: 'image/svg+xml', body: avatarBody })
  })
  await keyLogin(page)
  await page.getByRole('link', { name: '接入配置', exact: true }).click()
  const settings = page.getByTestId('sso-settings')
  await expect(settings).toBeVisible()
  await settings.getByLabel(/Issuer|颁发者/i).fill(OIDC_ISSUER)
  await settings.getByLabel('Client ID', { exact: true }).fill(OIDC_CLIENT_ID)
  const secret = settings.getByLabel('Client Secret', { exact: true })
  await secret.fill(OIDC_CLIENT_SECRET)
  await expect(secret).toHaveAttribute('type', 'password')
  await settings.getByLabel(/提供方名称|提供方名|登录名称/).fill('Browser VaultSSO')
  await settings.getByLabel(/管理员.*[Ss]ubject|[Ss]ubject.*白名单/).fill(OIDC_SUBJECT)
  await expect(
    settings.getByText('http://127.0.0.1:19220/api/auth/oidc/callback', { exact: true }),
  ).toBeVisible()
  await settings.getByTestId('sso-enabled').locator('..').click()
  await expect(settings.getByTestId('sso-enabled')).toBeChecked()
  await settings.getByTestId('sso-save').click()
  await expect
    .poll(async () => (await (await request.get('/api/auth/config')).json()).sso.enabled)
    .toBe(true)
  await expect(secret).toHaveValue('')

  await signOut(page)
  // Refresh the public auth configuration after changing it from the settings page.
  await page.reload()
  await expect(page.getByLabel('管理密钥', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '使用 Browser VaultSSO 登录', exact: true }).click()
  await expect(page).toHaveURL(/\/#overview$/)
  const session = await (await page.request.get('/api/session')).json()
  expect(session.user).toMatchObject({
    provider: 'oidc',
    name: 'Browser SSO Admin',
    email: 'browser-admin@example.test',
  })
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  await expect(page.getByRole('menu')).toContainText('Browser SSO Admin')
  await expect(page.getByRole('menu')).toContainText('browser-admin@example.test')
  await page.getByRole('button', { name: '用户菜单', exact: true }).click()
  const avatar = page.locator('.user-trigger img')
  await expect(avatar).toBeVisible()
  await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(64)
  const upstream = await (await request.get(`${OIDC_ISSUER}/test/status`)).json()
  expect(upstream.tokenExchanges).toBeGreaterThan(0)
  expect(upstream.lastAuthorization).toMatchObject({
    challengeMethod: 'S256',
    nonce: true,
    state: true,
  })

  await page.getByRole('link', { name: '接入配置', exact: true }).click()
  await settings.getByTestId('key-login-enabled').locator('..').click()
  await expect(settings.getByTestId('key-login-enabled')).not.toBeChecked()
  await settings.getByTestId('sso-save').click()
  await expect
    .poll(async () => (await (await request.get('/api/auth/config')).json()).keyLoginEnabled)
    .toBe(false)
  await signOut(page)
  await page.reload()
  await expect(page.getByLabel('管理密钥', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '进入控制台' })).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: '使用 Browser VaultSSO 登录', exact: true }),
  ).toBeVisible()
  const rejected = await request.post('/api/session', { data: { key: ADMIN } })
  expect(rejected.status()).toBe(403)
  expect((await rejected.json()).error.message).toContain('单点登录')
  await page.screenshot({ path: '../test-results/sso-only-login.png', fullPage: true })

  await page.getByRole('button', { name: '使用 Browser VaultSSO 登录', exact: true }).click()
  await expect(page).toHaveURL(/\/#overview$/)
  const saved = await (await page.request.get('/api/auth/settings')).json()
  expect(saved).toMatchObject({ ssoEnabled: true, keyLoginEnabled: false, hasClientSecret: true })
  expect(saved).not.toHaveProperty('clientSecret')
})

test('a mismatched OIDC state returns a readable login error and removes callback parameters', async ({
  page,
  request,
}) => {
  await request.post('/api/session', { data: { key: ADMIN } })
  const configured = await request.patch('/api/auth/settings', {
    data: {
      ssoEnabled: true,
      keyLoginEnabled: true,
      issuer: OIDC_ISSUER,
      clientId: OIDC_CLIENT_ID,
      clientSecret: OIDC_CLIENT_SECRET,
      allowedSubjects: [OIDC_SUBJECT],
    },
  })
  expect(configured.ok()).toBeTruthy()
  const started = await page.request.get('/api/auth/oidc/login', { maxRedirects: 0 })
  expect(started.status()).toBe(302)
  expect(new URL(started.headers().location).pathname).toBe('/authorize')
  await page.goto('/api/auth/oidc/callback?state=invalid-state&code=never-a-real-code')
  await expect(page.getByRole('heading', { name: '欢迎回到控制台' })).toBeVisible()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByRole('alert')).not.toContainText('never-a-real-code')
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toHaveCount(0)
})
