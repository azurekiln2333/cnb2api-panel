export const INITIAL_MESSAGE_LIMIT = 4000;

const STRUCTURE_FIELDS = [
  "model", "messages", "system", "input", "stream", "stream_options",
  "temperature", "top_p", "max_tokens", "max_completion_tokens", "tools",
  "tool_choice", "reasoning_effort", "store", "metadata", "response_format",
  "parallel_tool_calls", "stop", "seed", "n", "user",
];
const MESSAGE_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);
const STRUCTURE_MESSAGE_LIMIT = 64;

// Do not record untrusted keys, role names, or message and tool contents.
export function requestShape(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const selected = messages.length <= STRUCTURE_MESSAGE_LIMIT
    ? messages.map((message, index) => ({ message, index }))
    : [
        ...messages.slice(0, STRUCTURE_MESSAGE_LIMIT / 2).map((message, index) => ({ message, index })),
        ...messages.slice(-STRUCTURE_MESSAGE_LIMIT / 2).map((message, index) => ({
          message, index: messages.length - STRUCTURE_MESSAGE_LIMIT / 2 + index,
        })),
      ];
  return {
    fields: STRUCTURE_FIELDS.filter((field) => Object.hasOwn(payload, field)),
    messageCount: messages.length,
    messages: selected.map(({ message, index }) => {
      const content = message?.content;
      return {
        index,
        role: MESSAGE_ROLES.has(message?.role) ? message.role : "other",
        contentType: typeof content === "string" ? "text" : Array.isArray(content) ? "blocks" : content === null ? "null" : content === undefined ? "missing" : "other",
        length: typeof content === "string" || Array.isArray(content) ? content.length : null,
      };
    }),
    truncated: messages.length > STRUCTURE_MESSAGE_LIMIT,
  };
}

const placeholders = new Map([
  ["image", "[图片]"],
  ["image_url", "[图片]"],
  ["input_image", "[图片]"],
  ["audio", "[音频]"],
  ["input_audio", "[音频]"],
  ["document", "[文件]"],
  ["file", "[文件]"],
  ["input_file", "[文件]"],
  ["tool_result", "[工具内容]"],
  ["tool_use", "[工具内容]"],
]);

function* contentParts(content) {
  if (typeof content === "string") {
    yield content;
    return;
  }
  if (!Array.isArray(content)) {
    yield "[非文本内容]";
    return;
  }
  for (const part of content) {
    if (
      (part?.type === "text" || part?.type === "input_text") &&
      typeof part.text === "string"
    )
      yield part.text;
    else yield placeholders.get(part?.type) || "[非文本内容]";
  }
}

// Retain only the first user's visible content, never nested media payloads or
// tool results. Count Unicode characters so truncation cannot split an emoji.
export function initialUserMessage(payload) {
  if (!Array.isArray(payload.messages)) return undefined;
  const message = payload.messages.find((entry) => entry?.role === "user");
  if (!message) return undefined;
  let text = "";
  let length = 0;
  let truncated = false;
  let firstPart = true;
  outer: for (const part of contentParts(message.content)) {
    const value = `${firstPart ? "" : "\n"}${part}`;
    firstPart = false;
    for (const character of value) {
      if (length === INITIAL_MESSAGE_LIMIT) {
        truncated = true;
        break outer;
      }
      text += character;
      length++;
    }
  }
  return { role: "user", text, truncated };
}
