import { test, expect, type Page } from '@playwright/test'

const ADMIN = 'browser-test-admin-key'

async function prepareSession(page: Page) {
  await page.request.post('/api/session', { data: { key: ADMIN } })
  await page.request.post('/api/accounts', {
    data: { name: '启动测试工作区', repo: 'startup/test', proxyKey: 'test-worker-key' },
  })
}

async function signIn(page: Page) {
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台', exact: true }).click()
}

for (const existingSession of [false, true]) {
  test(`${existingSession ? 'existing session' : 'new login'} opens the console while auth configuration and overview are pending`, async ({
    page,
  }) => {
    await prepareSession(page)
    if (!existingSession) await page.request.delete('/api/session')
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let logsRequested = 0
    await page.route('**/api/auth/config', async (route) => {
      await pending
      await route.continue()
    })
    await page.route('**/api/overview', async (route) => {
      await pending
      await route.continue()
    })
    await page.route('**/api/logs?**', async (route) => {
      logsRequested++
      await pending
      await route.continue()
    })
    try {
      await page.goto('/')
      if (!existingSession) await signIn(page)
      await expect(page.locator('.app-shell')).toBeVisible()
      await expect(page.getByText('正在连接控制台', { exact: true })).toHaveCount(0)
      await expect(page.getByText('正在读取账号池…', { exact: true })).toBeVisible()
      expect(logsRequested).toBe(0)
      await page.getByRole('link', { name: '请求日志', exact: true }).click()
      await expect(page.getByRole('heading', { name: '请求日志', exact: true })).toBeVisible()
      await expect.poll(() => logsRequested).toBe(1)
      await page.getByRole('link', { name: /^账号管理/ }).click()
      await expect(page.getByText('正在读取账号池…', { exact: true })).toBeVisible()
    } finally {
      release()
    }
    await expect(page.getByRole('heading', { name: /^账号池/ })).toBeVisible()
  })
}

test('a stalled HTTP 200 log body times out without blocking console navigation', async ({
  page,
}) => {
  await prepareSession(page)
  await page.clock.install()
  await page.addInitScript(() => {
    const fetchOriginal = window.fetch.bind(window)
    window.fetch = (input, init) => {
      if (String(input).startsWith('/api/logs?')) {
        return Promise.resolve(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"logs":['))
                init?.signal?.addEventListener('abort', () => {
                  controller.error(new DOMException('Aborted', 'AbortError'))
                })
              },
            }),
            {
              status: 200,
              headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'CF-Ray': 'a52131c868bda0b0-HKG',
              },
            },
          ),
        )
      }
      return fetchOriginal(input, init)
    }
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /^账号池/ })).toBeVisible()
  await page.getByRole('link', { name: '请求日志', exact: true }).click()
  await expect(page.getByRole('heading', { name: '正在读取日志', exact: true })).toBeVisible()
  await page.getByRole('link', { name: /^账号管理/ }).click()
  await expect(page.getByRole('heading', { name: /^账号池/ })).toBeVisible()
  await page.clock.fastForward(12001)
  await page.locator('.toast').getByRole('button', { name: '诊断详情', exact: true }).click()
  const diagnostics = page.getByTestId('api-diagnostics')
  await expect(diagnostics).toContainText('HTTP 状态: 200')
  await expect(diagnostics).toContainText('请求超时')
  await expect(diagnostics).toContainText('Cloudflare Ray ID: a52131c868bda0b0-HKG')
})

test('a previous session log request cannot expire a newly established session', async ({
  page,
}) => {
  await prepareSession(page)
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  let logsRequested = 0
  await page.route('**/api/logs?**', async (route) => {
    if (++logsRequested === 1) {
      await pending
      return route.fulfill({ status: 401, json: { error: { message: 'old session' } } })
    }
    await route.continue()
  })
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /^账号池/ })).toBeVisible()
  try {
    await page.getByRole('link', { name: '请求日志', exact: true }).click()
    await expect.poll(() => logsRequested).toBe(1)
    await page.getByRole('button', { name: '用户菜单', exact: true }).click()
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await signIn(page)
    await expect(page.getByRole('heading', { name: '请求日志', exact: true })).toBeVisible()
    await expect.poll(() => logsRequested).toBe(2)
    const oldResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/logs' && response.status() === 401,
    )
    release()
    await (await oldResponse).finished()
    await page.getByRole('link', { name: /^账号管理/ }).click()
    await expect(page.getByRole('heading', { name: /^账号池/ })).toBeVisible()
    await expect(page.getByLabel('管理密钥', { exact: true })).toHaveCount(0)
  } finally {
    release()
  }
})
