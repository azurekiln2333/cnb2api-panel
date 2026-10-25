import { createHash } from "node:crypto";

const sessionId = (value) =>
  typeof value === "string" && value.trim() && value.length <= 1024
    ? value.trim()
    : null;

function metadataSession(metadata) {
  const explicit =
    sessionId(metadata?.session_id) || sessionId(metadata?.conversation_id);
  if (explicit) return explicit;
  // A user identity alone is not a conversation. Only accept embedded session IDs.
  const user = metadata?.user_id;
  if (typeof user !== "string") return null;
  try {
    const parsed = JSON.parse(user);
    const id = sessionId(parsed?.session_id);
    if (id) return id;
  } catch {
    // Older clients append a session UUID to their user identity.
  }
  return (
    user.match(
      /_session_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i,
    )?.[1] || null
  );
}

export function sessionKey(headers, payload) {
  const id =
    sessionId(headers["x-session-id"]) ||
    sessionId(headers["x-conversation-id"]) ||
    metadataSession(payload.metadata);
  let identity;
  if (id) {
    identity = ["session", payload.model || "", id];
  } else {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const first = messages.findIndex((message) => message?.role === "user");
    if (first < 0 || messages[first].content == null) return null;
    identity = [
      "prefix",
      payload.model || "",
      payload.system ?? null,
      messages
        .slice(0, first)
        .filter(
          (message) =>
            message?.role === "system" || message?.role === "developer",
        ),
      messages[first].content,
    ];
  }
  // Hash full content, including media. Never retain prompts or client IDs here.
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export class SessionAffinity {
  constructor({
    now = Date.now,
    idleTtlMs = 3600000,
    maxEntries = 10000,
  } = {}) {
    this.now = now;
    this.idleTtlMs = idleTtlMs;
    this.maxEntries = maxEntries;
    this.bindings = new Map();
  }

  get(key) {
    if (!key) return null;
    const entry = this.bindings.get(key);
    if (!entry) return null;
    this.bindings.delete(key);
    if (this.now() - entry.lastUsed >= this.idleTtlMs) return null;
    entry.lastUsed = this.now();
    this.bindings.set(key, entry);
    return entry.accountId;
  }

  bind(key, accountId) {
    if (!key) return;
    const now = this.now();
    for (const [oldest, entry] of this.bindings) {
      if (now - entry.lastUsed < this.idleTtlMs) break;
      this.bindings.delete(oldest);
    }
    this.bindings.delete(key);
    this.bindings.set(key, { accountId, lastUsed: now });
    while (this.bindings.size > this.maxEntries)
      this.bindings.delete(this.bindings.keys().next().value);
  }

  forget(key, accountId) {
    if (!accountId || this.bindings.get(key)?.accountId === accountId)
      this.bindings.delete(key);
  }

  clear() {
    this.bindings.clear();
  }
}
