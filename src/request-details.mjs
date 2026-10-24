export const INITIAL_MESSAGE_LIMIT = 4000;

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
