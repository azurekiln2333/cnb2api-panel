import { isDeepStrictEqual } from "node:util";
import { Script } from "node:vm";
import { performance } from "node:perf_hooks";

// Three preset entries are reserved within the diagnostic budget.
const MAX_OPERATIONS = 64;
const MAX_CUSTOM_OPERATIONS = MAX_OPERATIONS - 3;
const MAX_CONDITIONS = 16;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_REGEX_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_ARRAY_INDEX = 1023;
const REGEX_TIMEOUT_MS = 50;
const REGEX_BUDGET_MS = 100;

const HEADER_NAMES = new Set([
  "user-agent", "accept", "x-product-code", "x-ide-name", "x-ide-type",
  "x-ide-version", "x-agent-intent", "x-agent-type",
]);
const DIAGNOSTIC_FIELDS = new Set([
  "model", "messages", "role", "content", "text", "type", "system", "input",
  "stream", "stream_options", "include_usage", "temperature", "top_p",
  "max_tokens", "max_completion_tokens", "tools", "tool_choice", "metadata",
  "reasoning_effort", "store", "response_format", "parallel_tool_calls", "stop",
  "seed", "n", "user",
]);
const IDENTITY = "\\bYou are an AI agent powered by DeepSeek Harness\\.?(?![\\w-])";
const CODING_IDENTITY = "\\bYou are a coding agent powered by the [^\\r\\n]{1,200}? model\\.?(?![\\w-])";
const ASSISTANT_CODING_IDENTITY = "\\bYou are a coding agent powered by the (?:cn-)?deepseek-[a-z0-9._-]{1,120} model\\.?(?![\\w-])";
const BRAND = "DeepSeek Harness";
const DSH_PATH_FINGERPRINT = "Tokens prefixed with @ are paths the user explicitly referenced. Relative paths resolve from the workspace root";
const DSH_PATH_REPLACEMENT = "Treat tokens beginning with @ as paths explicitly referenced by the user. Resolve relative paths from the workspace root";

const regexTest = new Script("new RegExp(pattern, flags).test(input)");
const regexReplace = new Script(`
  (() => {
    const regex = new RegExp(pattern, flags);
    const pieces = [];
    let end = 0, count = 0, size = 0, match;
    const add = (part) => {
      size += part.length;
      if (size > limit) throw new Error("output limit");
      pieces.push(part);
    };
    while ((match = regex.exec(input)) !== null) {
      add(input.slice(end, match.index));
      add(replacement.replace(/\\$(\\$|[A-Za-z0-9_]+|\\{[A-Za-z0-9_]+\\})/g, (_, token) => {
        if (token === "$") return "$";
        const name = token[0] === "{" ? token.slice(1, -1) : token;
        if (/^\\d+$/.test(name)) return match[Number(name)] || "";
        return match.groups?.[name] || "";
      }));
      end = match.index + match[0].length;
      count++;
      if (!regex.global) break;
      if (match[0].length === 0) {
        if (regex.lastIndex >= input.length) break;
        regex.lastIndex++;
      }
    }
    add(input.slice(end));
    const value = pieces.join("");
    return { value, count, changed: value !== input };
  })()
`);

function fail(message) { throw new Error(message); }

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function keysOnly(value, allowed) {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    fail("Invalid override configuration");
}

function boundedJson(value) {
  const stack = [{ value, depth: 0 }];
  const seen = new Set();
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    const item = current.value;
    if (++nodes > 8192 || current.depth > 24) fail("Override configuration is too large");
    if (item === null || typeof item === "boolean") continue;
    if (typeof item === "number" && Number.isFinite(item)) continue;
    if (typeof item === "string") {
      if (Buffer.byteLength(item) > MAX_CONFIG_BYTES) fail("Override configuration is too large");
      continue;
    }
    if ((!Array.isArray(item) && !record(item)) || seen.has(item))
      fail("Invalid override configuration");
    seen.add(item);
    for (const key of Object.keys(item)) {
      if (Array.isArray(item) && !/^(0|[1-9]\d*)$/.test(key)) fail("Invalid override configuration");
      stack.push({ value: item[key], depth: current.depth + 1 });
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length) fail("Invalid override configuration");
  }
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { fail("Invalid override configuration"); }
  if (Buffer.byteLength(serialized) > MAX_CONFIG_BYTES) fail("Override configuration is too large");
  return JSON.parse(serialized);
}

function pathParts(value) {
  if (typeof value !== "string" || !value || value.length > 256) fail("Invalid override path");
  const parts = value.split(".");
  if (parts.length > 16 || parts.some((part) =>
    !/^(?:[A-Za-z_$][A-Za-z0-9_$-]*|0|[1-9]\d*)$/.test(part) ||
    ["__proto__", "prototype", "constructor"].includes(part) ||
    (/^\d+$/.test(part) && Number(part) > MAX_ARRAY_INDEX)))
    fail("Invalid override path");
  return parts;
}

function writePath(value) {
  const parts = pathParts(value);
  if (parts[0] === "model") fail("Custom model mutations are not supported");
  return value;
}

function regexParts(pattern, allowEmpty = false) {
  if (typeof pattern !== "string" || pattern.length > 256 || /[\x00-\x1f\x7f]/.test(pattern))
    fail("Invalid override regex");
  const insensitive = pattern.startsWith("(?i)");
  const source = insensitive ? pattern.slice(4) : pattern;
  if (!allowEmpty && !source) fail("Invalid override regex");
  // Reject common exponential constructs; a VM timeout bounds other patterns.
  const groups = [{ repeat: false, alternate: false }];
  let inClass = false;
  let atom = null;
  let quantified = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "\\") {
      const next = source[++i];
      if (next === undefined || (!inClass && (/[1-9]/.test(next) || next === "k")))
        fail("Unsupported override regex");
      if (!inClass) { atom = {}; quantified = false; }
      continue;
    }
    if (inClass) {
      if (char === "]") { inClass = false; atom = {}; quantified = false; }
      continue;
    }
    if (char === "[") { inClass = true; continue; }
    if (char === "(") {
      if (source[i + 1] === "?") {
        if (source[i + 2] !== ":") fail("Unsupported override regex");
        i += 2;
      }
      groups.push({ repeat: false, alternate: false });
      atom = null;
      quantified = false;
      continue;
    }
    if (char === ")") {
      if (groups.length === 1) fail("Invalid override regex");
      atom = groups.pop();
      groups.at(-1).repeat ||= atom.repeat;
      groups.at(-1).alternate ||= atom.alternate;
      quantified = false;
      continue;
    }
    if (char === "|") { groups.at(-1).alternate = true; atom = null; quantified = false; continue; }
    if (char === "*" || char === "+" || char === "?" || char === "{") {
      if (char === "?" && quantified) { quantified = false; continue; }
      if (!atom || quantified || (char !== "?" && (atom.repeat || atom.alternate)))
        fail("Unsupported override regex");
      if (char === "{") {
        const range = source.slice(i).match(/^\{(\d{1,3})(?:,(\d{0,3}))?\}/);
        if (!range || Number(range[1]) > 128 || (range[2] && Number(range[2]) > 128))
          fail("Unsupported override regex");
        i += range[0].length - 1;
      }
      groups.at(-1).repeat = true;
      quantified = true;
      continue;
    }
    atom = char === "^" || char === "$" ? null : {};
    quantified = false;
  }
  if (inClass || groups.length !== 1) fail("Invalid override regex");
  try { new RegExp(source, insensitive ? "i" : ""); }
  catch { fail("Invalid override regex"); }
  return { pattern: source, flags: insensitive ? "i" : "" };
}

function normalizeCondition(input) {
  keysOnly(input, ["path", "mode", "value", "invert", "pass_missing_key"]);
  pathParts(input.path);
  if (!Object.hasOwn(input, "value") || typeof input.mode !== "string") fail("Invalid override condition");
  const mode = input.mode.toLowerCase();
  if (!["full", "prefix", "regex"].includes(mode)) fail("Unsupported override condition");
  if ((mode === "prefix" || mode === "regex") && typeof input.value !== "string")
    fail("Invalid override condition");
  if (mode === "regex") regexParts(input.value, true);
  for (const key of ["invert", "pass_missing_key"])
    if (Object.hasOwn(input, key) && typeof input[key] !== "boolean") fail("Invalid override condition");
  return {
    path: input.path, mode, value: input.value,
    ...(Object.hasOwn(input, "invert") ? { invert: input.invert } : {}),
    ...(Object.hasOwn(input, "pass_missing_key") ? { pass_missing_key: input.pass_missing_key } : {}),
  };
}

function normalizeOperation(input) {
  if (!record(input) || !["set", "copy", "delete", "regex_replace"].includes(input.mode))
    fail("Unsupported override operation");
  const common = ["mode", "conditions", "logic", "description"];
  const fields = {
    set: ["path", "value", "keep_origin"], copy: ["from", "to"],
    delete: ["path"], regex_replace: ["path", "from", "to", "global"],
  };
  keysOnly(input, [...common, ...fields[input.mode]]);
  const operation = { mode: input.mode };
  if (Object.hasOwn(input, "description")) {
    if (typeof input.description !== "string" || Buffer.byteLength(input.description) > 512)
      fail("Invalid override operation");
    operation.description = input.description;
  }
  if (input.mode === "copy") {
    pathParts(input.from);
    operation.from = input.from;
    operation.to = writePath(input.to);
  } else operation.path = writePath(input.path);
  if (input.mode === "set") {
    if (!Object.hasOwn(input, "value")) fail("Invalid override operation");
    operation.value = input.value;
    if (Object.hasOwn(input, "keep_origin")) {
      if (typeof input.keep_origin !== "boolean") fail("Invalid override operation");
      operation.keep_origin = input.keep_origin;
    }
  }
  if (input.mode === "regex_replace") {
    regexParts(input.from);
    if (typeof input.to !== "string" || input.to.length > 2048 ||
        (Object.hasOwn(input, "global") && typeof input.global !== "boolean"))
      fail("Invalid override operation");
    operation.from = input.from;
    operation.to = input.to;
    if (Object.hasOwn(input, "global")) operation.global = input.global;
  }
  if (Object.hasOwn(input, "conditions")) {
    if (!Array.isArray(input.conditions) || input.conditions.length > MAX_CONDITIONS)
      fail("Invalid override conditions");
    operation.conditions = input.conditions.map(normalizeCondition);
  }
  if (Object.hasOwn(input, "logic")) {
    if (typeof input.logic !== "string" || !["AND", "OR"].includes(input.logic.toUpperCase()))
      fail("Invalid override condition logic");
    operation.logic = input.logic.toUpperCase();
  }
  return operation;
}

export function validateRequestOverrides(value) {
  const input = boundedJson(value);
  keysOnly(input, ["operations"]);
  if (!Array.isArray(input.operations) || input.operations.length > MAX_CUSTOM_OPERATIONS)
    fail("Invalid override operations");
  return { operations: input.operations.map(normalizeOperation) };
}

export function validateUpstreamHeaders(value) {
  if (!record(value)) fail("Invalid upstream headers");
  const entries = Object.entries(value);
  if (entries.length > HEADER_NAMES.size) fail("Invalid upstream headers");
  const headers = {};
  for (const [name, content] of entries) {
    const normalized = name.toLowerCase();
    if (!HEADER_NAMES.has(normalized) || Object.hasOwn(headers, normalized) ||
        typeof content !== "string" || content.length > 512 || !/^[\x20-\x7e]*$/.test(content))
      fail("Invalid upstream headers");
    headers[normalized] = content;
  }
  return headers;
}

function diagnosticPath(path) {
  return path.split(".").map((part) =>
    DIAGNOSTIC_FIELDS.has(part) || /^\d+$/.test(part) ? part : "*",
  ).join(".");
}

function cloneRequestValue(value) {
  try { return structuredClone(value); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Request values come from JSON; clone them iteratively when V8's
    // structured clone exceeds its lower nesting limit.
    const clone = Array.isArray(value) ? [] : {};
    const pending = [[value, clone]];
    while (pending.length) {
      const [source, target] = pending.pop();
      for (const key of Object.keys(source)) {
        const item = source[key];
        const child = item !== null && typeof item === "object"
          ? Array.isArray(item) ? [] : {}
          : item;
        if (key === "__proto__")
          Object.defineProperty(target, key, { value: child, enumerable: true, configurable: true, writable: true });
        else target[key] = child;
        if (child !== item) pending.push([item, child]);
      }
    }
    return clone;
  }
}

function equalRequestValues(left, right) {
  try { return isDeepStrictEqual(left, right); }
  catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const pending = [[left, right]];
    while (pending.length) {
      const [a, b] = pending.pop();
      if (Object.is(a, b)) continue;
      if (a === null || b === null || typeof a !== "object" || typeof b !== "object" ||
          Array.isArray(a) !== Array.isArray(b)) return false;
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (const key of keys) {
        if (!Object.hasOwn(b, key)) return false;
        pending.push([a[key], b[key]]);
      }
    }
    return true;
  }
}

function getPath(root, path) {
  let value = root;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" ||
        (Array.isArray(value) && !/^(0|[1-9]\d*)$/.test(part)) ||
        !Object.hasOwn(value, part)) return { found: false };
    value = value[part];
  }
  return { found: true, value };
}

function setPath(root, path, value) {
  const parts = path.split(".");
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    if (node === null || typeof node !== "object") return false;
    const part = parts[i];
    if (Array.isArray(node) && (!/^(0|[1-9]\d*)$/.test(part) || Number(part) > node.length))
      return false;
    if (i < parts.length - 1)
      node = Object.hasOwn(node, part) ? node[part] : (/^\d+$/.test(parts[i + 1]) ? [] : {});
  }
  node = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!Object.hasOwn(node, part)) node[part] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
  return true;
}

function deletePath(root, path) {
  const parts = path.split(".");
  const key = parts.pop();
  const parent = parts.length ? getPath(root, parts.join(".")) : { found: true, value: root };
  if (!parent.found || parent.value === null || typeof parent.value !== "object" ||
      (Array.isArray(parent.value) && !/^(0|[1-9]\d*)$/.test(key)) ||
      !Object.hasOwn(parent.value, key)) return false;
  if (Array.isArray(parent.value)) parent.value.splice(Number(key), 1);
  else delete parent.value[key];
  return true;
}

function runRegex(script, context, budget) {
  if (budget.regexMs < 1) throw new Error("Regex budget exhausted");
  const started = performance.now();
  try {
    return script.runInNewContext(context, {
      timeout: Math.max(1, Math.min(REGEX_TIMEOUT_MS, Math.floor(budget.regexMs))),
    });
  } finally {
    budget.regexMs -= performance.now() - started;
  }
}

function canWrite(payload, path, current, value) {
  try {
    const nextBytes = Buffer.byteLength(JSON.stringify(value));
    const previousBytes = current.found ? Buffer.byteLength(JSON.stringify(current.value)) : 0;
    if (current.found && nextBytes <= previousBytes) return true;
    const overhead = current.found ? 0 : Buffer.byteLength(path) * 6 + 32;
    return Buffer.byteLength(JSON.stringify(payload)) - previousBytes + nextBytes + overhead <= MAX_REQUEST_BYTES;
  } catch {
    return false;
  }
}

function conditionResult(payload, condition, budget) {
  const current = getPath(payload, condition.path);
  if (!current.found) return condition.pass_missing_key ? "matched" : "unmatched";
  let result;
  if (condition.mode === "full") result = equalRequestValues(current.value, condition.value);
  else {
    if (!["string", "number", "boolean"].includes(typeof current.value)) return "skipped";
    const text = String(current.value);
    if (condition.mode === "prefix") result = text.startsWith(condition.value);
    else {
      if (Buffer.byteLength(text) > MAX_REGEX_BYTES) return "skipped";
      try {
        result = runRegex(regexTest, { ...regexParts(condition.value, true), input: text }, budget);
      } catch { return "skipped"; }
    }
  }
  return (condition.invert ? !result : result) ? "matched" : "unmatched";
}

function conditionsResult(payload, operation, budget) {
  if (!operation.conditions?.length) return "matched";
  const and = operation.logic === "AND";
  let skipped = false;
  for (const condition of operation.conditions) {
    const result = conditionResult(payload, condition, budget);
    if (and && result === "unmatched") return "unmatched";
    if (!and && result === "matched") return "matched";
    if (result === "skipped") skipped = true;
  }
  return skipped ? "skipped" : and ? "matched" : "unmatched";
}

function customRule(payload, operation, index, budget) {
  const target = operation.mode === "copy" ? operation.to : operation.path;
  const rule = { name: `override_${index + 1}`, mode: operation.mode, path: diagnosticPath(target) };
  const condition = conditionsResult(payload, operation, budget);
  if (condition !== "matched") return { ...rule, outcome: condition };
  const current = getPath(payload, target);
  if (operation.mode === "delete") {
    return deletePath(payload, target)
      ? { ...rule, outcome: "applied", count: 1, changed: true }
      : { ...rule, outcome: "skipped" };
  }
  if (operation.mode === "regex_replace") {
    if (!current.found || typeof current.value !== "string" || Buffer.byteLength(current.value) > MAX_REGEX_BYTES)
      return { ...rule, outcome: "skipped" };
    let replaced;
    try {
      const regex = regexParts(operation.from);
      replaced = runRegex(regexReplace, {
        ...regex, flags: regex.flags + (operation.global === false ? "" : "g"),
        input: current.value, replacement: operation.to, limit: MAX_REGEX_BYTES,
      }, budget);
    } catch { return { ...rule, outcome: "skipped" }; }
    if (Buffer.byteLength(replaced.value) > MAX_REGEX_BYTES) return { ...rule, outcome: "skipped" };
    if (!replaced.count) return { ...rule, outcome: "unmatched", count: 0, changed: false };
    if (!canWrite(payload, target, current, replaced.value)) return { ...rule, outcome: "skipped" };
    setPath(payload, target, replaced.value);
    return { ...rule, outcome: "applied", count: replaced.count, changed: replaced.changed };
  }
  if (operation.mode === "set" && operation.keep_origin && current.found)
    return { ...rule, outcome: "skipped" };
  const source = operation.mode === "copy" ? getPath(payload, operation.from) : { found: true, value: operation.value };
  if (!source.found) return { ...rule, outcome: "skipped" };
  if (!canWrite(payload, target, current, source.value)) return { ...rule, outcome: "skipped" };
  const changed = !current.found || !equalRequestValues(current.value, source.value);
  if (!setPath(payload, target, cloneRequestValue(source.value))) return { ...rule, outcome: "skipped" };
  return { ...rule, outcome: "applied", count: 1, changed };
}

function* textFields(message) {
  if (typeof message?.content === "string") yield [message, "content"];
  else if (Array.isArray(message?.content)) {
    for (const block of message.content)
      if ((block?.type === "text" || block?.type === "input_text") && typeof block.text === "string")
        yield [block, "text"];
  }
}

function presetRules(payload, enabled, path) {
  const rules = [
    { name: "dsh_roles", mode: "set", path: "messages.*.role" },
    { name: "dsh_privileged_text", mode: "regex_replace", path: "messages.*.content" },
    { name: "dsh_assistant_identity", mode: "regex_replace", path: "messages.*.content" },
  ];
  const skipped = () => rules.map((rule) => ({ ...rule, outcome: "skipped" }));
  if (!enabled || path !== "/v1/chat/completions" || !Array.isArray(payload?.messages)) return skipped();
  const messages = payload.messages;
  const brand = new RegExp(BRAND, "i");
  const identity = new RegExp(IDENTITY, "i");
  const codingIdentity = new RegExp(ASSISTANT_CODING_IDENTITY, "i");
  let identified = false;
  for (const message of messages) {
    const role = message?.role;
    if (!["system", "developer", "assistant"].includes(role)) continue;
    for (const [owner, key] of textFields(message)) {
      if (role === "assistant"
        ? identity.test(owner[key]) || codingIdentity.test(owner[key])
        : brand.test(owner[key]) || owner[key].includes(DSH_PATH_FINGERPRINT)) identified = true;
    }
  }
  const counts = [0, 0, 0];
  for (const message of messages) {
    const role = message?.role;
    if (!["system", "developer", "assistant"].includes(role)) continue;
    if (role === "developer") { message.role = "system"; counts[0]++; }
    if (!identified) continue;
    const category = role === "assistant" ? 2 : 1;
    for (const [owner, key] of textFields(message)) {
      const replace = (pattern, replacement) => {
        owner[key] = owner[key].replace(new RegExp(pattern, "gi"), () => {
          counts[category]++;
          return replacement;
        });
      };
      replace(IDENTITY, "You are an AI assistant.");
      if (category === 1) {
        replace(CODING_IDENTITY, "You are a coding assistant.");
        replace(BRAND, "AI assistant");
        owner[key] = owner[key].replaceAll(DSH_PATH_FINGERPRINT, () => {
          counts[category]++;
          return DSH_PATH_REPLACEMENT;
        });
      } else {
        replace(ASSISTANT_CODING_IDENTITY, "You are a coding assistant.");
      }
    }
  }
  return rules.map((rule, i) => ({
    ...rule,
    outcome: counts[i] ? "applied" : "unmatched",
    count: counts[i], changed: counts[i] > 0,
  }));
}

export function rewriteRequest(payload, settings, path) {
  const cloned = cloneRequestValue(payload);
  const rules = presetRules(cloned, settings?.dshCompat === true, path);
  if (settings?.requestOverrides === undefined) return { payload: cloned, rules };
  let overrides;
  try { overrides = validateRequestOverrides(settings.requestOverrides); }
  catch {
    return { payload: cloned, rules: [...rules, { name: "invalid_overrides", mode: "invalid", path: "", outcome: "skipped" }] };
  }
  const budget = { regexMs: REGEX_BUDGET_MS };
  for (const [index, operation] of overrides.operations.entries())
    rules.push(customRule(cloned, operation, index, budget));
  return { payload: cloned, rules };
}
