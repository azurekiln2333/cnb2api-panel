// Cross-repository acceptance: actual worker -> loopback provider -> actual panel.
// Run: node scripts/verify-worker-usage.mjs ../cnb2api
// All credentials are synthetic. No operator environment or production data is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPanelServer } from '../src/app.mjs';

if (!process.argv[2]) throw new Error('Usage: node scripts/verify-worker-usage.mjs <worker-root>');
const workerRoot = resolve(process.argv[2]);
assert.ok(existsSync(join(workerRoot, 'src/server.mjs')), 'worker source must exist');
const WORKER_KEY = 'local-worker-usage-acceptance-key';
const GATEWAY_KEY = 'local-panel-usage-acceptance-key';
const MODEL = 'usage-acceptance-model';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}
const data = (value) => `data: ${JSON.stringify(value)}\n\n`;
const primary = { prompt_tokens: 4007, completion_tokens: 100 };
const cache = {
  prompt_cache_hit_tokens: 3840,
  prompt_cache_miss_tokens: 167,
  prompt_tokens_details: { cached_tokens: 3840, cache_creation_tokens: 20 },
  credit: 0.0125,
};
const scenarios = [
  { name: 'measured', events: [{ usage: { ...primary, ...cache } }], input: 4007, output: 100, read: 3840, write: 20 },
  { name: 'zero-alias', events: [{ usage: { ...primary, ...cache, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }], input: 4007, output: 100, read: 3840, write: 20 },
  { name: 'chat-placeholders', events: [{ usage: { prompt_tokens: 0, completion_tokens: 0, input_tokens: 167, output_tokens: 100, cache_read_input_tokens: 3840 } }], input: 4007, output: 100, read: 3840, write: null },
  { name: 'all-cached-messages-shape', events: [{ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 3840 } }], input: 3840, output: 0, read: 3840, write: null },
  { name: 'all-cached-split-first', events: [{ usage: { cache_read_input_tokens: 3840 } }, { usage: { prompt_tokens: 0, completion_tokens: 0, input_tokens: 0, output_tokens: 0 } }], input: 3840, output: 0, read: 3840, write: null },
  { name: 'all-cached-split-last', events: [{ usage: { prompt_tokens: 0, completion_tokens: 0, input_tokens: 0, output_tokens: 0 } }, { usage: { cache_read_input_tokens: 3840 } }], input: 3840, output: 0, read: 3840, write: null },
  { name: 'billing-measured-family', events: [{ usage: { prompt_tokens: 0, completion_tokens: 0 } }, { billing_usage: { input_tokens: 167, output_tokens: 100, cache_read_input_tokens: 3840 } }], input: 4007, output: 100, read: 3840, write: null },
  { name: 'billing-output', events: [{ usage: { prompt_tokens: 4007, ...cache } }, { billing_usage: { output_tokens: 100 } }], input: 4007, output: 100, read: 3840, write: 20 },
  { name: 'billing-increases-cumulative', events: [{ usage: { prompt_tokens: 4000, completion_tokens: 90, ...cache } }, { billing_usage: primary }], input: 4007, output: 100, read: 3840, write: 20 },
  { name: 'split', events: [{ usage: { prompt_tokens: 4007, ...cache } }, { usage: { completion_tokens: 100 } }], input: 4007, output: 100, read: 3840, write: 20 },
  { name: 'billing-last', events: [{ usage: primary }, { billing_usage: { cache_read_input_tokens: 3840, cache_creation_input_tokens: 20, credit: 0.0125 } }], input: 4007, output: 100, read: 3840, write: 20 },
  { name: 'billing-first', events: [{ billing_usage: { cache_read_input_tokens: 3840, cache_creation_input_tokens: 20, credit: 0.0125 } }, { usage: primary }], input: 4007, output: 100, read: 3840, write: 20 },
  { name: 'cache-unknown', events: [{ usage: primary }], input: 4007, output: 100, read: null, write: null },
  { name: 'usage-unknown', events: [], input: 0, output: 0, read: null, write: null, missing: true },
  { name: 'measured-zero', events: [{ usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_creation_tokens: 0 }, prompt_cache_miss_tokens: 0, credit: 0 } }], input: 0, output: 0, read: 0, write: 0 },
];

test('actual worker and panel preserve usage across native and converted routes', { timeout: 60000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cnb-cache-acceptance-'));
  let fixture = scenarios[0];
  const requests = [];
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/upstream');
      assert.equal(req.headers.authorization, 'Bearer local-provider-token');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push(payload);
      assert.equal(payload.stream, true);
      assert.equal(payload.stream_options?.include_usage, true);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(data({ id: 'chatcmpl-local-usage', model: MODEL, choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] }));
      for (const event of fixture.events) res.write(data({ choices: [], ...event }));
      if (fixture.interrupted) {
        // Deliver observed usage first, then break the actual provider transport.
        setTimeout(() => res.destroy(), 30);
        return;
      }
      res.end(data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    } catch (error) {
      res.writeHead(500);
      res.end('invalid local fixture request');
      requests.push({ fixtureError: error.message });
    }
  });
  const providerBase = await listen(provider);
  const reserve = http.createServer();
  const workerBase = await listen(reserve);
  const port = new URL(workerBase).port;
  await close(reserve);
  let child;
  let app;
  t.after(async () => {
    app?.pool.stop();
    if (app) await close(app.server);
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    await close(provider);
    // directory is an exact mkdtemp result; never remove an operator path.
    rmSync(directory, { recursive: true, force: true });
  });
  const environment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  child = spawn(process.execPath, [join(workerRoot, 'src/server.mjs')], {
    cwd: directory,
    env: {
      ...environment,
      PROXY_KEY: WORKER_KEY,
      CNB_TOKEN: 'local-provider-token',
      CNB_REPO_SLUG: 'local/fixture',
      UPSTREAM_OVERRIDE: `${providerBase}/upstream`,
      PROXY_PORT: port,
      PROXY_CATALOG_DISABLED: '1',
      PROXY_MODELS: MODEL,
      PROXY_MODELS_STATE: join(directory, 'worker-models.json'),
      PROXY_CATALOG_STATE: join(directory, 'worker-catalog.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (value) => { output = (output + value).slice(-4000); });
  let started = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Local worker exited: ${output}`);
    try {
      const response = await fetch(`${workerBase}/health`, { signal: AbortSignal.timeout(500) });
      await response.arrayBuffer();
      if (response.ok) { started = true; break; }
    } catch { /* wait for the local child listener */ }
    await delay(30);
  }
  assert.ok(started, `local worker did not start: ${output}`);
  app = createPanelServer({ adminKey: 'local-usage-admin-key', gatewayKey: GATEWAY_KEY, dataDir: join(directory, 'data'), logDir: join(directory, 'logs'), allowLocal: true });
  app.store.settings({ quotaProtection: { enabled: false } });
  const account = app.store.create({ name: 'local usage worker', endpoint: workerBase, proxyKey: WORKER_KEY });
  await app.pool.probe(account.id);
  const panelBase = await listen(app.server);
  const snapshot = async () => {
    const response = await fetch(`${workerBase}/usage`, { headers: { Authorization: `Bearer ${WORKER_KEY}` } });
    assert.equal(response.status, 200);
    return response.json();
  };

  for (const path of ['/v1/chat/completions', '/v1/messages', '/v1/responses']) {
    for (const stream of [false, true]) {
      for (const scenario of scenarios) {
        await t.test(`${path} ${stream ? 'SSE' : 'JSON'} ${scenario.name}`, async () => {
          fixture = scenario;
          const before = await snapshot();
          await app.pool.workerUsage.refresh(account.id);
          const payload = path === '/v1/responses'
            ? { model: MODEL, input: 'local usage fixture', stream }
            : { model: MODEL, messages: [{ role: 'user', content: 'local usage fixture' }], max_tokens: 100, stream };
          const response = await fetch(`${panelBase}${path}`, {
            method: 'POST', headers: { Authorization: `Bearer ${GATEWAY_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
          });
          const body = await response.text();
          assert.equal(response.status, 200, body);
          const log = app.store.state.logs.find((row) => row.kind === 'request' && row.requestId === response.headers.get('x-request-id'));
          assert.ok(log, 'panel request must be recorded');
          assert.equal(log.attempts, 1);
          const usage = log.tokenUsage;
          assert.equal(usage.input, scenario.input);
          assert.equal(usage.output, scenario.output);
          assert.equal(usage.cacheRead, scenario.read ?? 0);
          assert.equal(usage.cacheWrite, scenario.write ?? 0);
          assert.equal(usage.cacheReadReported, Number(scenario.read !== null));
          assert.equal(usage.cacheWriteReported, Number(scenario.write !== null));
          assert.equal(usage.missingRequests, Number(Boolean(scenario.missing)));
          const after = await snapshot();
          assert.equal(after.schema_version, 2);
          assert.equal(after.totals.requests - before.totals.requests, 1);
          assert.equal(after.totals.partial_requests - before.totals.partial_requests, 0);
          assert.equal(after.totals.prompt - before.totals.prompt, scenario.input);
          assert.equal(after.totals.completion - before.totals.completion, scenario.output);
          assert.equal(after.totals.cache_hit - before.totals.cache_hit, scenario.read ?? 0);
          assert.equal(after.coverage.cache_hit - before.coverage.cache_hit, Number(scenario.read !== null));
          assert.equal(after.coverage.cache_write - before.coverage.cache_write, Number(scenario.write !== null));
          const sources = scenario.events.flatMap((event) => [event.usage, event.billing_usage]).filter(Boolean);
          const credit = sources.find((source) => typeof source.credit === 'number')?.credit;
          const miss = sources.find((source) => typeof source.prompt_cache_miss_tokens === 'number')?.prompt_cache_miss_tokens;
          assert.ok(Math.abs(after.totals.credit - before.totals.credit - (credit ?? 0)) < 1e-9);
          assert.equal(after.coverage.credit - before.coverage.credit, Number(credit !== undefined));
          assert.equal(after.totals.cache_miss - before.totals.cache_miss, miss ?? 0);
          assert.equal(after.coverage.cache_miss - before.coverage.cache_miss, Number(miss !== undefined));
          if (path === '/v1/chat/completions' && !stream && !scenario.missing) {
            assert.equal(JSON.parse(body).usage.prompt_tokens, scenario.input);
          }
          if (path === '/v1/responses') {
            const result = stream
              ? body.split('\n').filter((line) => line.startsWith('data: {')).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === 'response.completed')?.response
              : JSON.parse(body);
            assert.ok(result, 'Responses client must receive a terminal response');
            if (scenario.missing) assert.equal(result.usage, null);
            else {
              assert.equal(result.usage.input_tokens, scenario.input);
              assert.equal(result.usage.output_tokens, scenario.output);
              assert.equal(result.usage.input_tokens_details.cached_tokens, scenario.read ?? 0);
            }
          }
          const comparison = await app.pool.workerUsage.refresh(account.id);
          assert.equal(comparison.status, 'ok');
          assert.ok(!requests.some((request) => request.fixtureError));
        });
      }
    }
  }
  for (const path of ['/v1/chat/completions', '/v1/responses', '/v1/messages']) {
    await t.test(`${path} interrupted stream retains partial measurements`, async () => {
      fixture = { events: [{ usage: { ...primary, ...cache } }], interrupted: true };
      await app.pool.probe(account.id);
      const before = await snapshot();
      const payload = path === '/v1/responses'
        ? { model: MODEL, input: 'local interrupted fixture', stream: true }
        : { model: MODEL, messages: [{ role: 'user', content: 'local interrupted fixture' }], max_tokens: 100, stream: true };
      const response = await fetch(`${panelBase}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${GATEWAY_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 200);
      const body = await response.text();
      const log = app.store.state.logs.find((row) => row.kind === 'request' && row.requestId === response.headers.get('x-request-id'));
      assert.ok(log, 'interrupted request must be recorded');
      assert.equal(log.attempts, 1);
      assert.equal(log.tokenUsage.input, 4007);
      assert.equal(log.tokenUsage.output, 100);
      assert.equal(log.tokenUsage.cacheRead, 3840);
      assert.equal(log.tokenUsage.partialRequests, 1);
      assert.equal(log.cacheMiss, undefined, 'partial usage cannot prove a complete cache miss');
      const after = await snapshot();
      assert.equal(after.totals.requests - before.totals.requests, 1);
      assert.equal(after.totals.partial_requests - before.totals.partial_requests, 1);
      assert.equal(after.totals.prompt - before.totals.prompt, 4007);
      assert.equal(after.totals.cache_hit - before.totals.cache_hit, 3840);
      if (path === '/v1/responses') {
        assert.ok(body.includes('"type":"response.failed"'));
        assert.ok(!body.includes('"type":"response.completed"'));
      }
      if (path === '/v1/messages') assert.ok(body.includes('"usage_partial":true'));
    });
  }
  assert.equal(requests.length, scenarios.length * 6 + 3);
});
