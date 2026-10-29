import { expect, test, type Page } from '@playwright/test'
import type { ModelInventoryEntry } from '../src/types'

const ADMIN = 'browser-test-admin-key'
const configuredId = 'configured-model-with-a-very-long-name-for-small-screen'
const catalog = (): ModelInventoryEntry[] => [
  {
    id: 'deepseek-v4.1-flash',
    listed: true,
    configuredAccounts: [{ id: 'configured-account', name: '配置账号' }],
    discoveredAccounts: [{ id: 'discovered-account', name: '上游账号' }],
    eligibleAccounts: [{ id: 'wildcard-account', name: '通配账号' }],
  },
  {
    id: configuredId,
    listed: false,
    configuredAccounts: [{ id: 'offline-account', name: '未接入账号' }],
    discoveredAccounts: [],
    eligibleAccounts: [],
  },
]

async function login(page: Page, path = '/') {
  await page.goto(path)
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await expect(page.getByRole('link', { name: '模型列表', exact: true })).toBeAttached()
}

test('model catalog distinguishes sources and readiness, searches, copies and opens on mobile', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  let logReads = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/logs')) logReads++
  })
  await page.route('**/api/models', (route) => route.fulfill({ json: { models: catalog() } }))
  await login(page)
  await page.getByRole('link', { name: '模型列表', exact: true }).click()
  await expect(page.getByRole('heading', { name: '模型列表', exact: true })).toBeVisible()
  await expect(page.getByText('上游发现不代表推理已验证。', { exact: false })).toBeVisible()
  const first = page.locator('[data-model-id="deepseek-v4.1-flash"]')
  await expect(first).toContainText('上游发现')
  await expect(first).toContainText('上游账号')
  await expect(first).toContainText('配置声明')
  await expect(first).toContainText('配置账号')
  await expect(first).toContainText('已收录')
  await expect(first).toContainText('1 个就绪账号')
  await expect(first).toContainText('通配账号')
  const second = page.locator(`[data-model-id="${configuredId}"]`)
  await expect(second).toContainText('配置声明')
  await expect(second).not.toContainText('上游发现')
  await expect(second).toContainText('未收录')
  await expect(second).toContainText('0 个就绪账号')
  await first.getByRole('button', { name: '复制模型 ID deepseek-v4.1-flash', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('deepseek-v4.1-flash')
  const search = page.getByLabel('搜索模型', { exact: true })
  await search.fill('上游发现')
  await expect(first).toBeVisible()
  await expect(second).toHaveCount(0)
  await search.fill('配置声明')
  await expect(page.locator('[data-model-id]')).toHaveCount(2)
  await search.fill('通配账号')
  await expect(page.locator('[data-model-id]')).toHaveCount(1)
  await search.fill('offline-account')
  await expect(second).toBeVisible()
  await search.fill('no-such-model')
  await expect(page.getByRole('heading', { name: '没有匹配的模型' })).toBeVisible()
  await page
    .locator('.empty-filter')
    .getByRole('button', { name: '清空模型搜索', exact: true })
    .click()
  await expect(page.locator('[data-model-id]')).toHaveCount(2)
  expect(logReads).toBe(0)
  await page.screenshot({ path: '../test-results/models-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '展开导航' }).click()
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  await page.getByRole('button', { name: '展开导航' }).click()
  await page.getByRole('link', { name: '模型列表', exact: true }).click()
  await expect(page.getByRole('heading', { name: '模型列表', exact: true })).toBeVisible()
  await expect(second).toBeVisible()
  await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, -208, 0)')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  expect(
    await page.locator('.models-panel').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true)
  await page.screenshot({ path: '../test-results/models-mobile.png', fullPage: true })
})

test('model errors can retry into an empty catalog and refresh into current readiness', async ({
  page,
}) => {
  let state: 'error' | 'empty' | 'ready' | 'offline' = 'error'
  await page.route('**/api/models', (route) => {
    if (state === 'error')
      return route.fulfill({ status: 503, json: { error: { message: '模型目录暂不可用' } } })
    const models = state === 'empty' ? [] : catalog()
    if (state === 'offline') models[0]!.eligibleAccounts = []
    return route.fulfill({ json: { models } })
  })
  await login(page, '/#models')
  await expect(page.getByRole('alert')).toContainText('模型目录暂不可用')
  state = 'empty'
  await page.getByRole('button', { name: '重试读取模型', exact: true }).click()
  await expect(page.getByRole('heading', { name: '暂无模型', exact: true })).toBeVisible()
  state = 'ready'
  await page.getByRole('button', { name: '刷新模型', exact: true }).click()
  const model = page.locator('[data-model-id="deepseek-v4.1-flash"]')
  await expect(model).toContainText('1 个就绪账号')
  state = 'offline'
  await page.getByRole('button', { name: '刷新模型', exact: true }).click()
  await expect(model).toContainText('0 个就绪账号')
  await expect(model).toContainText('暂无就绪账号')
})

test('model loads independently, ignores prior mounts and cleans up polling and sessions', async ({
  page,
}) => {
  await page.clock.install()
  let releaseOverview = () => {}
  const overviewGate = new Promise<void>((resolve) => {
    releaseOverview = resolve
  })
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch()
    await overviewGate
    await route.fulfill({ response })
  })
  let releaseOld = () => {}
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve
  })
  let reads = 0
  let unauthorized = false
  await page.route('**/api/models', async (route) => {
    const first = ++reads === 1
    if (first) await oldGate
    if (unauthorized)
      return route.fulfill({ status: 401, json: { error: { message: 'Unauthorized' } } })
    const model = catalog()[0]!
    model.id = first ? 'old-model' : 'new-model'
    await route.fulfill({ json: { models: [model] } })
  })
  await login(page, '/#models')
  await expect(page.getByRole('heading', { name: '模型列表', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: '正在读取模型列表', exact: true })).toBeVisible()
  releaseOverview()
  await page.getByRole('link', { name: /账号管理/ }).click()
  await page.getByRole('link', { name: '模型列表', exact: true }).click()
  await expect(page.locator('[data-model-id="new-model"]')).toBeVisible()
  const oldResponse = page.waitForResponse('**/api/models')
  releaseOld()
  await oldResponse
  await expect(page.locator('[data-model-id="old-model"]')).toHaveCount(0)
  await page.evaluate(() =>
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }),
  )
  const hiddenReads = reads
  await page.clock.runFor(16000)
  expect(reads).toBe(hiddenReads)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(() => reads).toBeGreaterThan(hiddenReads)
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  const unmountedReads = reads
  await page.clock.runFor(16000)
  expect(reads).toBe(unmountedReads)
  unauthorized = true
  await page.getByRole('link', { name: '模型列表', exact: true }).click()
  await expect(page.getByRole('button', { name: '进入控制台', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '模型列表', exact: true })).toHaveCount(0)
})

test('model page reflects the authenticated inventory and account disablement', async ({
  page,
}) => {
  await login(page)
  const response = await page.request.post('/api/accounts', {
    data: {
      name: '模型目录测试账号',
      repo: 'browser-models/cnb2api',
      endpoint: 'http://127.0.0.1:19221',
      proxyKey: 'test-worker-key',
      models: ['browser-configured-model'],
    },
  })
  expect(response.ok()).toBe(true)
  const { account } = await response.json()
  try {
    await page.request.post(`/api/accounts/${account.id}/probe`, { data: {} })
    const inventory = (await (await page.request.get('/api/models')).json())
      .models as ModelInventoryEntry[]
    const original = inventory.find((model) => model.id === 'browser-configured-model')!
    expect(original.eligibleAccounts).toContainEqual({ id: account.id, name: account.name })
    await page.getByRole('link', { name: '模型列表', exact: true }).click()
    const configured = page.locator('[data-model-id="browser-configured-model"]')
    await expect(configured).toContainText('配置声明')
    await expect(configured).toContainText('模型目录测试账号')
    await expect(configured).toContainText(`${original.eligibleAccounts.length} 个就绪账号`)
    const discovered = page.locator('[data-model-id="deepseek-v4.1-flash"]')
    await expect(discovered).toContainText('上游发现')
    await page.request.patch(`/api/accounts/${account.id}`, { data: { enabled: false } })
    await page.getByRole('button', { name: '刷新模型', exact: true }).click()
    await expect(configured).toContainText(`${original.eligibleAccounts.length - 1} 个就绪账号`)
    await expect(configured).toContainText('未收录')
  } finally {
    await page.request.delete(`/api/accounts/${account.id}`)
  }
})
