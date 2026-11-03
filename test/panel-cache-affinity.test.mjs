import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";
import { SessionAffinity } from "../src/session-affinity.mjs";

const GATEWAY = "cache-affinity-gateway-key";
const WORKER = "cache-affinity-worker-key";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};
const json = (res, body, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const completion = (content = "ok") => ({
  model: "deepseek-v4.1",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
});

// Each worker records which account served each request.
async function fixture(t, accounts = 3) {
  const directory = mkdtempSync(join(tmpdir(), "panel-cache-affinity-"));
  const app = createPanelServer({
    adminKey: "cache-affinity-admin-key", gatewayKey: GATEWAY,
    dataDir: join(directory, "data"), allowLocal: true,
  });
  app.store.settings({ quotaProtection: { enabled: false } });
  const served = [];
  const workers = [];
  const endpoints = [];
  for (let i = 0; i < accounts; i++) {
    const name = `cache-worker-${i}`;
    const worker = http.createServer(async (req, res) => {
      if (req.url === "/v1/models") {
        json(res, { object: "list", data: [{ id: "deepseek-v4.1" }] });
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      served.push({ account: name, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      json(res, completion());
    });
    workers.push(worker);
    endpoints.push(await listen(worker));
  }
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    for (const worker of workers) await close(worker);
    rmSync(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < accounts; i++) {
    const created = app.store.create({
      name: `cache-worker-${i}`, endpoint: endpoints[i], proxyKey: WORKER,
    });
    await app.pool.probe(created.id);
    // Equal weight and priority so selection is driven by affinity alone.
    app.store.state.accounts.find((a) => a.id === created.id).weight = 1;
  }
  const post = (path, payload) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { ...app, post, served, endpoints };
}

// The prefix cache lives inside one account. If the same conversation keeps
// landing on different accounts, every turn is a guaranteed cache miss.
const claudeCodeChat = (cch) => ({
  model: "deepseek-v4.1",
  messages: [
    {
      role: "system",
      content: `x-anthropic-billing-header: cch=${cch};\n`
        + "You are Claude Code, Anthropic's official CLI tool for Claude.\n"
        + "You help with coding.",
    },
    { role: "user", content: "fix the failing test" },
  ],
});

test("a Claude Code conversation stays on one account across turns", async (t) => {
  const app = await fixture(t);
  // Same conversation, different volatile billing values per turn.
  for (const cch of ["aaaa1111", "bbbb2222", "cccc3333", "dddd4444"]) {
    const response = await app.post("/v1/chat/completions", claudeCodeChat(cch));
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.equal(app.served.length, 4);
  const accounts = new Set(app.served.map((entry) => entry.account));
  assert.equal(
    accounts.size, 1,
    `conversation split across ${[...accounts].join(", ")}`,
  );
  // Every turn also sent a byte-identical cached prefix.
  const prefixes = new Set(app.served.map((entry) => JSON.stringify(entry.payload.messages[0])));
  assert.equal(prefixes.size, 1, "the cached prefix changed between turns");
});

test("the forwarded prefix no longer carries the per-request billing value", async (t) => {
  const app = await fixture(t, 1);
  await (await app.post("/v1/chat/completions", claudeCodeChat("deadbeefcafe"))).text();
  const system = app.served[0].payload.messages[0].content;
  assert.doesNotMatch(system, /deadbeefcafe/);
  assert.match(system, /^x-cc-billing-meta: cch=0\n/);
  // The user turn is untouched, so a real cache key can still vary by content.
  assert.equal(app.served[0].payload.messages[1].content, "fix the failing test");
});

test("a Codex conversation keyed by prompt_cache_key stays on one account", async (t) => {
  const app = await fixture(t);
  const codex = (turn, prefix) => ({
    model: "deepseek-v4.1",
    prompt_cache_key: "conversation-alpha",
    messages: [
      { role: "system", content: prefix },
      { role: "user", content: "start" },
      ...Array.from({ length: turn }, (_unused, index) => (
        { role: "assistant", content: `step ${index}` }
      )),
      { role: "user", content: `continue ${turn}` },
    ],
  });
  // Codex rewrites its system prompt between turns (tool list, sandbox notes),
  // so the transcript hash moves while the conversation does not. Only
  // prompt_cache_key identifies the conversation, and only it can hold the
  // account steady.
  const prefixes = [
    "You are a coding agent. Tools: shell, apply_patch.",
    "You are a coding agent. Tools: shell, apply_patch, read_file.",
    "You are a coding agent. Tools: shell, apply_patch, read_file, write_file.",
    "You are a coding agent. Tools: shell, apply_patch, read_file, write_file, grep.",
  ];
  for (let turn = 0; turn < prefixes.length; turn++) {
    const response = await app.post("/v1/chat/completions", codex(turn, prefixes[turn]));
    assert.equal(response.status, 200);
    await response.text();
  }
  const accounts = new Set(app.served.map((entry) => entry.account));
  assert.equal(accounts.size, 1, `Codex conversation split across ${accounts.size} accounts`);
});

// --- Cooldown and quota protection -----------------------------------------
// Cooldown and quota suspension change the candidate set. The binding must
// survive a failure on an unrelated account, and must be released only when the
// bound account itself fails or leaves the candidates.

test("a binding is dropped when its account leaves the candidate set", () => {
  const affinity = new SessionAffinity();
  affinity.bind("session-a", "account-1");
  assert.equal(affinity.get("session-a"), "account-1");
  // Pool.select calls forget() when the bound account is not a candidate.
  affinity.forget("session-a");
  assert.equal(affinity.get("session-a"), null);
});

test("a failure on another account keeps the current binding", () => {
  const affinity = new SessionAffinity();
  affinity.bind("session-a", "account-1");
  affinity.forget("session-a", "account-2");
  assert.equal(affinity.get("session-a"), "account-1");
});

test("a failure on the bound account clears it", () => {
  const affinity = new SessionAffinity();
  affinity.bind("session-a", "account-1");
  affinity.forget("session-a", "account-1");
  assert.equal(affinity.get("session-a"), null);
});

test("an expired binding is not returned", () => {
  let now = 1000;
  const affinity = new SessionAffinity({ now: () => now, idleTtlMs: 5000 });
  affinity.bind("session-a", "account-1");
  // get() refreshes lastUsed, so advance the clock without reading first.
  now += 5001;
  assert.equal(affinity.get("session-a"), null);
  affinity.bind("session-b", "account-2");
  now += 1000;
  assert.equal(affinity.get("session-b"), "account-2");
});
