import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

const ADMIN = 'browser-test-admin-key'
async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await expect(page.getByRole('heading', { name: '账号池' })).toBeVisible()
}
async function searchLogs(page: Page, query: string, channel = 'requests') {
  const path = channel === 'requests' ? '/api/logs' : `/api/logs/${channel}`
  const response = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname === path && url.searchParams.get('q') === query
  })
  await page.getByLabel('搜索事件', { exact: true }).fill(query)
  await response
}
async function seed(request: APIRequestContext) {
  await request.post('/api/session', { data: { key: ADMIN } })
  await request.patch('/api/settings', {
    data: {
      strategy: 'weighted',
      sessionAffinity: true,
      quotaProtection: { enabled: false, thresholdPercent: 10 },
    },
  })
  const data = await (await request.get('/api/accounts')).json()
  for (const account of data.accounts) await request.delete(`/api/accounts/${account.id}`)
  await request.post('http://127.0.0.1:19221/test/quota', {
    data: { total: 2000, used: 100, freeze: 25 },
  })
  const created = []
  for (const [index, name, group, weight, priority, enabled] of [
    [0, 'AzureKiln · 主力', '主力账号', 3, 10, true],
    [1, '开发工作区', '开发测试', 2, 0, true],
    [2, '备用工作区', '备用账号', 1, 0, false],
  ] as const) {
    const result = await request.post('/api/accounts', {
      data: {
        name,
        repo: `azurekiln-${index}/cnb2api`,
        group,
        weight,
        priority,
        enabled,
        proxyKey: 'test-worker-key',
        endpoint: 'http://127.0.0.1:19221',
      },
    })
    const { account } = await result.json()
    created.push(account)
    await request.post(`/api/accounts/${account.id}/probe`, { data: {} })
  }
  return created
}

test('login rejects a wrong key and first account can be created, edited, filtered and deleted', async ({
  page,
  request,
}) => {
  await request.post('/api/session', { data: { key: ADMIN } })
  const current = await (await request.get('/api/accounts')).json()
  for (const account of current.accounts) await request.delete(`/api/accounts/${account.id}`)
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill('incorrect-key')
  await page.getByRole('button', { name: '进入控制台' }).click()
  await expect(page.getByRole('alert')).toContainText('管理密钥不正确')
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await expect(page.getByRole('heading', { name: '从第一个 CNB 账号开始' })).toBeVisible()
  await page.screenshot({ path: '../test-results/accounts-empty.png', fullPage: true })
  await page.getByRole('button', { name: '接入第一个账号' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('账号名称').fill('我的测试账号')
  await dialog.getByLabel('CNB 仓库路径').fill('browser-test/cnb2api')
  await dialog.getByLabel('工作区地址').fill('http://127.0.0.1:19221')
  await dialog.getByLabel('工作区 PROXY_KEY').fill('test-worker-key')
  await dialog.getByRole('button', { name: '随机生成', exact: true }).click()
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(page.getByRole('heading', { name: '配置工作区自注册' })).toBeVisible()
  await expect(dialog.locator('pre')).toContainText('/ops/register/')
  await expect(dialog.locator('pre')).toContainText('REG_TOKEN:')
  await dialog.getByRole('button', { name: '我已保存配置' }).click()
  await page.getByRole('button', { name: '编辑我的测试账号' }).click()
  await dialog.getByLabel('账号名称').fill('修改后的账号')
  await dialog.getByRole('button', { name: '保存修改' }).click()
  await expect(
    page.getByRole('button', { name: '修改后的账号 默认分组', exact: true }),
  ).toBeVisible()
  await page.getByLabel('搜索账号', { exact: true }).fill('不存在')
  await expect(page.getByRole('heading', { name: '没有找到匹配的账号' })).toBeVisible()
  await page.getByRole('button', { name: '清除筛选', exact: true }).click()
  await page.getByRole('button', { name: '管理修改后的账号' }).click()
  await dialog.getByRole('button', { name: '移除账号' }).click()
  await page.getByRole('button', { name: '确认移除' }).click()
  await expect(page.getByRole('heading', { name: '从第一个 CNB 账号开始' })).toBeVisible()
})

test('existing cloud tokens can be imported and edited without the cloud configuration wizard', async ({
  page,
  request,
}) => {
  await seed(request)
  await login(page)
  await page.getByRole('button', { name: '接入账号', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('账号名称').fill('沿用云机配置')
  await dialog.getByLabel('CNB 仓库路径').fill('legacy/cnb2api')
  await dialog.getByLabel('工作区 PROXY_KEY').fill('test-worker-key')
  await dialog.getByLabel('注册密钥 REG_TOKEN').fill('123456789')
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(page.getByText('账号已添加，已沿用原有注册密钥')).toBeVisible()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('heading', { name: '配置工作区自注册' })).not.toBeVisible()
  const { accounts } = await (await request.get('/api/accounts')).json()
  const account = accounts.find((a: { repo: string }) => a.repo === 'legacy/cnb2api')
  expect(account).toBeTruthy()
  const register = (token: string) =>
    request.post('/register', {
      headers: { 'X-Reg-Token': token },
      data: { uri: 'http://127.0.0.1:19221' },
    })
  expect((await register('123456789')).status()).toBe(200)
  const registered = await (await request.get(`/api/accounts/${account.id}`)).json()
  expect(registered.account.endpoint).toBe('http://127.0.0.1:19221')

  await page.getByRole('button', { name: '接入账号', exact: true }).click()
  await dialog.getByLabel('账号名称').fill('重复 token')
  await dialog.getByLabel('CNB 仓库路径').fill('legacy/duplicate')
  await dialog.getByLabel('工作区 PROXY_KEY').fill('test-worker-key')
  await dialog.getByLabel('注册密钥 REG_TOKEN').fill('123456789')
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('该注册密钥已被其他账号使用')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await page.getByRole('button', { name: '编辑沿用云机配置' }).click()
  await expect(dialog.getByLabel('注册密钥 REG_TOKEN')).toHaveValue('')
  await dialog.getByRole('button', { name: '保存修改' }).click()
  await expect(dialog).not.toBeVisible()
  expect((await register('123456789')).status()).toBe(200)
  await page.getByRole('button', { name: '编辑沿用云机配置' }).click()
  const replacementToken = 'another-"quoted"\\token'
  await dialog.getByLabel('注册密钥 REG_TOKEN').fill(replacementToken)
  await dialog.getByRole('button', { name: '保存修改' }).click()
  await expect(page.getByRole('heading', { name: '配置工作区自注册' })).toBeVisible()
  const snippet = await dialog.locator('pre').innerText()
  const tokenLine = snippet.split('\n').find((line) => line.trim().startsWith('REG_TOKEN:'))
  expect(tokenLine).toBeTruthy()
  expect(JSON.parse(tokenLine!.split('REG_TOKEN:')[1]!.trim())).toBe(replacementToken)
  await dialog.getByRole('button', { name: '我已保存配置' }).click()
  expect((await register('123456789')).status()).toBe(403)
  expect((await register(replacementToken)).status()).toBe(200)
})

test('accounts can use a generated registration token without a repository and preserve it on blank edits', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await seed(request)
  await login(page)
  await page.getByRole('button', { name: '接入账号', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const repository = dialog.getByLabel('CNB 仓库路径')
  const tokenInput = dialog.getByLabel('注册密钥 REG_TOKEN')
  await expect(repository).not.toHaveAttribute('required', '')
  await expect(repository).toHaveValue('')
  await expect(tokenInput).toHaveValue('')
  await expect(tokenInput).toHaveAttribute('required', '')
  await expect(dialog.getByRole('button', { name: '显示注册密钥', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '复制注册密钥', exact: true })).toBeDisabled()
  await dialog.getByLabel('账号名称').fill('无仓库工作区')
  const proxyKey = dialog.getByLabel('工作区 PROXY_KEY')
  await proxyKey.fill('test-worker-key')
  await expect(proxyKey).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '显示工作区密钥', exact: true }).click()
  await expect(proxyKey).toHaveAttribute('type', 'text')
  await expect(proxyKey).toHaveValue('test-worker-key')
  await dialog.getByRole('button', { name: '隐藏工作区密钥', exact: true }).click()
  await expect(proxyKey).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '复制工作区密钥', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('test-worker-key')
  await dialog.getByRole('button', { name: '随机生成', exact: true }).click()
  const firstToken = await tokenInput.inputValue()
  expect(firstToken).toMatch(/^[a-f0-9]{48}$/)
  await expect(tokenInput).toHaveAttribute('type', 'text')
  await dialog.getByRole('button', { name: '隐藏注册密钥', exact: true }).click()
  await expect(tokenInput).toHaveAttribute('type', 'password')
  await expect(tokenInput).toHaveValue(firstToken)
  await dialog.getByRole('button', { name: '显示注册密钥', exact: true }).click()
  await expect(tokenInput).toHaveAttribute('type', 'text')
  await expect(tokenInput).toHaveValue(firstToken)
  await dialog.getByRole('button', { name: '随机生成', exact: true }).click()
  const token = await tokenInput.inputValue()
  expect(token).toMatch(/^[a-f0-9]{48}$/)
  expect(token).not.toBe(firstToken)
  await dialog.getByRole('button', { name: '隐藏注册密钥', exact: true }).click()
  await dialog.getByRole('button', { name: '复制注册密钥', exact: true }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(token)
  await tokenInput.fill('manual-registration-token-to-copy')
  await dialog.getByRole('button', { name: '复制注册密钥', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('manual-registration-token-to-copy')
  await tokenInput.fill(token)
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(page.getByRole('heading', { name: '配置工作区自注册' })).toBeVisible()
  await expect(dialog.locator('pre')).toContainText(token)
  await expect(dialog.locator('pre')).toContainText('/ops/register/')
  await expect(dialog.getByRole('link', { name: '打开 CNB 仓库' })).not.toBeVisible()
  await dialog.getByRole('button', { name: '我已保存配置' }).click()

  const { accounts } = await (await request.get('/api/accounts')).json()
  const account = accounts.find((a: { name: string }) => a.name === '无仓库工作区')
  expect(account).toBeTruthy()
  expect(account.repo).toBe('')
  await expect(page.getByRole('link', { name: '打开 CNB 首页', exact: true })).toHaveAttribute(
    'href',
    'https://cnb.cool/',
  )
  await expect(page.getByRole('link', { name: '打开 CNB 首页', exact: true })).toHaveAttribute(
    'target',
    '_blank',
  )
  const register = () =>
    request.post('/register', {
      headers: { 'X-Reg-Token': token },
      data: { uri: 'http://127.0.0.1:19221' },
    })
  expect((await register()).status()).toBe(200)
  await page.getByRole('button', { name: '编辑无仓库工作区' }).click()
  await expect(dialog.getByLabel('CNB 仓库路径')).toHaveValue('')
  await expect(dialog.getByLabel('注册密钥 REG_TOKEN')).toHaveValue('')
  await dialog.getByRole('button', { name: '保存修改' }).click()
  await expect(dialog).not.toBeVisible()
  expect((await register()).status()).toBe(200)
})

for (const clipboardMode of ['unavailable', 'rejected'] as const) {
  test(`registration token can be copied inside a modal when the Clipboard API is ${clipboardMode}`, async ({
    page,
    request,
  }) => {
    await seed(request)
    await login(page)
    await page.getByRole('button', { name: '接入账号', exact: true }).click()
    const dialog = page.getByRole('dialog')
    const token = `fallback-registration-token-${clipboardMode}`
    await dialog.getByLabel('注册密钥 REG_TOKEN').fill(token)
    await page.evaluate((mode) => {
      if (mode === 'unavailable') {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
      } else {
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: async () => {
            throw new DOMException('Clipboard write denied', 'NotAllowedError')
          },
        })
      }
    }, clipboardMode)
    await dialog.getByRole('button', { name: '复制注册密钥', exact: true }).click()
    await expect(page.getByText('已复制到剪贴板', { exact: true })).toBeVisible()
    const pasteTarget = dialog.getByLabel('账号名称')
    await pasteTarget.fill('')
    await pasteTarget.press('ControlOrMeta+V')
    await expect(pasteTarget).toHaveValue(token)
    await expect(dialog).toBeVisible()
  })
}

test('personal tokens can be shown, hidden, copied, preserved on edits and removed', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await seed(request)
  await login(page)
  await page.getByRole('button', { name: '接入账号', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('账号名称').fill('个人令牌工作区')
  await dialog.getByLabel('工作区 PROXY_KEY').fill('test-worker-key')
  await dialog.getByLabel('注册密钥 REG_TOKEN').fill('personal-token-test-registration')
  await dialog.getByRole('button', { name: /高级配置/ }).click()
  await expect(dialog).toContainText('自动唤醒有30分钟间隔，手动唤醒可立即重试')
  const personalToken = dialog.getByLabel('CNB 个人令牌（可选）', { exact: true })
  await personalToken.fill('test-personal-token-for-visibility')
  await expect(personalToken).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '显示个人令牌', exact: true }).click()
  await expect(personalToken).toHaveAttribute('type', 'text')
  await expect(personalToken).toHaveValue('test-personal-token-for-visibility')
  await dialog.getByRole('button', { name: '隐藏个人令牌', exact: true }).click()
  await expect(personalToken).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '添加账号', exact: true }).click()
  await expect(dialog).not.toBeVisible()

  await page.getByRole('button', { name: '编辑个人令牌工作区' }).click()
  await expect(personalToken).toHaveValue('')
  await expect(dialog.getByRole('button', { name: '显示个人令牌', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: '显示个人令牌', exact: true }).click()
  await expect(personalToken).toHaveValue('test-personal-token-for-visibility')
  await expect(personalToken).toHaveAttribute('type', 'text')
  await dialog.getByRole('button', { name: '隐藏个人令牌', exact: true }).click()
  await dialog.getByRole('button', { name: '复制个人令牌', exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('test-personal-token-for-visibility')
  await dialog.getByRole('button', { name: '保存修改' }).click()
  await expect(dialog).not.toBeVisible()
  await page.getByRole('button', { name: '编辑个人令牌工作区' }).click()
  await expect(personalToken).toHaveValue('')
  await dialog.getByRole('button', { name: '保存修改' }).click()
  const { accounts } = await (await request.get('/api/accounts')).json()
  const saved = accounts.find((account: { name: string }) => account.name === '个人令牌工作区')
  expect(saved.hasPat).toBe(true)
  await page.getByRole('button', { name: '编辑个人令牌工作区' }).click()
  await dialog.getByLabel('移除已保存的个人令牌').check()
  await expect(personalToken).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '显示个人令牌', exact: true })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: '复制个人令牌', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '保存修改' }).click()
  await expect(dialog).not.toBeVisible()
  const removed = await (await request.get(`/api/accounts/${saved.id}`)).json()
  expect(removed.account.hasPat).toBe(false)
})

test('saved account credentials can be revealed or copied without changing or rotating them', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await seed(request)
  const credentials = {
    proxyKey: 'saved-workspace-proxy-key',
    registrationToken: 'saved-workspace-registration-token',
    pat: 'saved-workspace-personal-token',
  }
  const created = await request.post('/api/accounts', {
    data: { name: '已保存凭据工作区', repo: 'browser-secrets/cnb2api', ...credentials },
  })
  expect(created.status()).toBe(201)
  const { account } = await created.json()
  let credentialReads = 0
  page.on('request', (req) => {
    if (new URL(req.url()).pathname === `/api/accounts/${account.id}/credentials`) credentialReads++
  })
  await login(page)
  await page.getByRole('button', { name: '编辑已保存凭据工作区', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const fields = [
    ['工作区 PROXY_KEY', '工作区密钥', credentials.proxyKey],
    ['注册密钥 REG_TOKEN', '注册密钥', credentials.registrationToken],
    ['CNB 个人令牌（可选）', '个人令牌', credentials.pat],
  ] as const
  for (const [label, name, value] of fields) {
    const input = dialog.getByLabel(label, { exact: true })
    await expect(input).toHaveValue('')
    await expect(input).toHaveAttribute('type', 'password')
    await expect(dialog.getByRole('button', { name: `显示${name}`, exact: true })).toBeEnabled()
    await dialog.getByRole('button', { name: `复制${name}`, exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value)
    await expect(input).toHaveValue(value)
    await expect(input).toHaveAttribute('type', 'password')
    await dialog.getByRole('button', { name: `显示${name}`, exact: true }).click()
    await expect(input).toHaveAttribute('type', 'text')
    await expect(input).toHaveValue(value)
    await dialog.getByRole('button', { name: `隐藏${name}`, exact: true }).click()
    await expect(input).toHaveAttribute('type', 'password')
  }
  expect(credentialReads).toBe(1)
  const save = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === `/api/accounts/${account.id}` && req.method() === 'PATCH',
  )
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  const savedPayload = (await save).postDataJSON()
  for (const field of Object.keys(credentials)) expect(savedPayload).not.toHaveProperty(field)
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('heading', { name: '配置工作区自注册' })).not.toBeVisible()
  expect(
    await (await request.post(`/api/accounts/${account.id}/credentials`, { data: {} })).json(),
  ).toEqual(credentials)

  await page.getByRole('button', { name: '编辑已保存凭据工作区', exact: true }).click()
  const replacements = {
    proxyKey: 'replacement-workspace-proxy-key',
    registrationToken: 'replacement-workspace-registration-token',
    pat: 'replacement-workspace-personal-token',
  }
  for (const [label] of fields)
    await expect(dialog.getByLabel(label, { exact: true })).toHaveValue('')
  await dialog.getByLabel('工作区 PROXY_KEY', { exact: true }).fill(replacements.proxyKey)
  await dialog
    .getByLabel('注册密钥 REG_TOKEN', { exact: true })
    .fill(replacements.registrationToken)
  await dialog.getByLabel('CNB 个人令牌（可选）', { exact: true }).fill(replacements.pat)
  await dialog.getByRole('button', { name: '保存修改', exact: true }).click()
  await expect(page.getByRole('heading', { name: '配置工作区自注册' })).toBeVisible()
  await expect(dialog.locator('pre')).toContainText(replacements.registrationToken)
  await dialog.getByRole('button', { name: '我已保存配置', exact: true }).click()
  expect(
    await (await request.post(`/api/accounts/${account.id}/credentials`, { data: {} })).json(),
  ).toEqual(replacements)
  await page.getByRole('button', { name: '编辑已保存凭据工作区', exact: true }).click()
  for (const [label, name] of fields) {
    await expect(dialog.getByLabel(label, { exact: true })).toHaveValue('')
    await dialog.getByRole('button', { name: `显示${name}`, exact: true }).click()
  }
  await page.screenshot({ path: '../test-results/saved-account-credentials.png', fullPage: true })
})

test('loading saved credentials preserves in-flight edits and cannot populate a reopened dialog', async ({
  page,
  request,
}) => {
  await seed(request)
  const credentials = {
    proxyKey: 'delayed-saved-proxy-key',
    registrationToken: 'delayed-saved-registration-token',
    pat: 'delayed-saved-personal-token',
  }
  const created = await request.post('/api/accounts', {
    data: { name: '延迟读取工作区', ...credentials },
  })
  expect(created.status()).toBe(201)
  const { account } = await created.json()
  const pending: Array<() => void> = []
  const path = `/api/accounts/${account.id}/credentials`
  await page.route(`**${path}`, async (route) => {
    await new Promise<void>((resolve) => pending.push(resolve))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(credentials),
    })
  })
  await login(page)
  await page.getByRole('button', { name: '编辑延迟读取工作区', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const proxy = dialog.getByLabel('工作区 PROXY_KEY', { exact: true })
  await dialog.getByRole('button', { name: '显示工作区密钥', exact: true }).click()
  await expect.poll(() => pending.length).toBe(1)
  await proxy.fill('operator-entered-proxy-key')
  pending[0]!()
  await expect(dialog.getByRole('button', { name: '隐藏工作区密钥', exact: true })).toBeVisible()
  await expect(proxy).toHaveValue('operator-entered-proxy-key')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()

  await page.getByRole('button', { name: '编辑延迟读取工作区', exact: true }).click()
  await expect(proxy).toHaveValue('')
  await expect(proxy).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '显示注册密钥', exact: true }).click()
  await expect.poll(() => pending.length).toBe(2)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '编辑延迟读取工作区', exact: true }).click()
  const closedResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === path,
  )
  pending[1]!()
  await closedResponse
  await expect(dialog.getByLabel('注册密钥 REG_TOKEN', { exact: true })).toHaveValue('')
  await expect(proxy).toHaveValue('')
  await dialog.getByRole('button', { name: '显示个人令牌', exact: true }).click()
  await expect.poll(() => pending.length).toBe(3)
  pending[2]!()
  await expect(dialog.getByLabel('CNB 个人令牌（可选）', { exact: true })).toHaveValue(
    credentials.pat,
  )
  await expect(proxy).toHaveValue('')
  await expect(dialog.getByLabel('注册密钥 REG_TOKEN', { exact: true })).toHaveValue('')
})

test('overview summary cards remain visible when token and credit data is absent', async ({
  page,
  request,
}) => {
  await seed(request)
  await page.route('**/api/overview', async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    data.stats.tokenUsage.today = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      reportedRequests: 0,
      missingRequests: 0,
      partialRequests: 0,
    }
    data.stats.remainingCredits = null
    data.stats.quotaOrganizations = 0
    for (const account of data.accounts) {
      account.hasPat = false
      account.quota = null
      account.quotaSync = null
    }
    await route.fulfill({ response, json: data })
  })
  await login(page)
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  const token = page.getByTestId('overview-token-summary')
  const credits = page.getByTestId('overview-credits-summary')
  await expect(token).toBeInViewport()
  await expect(credits).toBeInViewport()
  await expect(page.getByTestId('summary-token-total')).toHaveText('0')
  await expect(token).toContainText('今日暂无请求，调用统一入口后自动统计')
  await expect(page.getByTestId('summary-credits-remaining')).toHaveText('—')
  await expect(credits).toContainText('尚未配置额度同步')
})

test('overview distinguishes missing token usage from measured zero in totals and comparison', async ({
  page,
  request,
}) => {
  await seed(request)
  const overview = await (await request.get('/api/overview')).json()
  const comparison = await (await request.post('/api/usage/comparison', { data: {} })).json()
  let usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    reportedRequests: 0,
    missingRequests: 2,
    partialRequests: 0,
  }
  await page.route('**/api/overview', (route) =>
    route.fulfill({
      json: {
        ...overview,
        stats: {
          ...overview.stats,
          tokenUsage: { ...overview.stats.tokenUsage, today: usage, total: usage },
        },
      },
    }),
  )
  await page.route('**/api/usage/comparison', (route) =>
    route.fulfill({
      json: {
        accounts: comparison.accounts.map((row: Record<string, unknown>) => ({
          ...row,
          local: usage,
        })),
      },
    }),
  )
  await login(page)
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  await expect(page.getByTestId('summary-token-total')).toHaveText('—')
  await expect(page.getByTestId('overview-token-summary')).toContainText('2 次请求未上报用量')
  const tokenPanel = page.getByRole('region', { name: 'Token 用量', exact: true })
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'])
    await expect(tokenPanel.getByTestId(`token-${key}`).locator('strong')).toHaveText('—')
  await tokenPanel.getByRole('button', { name: '累计', exact: true }).click()
  await expect(tokenPanel.getByTestId('token-total').locator('strong')).toHaveText('—')
  const account = page.getByTestId(`usage-comparison-${comparison.accounts[0].accountId}`)
  await expect(account.getByTestId('comparison-local')).toHaveText('—')
  await expect(account.getByTestId('comparison-difference')).toHaveText('—')
  await expect(account).toContainText('2 次本地请求未上报用量')
  await account.getByText('查看输入、输出与缓存明细', { exact: true }).click()
  await expect(account.getByRole('row', { name: '输入 Tokens — 0 —', exact: true })).toBeVisible()
  usage = { ...usage, reportedRequests: 1, missingRequests: 0 }
  await page.reload()
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  await expect(page.getByTestId('summary-token-total')).toHaveText('0')
  await expect(page.getByTestId('overview-token-summary')).toContainText('1 次已上报')
  await expect(account.getByTestId('comparison-local')).toHaveText('0')
  await expect(account.getByTestId('comparison-difference')).toHaveText('0')
})

test('overview shows measured token usage and compares aligned worker usage on desktop and phone', async ({
  page,
  request,
}) => {
  const seeded = await seed(request)
  await request.post('http://127.0.0.1:19221/test/quota', {
    data: { total: 2000, used: 100, freeze: 25 },
  })
  await request.patch(`/api/accounts/${seeded[0].id}`, {
    data: { pat: 'test-overview-personal-token' },
  })
  await expect
    .poll(async () => (await (await request.get('/api/overview')).json()).stats.remainingCredits)
    .toBe(1875)
  expect((await request.post('/api/usage/comparison', { data: {} })).status()).toBe(200)
  const before = await (await request.get('/api/overview')).json()
  const response = await request.post('/v1/chat/completions', {
    headers: { Authorization: 'Bearer browser-test-gateway-key' },
    data: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Test usage' }] },
  })
  expect(response.status()).toBe(200)
  expect((await response.json()).usage.prompt_tokens).toBe(1200)
  await expect
    .poll(
      async () => (await (await request.get('/api/overview')).json()).stats.tokenUsage.total.total,
    )
    .toBe(before.stats.tokenUsage.total.total + 1500)
  const after = await (await request.get('/api/overview')).json()
  await login(page)
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  await expect(page.getByTestId('overview-token-summary')).toBeInViewport()
  await expect(page.getByTestId('overview-credits-summary')).toBeInViewport()
  await expect(page.getByTestId('summary-token-total')).toHaveText(
    after.stats.tokenUsage.today.total.toLocaleString('zh-CN'),
  )
  await expect(page.getByTestId('summary-credits-remaining')).toHaveText('1,875')
  for (const [label, value] of [
    ['输入', after.stats.tokenUsage.today.input],
    ['输出', after.stats.tokenUsage.today.output],
    ['缓存读取', after.stats.tokenUsage.today.cacheRead],
    ['缓存写入', after.stats.tokenUsage.today.cacheWrite],
  ] as const) {
    await expect(
      page
        .getByTestId('overview-token-summary')
        .locator('dl > div')
        .filter({ has: page.getByText(label, { exact: true }) })
        .locator('dd'),
    ).toHaveText(Number(value).toLocaleString('zh-CN'))
  }
  await expect(page.getByTestId('overview-credits-summary')).toContainText('已使用')
  await expect(page.getByTestId('overview-credits-summary')).toContainText('总额度')
  await page.screenshot({ path: '../test-results/overview-summary-desktop.png' })
  await expect(page.getByRole('region', { name: 'Credits 额度', exact: true })).toBeVisible()
  await expect(page.getByTestId('overview-credits-remaining').locator('strong')).toHaveText('1,875')
  const tokenPanel = page.getByRole('region', { name: 'Token 用量', exact: true })
  for (const [key, value] of Object.entries(after.stats.tokenUsage.today)) {
    if (['input', 'output', 'cacheRead', 'cacheWrite', 'total'].includes(key)) {
      await expect(tokenPanel.getByTestId(`token-${key}`).locator('strong')).toHaveText(
        Number(value).toLocaleString('zh-CN'),
      )
    }
  }
  await tokenPanel.getByRole('button', { name: '累计', exact: true }).click()
  await expect(page.getByTestId('summary-token-total')).toHaveText(
    after.stats.tokenUsage.today.total.toLocaleString('zh-CN'),
  )
  await expect(tokenPanel.getByTestId('token-input').locator('strong')).toHaveText(
    after.stats.tokenUsage.total.input.toLocaleString('zh-CN'),
  )
  await expect(tokenPanel.getByTestId('token-cacheRead').locator('strong')).toHaveText(
    after.stats.tokenUsage.total.cacheRead.toLocaleString('zh-CN'),
  )
  await expect(tokenPanel).toContainText('缓存已包含在输入中，不重复相加')
  await page.getByRole('button', { name: '同步工作区用量', exact: true }).click()
  const comparison = page.getByTestId(`usage-comparison-${seeded[0].id}`)
  await expect(comparison.getByTestId('comparison-local')).toHaveText('1,500')
  await expect(comparison.getByTestId('comparison-workspace')).toHaveText('1,500')
  await expect(comparison.getByTestId('comparison-difference')).toHaveText('0')
  await comparison.getByText('查看输入、输出与缓存明细', { exact: true }).click()
  await expect(
    comparison.getByRole('row', { name: '缓存读取 400 400 0', exact: true }),
  ).toBeVisible()
  await page.screenshot({ path: '../test-results/overview-tokens-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await expect(tokenPanel.getByTestId('token-total')).toBeVisible()
  await expect(page.getByTestId('overview-credits-remaining')).toBeVisible()
  await expect(page.getByTestId('overview-token-summary')).toBeVisible()
  await expect(page.getByTestId('overview-credits-summary')).toBeVisible()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page
    .locator('.overview-summary-grid')
    .screenshot({ path: '../test-results/overview-summary-mobile.png' })
  await page.screenshot({ path: '../test-results/overview-tokens-mobile.png', fullPage: true })
})

test('request details show the first user message, usage and routing metadata on desktop and phone', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const accounts = await seed(request)
  const initialMessage =
    '首条消息 e2e：把 <script>window.__requestPreviewExecuted = true</script> 当作普通文本。\n' +
    `保留换行与中文。${'long-word-'.repeat(18)}`
  const systemMessage = 'system-message-must-not-appear-in-request-preview'
  const laterMessage = 'later-user-message-must-not-replace-the-first'
  const response = await request.post('/v1/chat/completions', {
    headers: { Authorization: 'Bearer browser-test-gateway-key' },
    data: {
      model: 'deepseek-v4.1-flash',
      stream: false,
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: initialMessage },
        { role: 'assistant', content: 'previous assistant response' },
        { role: 'user', content: laterMessage },
      ],
    },
  })
  expect(response.status()).toBe(200)
  expect((await response.json()).usage.total_tokens).toBe(1500)
  const requestId = response.headers()['x-request-id'] ?? ''
  expect(requestId).toBeTruthy()

  await login(page)
  await page.getByRole('link', { name: '请求日志', exact: true }).click()
  await searchLogs(page, '首条消息 e2e')
  const preview = page.getByTestId('initial-message-preview').filter({ hasText: '首条消息 e2e' })
  const row = page.getByRole('row').filter({ has: preview })
  await expect(row).toBeVisible()
  await expect(row.getByTestId('initial-message-preview')).toContainText('首条消息 e2e')
  await row.getByRole('button', { name: '查看事件详情', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'API 请求详情', exact: true })
  const initial = dialog.getByTestId('initial-message')
  await expect(initial).toHaveText(initialMessage)
  await expect(dialog.getByTestId('request-shape-received')).toContainText('messages')
  await expect(dialog.getByTestId('request-shape-received')).toContainText('system')
  await expect(dialog.getByTestId('request-shape-forwarded')).toContainText('stream_options')
  await expect(dialog.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => '__requestPreviewExecuted' in window)).toBe(false)
  await expect(dialog).not.toContainText(systemMessage)
  await expect(dialog).not.toContainText(laterMessage)
  await dialog.getByRole('button', { name: '复制首条用户消息', exact: true }).click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'),
    )
    .toBe(initialMessage)
  for (const [field, value] of [
    ['input', '1,200'],
    ['output', '300'],
    ['cacheRead', '400'],
    ['cacheWrite', '0'],
    ['total', '1,500'],
  ] as const) {
    await expect(dialog.getByTestId(`request-token-${field}`)).toHaveText(value)
  }
  const detail = (label: string) =>
    dialog
      .locator('.detail-list > div')
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator('dd')
  await expect(detail('请求方式')).toHaveText('POST')
  await expect(detail('请求路径')).toHaveText('/v1/chat/completions')
  await expect(detail('响应模式')).toHaveText('非流式响应')
  await expect(detail('目标工作区')).toHaveText('http://127.0.0.1:19221')
  await expect(detail('请求 ID')).toContainText(requestId)
  await expect(detail('首字节耗时')).toHaveText(/^\d[\d,]* ms$/)
  await expect(detail('请求大小')).toHaveText(/^\d[\d,.]* (?:B|KiB|MiB)$/)
  await expect(detail('上游正文大小')).toHaveText(/^\d[\d,.]* (?:B|KiB|MiB)$/)
  await page.screenshot({ path: '../test-results/request-details-desktop.png' })

  await page.setViewportSize({ width: 390, height: 844 })
  await initial.scrollIntoViewIfNeeded()
  await expect(initial).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  expect(
    await dialog
      .locator('.modal-content')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true)
  const messageBox = await initial.boundingBox()
  expect(messageBox).not.toBeNull()
  expect(messageBox!.x).toBeGreaterThanOrEqual(0)
  expect(messageBox!.x + messageBox!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: '../test-results/request-details-mobile.png' })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()

  const legacyLog = {
    id: 'legacy-request-preview',
    at: new Date().toISOString(),
    kind: 'request',
    accountId: accounts[0].id,
    accountName: '旧请求记录',
    status: 200,
    message: '旧版请求完成',
    path: '/v1/chat/completions',
    requestId: 'legacy-request-id',
  }
  await page.route('**/api/logs/requests/legacy-request-preview', (route) =>
    route.fulfill({ json: { log: legacyLog } }),
  )
  await page.route('**/api/logs?**', async (route) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 150))
    await route.fulfill({ json: { logs: [legacyLog], total: 1, limit: 20, offset: 0 } })
  })
  await page.getByLabel('搜索事件', { exact: true }).fill('')
  await page.getByRole('button', { name: '刷新记录', exact: true }).click()
  const legacyRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: '旧请求记录', exact: true }) })
  await expect(legacyRow).toBeVisible()
  await legacyRow.getByRole('button', { name: '查看事件详情', exact: true }).click()
  await expect(dialog).toContainText('此记录未保存首条用户消息。')
  await expect(dialog).toContainText('此记录未保存 Token 用量。')
  await expect(dialog).toContainText('此记录未保存请求结构。')
  await expect(dialog.getByTestId('initial-message')).toHaveCount(0)
})

test('account table filters groups and statuses, enables disabled accounts and renders without runtime errors', async ({
  page,
  request,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await seed(request)
  await login(page)
  await expect(
    page.getByRole('button', { name: 'AzureKiln · 主力 主力账号', exact: true }),
  ).toBeVisible()
  const repositoryLink = page.getByRole('link', {
    name: '打开 CNB 仓库 azurekiln-0/cnb2api',
    exact: true,
  })
  await expect(repositoryLink).toHaveAttribute('href', 'https://cnb.cool/azurekiln-0/cnb2api')
  await expect(repositoryLink).toHaveAttribute('target', '_blank')
  await expect(repositoryLink).toHaveAttribute('rel', 'noopener noreferrer')
  await page.screenshot({ path: '../test-results/accounts-desktop.png', fullPage: true })
  await page.getByRole('tab', { name: '已停用' }).click()
  await expect(page.getByRole('button', { name: '备用工作区 备用账号', exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: '开发工作区 开发测试', exact: true }),
  ).not.toBeVisible()
  await page.getByRole('button', { name: '管理备用工作区' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '启用账号' }).click()
  await expect(page.getByRole('heading', { name: '没有找到匹配的账号' })).toBeVisible()
  await page.getByRole('tab', { name: '全部账号' }).click()
  await page.getByLabel('账号分组', { exact: true }).selectOption('开发测试')
  await expect(page.getByRole('button', { name: '开发工作区 开发测试', exact: true })).toBeVisible()
  await expect(
    page.getByRole('button', { name: 'AzureKiln · 主力 主力账号', exact: true }),
  ).not.toBeVisible()
  await page.getByLabel('账号分组', { exact: true }).selectOption('all')
  await page.getByRole('button', { name: '切换深色主题' }).click()
  await page.screenshot({ path: '../test-results/accounts-dark.png', fullPage: true })
  expect(errors).toEqual([])
})

test('release version and selected sidebar remain distinct in light, dark, collapsed and mobile views', async ({
  page,
  request,
}) => {
  await seed(request)
  await login(page)
  await expect(page.locator('.footer-product small')).toHaveText(`v${version}`)
  const selected = page.locator('.main-nav > a[aria-current="page"]')
  const checkSelected = async () => {
    await expect(selected).toHaveCSS('color', 'rgb(0, 0, 0)')
    await expect(selected.locator('svg')).toHaveCSS('color', 'rgb(0, 0, 0)')
    await expect(selected.locator('small')).toHaveCSS('color', 'rgb(0, 0, 0)')
    const styles = await selected.evaluate((link) => {
      const css = getComputedStyle(link)
      const sidebar = getComputedStyle(link.closest('.sidebar')!)
      return {
        background: css.backgroundColor,
        sidebar: sidebar.backgroundColor,
        weight: Number(css.fontWeight),
        shadow: css.boxShadow,
      }
    })
    expect(styles.background).not.toBe(styles.sidebar)
    expect(styles.background).not.toBe('rgba(0, 0, 0, 0)')
    expect(styles.weight).toBe(500)
    expect(styles.shadow).toContain('rgb(30, 64, 175)')
  }
  await expect(page.locator('.nav-caption').first()).toHaveCSS('font-weight', '450')
  await checkSelected()
  await page.screenshot({ path: '../test-results/sidebar-selected-light.png', fullPage: true })
  await page.getByRole('button', { name: '切换深色主题' }).click()
  await checkSelected()
  await page.screenshot({ path: '../test-results/sidebar-selected-dark.png', fullPage: true })
  await page.getByRole('button', { name: '收起侧栏' }).click()
  await checkSelected()
  await page.screenshot({ path: '../test-results/sidebar-selected-collapsed.png', fullPage: true })
  await page.getByRole('button', { name: '展开侧栏' }).click()
  await page.getByRole('button', { name: '切换浅色主题' }).click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: '展开导航' }).click()
  await expect(page.locator('.sidebar')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
  await checkSelected()
  await page.screenshot({ path: '../test-results/sidebar-selected-mobile.png', fullPage: true })
})

test('bulk probing stays available while another account operation is pending', async ({
  page,
  request,
}) => {
  const accounts = await seed(request)
  await login(page)
  let releaseProbe!: () => void
  const pendingProbe = new Promise<void>((resolve) => {
    releaseProbe = resolve
  })
  let otherProbes = 0
  await page.route('**/api/accounts/*/probe', async (route) => {
    if (route.request().url().includes(`/accounts/${accounts[0].id}/`)) await pendingProbe
    else otherProbes++
    await route.continue()
  })
  const firstProbe = page.getByRole('button', { name: '探活AzureKiln · 主力', exact: true })
  try {
    await firstProbe.click()
    await expect(firstProbe).toBeDisabled()
    const bulk = page.getByRole('button', { name: '全部探活', exact: true })
    await expect(bulk).toBeEnabled()
    await bulk.click()
    await expect.poll(() => otherProbes).toBe(1)
    await expect(bulk).toBeEnabled()
    expect(otherProbes).toBe(1)
  } finally {
    releaseProbe()
  }
  await expect(firstProbe).toBeEnabled()
})

test('request outcomes filter results and export every matching page', async ({
  page,
  request,
}) => {
  await seed(request)
  const matching = [...Array.from({ length: 22 }, () => 200), 302, 400, 499, 503].map(
    (status, index) => ({
      id: `export-request-${index}`,
      at: '2026-10-29T07:00:00.000Z',
      kind: 'request',
      accountId: 'filter-account',
      accountName: '筛选工作区',
      status,
      message: '筛选导出标记',
      durationMs: 10,
    }),
  )
  const seeded = await request.post('http://127.0.0.1:19221/test/request-logs', {
    data: { logs: [...matching, { ...matching[0], id: 'outside-search', message: '其他记录' }] },
  })
  expect(seeded.ok()).toBe(true)
  await login(page)
  await page.getByRole('link', { name: '请求日志', exact: true }).click()
  const outcome = page.getByLabel('请求结果', { exact: true })
  await expect(outcome).toBeVisible()
  await expect(page.getByLabel('事件类型', { exact: true })).toHaveCount(0)
  await page.getByLabel('搜索事件', { exact: true }).fill('筛选导出标记')
  await outcome.selectOption('success')
  await expect(page.locator('.activity-table tbody tr')).toHaveCount(20)
  await expect(page.locator('.table-footer')).toContainText('共 23 条记录')
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('.activity-table tbody tr')).toHaveCount(3)
  const exportButton = page.getByRole('button', { name: '导出筛选记录', exact: true })
  const successDownload = page.waitForEvent('download')
  await exportButton.click()
  const successFile = await (await successDownload).path()
  expect(successFile).not.toBeNull()
  const successful = JSON.parse(readFileSync(successFile!, 'utf8'))
  expect(successful).toHaveLength(23)
  expect(successful.map((entry: { id: string }) => entry.id)).toEqual(
    matching.filter((entry) => entry.status < 400).map((entry) => entry.id),
  )
  await outcome.selectOption('failure')
  await expect(page.locator('.activity-table tbody tr')).toHaveCount(3)
  await expect(page.getByRole('button', { name: '上一页', exact: true })).toBeDisabled()
  await expect(page.locator('.http-status')).toHaveText(['400', '499', '503'])
  const failureDownload = page.waitForEvent('download')
  await exportButton.click()
  const failureFile = await (await failureDownload).path()
  expect(failureFile).not.toBeNull()
  const failed = JSON.parse(readFileSync(failureFile!, 'utf8'))
  expect(failed.map((entry: { status: number }) => entry.status)).toEqual([400, 499, 503])
  await page.screenshot({ path: '../test-results/request-log-filters-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.app-shell')).toHaveCSS('grid-template-columns', '0px 390px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await expect(exportButton).toBeVisible()
  await page.screenshot({ path: '../test-results/request-log-filters-mobile.png' })
  await page.getByLabel('搜索事件', { exact: true }).fill('没有匹配的请求')
  await expect(exportButton).toBeDisabled()
})

test('request logs, audit logs and system events have separate navigation and never mix records', async ({
  page,
  request,
}) => {
  const accounts = await seed(request)
  const id = accounts[0].id
  await request.patch(`/api/accounts/${id}`, { data: { name: '审计分流目标' } })
  const credentials = await (
    await request.post(`/api/accounts/${id}/credentials`, { data: {} })
  ).json()
  await request.post('/ops/register', {
    headers: { 'x-reg-token': credentials.registrationToken },
    data: { uri: 'http://127.0.0.1:19221' },
  })
  const response = await request.post('/v1/chat/completions', {
    headers: { Authorization: 'Bearer browser-test-gateway-key' },
    data: {
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: '请求分流独立标记' }],
    },
  })
  expect(response.status()).toBe(200)
  await response.json()
  await login(page)
  await page.getByRole('link', { name: '请求日志', exact: true }).click()
  await expect(page.getByRole('heading', { name: '请求日志', exact: true })).toBeVisible()
  await searchLogs(page, '请求分流独立标记')
  await expect(page.locator('.event-type')).toHaveText(['API 请求'])
  await expect(page.getByLabel('事件类型').locator('option[value="audit"]')).toHaveCount(0)
  await page.getByRole('link', { name: '审计日志', exact: true }).click()
  await expect(page.getByRole('heading', { name: '审计日志', exact: true })).toBeVisible()
  await searchLogs(page, '审计分流目标', 'audit')
  await expect(page.getByTestId('initial-message-preview')).toHaveCount(0)
  await expect(page.getByLabel('事件类型').locator('option[value="request"]')).toHaveCount(0)
  const row = page
    .getByRole('row')
    .filter({ hasText: '审计分流目标' })
    .filter({ has: page.getByRole('cell', { name: '查看账号凭据成功', exact: true }) })
  await expect(row).toBeVisible()
  await expect(row).toContainText('操作人：管理员')
  await row.getByRole('button', { name: '查看事件详情' }).click()
  const dialog = page.getByRole('dialog', { name: '审计详情', exact: true })
  await expect(dialog).toContainText('account.credentials.read')
  await expect(dialog).toContainText('来源 IP')
  await expect(dialog).not.toContainText(credentials.proxyKey)
  await page.screenshot({ path: '../test-results/audit-details-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: '../test-results/audit-details-mobile.png' })
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await page.getByRole('button', { name: '展开导航' }).click()
  await page.getByRole('link', { name: '运行事件', exact: true }).click()
  await expect(page.getByRole('heading', { name: '运行事件', exact: true })).toBeVisible()
  await searchLogs(page, '审计分流目标', 'system')
  const registrationRow = page
    .getByRole('row')
    .filter({ hasText: '审计分流目标' })
    .filter({ has: page.getByRole('cell', { name: '域名注册', exact: true }) })
  await expect(registrationRow).toBeVisible()
  await expect(page.getByLabel('事件类型').locator('option[value="audit"]')).toHaveCount(0)
  await expect(page.getByLabel('事件类型').locator('option[value="request"]')).toHaveCount(0)
})

test('routing changes persist and access examples match each protocol', async ({
  page,
  request,
}) => {
  await seed(request)
  await login(page)
  await page.getByRole('link', { name: '路由策略', exact: true }).click()
  await expect(page.getByRole('checkbox', { name: /会话粘性/ })).toBeChecked()
  await page.getByRole('checkbox', { name: /会话粘性/ }).uncheck()
  await page.getByRole('radio', { name: /最少连接/ }).click()
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect(page.getByText('路由配置已保存并即时生效')).toBeVisible()
  await page.reload()
  await expect(page.getByRole('checkbox', { name: /会话粘性/ })).not.toBeChecked()
  await expect(page.getByRole('radio', { name: /最少连接/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await page.screenshot({ path: '../test-results/routing-desktop.png', fullPage: true })
  await page.getByRole('checkbox', { name: /会话粘性/ }).check()
  await page.getByRole('button', { name: '保存配置' }).click()
  await expect
    .poll(async () => (await (await request.get('/api/overview')).json()).settings.sessionAffinity)
    .toBe(true)
  await page.getByRole('link', { name: '接入配置', exact: true }).click()
  await expect(page.locator('pre')).toContainText('/v1/chat/completions')
  await expect(page.getByText('工作区启动后向面板注册地址。', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: 'Responses', exact: true }).click()
  await expect(page.locator('pre')).toContainText('curl http://127.0.0.1:19220/v1/responses')
  await expect(page.locator('pre')).toContainText('"input": "你好"')
  await expect(page.locator('pre')).toContainText('"store": false')
  await expect(page.locator('pre')).toContainText('"stream": true')
  await expect(page.locator('pre')).toContainText('Authorization: Bearer YOUR_GATEWAY_KEY')
  await expect(page.locator('pre')).not.toContainText('\n+')
  await page.getByRole('tab', { name: 'New API', exact: true }).click()
  await expect(page.locator('pre')).toContainText('渠道类型    OpenAI')
  await expect(page.locator('pre')).toContainText('http://127.0.0.1:19220')
  await page.getByRole('tab', { name: 'Claude Code' }).click()
  await expect(page.locator('pre')).toContainText('ANTHROPIC_BASE_URL')
  await page.getByRole('button', { name: '显示网关密钥' }).click()
  await expect(page.locator('.copy-field')).toContainText([
    'http://127.0.0.1:19220/v1',
    'http://127.0.0.1:19220',
    'browser-test-gateway-key',
  ])
  await page.getByRole('button', { name: '隐藏网关密钥' }).click()
  await expect(page.getByText('browser-test-gateway-key', { exact: true })).not.toBeVisible()
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  await expect(page.getByRole('heading', { name: '号池健康度' })).toBeVisible()
  await page.getByRole('link', { name: '请求日志', exact: true }).click()
  await page.getByRole('link', { name: '审计日志', exact: true }).click()
  await expect(page.getByRole('cell', { name: '管理操作', exact: true }).first()).toBeVisible()
})

test('phone layout keeps content within the viewport and account forms support keyboard dismissal', async ({
  page,
  request,
}) => {
  await seed(request)
  await page.setViewportSize({ width: 390, height: 844 })
  await login(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: '../test-results/accounts-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '接入账号', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const tokenInput = dialog.getByLabel('注册密钥 REG_TOKEN')
  const generateButton = dialog.getByRole('button', { name: '随机生成', exact: true })
  await generateButton.click()
  await expect(tokenInput).toHaveValue(/^[a-f0-9]{48}$/)
  await expect(tokenInput).toHaveAttribute('type', 'text')
  for (const control of [
    tokenInput,
    dialog.getByRole('button', { name: '隐藏注册密钥', exact: true }),
    dialog.getByRole('button', { name: '复制注册密钥', exact: true }),
    generateButton,
  ]) {
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: '../test-results/account-form-mobile.png', fullPage: true })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).not.toBeVisible()
  await expect(page.getByRole('button', { name: '接入账号', exact: true })).toBeFocused()
  await page.getByRole('button', { name: '展开导航' }).click()
  await page.getByRole('link', { name: '接入配置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '接入配置', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('visible console automatically polls new Token usage without reloading or manual refresh', async ({
  page,
  request,
}) => {
  await seed(request)
  await page.clock.install()
  await login(page)
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  const tokenPanel = page.getByRole('region', { name: 'Token 用量', exact: true })
  const before = await (await request.get('/api/overview')).json()
  const display = (value: number) => value.toLocaleString('zh-CN')
  await expect(tokenPanel.getByTestId('token-total').locator('strong')).toHaveText(
    display(before.stats.tokenUsage.today.total),
  )
  const response = await request.post('/v1/chat/completions', {
    headers: { Authorization: 'Bearer browser-test-gateway-key' },
    data: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'Poll usage' }] },
  })
  expect(response.status()).toBe(200)
  await response.json()
  await expect
    .poll(
      async () => (await (await request.get('/api/overview')).json()).stats.tokenUsage.today.total,
    )
    .toBe(before.stats.tokenUsage.today.total + 1500)
  await page.clock.fastForward(15001)
  for (const [field, increment] of [
    ['input', 1200],
    ['output', 300],
    ['cacheRead', 400],
    ['total', 1500],
  ] as const)
    await expect(tokenPanel.getByTestId(`token-${field}`).locator('strong')).toHaveText(
      display(before.stats.tokenUsage.today[field] + increment),
    )
})

test('resuming a hidden console refreshes immediately and expired sessions stop polling', async ({
  page,
  request,
}) => {
  const accounts = await seed(request)
  await page.clock.install()
  await login(page)
  let overviewRequests = 0
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname === '/api/overview') overviewRequests++
  })
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(
    (
      await request.patch(`/api/accounts/${accounts[0].id}`, {
        data: { name: '后台改名后立即出现' },
      })
    ).status(),
  ).toBe(200)
  await page.clock.fastForward(15001)
  await expect(
    page.getByRole('button', { name: 'AzureKiln · 主力 主力账号', exact: true }),
  ).toBeVisible()
  expect(overviewRequests).toBe(0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(
    page.getByRole('button', { name: '后台改名后立即出现 主力账号', exact: true }),
  ).toBeVisible()
  expect(overviewRequests).toBeGreaterThan(0)

  expect((await page.request.delete('/api/session')).status()).toBe(200)
  await page.clock.fastForward(15001)
  await expect(page.getByRole('button', { name: '进入控制台', exact: true })).toBeVisible()
  const afterExpiry = overviewRequests
  await page.clock.fastForward(45001)
  expect(overviewRequests).toBe(afterExpiry)
})

test('Credits are fetched periodically by the backend and update in the open console automatically', async ({
  page,
  request,
}) => {
  const accounts = await seed(request)
  expect(
    (
      await request.post('http://127.0.0.1:19221/test/quota', {
        data: { total: 2000, used: 100, freeze: 25 },
      })
    ).status(),
  ).toBe(200)
  expect(
    (
      await request.patch(`/api/accounts/${accounts[0].id}`, {
        data: { pat: 'test-refresh-personal-token' },
      })
    ).status(),
  ).toBe(200)
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/accounts/${accounts[0].id}`)).json()).account.quota?.credits
          .used,
    )
    .toBe(100)
  await page.clock.install()
  await login(page)
  const accountRow = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'AzureKiln · 主力 主力账号', exact: true }) })
  const creditsCard = page.locator('.stat-card').filter({ hasText: '组织剩余额度' })
  await expect(accountRow.locator('.quota-numbers > strong')).toHaveText('1,875')
  await expect(accountRow.locator('.quota-percentage')).toHaveText('93.8%')
  await expect(creditsCard.locator('.stat-value')).toContainText('1,875')
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  const overviewCredits = page.getByTestId('overview-credits-remaining').locator('strong')
  await expect(overviewCredits).toHaveText('1,875')
  await expect(page.getByTestId('summary-credits-remaining')).toHaveText('1,875')
  await expect(page.getByTestId('summary-credits-percent')).toHaveText('93.8%')
  const initial = await (await request.get(`/api/accounts/${accounts[0].id}`)).json()
  await request.post('http://127.0.0.1:19221/test/quota', { data: { used: 450 } })
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/accounts/${accounts[0].id}`)).json()).account.quota?.credits
          .used,
    )
    .toBe(450)
  const updated = await (await request.get(`/api/accounts/${accounts[0].id}`)).json()
  expect(updated.account.quota.syncedAt).not.toBe(initial.account.quota.syncedAt)
  await page.clock.fastForward(15001)
  await expect(overviewCredits).toHaveText('1,525')
  await expect(page.getByTestId('summary-credits-remaining')).toHaveText('1,525')
  await expect(page.getByTestId('summary-credits-percent')).toHaveText('76.3%')
  await page.getByRole('button', { name: '管理账号池', exact: true }).click()
  await expect(accountRow.locator('.quota-numbers > strong')).toHaveText('1,525')
  await expect(accountRow.locator('.quota-percentage')).toHaveText('76.3%')
  await expect(creditsCard.locator('.stat-value')).toContainText('1,525')
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.app-shell')).toHaveCSS('grid-template-columns', '0px 390px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await expect(page.getByTestId('accounts-credits-percent')).toBeVisible()
  await page.screenshot({ path: '../test-results/quota-percentage-mobile.png', fullPage: true })
})

test('quota protection pauses below ten percent and automatically resumes at the threshold and reset', async ({
  page,
  request,
}) => {
  const accounts = await seed(request)
  const primary = accounts[0]
  const backup = accounts[2]
  await request.post('http://127.0.0.1:19221/test/quota', {
    data: { total: 1000, used: 901, freeze: 0 },
  })
  await request.patch(`/api/accounts/${backup.id}`, {
    data: { repo: 'azurekiln-0/backup', enabled: true },
  })
  await request.patch(`/api/accounts/${primary.id}`, {
    data: { pat: 'test-protection-personal-token' },
  })
  const account = async (id: string) =>
    (await (await request.get(`/api/accounts/${id}`)).json()).account
  await expect.poll(async () => (await account(primary.id)).quota?.credits.used).toBe(901)
  await request.patch('/api/settings', {
    data: { quotaProtection: { enabled: true, thresholdPercent: 10 } },
  })
  await page.clock.install()
  await login(page)
  const health = page.getByTestId(`health-${primary.id}`)
  const disabledHealth = page.getByTestId(`health-${backup.id}`)
  const quota = page.getByTestId(`quota-${primary.id}`)
  await expect(health).toContainText('额度暂停')
  await expect(health).toContainText('剩余额度低于 10%')
  await expect(quota.locator('.quota-percentage')).toHaveText('9.9%')
  expect((await account(primary.id)).enabled).toBe(true)
  expect((await account(primary.id)).status).toBe('healthy')
  await page.getByRole('button', { name: '管理备用工作区', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '停用账号' }).click()
  await expect(disabledHealth).toContainText('已停用')
  const chat = () =>
    request.post('/v1/chat/completions', {
      headers: { Authorization: 'Bearer browser-test-gateway-key' },
      data: {
        model: 'deepseek-v4.1-flash',
        messages: [{ role: 'user', content: 'quota recovery' }],
      },
    })
  expect((await chat()).status()).toBe(503)
  await page.screenshot({
    path: '../test-results/quota-protection-paused-desktop.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.locator('.app-shell')).toHaveCSS('grid-template-columns', '0px 390px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({
    path: '../test-results/quota-protection-paused-mobile.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 1440, height: 1000 })

  await request.post('http://127.0.0.1:19221/test/quota', { data: { used: 900 } })
  await expect.poll(async () => (await account(primary.id)).quotaProtection.suspended).toBe(false)
  await page.clock.fastForward(15001)
  await expect(health.locator('.status-badge')).toHaveText('可用')
  await expect(quota.locator('.quota-percentage')).toHaveText('10%')
  expect((await chat()).status()).toBe(200)
  await expect(disabledHealth).toContainText('已停用')
  expect((await account(backup.id)).quotaProtection.suspended).toBe(false)
  expect((await account(backup.id)).enabled).toBe(false)

  await request.post('http://127.0.0.1:19221/test/quota', { data: { used: 1000 } })
  await expect.poll(async () => (await account(primary.id)).quotaProtection.suspended).toBe(true)
  await page.clock.fastForward(15001)
  await expect(health).toContainText('额度暂停')
  await expect(quota.locator('.quota-percentage')).toHaveText('0%')
  expect((await chat()).status()).toBe(503)
  await request.post('http://127.0.0.1:19221/test/quota', { data: { reset: true } })
  await expect.poll(async () => (await account(primary.id)).quota?.credits.used).toBe(0)
  await expect.poll(async () => (await account(primary.id)).quotaProtection.suspended).toBe(false)
  await page.clock.fastForward(15001)
  await expect(health.locator('.status-badge')).toHaveText('可用')
  await expect(quota.locator('.quota-percentage')).toHaveText('100%')
  await expect(disabledHealth).toContainText('已停用')
  expect((await account(backup.id)).enabled).toBe(false)
  expect((await chat()).status()).toBe(200)
})

test('quota protection settings validate and persist the switch and threshold', async ({
  page,
  request,
}) => {
  await seed(request)
  await login(page)
  await page.getByRole('link', { name: '路由策略', exact: true }).click()
  const settings = page.getByTestId('quota-protection-settings')
  const enabled = settings.getByRole('checkbox', { name: /自动保护低额度账号/ })
  const threshold = settings.getByRole('spinbutton', { name: '剩余额度阈值', exact: true })
  const save = page.getByRole('button', { name: '保存配置', exact: true })
  await expect(enabled).not.toBeChecked()
  await expect(threshold).toHaveValue('10')
  await enabled.check()
  await threshold.fill('25')
  await save.click()
  await expect
    .poll(async () => (await (await request.get('/api/settings')).json()).settings.quotaProtection)
    .toEqual({ enabled: true, thresholdPercent: 25 })
  await expect(save).toBeDisabled()
  await page.reload()
  await expect(enabled).toBeChecked()
  await expect(threshold).toHaveValue('25')
  await threshold.fill('0')
  await save.click()
  await expect(page.getByRole('alert')).toContainText('额度保护阈值须为 1 至 100 的整数')
  expect(
    (await (await request.get('/api/settings')).json()).settings.quotaProtection.thresholdPercent,
  ).toBe(25)
  await threshold.fill('10')
  await enabled.uncheck()
  await save.click()
  await expect
    .poll(async () => (await (await request.get('/api/settings')).json()).settings.quotaProtection)
    .toEqual({ enabled: false, thresholdPercent: 10 })
  await page.reload()
  await expect(enabled).not.toBeChecked()
  await expect(threshold).toHaveValue('10')
})

test('a stalled refresh times out and the next automatic poll recovers without reloading', async ({
  page,
  request,
}) => {
  const accounts = await seed(request)
  await page.clock.install()
  await login(page)
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window)
    let hangNextOverview = true
    window.fetch = (input, options) => {
      const url = input instanceof Request ? input.url : String(input)
      if (hangNextOverview && new URL(url, location.href).pathname === '/api/overview') {
        hangNextOverview = false
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(new DOMException('Request aborted', 'AbortError'))
          if (options?.signal?.aborted) abort()
          else options?.signal?.addEventListener('abort', abort, { once: true })
        })
      }
      return originalFetch(input, options)
    }
  })
  await request.patch(`/api/accounts/${accounts[0].id}`, {
    data: { name: '网络恢复后自动同步' },
  })
  await page.clock.fastForward(15001)
  await page.clock.fastForward(12001)
  await expect(page.locator('.error-banner')).toContainText('超时')
  await expect(
    page.getByRole('button', { name: 'AzureKiln · 主力 主力账号', exact: true }),
  ).toBeVisible()
  await page.clock.fastForward(15001)
  await expect(
    page.getByRole('button', { name: '网络恢复后自动同步 主力账号', exact: true }),
  ).toBeVisible()
  await expect(page.locator('.error-banner')).not.toBeVisible()
})

test('wake errors identify Cloudflare HTML failures safely and preserve backend JSON messages and the session', async ({
  page,
  request,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const accounts = await seed(request)
  const account = accounts[0]
  await request.patch(`/api/accounts/${account.id}`, {
    data: { pat: 'test-wake-diagnostics-personal-token' },
  })
  await login(page)
  const wakePath = `/api/accounts/${account.id}/wake`
  let mode: 'header' | 'html' | 'problem' | 'json' = 'header'
  let jsonStatus: 502 | 424 = 502
  const permissionHint = 'CNB 唤醒失败：个人令牌缺少 repo-cnb-trigger:rw 权限，请更换个人令牌后重试'
  const headerRay = 'a4f753ed9fae0463-HKG'
  const htmlRay = 'f00dbabe01234567'
  const html = `<!doctype html>
    <html><head><title>cnb2api.azurekiln.cn | 502: Bad gateway</title></head>
    <body><main id="raw-cloudflare-error"><h1>Bad gateway</h1>
      <div id="cf-error-details">Browser Working · Cloudflare Working · Host Error</div>
      <span class="cf-footer-item">Cloudflare Ray ID: <strong class="font-semibold">${htmlRay}</strong></span>
      <p>PANEL_SECRET=should-never-be-shown</p>
      <script>window.__cloudflareErrorExecuted = true</script>
      <img src="data:image/png,invalid" onerror="window.__cloudflareErrorExecuted = true">
    </main></body></html>`
  await page.route(`**${wakePath}`, async (route) => {
    expect(route.request().method()).toBe('POST')
    if (mode === 'problem') {
      await route.fulfill({
        status: 502,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          cloudflare_error: true,
          title: 'Bad gateway',
          detail: 'Cloudflare 无法连接源站',
          ray_id: headerRay,
          timestamp: '2026-10-24T06:32:10Z',
          error_category: 'origin',
        }),
      })
      return
    }
    if (mode === 'json') {
      await route.fulfill({
        status: jsonStatus,
        contentType: 'application/json',
        headers: { 'cf-ray': headerRay, server: 'cloudflare' },
        body: JSON.stringify({ error: { message: permissionHint } }),
      })
      return
    }
    await route.fulfill({
      status: 502,
      contentType: 'text/html; charset=utf-8',
      headers: {
        ...(mode === 'header' ? { 'cf-ray': headerRay, server: 'cloudflare' } : {}),
        date: 'Sat, 24 Oct 2026 06:32:10 GMT',
        'x-request-id': 'diagnostic-test-request-id',
      },
      body: html,
    })
  })
  const wake = async () => {
    await page.getByRole('button', { name: '唤醒AzureKiln · 主力', exact: true }).click()
  }
  await wake()
  const headerError = page.locator('.toast.error').last()
  await expect(headerError).toContainText('502')
  await expect(headerError).toContainText('POST')
  await expect(headerError).toContainText(wakePath)
  await expect(headerError).toContainText('Cloudflare')
  await expect(headerError).toContainText('源站')
  await expect(headerError).toContainText(headerRay)
  await expect(headerError).not.toContainText(htmlRay)
  await expect(headerError).not.toContainText('PANEL_SECRET')
  await expect(headerError).not.toContainText('<script>')
  await expect(page.locator('#raw-cloudflare-error')).toHaveCount(0)
  expect(await page.evaluate(() => '__cloudflareErrorExecuted' in window)).toBe(false)
  expect((await page.request.get('/api/session')).status()).toBe(200)
  await expect(page.getByRole('button', { name: '用户菜单', exact: true })).toBeVisible()
  await headerError.getByRole('button', { name: '诊断详情', exact: true }).click()
  const diagnosticsDialog = page.getByRole('dialog', { name: '接口诊断详情', exact: true })
  const details = diagnosticsDialog.getByTestId('api-diagnostics')
  await expect(details).toContainText(`请求: POST ${wakePath}`)
  await expect(details).toContainText('HTTP 状态: 502')
  await expect(details).toContainText('响应类型: text/html; charset=utf-8')
  await expect(details).toContainText('响应来源: cloudflare')
  await expect(details).toContainText(`Cloudflare Ray ID: ${headerRay}`)
  await expect(details).toContainText('请求 ID: diagnostic-test-request-id')
  await expect(details).toContainText('响应时间: Sat, 24 Oct 2026 06:32:10 GMT')
  await expect(details).toContainText(/收到时间: \d{4}-\d{2}-\d{2}T/)
  await expect(details).not.toContainText('PANEL_SECRET')
  await expect(details).not.toContainText('<html>')
  await page.screenshot({ path: '../test-results/api-diagnostics-cloudflare.png' })
  const safeDiagnostics = await details.innerText()
  await diagnosticsDialog.getByRole('button', { name: '复制诊断', exact: true }).click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'),
    )
    .toBe(safeDiagnostics.replace(/\r\n/g, '\n'))
  await diagnosticsDialog.getByRole('button', { name: '关闭', exact: true }).click()

  mode = 'html'
  await wake()
  await expect(page.locator('.toast.error').last()).toContainText(htmlRay)
  await expect(page.locator('#raw-cloudflare-error')).toHaveCount(0)
  expect(await page.evaluate(() => '__cloudflareErrorExecuted' in window)).toBe(false)

  mode = 'problem'
  await wake()
  const problemError = page.locator('.toast.error').last()
  await expect(problemError).toContainText('Cloudflare 无法连接源站')
  await expect(problemError).toContainText(headerRay)
  await problemError.getByRole('button', { name: '诊断详情', exact: true }).click()
  await expect(page.getByTestId('api-diagnostics')).toContainText(
    '响应类型: application/problem+json',
  )
  await expect(page.getByTestId('api-diagnostics')).toContainText('响应来源: cloudflare')
  await expect(page.getByTestId('api-diagnostics')).toContainText('Cloudflare 错误来源: origin')
  await expect(page.getByTestId('api-diagnostics')).toContainText('响应时间: 2026-10-24T06:32:10Z')
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()

  mode = 'json'
  await wake()
  await expect(page.locator('.toast.error').last()).toContainText(permissionHint)
  const jsonError = page.locator('.toast.error').last()
  await expect(jsonError).toContainText('HTTP 502')
  await expect(jsonError).not.toContainText('Cloudflare 返回错误页')
  await expect(jsonError).not.toContainText('Cloudflare 错误响应')
  await jsonError.getByRole('button', { name: '诊断详情', exact: true }).click()
  await expect(page.getByTestId('api-diagnostics')).toContainText('响应来源: json-api')
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()

  jsonStatus = 424
  await wake()
  const dependencyError = page.locator('.toast.error').last()
  await expect(dependencyError).toContainText('HTTP 424')
  await expect(dependencyError).toContainText(permissionHint)
  await expect(dependencyError).not.toContainText('Cloudflare 错误响应')
  await dependencyError.getByRole('button', { name: '诊断详情', exact: true }).click()
  await expect(details).toContainText(`错误说明: ${permissionHint}`)
  await expect(details).toContainText('HTTP 状态: 424')
  await expect(details).toContainText('响应来源: json-api')
  const dependencyDiagnostics = await details.innerText()
  await diagnosticsDialog.getByRole('button', { name: '复制诊断', exact: true }).click()
  await expect
    .poll(async () =>
      (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'),
    )
    .toBe(dependencyDiagnostics.replace(/\r\n/g, '\n'))
  expect(dependencyDiagnostics).toContain('repo-cnb-trigger:rw')
  await diagnosticsDialog.getByRole('button', { name: '关闭', exact: true }).click()
  expect((await page.request.get('/api/session')).status()).toBe(200)
  await expect(page.getByRole('heading', { name: /^账号池/ })).toBeVisible()
})
