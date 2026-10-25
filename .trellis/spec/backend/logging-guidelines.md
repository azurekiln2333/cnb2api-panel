# Logging Guidelines

`Store.record()` routes events through `logChannel()` in `src/file-storage.mjs`.
Keep three independent streams under the data directory:

| Stream | File | Event kinds | Management endpoint |
| --- | --- | --- | --- |
| API requests | `requests.log` | `request` | `/api/logs/requests` |
| Management audit | `audit.log` | `audit`, legacy `account` | `/api/logs/audit` |
| Runtime events | `system.log` | `register`, `health`, `wake`, `failover` | `/api/logs/system` |

Each file contains one JSON object per line in chronological order. Each stream
retains its latest 1,000 records in memory and in the console. Ordinary writes
append to the matching file. After 2,000 records, the next write compacts that
file to the latest 1,000. Other streams remain unchanged.

All log endpoints require an authenticated management session. `/api/logs` is an
alias for requests only. The console provides separate request, audit and system
navigation entries. Never put event arrays in `panel.json` or `accounts.json`.
Request counters and Token totals belong in `stats.json` and survive log cleanup.

## Management audit

`auditRequest()` in `src/audit.mjs` records the final HTTP outcome on response
finish or close, exactly once. Cover login/logout, SSO login/configuration,
routing settings, account changes, credential/key reveals, registration-token
rotation and manual probe/quota/wake/usage operations. Automatic worker results
remain runtime events, even when a manual management action triggered them.

Record the stable action name, actor name/provider/optional OIDC subject, target,
socket source IP, method, path and status. Include failures and disconnected
operations. Do not trust forwarded IP headers without an explicit proxy policy.
Never copy request bodies, headers, query strings, keys, tokens, OIDC codes or raw
exception messages into an audit record. Use static operation descriptions.

## Request records

`Pool.forward()` records one request event in `finally`, including the final account, status, request ID, model, path, attempt count and total duration. Existing records may omit newly added optional fields.

- `method` and `stream` describe the accepted request.
- `requestBytes` counts the UTF-8 JSON forwarded to each upstream attempt.
- `responseBytes` counts upstream body bytes written to the client.
- `firstByteMs` measures request start to the first forwarded body chunk. It is `null` if no upstream body was forwarded.
- `upstreamEndpoint` identifies the last selected workspace without authentication headers.
- `tokenUsage` keeps the existing reported/missing/partial accounting semantics.

## Initial user message

`initialUserMessage()` in `src/request-details.mjs` selects the first message whose role is `user`. It supports text strings and OpenAI/Anthropic text blocks. The result contains `role`, `text` and `truncated` and is limited to 4,000 Unicode code points.

Use media-type placeholders for image, audio, file and tool-result blocks. Do not retain media URLs, base64 data, system messages, assistant history, later user messages, tool bodies, credentials, or response bodies. Request failure descriptions must not include raw upstream error bodies.

Initial message previews are stored in plaintext with event metadata, as documented in the README. Historical records have no preview and must remain readable. The frontend renders previews as escaped text and labels missing or truncated data.

## Verification

Cover text formats, Unicode truncation, media omission, unchanged upstream forwarding, streaming byte counts, empty responses, failure descriptions and persisted legacy records. Browser checks cover preview search, details, copying and mobile wrapping.

Storage tests must prove category separation, independent retention, unchanged
account/configuration files on event writes, and replay-safe interrupted writes.
API checks cover authentication, audit actors, successful/failed operations and
secret exclusion. Browser checks verify separate navigation and filters.
