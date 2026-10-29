// Isolated browser-test backend. Never loads production credentials or writes production data.
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPanelServer } from '../../../src/app.mjs'
import { startOidcFixture } from './oidc.mjs'

const fixtureRoot = mkdtempSync(join(tmpdir(), 'cnb-panel-browser-'))
const dataDir = join(fixtureRoot, 'data')
const oidc = await startOidcFixture()
const workerBootedAt = new Date().toISOString()
const quotaState = { total: 2000, used: 100, freeze: 25, requests: 0 }
const workerTotals = {
  prompt: 0,
  completion: 0,
  requests: 0,
  errors: 0,
  credit: 0,
  cache_hit: 0,
  cache_miss: 0,
}
const worker = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  // Test controls live only in this isolated mock worker, never in the panel.
  if (req.url === '/test/request-logs' && req.method === 'POST') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const { logs } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    store.state.logs = [...logs, ...store.state.logs.filter((entry) => entry.kind !== 'request')]
    return res.end(JSON.stringify({ ok: true }))
  }
  if (req.url === '/test/quota') {
    if (req.method === 'POST') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const change = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      for (const field of ['total', 'used', 'freeze'])
        if (Number.isFinite(change[field])) quotaState[field] = change[field]
    }
    return res.end(JSON.stringify(quotaState))
  }
  if (req.url === '/usage') {
    if (req.headers.authorization !== 'Bearer test-worker-key') {
      res.statusCode = 401
      return res.end(JSON.stringify({ error: 'invalid worker key' }))
    }
    return res.end(
      JSON.stringify({
        boot_id: 'browser-worker-boot',
        booted_at: workerBootedAt,
        totals: workerTotals,
      }),
    )
  }
  if (req.url === '/v1/models')
    return res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: 'deepseek-v4.1-flash' }, { id: 'glm-5.3-flash' }],
      }),
    )
  for await (const _chunk of req) {
    /* drain request */
  }
  workerTotals.prompt += 1200
  workerTotals.completion += 300
  workerTotals.cache_hit += 400
  workerTotals.cache_miss += 800
  workerTotals.requests++
  res.end(
    JSON.stringify({
      id: 'test-completion',
      choices: [{ message: { content: 'Hello from the test workspace' } }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 300,
        total_tokens: 1500,
        prompt_tokens_details: { cached_tokens: 400 },
      },
    }),
  )
})
worker.listen(19221, '127.0.0.1')
const { server, pool, store } = createPanelServer({
  adminKey: 'browser-test-admin-key',
  gatewayKey: 'browser-test-gateway-key',
  dataDir,
  allowLocal: true,
  poolOptions: {
    quotaIntervalMs: 200,
    quotaPollMs: 25,
    fetchQuotaImpl: async ({ org }) => {
      quotaState.requests++
      return {
        org,
        credits: { total: quotaState.total, used: quotaState.used, freeze: quotaState.freeze },
        dev: { total: 100, used: 10, freeze: 0 },
        ci: { total: 100, used: 0 },
      }
    },
  },
})
server.listen(19220, '127.0.0.1', () => {
  pool.start()
  console.log('Browser fixture ready at http://127.0.0.1:19220')
})
const shutdown = () => {
  pool.stop()
  server.closeAllConnections()
  worker.closeAllConnections()
  oidc.closeAllConnections()
  server.close()
  worker.close()
  oidc.close()
  rmSync(fixtureRoot, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
