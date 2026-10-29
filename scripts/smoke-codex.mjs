// Run against an installed Codex CLI, with isolated state and synthetic keys:
// node scripts/smoke-codex.mjs /path/to/@openai/codex/bin/codex.js
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPanelServer } from "../src/app.mjs";

const cli = process.argv[2];
assert.ok(cli, "Pass the installed Codex CLI JavaScript entry point as the first argument");
const directory = mkdtempSync(join(tmpdir(), "panel-codex-smoke-"));
const home = join(directory, "codex-home");
const workspace = join(directory, "workspace");
mkdirSync(home);
mkdirSync(workspace);
const gatewayKey = "isolated-codex-gateway-key";
const workerKey = "isolated-codex-worker-key";
const marker = "CODEX_BRIDGE_SMOKE_OK";
const allowedFields = new Set([
  "model", "messages", "stream", "stream_options", "tools", "tool_choice",
  "parallel_tool_calls", "reasoning_effort", "prompt_cache_key", "service_tier",
  "temperature", "top_p", "max_tokens", "response_format", "verbosity", "metadata",
  "user", "safety_identifier",
]);
let calls = 0;
let failure;
const json = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
};
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const worker = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, `Bearer ${workerKey}`);
    if (req.url === "/v1/models") {
      json(res, 200, { object: "list", data: [{ id: "gpt-5.4" }] });
      return;
    }
    assert.equal(req.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.deepEqual(Object.keys(payload).filter((name) => !allowedFields.has(name)), []);
    assert.equal(payload.stream, true);
    assert.ok(payload.tools.every((tool) => tool.type === "function"));
    assert.equal(payload.stream_options.include_usage, true);
    calls++;
    const tool = payload.tools.find((tool) => tool.function.name === "exec_command");
    assert.ok(tool, "Codex must offer exec_command");
    const properties = tool.function.parameters.properties;
    const commandField = Object.hasOwn(properties, "cmd") ? "cmd" : "command";
    let delta;
    if (calls === 1) {
      delta = {
        role: "assistant", tool_calls: [{ index: 0, id: "codex_smoke_call", type: "function",
          function: { name: tool.function.name, arguments: JSON.stringify({ [commandField]: "echo codex-bridge-smoke" }) } }],
      };
    } else {
      assert.equal(calls, 2, "The smoke conversation must complete in two model turns");
      const result = payload.messages.find((message) => message.role === "tool" && message.tool_call_id === "codex_smoke_call");
      assert.ok(result, "Codex must return the tool result in its next request");
      assert.ok(JSON.stringify(result.content).includes("codex-bridge-smoke"), "The isolated echo command must execute");
      delta = { role: "assistant", content: marker };
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(frame({ model: payload.model, choices: [{ index: 0, delta, finish_reason: null }] }) +
      frame({ choices: [{ index: 0, delta: {}, finish_reason: calls === 1 ? "tool_calls" : "stop" }] }) +
      frame({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + "data: [DONE]\n\n");
  } catch (error) {
    failure = error;
    json(res, 400, { error: { message: "Strict synthetic Chat worker rejected the request" } });
  }
});
const app = createPanelServer({
  adminKey: "isolated-codex-admin-key", gatewayKey,
  dataDir: join(directory, "data"), logDir: join(directory, "logs"), allowLocal: true,
});
const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
};
let child;
try {
  const workerBase = await listen(worker);
  const panelBase = await listen(app.server);
  const account = app.store.create({ name: "isolated-smoke-worker", endpoint: workerBase, proxyKey: workerKey });
  await app.pool.probe(account.id);
  const config = [
    'model_provider="panel-smoke"', 'model="gpt-5.4"', 'web_search="disabled"', 'features.async_compaction=false',
    'model_providers.panel-smoke.name="Panel smoke"',
    `model_providers.panel-smoke.base_url="${panelBase}/v1"`,
    'model_providers.panel-smoke.wire_api="responses"',
    'model_providers.panel-smoke.env_key="PANEL_SMOKE_API_KEY"',
    'model_providers.panel-smoke.requires_openai_auth=false',
    'model_providers.panel-smoke.supports_websockets=false',
    'model_providers.panel-smoke.supports_standalone_web_search=false',
    'model_providers.panel-smoke.capabilities.remote_compaction="unsupported"',
  ];
  const args = [resolve(cli), "exec", "--skip-git-repo-check", "--ephemeral", "--sandbox", "read-only"];
  for (const entry of config) args.push("-c", entry);
  args.push("Complete the synthetic compatibility test. Follow the model tool request, then return its final text.");
  child = spawn(process.execPath, args, {
    cwd: workspace, windowsHide: true,
    env: { ...process.env, CODEX_HOME: home, PANEL_SMOKE_API_KEY: gatewayKey },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-16000); });
  const timer = setTimeout(() => child.kill(), 60000);
  let code;
  try { [code] = await once(child, "exit"); } finally { clearTimeout(timer); }
  if (failure) throw failure;
  assert.equal(code, 0, `Isolated Codex exited unsuccessfully: ${output}`);
  assert.equal(calls, 2);
  assert.ok(output.includes(marker), "Codex must consume the final Responses SSE text");
  process.stdout.write(`Real Codex smoke passed: ${calls} turns, function execution, full history, strict Chat upstream.\n`);
} finally {
  if (child?.exitCode === null) child.kill();
  app.pool.stop();
  await close(app.server);
  await close(worker);
  rmSync(directory, { recursive: true, force: true });
}
