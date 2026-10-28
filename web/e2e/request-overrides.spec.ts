import { expect, test, type Page } from '@playwright/test'

const ADMIN = 'browser-test-admin-key'

async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await expect(page.getByRole('link', { name: '路由策略', exact: true })).toBeVisible()
}

test('override drafts validate locally and survive save, refresh and reload', async ({ page }) => {
  let stored: Record<string, unknown> = {
    dshCompat: true,
    requestOverrides: { operations: [] },
    upstreamHeaders: {},
  }
  const patches: Record<string, unknown>[] = []
  let overviewReads = 0
  let delayNextOverview = false
  let releaseOverview = () => {}
  const delayedOverview = new Promise<void>((resolve) => {
    releaseOverview = resolve
  })
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch()
    const overview = await response.json()
    const settings = { ...overview.settings, ...stored }
    overviewReads++
    if (delayNextOverview) {
      delayNextOverview = false
      await delayedOverview
    }
    await route.fulfill({ json: { ...overview, settings } })
  })
  await page.route('**/api/settings', async (route) => {
    const data = route.request().postDataJSON() as Record<string, unknown>
    patches.push(data)
    stored = data
    await route.fulfill({ json: { settings: stored } })
  })

  await login(page)
  await page.getByRole('link', { name: '路由策略', exact: true }).click()
  const preset = page.getByRole('checkbox', { name: /CNB \/ DSH 兼容预设/ })
  const overrides = page.getByLabel('参数覆盖', { exact: true })
  const headers = page.getByLabel('请求头覆盖', { exact: true })
  const save = page.getByRole('button', { name: '保存配置' })
  await expect(preset).toBeChecked()
  await expect(preset.locator('..')).toContainText('所有 developer 角色改为 system')
  await expect(preset.locator('..')).toContainText('这项转换不依赖 DSH 标识')
  await expect(preset.locator('..')).toContainText('角色转换会改变消息优先级')
  await expect(preset.locator('..')).toContainText('assistant 历史中的两种 DSH 身份句')
  await expect(preset.locator('..')).toContainText('DSH 身份、名称和路径提示')
  await expect(preset.locator('..')).toContainText('模型收到改写后的内容。用户和工具内容不变。')
  await overrides.fill('{')
  await save.click()
  await expect(page.getByRole('alert')).toContainText('参数覆盖不是有效的 JSON。')
  expect(patches).toHaveLength(0)
  await overrides.fill('{"operations":[null]}')
  await save.click()
  await expect(page.getByRole('alert')).toContainText('参数覆盖须包含 operations 对象数组。')
  await overrides.fill('{"operations":[]}')
  await headers.fill('{"authorization":"secret"}')
  await save.click()
  await expect(page.getByRole('alert')).toContainText('请求头名称不在允许列表中。')
  await headers.fill('{"accept":42}')
  await save.click()
  await expect(page.getByRole('alert')).toContainText('请求头的值须为字符串。')
  expect(patches).toHaveLength(0)

  const rules = { operations: [{ mode: 'set', path: 'temperature', value: 0.4 }] }
  const headerValues = { 'user-agent': 'test-client', 'x-ide-name': 'test-ide' }
  await overrides.fill(JSON.stringify(rules))
  await headers.fill(JSON.stringify(headerValues))
  await preset.uncheck()
  delayNextOverview = true
  const readsBeforeSave = overviewReads
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => overviewReads).toBeGreaterThan(readsBeforeSave)
  await save.click()
  await expect.poll(() => patches.length).toBe(1)
  releaseOverview()
  expect(patches[0]).toMatchObject({
    dshCompat: false,
    requestOverrides: rules,
    upstreamHeaders: headerValues,
  })
  await expect(save).toBeDisabled()
  await expect(preset).not.toBeChecked()
  await expect.poll(async () => JSON.parse(await overrides.inputValue())).toEqual(rules)
  await page.reload()
  await expect(preset).not.toBeChecked()
  await expect.poll(async () => JSON.parse(await overrides.inputValue())).toEqual(rules)
  await expect.poll(async () => JSON.parse(await headers.inputValue())).toEqual(headerValues)

  await overrides.fill('{"operations": [')
  const previousReads = overviewReads
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => overviewReads).toBeGreaterThan(previousReads)
  await expect(overrides).toHaveValue('{"operations": [')
  await page.getByRole('button', { name: '恢复已保存的规则' }).click()
  await expect.poll(async () => JSON.parse(await overrides.inputValue())).toEqual(rules)
  await page.getByRole('button', { name: '清空规则' }).click()
  await page.getByRole('button', { name: '清空请求头' }).click()
  await preset.check()
  await save.click()
  await expect.poll(() => patches.length).toBe(2)
  await page.reload()
  await expect(preset).toBeChecked()
  await expect
    .poll(async () => JSON.parse(await overrides.inputValue()))
    .toEqual({ operations: [] })
  await expect.poll(async () => JSON.parse(await headers.inputValue())).toEqual({})
  await overrides.fill(JSON.stringify(rules))
  await headers.fill(JSON.stringify(headerValues))
  await save.click()
  await expect.poll(() => patches.length).toBe(3)

  await page.getByRole('heading', { name: '请求覆盖', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: '../test-results/request-overrides-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await overrides.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: '../test-results/request-overrides-mobile.png', fullPage: true })
})

test('request details fetch redacted diagnostics and handle legacy records and retries', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const entry = (id: string, accountName: string) => ({
    id,
    at: new Date().toISOString(),
    kind: 'request',
    accountId: null,
    accountName,
    status: 400,
    message: '请求失败',
    attempts: 2,
  })
  const current = entry('diagnostic-request', '诊断请求')
  const legacy = entry('legacy-request', '旧请求')
  const failed = entry('retry-request', '重试请求')
  const secret = 'sensitive-prompt-or-header-value'
  const diagnostics = {
    received: {
      fields: ['model', 'messages'],
      messageCount: 2,
      messages: [
        { index: 0, role: 'developer', contentType: 'text', length: 20, content: secret },
        { index: 1, role: 'tool', contentType: 'blocks', length: null, content: secret },
      ],
      truncated: false,
      content: secret,
    },
    forwarded: {
      fields: ['model', 'messages', 'stream_options'],
      messageCount: 2,
      messages: [{ index: 0, role: 'system', contentType: 'text', length: 18 }],
      truncated: true,
    },
    rules: [
      {
        name: 'DSH role',
        mode: 'set',
        path: 'messages.0.role',
        outcome: 'applied',
        count: 1,
        changed: true,
        value: secret,
      },
      {
        name: 'identity',
        mode: 'regex_replace',
        path: 'messages.0.content',
        outcome: 'unmatched',
        count: 0,
        changed: false,
      },
      { name: 'custom', mode: 'copy', path: 'missing', outcome: 'skipped' },
    ],
    headers: {
      configured: ['user-agent', 'x-ide-name'],
      supported: true,
      attempts: [
        { attempt: 1, status: 503, supported: false },
        { attempt: 2, status: 400, supported: true },
      ],
      values: secret,
    },
  }
  let detailRequests = 0
  let retryRequests = 0
  await page.route('**/api/logs', (route) =>
    route.fulfill({ json: { logs: [current, legacy, failed] } }),
  )
  await page.route('**/api/logs/requests/*', async (route) => {
    const id = route.request().url().split('/').pop()
    detailRequests++
    if (id === current.id) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      await route.fulfill({ json: { log: { ...current, requestDiagnostics: diagnostics } } })
    } else if (id === legacy.id) {
      await route.fulfill({ json: { log: legacy } })
    } else if (++retryRequests === 1) {
      await route.fulfill({ status: 503, json: { error: { message: 'unavailable' } } })
    } else {
      await route.fulfill({
        json: {
          log: {
            ...failed,
            requestDiagnostics: {
              ...diagnostics,
              headers: { ...diagnostics.headers, supported: null },
            },
          },
        },
      })
    }
  })

  await login(page)
  await page.getByRole('link', { name: '请求日志', exact: true }).click()
  const open = async (name: string) =>
    page
      .getByRole('row')
      .filter({ hasText: name })
      .getByRole('button', { name: '查看事件详情' })
      .click()
  await open('诊断请求')
  const dialog = page.getByRole('dialog', { name: 'API 请求详情' })
  await expect(dialog.getByRole('status')).toHaveText('正在读取请求详情')
  await expect(dialog.getByTestId('request-shape-received')).toContainText('developer')
  await expect(dialog.getByTestId('request-shape-received')).toContainText('长度 未知')
  await expect(dialog.getByTestId('request-shape-forwarded')).toContainText('system')
  await expect(dialog.getByTestId('request-shape-forwarded')).toContainText('结构记录已截断')
  for (const outcome of ['已应用', '未匹配', '已跳过'])
    await expect(dialog.getByTestId('request-rules')).toContainText(outcome)
  await expect(dialog.getByTestId('request-rules')).toContainText('次数 0')
  await expect(dialog.getByTestId('request-rules')).toContainText('字段已改变')
  await expect(dialog.getByTestId('request-rules')).toContainText('字段未改变')
  await expect(dialog.getByTestId('request-headers')).toContainText('工作区确认支持')
  await expect(dialog.getByTestId('request-headers')).toContainText('第 1 次 · HTTP 503')
  await expect(dialog.getByTestId('request-headers')).toContainText('工作区不支持')
  await expect(dialog.getByTestId('request-headers')).toContainText('不代表服务商已收到请求头')
  await expect(dialog).not.toContainText(secret)
  await dialog.getByRole('button', { name: '复制详情' }).click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).includes('requestDiagnostics'),
    )
    .toBe(true)
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toContain(secret)
  await page.screenshot({ path: '../test-results/request-diagnostics-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await dialog.getByTestId('request-headers').scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  expect(
    await dialog.locator('.modal-content').evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true)
  await page.screenshot({ path: '../test-results/request-diagnostics-mobile.png' })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  await open('旧请求')
  await expect(dialog).toContainText('此记录未保存请求结构。')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await open('重试请求')
  await expect(dialog.getByRole('alert')).toContainText('读取请求详情失败，请重试。')
  await dialog.getByRole('button', { name: '重试', exact: true }).click()
  await expect(dialog.getByTestId('request-rules')).toContainText('已应用')
  await expect(dialog.getByTestId('request-headers')).toContainText('暂无工作区确认')
  expect(detailRequests).toBe(4)
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  const delayedDetail = page.waitForResponse((response) =>
    response.url().endsWith('/api/logs/requests/diagnostic-request'),
  )
  await open('诊断请求')
  await expect(dialog.getByRole('status')).toBeVisible()
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await open('旧请求')
  await expect(dialog).toContainText('此记录未保存请求结构。')
  await delayedDetail
  await expect(dialog).toContainText('此记录未保存请求结构。')
  await expect(dialog.getByTestId('request-rules')).toHaveCount(0)
})

test('override settings round-trip through the management API', async ({ page }) => {
  await login(page)
  const original = (await (await page.request.get('/api/settings')).json()).settings
  const rules = { operations: [{ mode: 'set', path: 'temperature', value: 0.4 }] }
  const headers = { 'user-agent': 'browser-test-client' }
  try {
    await page.getByRole('link', { name: '路由策略', exact: true }).click()
    const preset = page.getByRole('checkbox', { name: /CNB \/ DSH 兼容预设/ })
    const operations = page.getByLabel('参数覆盖', { exact: true })
    const headerInput = page.getByLabel('请求头覆盖', { exact: true })
    const save = page.getByRole('button', { name: '保存配置' })
    await preset.uncheck()
    await operations.fill(JSON.stringify(rules))
    await headerInput.fill(JSON.stringify(headers))
    await save.click()
    await expect(page.getByText('路由配置已保存并即时生效')).toBeVisible()
    await expect
      .poll(async () => (await (await page.request.get('/api/settings')).json()).settings)
      .toMatchObject({ dshCompat: false, requestOverrides: rules, upstreamHeaders: headers })
    await page.reload()
    await expect(preset).not.toBeChecked()
    await expect.poll(async () => JSON.parse(await operations.inputValue())).toEqual(rules)
    await expect.poll(async () => JSON.parse(await headerInput.inputValue())).toEqual(headers)
    await page.getByRole('button', { name: '清空规则' }).click()
    await page.getByRole('button', { name: '清空请求头' }).click()
    await preset.check()
    await save.click()
    await expect
      .poll(async () => (await (await page.request.get('/api/settings')).json()).settings)
      .toMatchObject({ dshCompat: true, requestOverrides: { operations: [] }, upstreamHeaders: {} })
    await page.reload()
    await expect(preset).toBeChecked()
    await expect
      .poll(async () => JSON.parse(await operations.inputValue()))
      .toEqual({ operations: [] })
    await expect.poll(async () => JSON.parse(await headerInput.inputValue())).toEqual({})
  } finally {
    await page.request.patch('/api/settings', { data: original })
  }
})
