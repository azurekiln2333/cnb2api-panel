# Session routing

`sessionAffinity` defaults to true. Merge `DEFAULT_SETTINGS` into saved settings
when loading older state, and validate the flag as a boolean on writes.

`session-affinity.mjs` derives a SHA-256 key from model and an explicit session ID.
Headers take precedence over metadata. Only structured session IDs inside
`metadata.user_id` count; an opaque user identity must not pin all conversations.
The fallback hashes the full system prefix and first user message, including
media. Do not use the bounded log preview or the entire growing history. Identical
initial prompts can share a fallback key; explicit IDs avoid this ambiguity.

Each Pool keeps at most 10,000 in-memory bindings with a sliding one-hour idle TTL
and LRU eviction. Never persist raw session IDs or prompts in this map. Bind before
the first network await so concurrent requests in a new session share an account.

Check eligibility and highest available priority before reusing a binding. New
sessions use the existing weighted, least-connections, or failover selection.
Retryable failures invalidate only the failed binding, then rebind on retry. A
recovered same-priority account does not reclaim an existing binding; a recovered
higher-priority tier does. Never replay a response after headers have been sent.

Tests must distinguish independent sessions from subsequent turns. Cover weighted
distribution, concurrency, failover, eligibility changes, disabling affinity,
settings migration, bounded storage, expiry, preserved payload fields and streaming.

For `/v1/chat/completions`, merge `stream_options.include_usage: true` into the
forwarded body while retaining other options and all generation fields. CNB
workers force upstream streaming even for non-streaming clients, so request
usage in both modes. Other routes keep the original body. Derive affinity from
the original payload, and keep response bytes transparent. Never recover local
usage by subtracting workspace snapshots; concurrent/direct traffic is ambiguous.
