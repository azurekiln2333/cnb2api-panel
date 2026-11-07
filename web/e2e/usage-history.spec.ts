import { test, expect, type Page, type Route } from '@playwright/test'

const ADMIN = 'browser-test-admin-key'

async function login(page: Page) {
  await page.goto('/')
  await page.getByLabel('管理密钥', { exact: true }).fill(ADMIN)
  await page.getByRole('button', { name: '进入控制台' }).click()
  await expect(page.getByRole('heading', { name: '账号池' })).toBeVisible()
}

const usage = (input: number, output: number, extra: Record<string, number> = {}) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  total: input + output,
  reportedRequests: input || output ? 1 : 0,
  missingRequests: 0,
  partialRequests: 0,
  cacheReadReported: 0,
  cacheWriteReported: 0,
  ...extra,
})

// Synthetic history ending on 2026-03-30, oldest first like the API.
function history(days: number, filled: boolean) {
  const end = Date.parse('2026-03-30T00:00:00.000Z')
  const rows = Array.from({ length: days }, (_, index) => {
    const date = new Date(end - (days - index - 1) * 86_400_000).toISOString().slice(0, 10)
    const newest = index === days - 1
    const partial = filled && index === days - 3
    if (!filled || (!newest && !partial))
      return { date, requests: 0, errors: 0, tokenUsage: usage(0, 0), partial: false }
    return newest
      ? {
          date,
          requests: 12,
          errors: 2,
          tokenUsage: usage(1_234_567, 45_000, {
            cacheRead: 600_000,
            cacheReadReported: 1,
            cacheWriteReported: 1,
          }),
          partial: false,
        }
      : { date, requests: 3, errors: 0, tokenUsage: usage(4_000, 500), partial: true }
  })
  const accounts = filled
    ? [
        {
          accountId: 'history-a',
          name: '主力账号',
          requests: 12,
          tokenUsage: usage(1_234_567, 45_000),
          partial: false,
        },
        {
          accountId: 'history-gone',
          name: '',
          requests: 3,
          tokenUsage: usage(0, 0),
          partial: true,
        },
      ]
    : []
  return {
    range: { days, from: rows[0].date, to: rows.at(-1)!.date },
    days: rows,
    accounts,
    totals: {
      requests: filled ? 15 : 0,
      errors: filled ? 2 : 0,
      tokenUsage: filled
        ? usage(1_238_567, 45_500, {
            cacheRead: 600_000,
            cacheReadReported: 1,
            cacheWriteReported: 1,
            reportedRequests: 2,
          })
        : usage(0, 0),
      partial: filled,
    },
  }
}

async function mockHistory(page: Page, filled: () => boolean, requested: number[]) {
  await page.route(
    (url) => url.pathname === '/api/usage/history',
    (route: Route) => {
      const days = Number(new URL(route.request().url()).searchParams.get('days'))
      requested.push(days)
      return route.fulfill({ json: history(days, filled()) })
    },
  )
}

async function openOverview(page: Page) {
  await login(page)
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  const card = page.getByTestId('overview-history')
  await expect(card.getByRole('heading', { name: '历史用量' })).toBeVisible()
  return card
}

async function hoverBar(page: Page, index: number, count: number, tap = false) {
  const hit = page.getByTestId('history-hit')
  const box = await hit.boundingBox()
  expect(box).not.toBeNull()
  const position = { x: (box!.width * (index + 0.5)) / count, y: box!.height - 4 }
  if (tap) await hit.tap({ position })
  else await hit.hover({ position })
}

test('history card shows an empty state and switches ranges', async ({ page }) => {
  let filled = false
  const requested: number[] = []
  await mockHistory(page, () => filled, requested)
  const card = await openOverview(page)
  await expect(card.getByTestId('history-empty')).toContainText('最近 30 天没有用量记录')
  await expect(card.getByTestId('history-range-30')).toHaveAttribute('aria-pressed', 'true')
  expect(requested).toEqual([30])

  filled = true
  await card.getByTestId('history-range-7').click()
  await expect(card.getByTestId('history-range-7')).toHaveAttribute('aria-pressed', 'true')
  await expect(card.getByTestId('history-empty')).toHaveCount(0)
  await expect(card.locator('[data-testid^="history-day-"]')).toHaveCount(7)
  // The table lists the newest day first.
  await expect(card.locator('[data-testid^="history-day-"]').first()).toHaveAttribute(
    'data-testid',
    'history-day-2026-03-30',
  )
  for (const range of [90, 365]) {
    await card.getByTestId(`history-range-${range}`).click()
    await expect(card.locator('[data-testid^="history-day-"]')).toHaveCount(range)
  }
  expect(requested).toEqual([30, 7, 90, 365])
})

test('history chart explains each day and lists account totals', async ({ page }) => {
  const requested: number[] = []
  await mockHistory(page, () => true, requested)
  const card = await openOverview(page)
  await expect(card.getByTestId('history-chart')).toBeVisible()
  await expect(card.getByTestId('history-total-input').locator('strong')).toHaveText('1.24M')
  await expect(card.getByTestId('history-total-requests')).toContainText('2 次失败')
  await expect(card.getByTestId('history-total-partial').locator('strong')).toHaveText('1 天')
  // Cache reads were reported, so the secondary series and its legend appear.
  await expect(card.locator('.history-cache-line')).toHaveCount(1)
  await expect(card.locator('.history-legend')).toContainText('缓存读取')

  await hoverBar(page, 29, 30)
  const tooltip = card.getByTestId('history-tooltip')
  await expect(tooltip).toBeVisible()
  await expect(tooltip).toContainText('2026-03-30')
  await expect(tooltip.locator('dd').nth(0)).toHaveText('1.23M')
  await expect(tooltip.locator('dd').nth(0)).toHaveAttribute('title', '1,234,567')
  await expect(tooltip.locator('dd').nth(1)).toHaveText('45K')
  await expect(tooltip.locator('dd').nth(2)).toHaveText('600K')
  await expect(tooltip.locator('dd').nth(3)).toHaveText('0')
  await expect(tooltip.locator('dd').nth(4)).toHaveText('12')
  await expect(tooltip.locator('dd').nth(5)).toHaveText('2')

  // A backfilled day carries the partial marker, and a cache counter that
  // nobody reported stays unknown instead of zero.
  await hoverBar(page, 27, 30)
  await expect(tooltip).toContainText('2026-03-28')
  await expect(tooltip.locator('.history-partial')).toHaveText('部分')
  await expect(tooltip.locator('dd').nth(2)).toHaveText('—')
  await page.mouse.move(0, 0)
  await expect(tooltip).toHaveCount(0)

  // Arrow keys walk the same days for keyboard users.
  await card.getByTestId('history-hit').focus()
  await page.keyboard.press('ArrowLeft')
  await expect(tooltip).toContainText('2026-03-30')
  await page.keyboard.press('ArrowLeft')
  await expect(tooltip).toContainText('2026-03-29')

  const partialRow = card.getByTestId('history-day-2026-03-28')
  await expect(partialRow.locator('.history-partial')).toHaveText('部分')
  await expect(partialRow.locator('td').first()).toHaveText('4K')
  const accounts = card.getByTestId('history-accounts')
  await expect(accounts.getByTestId('history-account-history-a')).toContainText('主力账号')
  await expect(accounts.getByTestId('history-account-history-a').locator('strong')).toHaveText(
    '1.28M',
  )
  await expect(accounts.getByTestId('history-account-history-gone')).toContainText('已删除账号')
  await expect(
    accounts.getByTestId('history-account-history-gone').locator('.history-partial'),
  ).toHaveText('部分')
})

test('history card fits a phone and opens the tooltip on tap', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  const page = await context.newPage()
  await mockHistory(page, () => true, [])
  await login(page)
  await page.getByRole('button', { name: '展开导航' }).click()
  await page.getByRole('link', { name: '运行概览', exact: true }).click()
  const card = page.getByTestId('overview-history')
  await card.scrollIntoViewIfNeeded()
  await expect(card.getByTestId('history-chart')).toBeVisible()
  for (const range of [7, 30, 90, 365]) {
    const box = await card.getByTestId(`history-range-${range}`).boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  }
  await hoverBar(page, 29, 30, true)
  const tooltip = card.getByTestId('history-tooltip')
  await expect(tooltip).toContainText('2026-03-30')
  const tip = await tooltip.boundingBox()
  expect(tip!.x).toBeGreaterThanOrEqual(0)
  expect(tip!.x + tip!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  await page.screenshot({ path: '../test-results/history-mobile.png', fullPage: true })
  await context.close()
})

test('history card records real gateway traffic for today', async ({ page, request }) => {
  await request.post('/api/session', { data: { key: ADMIN } })
  await request.patch('/api/settings', {
    data: {
      quotaProtection: { enabled: false, thresholdPercent: 10 },
      inferenceProbe: { enabled: false, intervalMinutes: 30 },
    },
  })
  const { account } = await (
    await request.post('/api/accounts', {
      data: {
        name: '历史流量账号',
        repo: 'azurekiln-history/cnb2api',
        proxyKey: 'test-worker-key',
        endpoint: 'http://127.0.0.1:19221',
      },
    })
  ).json()
  await request.post(`/api/accounts/${account.id}/probe`, { data: {} })
  const before = await (await request.get('/api/usage/history?days=7')).json()
  const response = await request.post('/v1/chat/completions', {
    headers: { Authorization: 'Bearer browser-test-gateway-key' },
    data: { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'History usage' }] },
  })
  expect(response.status()).toBe(200)
  const after = await (await request.get('/api/usage/history?days=7')).json()
  const today = after.days.at(-1)
  expect(after.days).toHaveLength(7)
  expect(today.requests).toBeGreaterThan(before.days.at(-1).requests)
  expect(today.tokenUsage.input - before.days.at(-1).tokenUsage.input).toBe(1200)

  const card = await openOverview(page)
  const row = card.getByTestId(`history-day-${today.date}`)
  await expect(row).toBeVisible()
  await expect(row.locator('td').nth(4)).toHaveText(
    today.requests >= 1000 ? /K$/ : String(today.requests),
  )
  await expect(card.locator('[data-testid^="history-account-"]').first()).toBeVisible()
  await request.delete(`/api/accounts/${account.id}`)
})
