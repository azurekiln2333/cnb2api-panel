import { expect, test, type Page } from '@playwright/test'
import type { RegistrationRelayConfig, RegistrationRelayStatus } from '../src/types'

const ADMIN = 'browser-test-admin-key'
const config = (): RegistrationRelayConfig => ({
  enabled: true,
  servers: [{ id: 'peer-a', name: '香港服务器', origin: 'https://peer.example', enabled: true }],
})
const status = (
  relay: RegistrationRelayConfig,
  state: 'failed' | 'pending' | 'success' = 'success',
): RegistrationRelayStatus => ({
  enabled: relay.enabled,
  servers: relay.servers.map((server) => ({
    ...server,
    status: state,
    pending: state === 'success' ? 0 : 2,
    failed: state === 'failed' ? 2 : 0,
    lastAttemptAt: '2026-10-29T09:00:00.000Z',
    lastSuccessAt: state === 'success' ? '2026-10-29T09:00:00.000Z' : null,
    lastError: state === 'failed' ? '目标服务器拒绝注册。' : '',
  })),
})

async function settingsFixture(page: Page, relay?: RegistrationRelayConfig) {
  const state = {
    stored: relay ? { registrationRelay: relay } : ({} as Record<string, unknown>),
    patches: [] as Record<string, unknown>[],
    reads: 0,
  }
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch()
    const overview = await response.json()
    const settings = { ...overview.settings, ...state.stored }
    if (!('registrationRelay' in state.stored)) delete settings.registrationRelay
    state.reads++
    await route.fulfill({ json: { ...overview, settings } })
  })
  await page.route('**/api/settings', async (route) => {
    const data = route.request().postDataJSON() as Record<string, unknown>
    state.patches.push(data)
    state.stored = data
    await route.fulfill({ json: { settings: data } })
  })
  return state
}

async function openRouting(page: Page) {
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await page.getByRole('link', { name: '路由策略', exact: true }).click()
  await expect(page.getByRole('heading', { name: '注册联动', exact: true })).toBeVisible()
}

test('relay configuration validates, preserves drafts and saves normalized servers', async ({
  page,
}) => {
  // randomUUID requires a secure context; plain HTTP panels still expose getRandomValues.
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
  })
  const fixture = await settingsFixture(page)
  await page.route('**/api/registration-relay', (route) =>
    route.fulfill({ json: { enabled: false, servers: [] } }),
  )
  await openRouting(page)
  const panel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '注册联动', exact: true }) })
  const primary = panel.getByRole('checkbox', { name: /主服务器注册联动/ })
  const save = page.getByRole('button', { name: '保存配置' })
  await expect(primary).not.toBeChecked()
  await primary.check()
  await panel.getByRole('button', { name: '添加服务器' }).click()
  await save.click()
  await expect(panel.getByRole('alert')).toContainText('名称须为 1 至 80 字')
  expect(fixture.patches).toHaveLength(0)
  await panel.getByLabel('服务器名称 1', { exact: true }).fill(' 香港服务器 ')
  await panel.getByLabel('服务器域名 1', { exact: true }).fill('https://PEER.EXAMPLE/path')
  await save.click()
  await expect(panel.getByRole('alert')).toContainText('不能包含路径、参数或凭据')
  await panel.getByLabel('服务器域名 1', { exact: true }).fill('https://PEER.EXAMPLE:443/')
  await panel.getByRole('button', { name: '添加服务器' }).click()
  await panel.getByLabel('服务器名称 2', { exact: true }).fill('备用服务器')
  await panel.getByLabel('服务器域名 2', { exact: true }).fill('https://peer.example/')
  await save.click()
  await expect(panel.getByRole('alert')).toHaveText('服务器域名不能重复。')
  expect(fixture.patches).toHaveLength(0)
  await panel.getByLabel('服务器域名 2', { exact: true }).fill('https://secondary.example/')
  await panel.getByRole('checkbox', { name: '启用服务器 备用服务器', exact: true }).uncheck()
  const reads = fixture.reads
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => fixture.reads).toBeGreaterThan(reads)
  await expect(panel.getByLabel('服务器名称 1', { exact: true })).toHaveValue(' 香港服务器 ')
  await expect(panel.getByRole('button', { name: '同步现有工作区' })).toBeDisabled()
  await expect(panel).toContainText('保存配置后可手动同步。')
  await save.click()
  await expect(save).toBeDisabled()
  expect(fixture.patches).toHaveLength(1)
  expect(fixture.patches[0]?.registrationRelay).toEqual({
    enabled: true,
    servers: [
      {
        id: expect.stringMatching(/^peer-[0-9a-f]{32}$/),
        name: '香港服务器',
        origin: 'https://peer.example',
        enabled: true,
      },
      {
        id: expect.stringMatching(/^peer-[0-9a-f]{32}$/),
        name: '备用服务器',
        origin: 'https://secondary.example',
        enabled: false,
      },
    ],
  })
  await page.reload()
  await expect(primary).toBeChecked()
  await expect(panel.getByLabel('服务器域名 1', { exact: true })).toHaveValue(
    'https://peer.example',
  )
  await expect(
    panel.getByRole('checkbox', { name: '启用服务器 备用服务器', exact: true }),
  ).not.toBeChecked()
  await panel.getByRole('button', { name: '删除服务器 备用服务器', exact: true }).click()
  await save.click()
  await expect(save).toBeDisabled()
  await page.reload()
  await expect(panel.getByLabel('服务器名称 1', { exact: true })).toHaveValue('香港服务器')
  await expect(panel.getByLabel('服务器名称 2', { exact: true })).toHaveCount(0)
})

test('relay status retries separately, schedules sync and fits mobile', async ({ page }) => {
  await settingsFixture(page, config())
  let state: 'error' | 'failed' | 'pending' | 'success' = 'error'
  let syncs = 0
  await page.route('**/api/registration-relay', (route) =>
    state === 'error'
      ? route.fulfill({ status: 503, json: { error: { message: '状态暂不可用' } } })
      : route.fulfill({ json: status(config(), state) }),
  )
  await page.route('**/api/registration-relay/sync', async (route) => {
    expect(route.request().method()).toBe('POST')
    expect(route.request().postDataJSON()).toEqual({})
    syncs++
    state = 'pending'
    await route.fulfill({ json: { scheduled: 2 } })
  })
  await openRouting(page)
  const panel = page.locator('.relay-panel')
  await expect(panel.getByRole('alert')).toContainText('状态暂不可用')
  state = 'failed'
  await panel.getByRole('button', { name: '重试读取状态' }).click()
  const saved = panel.locator('.relay-status').filter({ hasText: 'https://peer.example' })
  await expect(saved).toContainText('同步失败')
  await expect(saved).toContainText('目标服务器拒绝注册。')
  await expect(saved.locator('dl > div').filter({ hasText: '待同步' }).locator('dd')).toHaveText(
    '2',
  )
  await expect(saved.locator('dl > div').filter({ hasText: '失败' }).locator('dd')).toHaveText('2')
  await expect(page.getByRole('button', { name: '保存配置' })).toBeDisabled()
  await panel.getByRole('button', { name: '同步现有工作区' }).click()
  await expect.poll(() => syncs).toBe(1)
  await expect(saved).toContainText('同步中')
  await expect(page.getByText('已安排 2 次同步', { exact: true })).toBeVisible()
  state = 'success'
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(saved).toContainText('同步成功')
  await expect(saved).not.toContainText('目标服务器拒绝注册。')
  await panel.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '../test-results/registration-relay-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await panel.getByRole('button', { name: '同步现有工作区' }).scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.screenshot({ path: '../test-results/registration-relay-mobile.png', fullPage: true })
})

test('relay status ignores older configuration and stops polling while hidden or unmounted', async ({
  page,
}) => {
  await page.clock.install()
  const fixture = await settingsFixture(page, config())
  let reads = 0
  let release = () => {}
  const delayed = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/api/registration-relay', async (route) => {
    const relay = structuredClone(fixture.stored.registrationRelay) as RegistrationRelayConfig
    const first = ++reads === 1
    if (first) await delayed
    await route.fulfill({ json: status(relay, first ? 'failed' : 'success') })
  })
  await openRouting(page)
  await expect.poll(() => reads).toBe(1)
  await page.getByLabel('服务器域名 1', { exact: true }).fill('https://new-peer.example')
  await page.getByRole('button', { name: '保存配置' }).click()
  const saved = page.locator('.relay-status')
  await expect(saved).toContainText('https://new-peer.example')
  await expect(saved).toContainText('同步成功')
  const oldResponse = page.waitForResponse('**/api/registration-relay')
  release()
  await oldResponse
  await expect(saved).toContainText('https://new-peer.example')
  await expect(saved).not.toContainText('同步失败')
  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }),
  )
  const beforeHidden = reads
  await page.clock.runFor(6000)
  expect(reads).toBe(beforeHidden)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => reads).toBeGreaterThan(beforeHidden)
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  const beforeLeaving = reads
  await page.clock.runFor(16000)
  expect(reads).toBe(beforeLeaving)
})

test('relay status uses the existing session expiry flow', async ({ page }) => {
  await settingsFixture(page, config())
  await page.route('**/api/registration-relay', (route) =>
    route.fulfill({ status: 401, json: { error: { message: 'Unauthorized' } } }),
  )
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await page.getByRole('link', { name: '路由策略', exact: true }).click()
  await expect(page.getByRole('button', { name: '进入控制台' })).toBeVisible()
  await expect(page.getByRole('link', { name: '路由策略', exact: true })).toHaveCount(0)
})
