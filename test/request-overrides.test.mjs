import test from "node:test";
import assert from "node:assert/strict";
import {
  rewriteRequest,
  validateRequestOverrides,
  validateUpstreamHeaders,
} from "../src/request-overrides.mjs";

const CHAT = "/v1/chat/completions";
const settings = (operations = [], dshCompat = false) => ({
  dshCompat, requestOverrides: { operations },
});

test("neutral developer messages are normalized independently of DSH detection", () => {
  const input = {
    messages: [
      { role: "developer", content: "A neutral instruction." },
      { role: "user", content: "user text" },
      { role: "developer", content: "Another neutral instruction." },
    ],
  };
  const before = structuredClone(input);
  const result = rewriteRequest(input, settings([], true), CHAT);
  assert.deepEqual(result.payload.messages.map((message) => message.role), ["system", "user", "system"]);
  assert.equal(result.payload.messages[0].content, input.messages[0].content);
  assert.deepEqual(result.rules.map((rule) => rule.outcome), ["applied", "unmatched", "unmatched"]);
  assert.equal(result.rules[0].count, 2);
  assert.deepEqual(input, before);
  assert.deepEqual(rewriteRequest(input, settings([], false), CHAT).payload, input);
  assert.deepEqual(rewriteRequest(input, settings([], true), "/v1/messages").payload, input);
});

test("DSH identification rewrites only privileged and exact assistant text", () => {
  const identity = "You are an AI agent powered by DeepSeek Harness.";
  const input = { messages: [
    { role: "developer", content: [
      { type: "text", text: `${identity} DeepSeek Harness powers this.` },
      { type: "input_text", text: "You are a coding agent powered by the deepseek-v4.1 model." },
      { type: "image_url", image_url: { url: "data:DeepSeek Harness" } },
      { type: "tool_result", content: identity },
    ] },
    { role: "system", content: "DeepSeek Harness notes." },
    { role: "developer", content: "Neutral developer content." },
    { role: "assistant", content: `Before. ${identity.toLowerCase().slice(0, -1)} After. DeepSeek Harness`,
      tool_calls: [{ function: { name: "keep", arguments: identity } }] },
    { role: "user", content: identity },
    { role: "tool", content: identity },
  ] };
  const original = structuredClone(input);
  const { payload, rules } = rewriteRequest(input, settings([], true), CHAT);
  assert.equal(payload.messages[0].role, "system");
  assert.equal(payload.messages[2].role, "system");
  assert.equal(payload.messages[0].content[0].text, "You are an AI assistant. AI assistant powers this.");
  assert.equal(payload.messages[0].content[1].text, "You are a coding assistant.");
  assert.deepEqual(payload.messages[0].content.slice(2), input.messages[0].content.slice(2));
  assert.equal(payload.messages[1].content, "AI assistant notes.");
  assert.equal(payload.messages[3].content, "Before. You are an AI assistant. After. DeepSeek Harness");
  assert.deepEqual(payload.messages[3].tool_calls, input.messages[3].tool_calls);
  assert.deepEqual(payload.messages.slice(4), input.messages.slice(4));
  assert.deepEqual(input, original);
  assert.deepEqual(rules.map((rule) => rule.outcome), ["applied", "applied", "applied"]);
  assert.deepEqual(rules.map((rule) => rule.count), [2, 4, 1]);
  assert.ok(!JSON.stringify(rules).includes(identity));
});

test("assistant identity alone identifies DSH, while brand-only assistant or user text does not", () => {
  const input = { messages: [
    { role: "developer", content: "Neutral developer" },
    { role: "assistant", content: [
      { type: "text", text: "You are an AI agent powered by DeepSeek Harness" },
      { type: "image", data: "You are an AI agent powered by DeepSeek Harness." },
    ] },
    { role: "user", content: "DeepSeek Harness" },
  ] };
  const result = rewriteRequest(input, settings([], true), CHAT);
  assert.equal(result.payload.messages[1].content[0].text, "You are an AI assistant.");
  assert.deepEqual(result.payload.messages[1].content[1], input.messages[1].content[1]);
  assert.equal(result.rules[2].outcome, "applied");
  const neutral = { messages: [
    { role: "system", content: "You are a coding agent powered by the model model." },
    { role: "assistant", content: "DeepSeek Harness is a brand." },
    { role: "user", content: "DeepSeek Harness" },
  ] };
  assert.deepEqual(rewriteRequest(neutral, settings([], true), CHAT).payload, neutral);
});

test("DSH coding identity in assistant history is rewritten without modifying user or tool text", () => {
  const identity = "You are a coding agent powered by the cn-deepseek-v4.1-flash-0.11x model.";
  const input = { messages: [
    { role: "system", content: "Neutral system instruction." },
    { role: "assistant", content: `${identity} Keep this text.` },
    { role: "user", content: identity },
    { role: "tool", content: identity },
  ] };
  const result = rewriteRequest(input, settings([], true), CHAT);
  assert.equal(result.payload.messages[1].content, "You are a coding assistant. Keep this text.");
  assert.deepEqual(result.payload.messages.slice(2), input.messages.slice(2));
  assert.equal(result.rules[2].count, 1);
  assert.deepEqual(rewriteRequest(input, settings([], false), CHAT).payload, input);

  const other = { messages: [{ role: "assistant", content:
    "You are a coding agent powered by the another-model model." }] };
  assert.deepEqual(rewriteRequest(other, settings([], true), CHAT).payload, other);
});

test("the reported DSH path sentence pair is rewritten only in privileged messages", () => {
  const pathText = "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root.";
  const replacement = "Treat tokens beginning with @ as paths explicitly referenced by the user. Resolve relative paths from the workspace root.";
  const input = { messages: [
    { role: "developer", content: `Before. ${pathText} After.` },
    { role: "system", content: [{ type: "text", text: pathText }] },
    { role: "assistant", content: pathText },
    { role: "user", content: pathText },
    { role: "tool", content: pathText },
  ] };
  const result = rewriteRequest(input, settings([], true), CHAT);
  assert.equal(result.payload.messages[0].content, `Before. ${replacement} After.`);
  assert.equal(result.payload.messages[1].content[0].text, replacement);
  assert.deepEqual(result.payload.messages.slice(2), input.messages.slice(2));
  assert.equal(result.rules[1].count, 2);
  assert.deepEqual(rewriteRequest(input, settings([], false), CHAT).payload, input);
});

test("New API-style operations execute in order with role and numeric conditions", () => {
  const input = {
    max_completion_tokens: 123, store: false,
    messages: [{ role: "developer", content: "DEEPSEEK HARNESS and DeepSeek Harness" }],
  };
  const operations = [
    { mode: "copy", from: "max_completion_tokens", to: "max_tokens", conditions: [
      { path: "max_completion_tokens", mode: "regex", value: "^[0-9]+$" },
    ] },
    { mode: "delete", path: "max_completion_tokens" },
    { mode: "delete", path: "store" },
    { mode: "set", path: "messages.0.role", value: "system", conditions: [
      { path: "messages.0.role", mode: "full", value: "developer" },
    ] },
    { mode: "regex_replace", path: "messages.0.content", from: "(?i)DeepSeek Harness", to: "coding assistant", conditions: [
      { path: "messages.0.role", mode: "regex", value: "^(system|developer)$" },
    ] },
  ];
  const result = rewriteRequest(input, settings(operations), CHAT);
  assert.deepEqual(result.payload, {
    max_tokens: 123, messages: [{ role: "system", content: "coding assistant and coding assistant" }],
  });
  assert.deepEqual(result.rules.slice(3).map((rule) => rule.outcome), Array(5).fill("applied"));
  assert.equal(result.rules.at(-1).count, 2);
  assert.equal(input.messages[0].role, "developer");
});

test("long DSH system and assistant messages are rewritten completely", () => {
  const padding = "x".repeat(70 * 1024);
  const identity = "You are an AI agent powered by DeepSeek Harness.";
  const input = { messages: [
    { role: "developer", content: `${padding}\n${identity} DeepSeek Harness` },
    { role: "assistant", content: `${padding}\n${identity} ${padding}` },
    { role: "user", content: `${padding}\n${identity}` },
  ] };
  const result = rewriteRequest(input, settings([], true), CHAT);
  assert.equal(result.payload.messages[0].content, `${padding}\nYou are an AI assistant. AI assistant`);
  assert.equal(result.payload.messages[1].content, `${padding}\nYou are an AI assistant. ${padding}`);
  assert.equal(result.payload.messages[2].content, input.messages[2].content);
  assert.deepEqual(result.rules.map((rule) => rule.outcome), ["applied", "applied", "applied"]);
  assert.equal(input.messages[0].role, "developer");
});

test("deeply nested JSON can be forwarded and copied without structured clone overflow", () => {
  const text = `${"[".repeat(3000)}0${"]".repeat(3000)}`;
  const nested = JSON.parse(text);
  const input = { nested, duplicate: JSON.parse(text), minusZero: -0,
    data: JSON.parse('{"__proto__":{"safe":true}}') };
  const unchanged = rewriteRequest(input, settings(), CHAT);
  assert.equal(JSON.stringify(unchanged.payload), JSON.stringify(input));
  assert.notEqual(unchanged.payload.nested, input.nested);
  assert.ok(Object.is(unchanged.payload.minusZero, -0));
  assert.equal(Object.getPrototypeOf(unchanged.payload.data), Object.prototype);
  assert.equal(unchanged.payload.data.__proto__.safe, true);
  assert.equal({}.safe, undefined);

  const copied = rewriteRequest(input, settings([
    { mode: "copy", from: "nested", to: "duplicate" },
  ]), CHAT);
  assert.equal(copied.rules[3].outcome, "applied");
  assert.equal(copied.rules[3].changed, false);
  assert.equal(JSON.stringify(copied.payload.duplicate), JSON.stringify(nested));
  assert.notEqual(copied.payload.duplicate, copied.payload.nested);
});

test("coding identity with no period is replaced without consuming later text", () => {
  const input = { messages: [{ role: "developer", content:
    "DeepSeek Harness. You are a coding agent powered by the deepseek-v4.1 model and keep this text." }] };
  const result = rewriteRequest(input, settings([], true), CHAT);
  assert.equal(result.payload.messages[0].content,
    "AI assistant. You are a coding assistant. and keep this text.");
});

test("conditions default to OR like New API, while explicit AND requires both", () => {
  const conditions = [
    { path: "messages.0.role", mode: "full", value: "system" },
    { path: "messages.0.role", mode: "full", value: "developer" },
  ];
  const operations = [
    { mode: "set", path: "temperature", value: 0.2, conditions },
    { mode: "set", path: "top_p", value: 0.8, conditions, logic: "AND" },
  ];
  // The same JSON object cannot contain shared references after deserialization.
  const result = rewriteRequest({ messages: [{ role: "system" }] }, settings(structuredClone(JSON.parse(JSON.stringify(operations)))), CHAT);
  assert.equal(result.payload.temperature, 0.2);
  assert.equal(result.payload.top_p, undefined);
  assert.equal(result.rules[3].outcome, "applied");
  assert.equal(result.rules[4].outcome, "unmatched");
});

test("temperature description and optional repeated group are accepted without logging values", () => {
  const operations = [
    { mode: "set", path: "temperature", value: 0.6, description: "sensitive-description-marker" },
    { mode: "regex_replace", path: "messages.0.content",
      from: "(?i)(DeepSeek|Harness)(?:-[a-z0-9._-]+ model)?", to: "assistant",
      conditions: [{ path: "messages.0.role", mode: "regex", value: "^(system|developer)$" }] },
  ];
  const normalized = validateRequestOverrides({ operations });
  assert.equal(normalized.operations[0].description, "sensitive-description-marker");
  const result = rewriteRequest({ messages: [{ role: "system", content: "DeepSeek-v4.1 model and HARNESS" }] },
    { dshCompat: false, requestOverrides: normalized }, CHAT);
  assert.equal(result.payload.temperature, 0.6);
  assert.equal(result.payload.messages[0].content, "assistant and assistant");
  assert.equal(result.rules[4].count, 2);
  assert.ok(!JSON.stringify(result.rules).includes("sensitive-description-marker"));
  assert.throws(() => validateRequestOverrides({ operations: [{ ...operations[0], description: "x".repeat(513) }] }),
    /Invalid override operation/);
});

test("regex results distinguish unchanged matches, no match, captures and global mode", () => {
  const input = { messages: [{ role: "system", content: "alpha ALPHA" }] };
  const operations = [
    { mode: "regex_replace", path: "messages.0.content", from: "alpha", to: "alpha" },
    { mode: "regex_replace", path: "messages.0.content", from: "missing", to: "private-value" },
    { mode: "regex_replace", path: "messages.0.content", from: "(?i)(alpha)", to: "<${1}>", global: false },
  ];
  const result = rewriteRequest(input, settings(operations), CHAT);
  assert.equal(result.payload.messages[0].content, "<alpha> ALPHA");
  assert.deepEqual(result.rules.slice(3).map(({ outcome, count, changed }) => ({ outcome, count, changed })), [
    { outcome: "applied", count: 1, changed: false },
    { outcome: "unmatched", count: 0, changed: false },
    { outcome: "applied", count: 1, changed: true },
  ]);
  assert.ok(!JSON.stringify(result.rules).includes("private-value"));
});

test("missing, incompatible and oversized inputs are skipped without partial mutations", () => {
  const long = "\u00e9".repeat(32769);
  const input = { messages: [{ role: "system", content: long }], nested: null, items: ["one", "two"] };
  const operations = [
    { mode: "regex_replace", path: "messages.0.content", from: "x", to: "y" },
    { mode: "regex_replace", path: "items", from: "x", to: "y" },
    { mode: "delete", path: "missing" },
    { mode: "copy", from: "missing", to: "test" },
    { mode: "set", path: "nested.value", value: 1 },
    { mode: "set", path: "new.1.value", value: 1 },
    { mode: "set", path: "items.4", value: "no holes" },
    { mode: "set", path: "temperature", value: 0.5, conditions: [
      { path: "messages.0.content", mode: "regex", value: "x" },
    ] },
  ];
  const result = rewriteRequest(input, settings(operations), CHAT);
  assert.deepEqual(result.payload, input);
  assert.deepEqual(result.rules.slice(3).map((rule) => rule.outcome), Array(8).fill("skipped"));
  for (const payload of [null, false, 12, "not an object", []]) {
    const rewritten = rewriteRequest(payload, settings([{ mode: "set", path: "temperature", value: 1 }]), CHAT);
    assert.equal(rewritten.rules[3].outcome, "skipped");
  }
});

test("copy clones values, set creates paths, array delete shifts, and keep_origin skips", () => {
  const input = { source: { child: ["one", "two"] }, messages: [{ role: "user" }, { role: "assistant" }] };
  const operations = [
    { mode: "copy", from: "source", to: "metadata.backup" },
    { mode: "set", path: "source.child.0", value: "changed" },
    { mode: "delete", path: "messages.0" },
    { mode: "set", path: "metadata.backup.child.0", value: "ignored", keep_origin: true },
    { mode: "set", path: "metadata.added.0.text", value: "created" },
  ];
  const result = rewriteRequest(input, settings(operations), CHAT);
  assert.deepEqual(result.payload.metadata, { backup: { child: ["one", "two"] }, added: [{ text: "created" }] });
  assert.deepEqual(result.payload.messages, [{ role: "assistant" }]);
  assert.deepEqual(result.payload.source.child, ["changed", "two"]);
  assert.equal(result.rules[6].outcome, "skipped");
  assert.deepEqual(input.source.child, ["one", "two"]);
});

test("untrusted regexes time out and expanding replacements are bounded", () => {
  const input = { text: "a".repeat(5000) };
  const operations = [
    { mode: "regex_replace", path: "text", from: "a+a+a+a+a+b", to: "x" },
    { mode: "regex_replace", path: "text", from: "a", to: "z".repeat(20) },
  ];
  const result = rewriteRequest(input, settings(operations), CHAT);
  assert.deepEqual(result.payload, input);
  assert.deepEqual(result.rules.slice(3).map((rule) => rule.outcome), ["skipped", "skipped"]);
});

test("copy operations cannot amplify a request beyond the workspace size limit", () => {
  const input = { metadata: { text: "a".repeat(64 * 1024) } };
  const operations = Array.from({ length: 12 }, (_, index) => ({
    mode: "copy", from: "metadata", to: `metadata.copy${index}`,
  }));
  const result = rewriteRequest(input, settings(operations), CHAT);
  assert.ok(Buffer.byteLength(JSON.stringify(result.payload)) <= 4 * 1024 * 1024);
  assert.ok(result.rules.slice(3).some((rule) => rule.outcome === "skipped"));
  assert.deepEqual(input, { metadata: { text: "a".repeat(64 * 1024) } });
});

test("all custom regexes share a per-request time budget", () => {
  const operations = [
    ...Array.from({ length: 12 }, () => ({ mode: "regex_replace", path: "text", from: "a+a+a+a+a+b", to: "x" })),
    { mode: "regex_replace", path: "safe", from: "safe", to: "changed" },
    { mode: "set", path: "nonRegex", value: true },
  ];
  const result = rewriteRequest({ text: "a".repeat(5000), safe: "safe" }, settings(operations), CHAT);
  assert.equal(result.payload.safe, "safe");
  assert.equal(result.rules.at(-2).outcome, "skipped");
  assert.equal(result.payload.nonRegex, true);
  assert.equal(result.rules.at(-1).outcome, "applied");
});

test("invalid configuration, unsafe paths, and all custom model writes are rejected", () => {
  const invalid = [
    null, {}, [], { operations: null }, { operations: [], unsupported: true },
    { operations: [{ mode: "set", path: "x" }] },
    { operations: [{ mode: "set", path: "x", value: undefined }] },
    { operations: [{ mode: "set", path: "x", value: NaN }] },
    { operations: [{ mode: "set", path: "x", value: true, extra: true }] },
    { operations: [{ mode: "replace", path: "x", from: "a", to: "b" }] },
    { operations: [{ mode: "set", path: "__proto__.polluted", value: true }] },
    { operations: [{ mode: "set", path: "x.constructor.prototype.polluted", value: true }] },
    { operations: [{ mode: "set", path: "messages.*.role", value: "system" }] },
    { operations: [{ mode: "set", path: "messages.1024.role", value: "system" }] },
    { operations: [{ mode: "set", path: "model", value: "test-model" }] },
    { operations: [{ mode: "set", path: "model.name", value: "test-model" }] },
    { operations: [{ mode: "copy", from: "temperature", to: "model" }] },
    { operations: [{ mode: "delete", path: "model" }] },
    { operations: [{ mode: "regex_replace", path: "model", from: "x", to: "y" }] },
    { operations: [{ mode: "regex_replace", path: "text", from: "(", to: "secret-pattern" }] },
    { operations: [{ mode: "regex_replace", path: "text", from: "(a+)+", to: "x" }] },
    { operations: [{ mode: "regex_replace", path: "text", from: "(a|aa)+", to: "x" }] },
    { operations: [{ mode: "regex_replace", path: "text", from: "(?i)a(?i)b", to: "x" }] },
    { operations: [{ mode: "regex_replace", path: "text", from: "a", to: "x", global: "yes" }] },
    { operations: [{ mode: "set", path: "x", value: 1, logic: "XOR" }] },
    { operations: [{ mode: "set", path: "x", value: 1, conditions: [{ path: "x", mode: "contains", value: "x" }] }] },
  ];
  for (const value of invalid) {
    assert.throws(() => validateRequestOverrides(value), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("secret-pattern"));
      return true;
    });
  }
  assert.equal({}.polluted, undefined);
  const cycle = { operations: [] };
  cycle.operations.push(cycle);
  assert.throws(() => validateRequestOverrides(cycle));
});

test("headers are exactly allowlisted, normalized and do not leak in errors", () => {
  const accepted = {
    "User-Agent": "agent/1", Accept: "application/json", "X-Product-Code": "product",
    "X-Ide-Name": "IDE", "X-Ide-Type": "desktop", "X-Ide-Version": "1.0",
    "X-Agent-Intent": "code", "X-Agent-Type": "interactive",
  };
  assert.deepEqual(validateUpstreamHeaders(accepted), Object.fromEntries(
    Object.entries(accepted).map(([name, value]) => [name.toLowerCase(), value]),
  ));
  for (const headers of [
    null, [], { authorization: "private-secret" }, { "content-type": "application/json" },
    { connection: "keep-alive" }, { "x-cnb2api-upstream-headers": "private-secret" },
    { accept: "a\r\nAuthorization: private-secret" }, { accept: "non-ascii-\u00e9" },
    { accept: "x".repeat(513) }, { accept: 1 }, { Accept: "a", accept: "b" },
  ]) {
    assert.throws(() => validateUpstreamHeaders(headers), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes("private-secret"));
      return true;
    });
  }
  assert.equal(validateUpstreamHeaders({ accept: "x".repeat(512) }).accept.length, 512);
});

test("rule diagnostics are bounded and hide arbitrary path parts, names and values", () => {
  const operations = Array.from({ length: 61 }, (_, index) => ({
    mode: "set", path: `metadata.private_path_${index}`, value: "private-value",
    description: "private-description",
  }));
  const config = validateRequestOverrides({ operations });
  const result = rewriteRequest({}, { dshCompat: true, requestOverrides: config }, CHAT);
  assert.equal(result.rules.length, 64);
  assert.equal(result.rules[3].path, "metadata.*");
  assert.ok(!/private_path_|private-value|private-description/.test(JSON.stringify(result.rules)));
  assert.throws(() => validateRequestOverrides({ operations: [...operations, {
    mode: "set", path: "extra", value: true,
  }] }));
  assert.deepEqual(rewriteRequest({}, { requestOverrides: null }, CHAT).rules.at(-1), {
    name: "invalid_overrides", mode: "invalid", path: "", outcome: "skipped",
  });
});
