// W-C: DSH compatibility guard.
// These tests pin the DSH behaviour that exists today so the Codex hosted-tool
// and Claude Code Messages work cannot silently change it. Rules are selected
// by name, not index, because other presets share the diagnostic list.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";
import { Store } from "../src/store.mjs";
import { prepareResponsesRequest } from "../src/responses.mjs";
import { rewriteRequest, validateRequestOverrides } from "../src/request-overrides.mjs";

const ADMIN = "dsh-guard-admin-key";
const GATEWAY = "dsh-guard-gateway-key";
const WORKER = "dsh-guard-worker-key";
const CHAT = "/v1/chat/completions";
const MESSAGES = "/v1/messages";
const RESPONSES = "/v1/responses";

const ROLES = "dsh_roles";
const PRIVILEGED = "dsh_privileged_text";
const ASSISTANT = "dsh_assistant_identity";
const DSH_RULES = [ROLES, PRIVILEGED, ASSISTANT];

const IDENTITY = "You are an AI agent powered by DeepSeek Harness.";
const CODING_IDENTITY = "You are a coding agent powered by the deepseek-v4.1 model.";
const ASSISTANT_IDENTITY = "You are a coding agent powered by the cn-deepseek-v4.1-flash-0.11x model.";
const PATH_PAIR = "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root";
const PATH_PAIR_REPLACEMENT = "Treat tokens beginning with @ as paths explicitly referenced by the user. Resolve relative paths from the workspace root";

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
const settings = (operations = [], dshCompat = true) => ({ dshCompat, requestOverrides: { operations } });

// Rule lookup by preset name keeps these tests stable while other workers add
// their own presets to the same diagnostic list.
const rule = (rules, name) => {
  const found = rules.find((entry) => entry.name === name);
  assert.ok(found, `missing preset rule ${name} in ${rules.map((entry) => entry.name).join(",")}`);
  return found;
};
const dshRules = (rules) => DSH_RULES.map((name) => rule(rules, name));
const outcomes = (rules) => dshRules(rules).map((entry) => entry.outcome);
const counts = (rules) => dshRules(rules).map((entry) => entry.count);

const chatCompletion = (content = "ok") => ({
  model: "test-model",
  choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 7, completion_tokens: 2 },
});
const anthropicBody = () => ({
  id: "msg_dsh", type: "message", role: "assistant", model: "test-model",
  content: [{ type: "text", text: "anthropic ok" }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 5, output_tokens: 2 },
});

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "dsh-guard-"));
  const app = createPanelServer({
    adminKey: ADMIN, gatewayKey: GATEWAY,
    dataDir: join(directory, "data"), allowLocal: true,
  });
  app.store.settings({ quotaProtection: { enabled: false } });
  const calls = [];
  const worker = http.createServer(async (req, res) => {
    if (req.url === "/v1/models") {
      json(res, { object: "list", data: [{ id: "test-model" }] });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    calls.push({ path: req.url, payload: JSON.parse(raw), raw, headers: req.headers });
    if (req.url === MESSAGES) return json(res, anthropicBody());
    json(res, chatCompletion());
  });
  const endpoint = await listen(worker);
  const base = await listen(app.server);
  t.after(async () => {
    app.pool.stop();
    await close(app.server);
    await close(worker);
    rmSync(directory, { recursive: true, force: true });
  });
  const account = app.store.create({ name: "dsh-worker", endpoint, proxyKey: WORKER });
  await app.pool.probe(account.id);
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GATEWAY}`, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  // Request logs are newest first.
  const logs = () => app.store.state.logs.filter((entry) => entry.kind === "request");
  const latest = () => logs()[0];
  return { ...app, base, directory, calls, post, logs, latest, accountId: account.id };
}

// ---------------------------------------------------------------------------
// Preset rule scope
// ---------------------------------------------------------------------------

test("the three DSH presets are declared once and only apply to Chat paths", () => {
  const dshMessages = { messages: [{ role: "developer", content: IDENTITY }] };
  const applied = rewriteRequest(dshMessages, settings(), CHAT);
  assert.deepEqual(dshRules(applied.rules).map((entry) => [entry.name, entry.mode, entry.path]), [
    [ROLES, "set", "messages.*.role"],
    [PRIVILEGED, "regex_replace", "messages.*.content"],
    [ASSISTANT, "regex_replace", "messages.*.content"],
  ]);
  assert.equal(applied.payload.messages[0].role, "system");
  assert.equal(applied.payload.messages[0].content, "You are an AI assistant.");

  // Disabled flag, non-Chat paths, and non-array messages all skip the presets.
  for (const [payload, path, enabled] of [
    [dshMessages, CHAT, false],
    [dshMessages, MESSAGES, true],
    [dshMessages, "/v1/messages/count_tokens", true],
    [dshMessages, "/v1/completions", true],
    [{ messages: "not-an-array" }, CHAT, true],
    [{ input: "hello" }, CHAT, true],
  ]) {
    const result = rewriteRequest(payload, settings([], enabled), path);
    assert.deepEqual(result.payload, payload, `${path} must stay untouched`);
    assert.deepEqual(outcomes(result.rules), ["skipped", "skipped", "skipped"]);
  }
});

test("preset rules keep their slots ahead of custom operations in diagnostics", () => {
  const result = rewriteRequest(
    { messages: [{ role: "developer", content: "neutral" }] },
    settings([{ mode: "set", path: "temperature", value: 0.1 }]),
    CHAT,
  );
  // Every preset precedes every custom operation, whatever sets are enabled.
  const names = result.rules.map((entry) => entry.name);
  assert.ok(names.indexOf("override_1") > names.indexOf(ASSISTANT));
  assert.deepEqual(outcomes(result.rules), ["applied", "unmatched", "unmatched"]);
  assert.equal(result.rules.at(-1).outcome, "applied");
});

// ---------------------------------------------------------------------------
// Identification and text categories
// ---------------------------------------------------------------------------

test("identification requires privileged text, not user, tool, or image content", () => {
  // Triggers: privileged brand or path sentence, and assistant-side identities.
  // Once any message identifies DSH, every privileged message is rewritten.
  for (const [role, text] of [
    ["system", "brand: DeepSeek Harness"],
    ["developer", "brand: DeepSeek Harness"],
    ["system", PATH_PAIR],
    ["assistant", IDENTITY],
    ["assistant", ASSISTANT_IDENTITY],
    ["assistant", "DeepSeek Harness"],
    ["user", IDENTITY],
    ["tool", IDENTITY],
  ]) {
    const input = { messages: [
      { role, content: text },
      { role: "system", content: "second marker: DeepSeek Harness" },
    ] };
    const result = rewriteRequest(input, settings(), CHAT);
    // Only assistant text feeds the assistant category.
    const assistantApplies = role === "assistant" && /You are (?:an AI agent powered by DeepSeek Harness|a coding agent powered by the (?:cn-)?deepseek-)/.test(text);
    assert.equal(
      rule(result.rules, ASSISTANT).outcome,
      assistantApplies ? "applied" : "unmatched",
      `assistant category for ${role}: ${text}`,
    );
    // The second system message always carries the brand, so identification is
    // never in doubt; only the first message's category is under test.
    assert.equal(rule(result.rules, PRIVILEGED).outcome, "applied",
      `privileged category for ${role}: ${text}`);
    // User and tool content is never rewritten even after identification.
    if (!["system", "developer", "assistant"].includes(role))
      assert.equal(result.payload.messages[0].content, text);
    if (role === "assistant" && !assistantApplies)
      assert.equal(result.payload.messages[0].content, text);
  }
  // User text is never rewritten, and a user message alone cannot identify DSH.
  const userOnly = { messages: [
    { role: "user", content: IDENTITY },
    { role: "system", content: "neutral system instruction" },
    { role: "developer", content: "neutral developer instruction" },
  ] };
  const userResult = rewriteRequest(userOnly, settings(), CHAT);
  assert.equal(userResult.payload.messages[0].content, IDENTITY);
  assert.deepEqual(outcomes(userResult.rules), ["applied", "unmatched", "unmatched"]);
  // A brand in a privileged message does identify, so that message is rewritten
  // while the user message keeps its bytes.
  const mixed = { messages: [
    { role: "user", content: IDENTITY },
    { role: "system", content: "brand: DeepSeek Harness" },
  ] };
  const mixedResult = rewriteRequest(mixed, settings(), CHAT);
  assert.equal(mixedResult.payload.messages[0].content, IDENTITY);
  assert.equal(mixedResult.payload.messages[1].content, "brand: AI assistant");
  // Media blocks never identify DSH even inside a privileged message.
  const media = { messages: [{ role: "system", content: [
    { type: "image_url", image_url: { url: "you are an ai agent powered by deepseek harness" } },
    { type: "tool_result", content: IDENTITY },
  ] }] };
  const result = rewriteRequest(media, settings(), CHAT);
  assert.deepEqual(outcomes(result.rules), ["unmatched", "unmatched", "unmatched"]);
  assert.deepEqual(result.payload, media);
});

test("brand, coding identity, and path fingerprint rewrites stay in their categories", () => {
  const input = { messages: [
    { role: "developer", content: `${IDENTITY} ${CODING_IDENTITY} ${PATH_PAIR}. DeepSeek Harness.` },
    { role: "assistant", content: `${IDENTITY} ${ASSISTANT_IDENTITY} ${PATH_PAIR}. DeepSeek Harness.` },
    { role: "user", content: `${IDENTITY} ${CODING_IDENTITY} ${PATH_PAIR}` },
    { role: "tool", content: `${IDENTITY} ${PATH_PAIR}` },
  ] };
  const original = structuredClone(input);
  const result = rewriteRequest(input, settings(), CHAT);
  assert.equal(
    result.payload.messages[0].content,
    `You are an AI assistant. You are a coding assistant. ${PATH_PAIR_REPLACEMENT}. AI assistant.`,
  );
  // Assistants only lose their own identities: brand and path text survive.
  assert.equal(
    result.payload.messages[1].content,
    `You are an AI assistant. You are a coding assistant. ${PATH_PAIR}. DeepSeek Harness.`,
  );
  // User and tool content are never rewritten.
  assert.equal(result.payload.messages[2].content, input.messages[2].content);
  assert.equal(result.payload.messages[3].content, input.messages[3].content);
  assert.deepEqual(input, original);
  assert.deepEqual(counts(result.rules), [1, 4, 2]);
});

test("identity patterns keep word boundaries and never over-consume trailing text", () => {
  // Privileged text only matches the neutral identity and the brand.
  for (const [text, expected] of [
    ["You are an AI agent powered by DeepSeek Harness.", "You are an AI assistant."],
    ["You are an AI agent powered by DeepSeek Harness and stay calm.", "You are an AI assistant. and stay calm."],
    ["you are an AI agent powered by DeepSeek HarnessX", "you are an AI agent powered by AI assistantX"],
    ["You are an AI agent powered by DeepSeek Harness-v2", "You are an AI agent powered by AI assistant-v2"],
  ]) {
    const result = rewriteRequest({ messages: [{ role: "system", content: text }] }, settings(), CHAT);
    assert.equal(result.payload.messages[0].content, expected, text);
  }
  // The "coding agent powered by the X model" form is assistant-only, and the
  // assistant pattern additionally requires a deepseek model name.
  for (const [text, expected] of [
    ["You are a coding agent powered by the deepseek-v4.1 model.", "You are a coding assistant."],
    ["You are a coding agent powered by the deepseek-v4.1 model and keep this.", "You are a coding assistant. and keep this."],
    ["You are a coding agent powered by the cn-deepseek-v4.1-flash-0.11x model.", "You are a coding assistant."],
    ["You are a coding agent powered by the model model.", "You are a coding agent powered by the model model."],
  ]) {
    const assistant = rewriteRequest({ messages: [{ role: "assistant", content: text }] }, settings(), CHAT);
    assert.equal(assistant.payload.messages[0].content, expected, text);
    const privileged = rewriteRequest({ messages: [{ role: "system", content: text }] }, settings(), CHAT);
    assert.equal(privileged.payload.messages[0].content, text, `system must not match: ${text}`);
  }
});

test("block content is rewritten in place while other block kinds and keys are untouched", () => {
  const input = { messages: [{ role: "developer", content: [
    { type: "text", text: IDENTITY },
    { type: "input_text", text: PATH_PAIR },
    { type: "text", text: "neutral" },
    { type: "image_url", image_url: { url: "u" } },
    { type: "tool_result", content: IDENTITY },
  ], extra: { keep: IDENTITY } }] };
  const result = rewriteRequest(input, settings(), CHAT);
  assert.equal(result.payload.messages[0].role, "system");
  assert.equal(result.payload.messages[0].content[0].text, "You are an AI assistant.");
  assert.equal(result.payload.messages[0].content[1].text, PATH_PAIR_REPLACEMENT);
  assert.equal(result.payload.messages[0].content[2].text, "neutral");
  assert.deepEqual(result.payload.messages[0].content.slice(3), input.messages[0].content.slice(3));
  assert.deepEqual(result.payload.messages[0].extra, { keep: IDENTITY });
});

test("disabling DSH also disables developer role normalization", () => {
  const input = { messages: [
    { role: "developer", content: IDENTITY },
    { role: "system", content: IDENTITY },
  ] };
  const result = rewriteRequest(input, settings([], false), CHAT);
  assert.deepEqual(result.payload.messages.map((message) => message.role), ["developer", "system"]);
  assert.equal(result.payload.messages[0].content, IDENTITY);
  assert.deepEqual(outcomes(result.rules), ["skipped", "skipped", "skipped"]);
  // Enabling the switch restores both the role and text rewrites.
  const enabled = rewriteRequest(input, settings([], true), CHAT);
  assert.deepEqual(enabled.payload.messages.map((message) => message.role), ["system", "system"]);
  assert.equal(enabled.payload.messages[0].content, "You are an AI assistant.");
});

// ---------------------------------------------------------------------------
// Interaction with custom overrides
// ---------------------------------------------------------------------------

test("custom operations observe DSH-rewritten values and run afterwards", () => {
  const operations = [
    { mode: "regex_replace", path: "messages.0.content", from: "You are an AI assistant\\.", to: "post-dsh",
      conditions: [{ path: "messages.0.role", mode: "full", value: "system" }] },
    { mode: "set", path: "messages.0.seen", value: true },
  ];
  const result = rewriteRequest(
    { messages: [{ role: "developer", content: IDENTITY }] },
    settings(operations), CHAT,
  );
  assert.equal(result.payload.messages[0].content, "post-dsh");
  assert.equal(result.payload.messages[0].seen, true);
  const custom = result.rules.filter((entry) => entry.name.startsWith("override_"));
  assert.deepEqual(custom.map((entry) => entry.outcome), ["applied", "applied"]);
});

test("invalid overrides keep DSH effects and add one skipped diagnostic", () => {
  const result = rewriteRequest(
    { messages: [{ role: "developer", content: IDENTITY }, { role: "user", content: "hi" }] },
    { dshCompat: true, requestOverrides: { operations: [{ mode: "set", path: "model", value: "x" }] } },
    CHAT,
  );
  assert.deepEqual(result.payload.messages.map((message) => [message.role, message.content]), [
    ["system", "You are an AI assistant."], ["user", "hi"],
  ]);
  assert.deepEqual(result.rules.at(-1), { name: "invalid_overrides", mode: "invalid", path: "", outcome: "skipped" });
});

// ---------------------------------------------------------------------------
// Responses bridge keeps DSH semantics on the converted Chat payload
// ---------------------------------------------------------------------------

test("Responses requests are converted before DSH rewriting and keep preset effects", () => {
  const prepared = prepareResponsesRequest({
    model: "test-model",
    instructions: IDENTITY,
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: PATH_PAIR }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: ASSISTANT_IDENTITY }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: IDENTITY }] },
    ],
  });
  const result = rewriteRequest(prepared.payload, settings(), CHAT);
  // The bridge already emits system roles, so the role rule alone never fires.
  assert.equal(rule(result.rules, PRIVILEGED).outcome, "applied");
  assert.equal(rule(result.rules, ASSISTANT).outcome, "applied");
  assert.deepEqual(result.payload.messages.map((message) => message.role), ["system", "system", "assistant", "user"]);
  assert.equal(result.payload.messages[0].content, "You are an AI assistant.");
  assert.equal(result.payload.messages[1].content[0].text, PATH_PAIR_REPLACEMENT);
  assert.equal(result.payload.messages[2].content[0].text, "You are a coding assistant.");
  assert.equal(result.payload.messages[3].content[0].text, IDENTITY);
  // The native Messages path is untouched by the Responses bridge.
  assert.deepEqual(rewriteRequest(prepared.payload, settings(), MESSAGES).payload, prepared.payload);
});

// ---------------------------------------------------------------------------
// End-to-end through the panel
// ---------------------------------------------------------------------------

test("DSH rewriting reaches Chat while the native Messages route stays untouched", async (t) => {
  const app = await fixture(t);
  const chat = await app.post(CHAT, {
    model: "test-model",
    messages: [
      { role: "developer", content: IDENTITY },
      { role: "assistant", content: ASSISTANT_IDENTITY },
      { role: "user", content: IDENTITY },
    ],
  });
  assert.equal(chat.status, 200);
  await chat.text();
  const chatCall = app.calls.at(-1);
  assert.equal(chatCall.path, CHAT);
  assert.deepEqual(chatCall.payload.messages.map((message) => message.role), ["system", "assistant", "user"]);
  assert.equal(chatCall.payload.messages[0].content, "You are an AI assistant.");
  assert.equal(chatCall.payload.messages[1].content, "You are a coding assistant.");
  assert.equal(chatCall.payload.messages[2].content, IDENTITY);
  assert.deepEqual(outcomes(app.latest().requestDiagnostics.rules), ["applied", "applied", "applied"]);

  const native = { model: "test-model", max_tokens: 16, messages: [
    { role: "user", content: [{ type: "text", text: "hello" }] },
  ], system: IDENTITY };
  const messages = await app.post(MESSAGES, native, { "anthropic-version": "2023-06-01", "x-api-key": GATEWAY });
  assert.equal(messages.status, 200);
  await messages.text();
  const messagesCall = app.calls.at(-1);
  assert.equal(messagesCall.path, MESSAGES);
  // A native Anthropic request keeps its own bytes: no role or system rewrite.
  assert.equal(messagesCall.payload.system, IDENTITY);
  assert.deepEqual(messagesCall.payload.messages, native.messages);

  const logs = app.logs();
  assert.deepEqual(logs.map((entry) => [entry.path, entry.status]), [
    [MESSAGES, 200], [CHAT, 200],
  ]);
  // The native Messages route records skipped DSH presets, not applied ones.
  assert.deepEqual(outcomes(logs[0].requestDiagnostics.rules), ["skipped", "skipped", "skipped"]);
  // Diagnostics never carry rewritten content.
  assert.ok(!JSON.stringify(logs).includes("You are an AI assistant."));
});

test("Responses traffic through the Chat bridge applies DSH to converted messages", async (t) => {
  const app = await fixture(t);
  const response = await app.post(RESPONSES, {
    model: "test-model",
    instructions: IDENTITY,
    input: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: ASSISTANT_IDENTITY }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
  });
  assert.equal(response.status, 200);
  await response.text();
  const call = app.calls.at(-1);
  assert.equal(call.path, CHAT);
  assert.equal(call.payload.messages[0].role, "system");
  assert.equal(call.payload.messages[0].content, "You are an AI assistant.");
  assert.equal(call.payload.messages[1].content[0].text, "You are a coding assistant.");
  assert.equal(call.payload.messages[2].content[0].text, "hi");
  const log = app.latest();
  assert.equal(log.path, RESPONSES);
  assert.equal(rule(log.requestDiagnostics.rules, PRIVILEGED).outcome, "applied");
});

test("the DSH switch is validated, persisted, and off preserves the client payload", async (t) => {
  const app = await fixture(t);
  const login = await fetch(`${app.base}/api/session`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: ADMIN }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const patch = (body) => fetch(`${app.base}/api/settings`, {
    method: "PATCH",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await patch({ dshCompat: "true" })).status, 400);
  assert.equal((await patch({ dshCompat: 0 })).status, 400);
  assert.equal(app.store.state.settings.dshCompat, true);

  assert.equal((await patch({ dshCompat: false })).status, 200);
  const payload = { model: "test-model", messages: [
    { role: "developer", content: IDENTITY }, { role: "user", content: "hi" },
  ] };
  await (await app.post(CHAT, payload)).text();
  assert.deepEqual(app.calls.at(-1).payload.messages, payload.messages);
  assert.deepEqual(outcomes(app.latest().requestDiagnostics.rules), ["skipped", "skipped", "skipped"]);

  const restarted = new Store(app.store.directory, { allowLocal: true });
  assert.equal(restarted.state.settings.dshCompat, false);
});

test("DSH defaults to enabled for a fresh data directory", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dsh-default-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new Store(directory, { allowLocal: true });
  assert.equal(store.state.settings.dshCompat, true);
});

// ---------------------------------------------------------------------------
// Budget and determinism guards shared with overrides
// ---------------------------------------------------------------------------

test("DSH rewriting is deterministic and never mutates the client payload", () => {
  const input = { messages: [
    { role: "developer", content: `${IDENTITY} ${PATH_PAIR}` },
    { role: "assistant", content: ASSISTANT_IDENTITY },
    { role: "user", content: "keep" },
  ] };
  const original = structuredClone(input);
  const first = rewriteRequest(input, settings(), CHAT);
  const second = rewriteRequest(input, settings(), CHAT);
  assert.deepEqual(first, second);
  assert.notEqual(first.payload, input);
  assert.deepEqual(input, original);
});

test("long DSH inputs stay within the request budget after rewriting", () => {
  const padding = "y".repeat(1024 * 1024);
  const input = { messages: [
    { role: "developer", content: `${padding}${IDENTITY}${PATH_PAIR}` },
    { role: "user", content: padding },
  ] };
  const result = rewriteRequest(input, settings(), CHAT);
  assert.ok(Buffer.byteLength(JSON.stringify(result.payload)) <= 4 * 1024 * 1024);
  assert.ok(result.payload.messages[0].content.startsWith(padding));
  assert.ok(result.payload.messages[0].content.endsWith(PATH_PAIR_REPLACEMENT));
  assert.equal(rule(result.rules, PRIVILEGED).count, 2);
});

test("preset rules never widen the accepted override schema", () => {
  // Preset paths are reserved diagnostics; clients cannot submit them.
  assert.throws(() => validateRequestOverrides({ operations: [
    { mode: "set", path: "messages.*.role", value: "system" },
  ] }), /Invalid override path/);
  const result = rewriteRequest(
    { messages: [{ role: "developer", content: IDENTITY }], tools: [{ type: "function", name: "x" }] },
    settings([{ mode: "set", path: "tools", value: [] }]),
    CHAT,
  );
  assert.deepEqual(result.payload.tools, []);
  assert.equal(result.payload.messages[0].role, "system");
});
