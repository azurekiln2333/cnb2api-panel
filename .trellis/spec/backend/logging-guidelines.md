# Logging Guidelines

`Store.record()` routes events through `logChannel()` in `src/file-storage.mjs`.
Keep three independent streams under the log directory, separate from data:

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

Console list requests must use server pagination. A request with `limit`,
`offset`, `q`, `outcome` or `kind` returns `{ logs, total, limit, offset }`.
The default page size is 20 and the maximum is 100. Apply channel selection,
case-insensitive search and outcome/kind filters before pagination. Search the
full stored initial user message as well as the existing metadata fields.
Keep the no-query `{ logs }` response for older clients.

The same authenticated endpoint with `download=1` sends a JSON attachment array
of all matching records, ignoring pagination. Lists and downloads omit
`requestDiagnostics`; individual request details retain it. An export must not
use only the current page or pass through the frontend's bounded JSON reader.

Do not make console startup depend on bulk logs. A full 1,000-record channel
with 4,000-character Chinese initial messages can exceed 12 MB, above the
frontend's 8 MiB JSON limit and its 12-second read deadline. Pagination addresses
the response size without discarding retained logs or increasing timeouts.
The default log directory is `logs/` beside the data directory. `PANEL_LOG_DIR`
can override it for plain Node. Compose fixes `/app/logs` and bind-mounts `./logs`.
Reject log paths inside the data directory. Startup relocates old `data/*.log`
before journal recovery so pending append offsets remain valid.

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
- `responseBytes` counts body bytes written to the client, including generated
  Responses JSON/SSE frames when protocol conversion is active.
- `firstByteMs` measures request start to the first emitted body chunk. It is
  `null` if no upstream response or converted body was emitted.
- `upstreamEndpoint` identifies the last selected workspace without authentication headers.
- `tokenUsage` keeps the existing reported/missing/partial accounting semantics.

`TokenUsageCapture` ignores usage objects marked `usage_estimated: true`. Older
workers synthesize zero counters when no upstream usage was received; these are
missing usage, not measured zero. Genuine numeric zero counters still count as
reported. The console shows `—` when all requests in the selected period lack
usage, and keeps `0` for a period with no requests. Apply the same distinction to
local comparison counters and hide the difference when no local usage is known.

## Initial user message

`initialUserMessage()` in `src/request-details.mjs` selects the first message whose role is `user`. It supports text strings and OpenAI/Anthropic text blocks. The result contains `role`, `text` and `truncated` and is limited to 4,000 Unicode code points.

Use media-type placeholders for image, audio, file and tool-result blocks. Do not retain media URLs, base64 data, system messages, assistant history, later user messages, tool bodies, credentials, or response bodies. Request failure descriptions must not include raw upstream error bodies.

Initial message previews are stored in plaintext with event metadata, as documented in the README. Historical records have no preview and must remain readable. The frontend renders previews as escaped text and labels missing or truncated data.

## Request structure

New request records may include bounded `requestDiagnostics` with separately
labelled received and forwarded shapes. Shapes contain only known field names,
message positions, known role names, content kinds and lengths. They do not
retain system text, assistant text, tool data or arbitrary request keys.
Rule results include operation names, sanitized paths and status, not values.
The header section contains allowed names and workspace capability acknowledgements,
not header values. Keep the existing initial user preview policy unchanged.

`GET /api/logs/requests/:id` returns one full request record to a logged-in
administrator. Bulk log endpoints omit `requestDiagnostics` to keep responses
bounded. Old records may omit diagnostics. Copying request details must not
introduce any content the record does not already expose.

## Verification

Cover text formats, Unicode truncation, media omission, unchanged upstream forwarding, streaming byte counts, empty responses, failure descriptions and persisted legacy records. Browser checks cover preview search, details, copying and mobile wrapping.

Storage tests must prove category separation, independent retention, unchanged
account/configuration files on event writes, and replay-safe interrupted writes.
API checks cover authentication, audit actors, successful/failed operations and
secret exclusion. Browser checks verify separate navigation and filters.
