# Logging Guidelines

`Store.record()` persists the latest 1,000 events in `panel.json` and updates request and Token totals. `/api/logs` requires an authenticated management session.

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
