# Research: Responses to Chat Completions bridge

- Query: Why is Responses unsupported, and what is the smallest compatible bridge when upstream only supports Chat Completions?
- Scope: mixed
- Date: 2026-10-29

## Findings

### Existing defect

- `src/app.mjs:397-401` registers Chat and Messages only. `/v1/responses` does not enter gateway authentication, CORS or forwarding.
- `src/pool.mjs:699-944` owns account selection, cancellation, retries, usage and request logging. `src/pool.mjs:782` forwards the original route unchanged. Adding only a route would still request an unsupported upstream endpoint.
- No adapter module exists. `.trellis/tasks/10-27-ai-protocol-compatibility/prd.md` remains planning with unresolved protocol scope.
- `src/request-overrides.mjs:490` applies the DSH preset only to Chat messages. Convert Responses before rewrites, and pass the Chat route into rewriting.

### Proposed boundary and integration

Add `src/responses.mjs` for pure request mapping, JSON mapping and incremental SSE conversion. Register only `POST /v1/responses` plus existing CORS handling. Keep the accepted client route in request logs, but send `/v1/chat/completions` upstream. Keep account selection, headers, timeouts, retries and backpressure in `Pool.forward()`.

Derive session affinity and first-user preview from the mapped Chat request before rewrite. Capture usage from original Chat bytes before conversion. Count bytes actually emitted to the client. Preserve original received diagnostics and mapped/rewritten forwarded diagnostics.

### Recommended request contract

| Responses | Chat mapping |
| --- | --- |
| `instructions` | Leading system message |
| String `input` | User message |
| Message input and text blocks | Preserve roles; `input_text`/`output_text` become text |
| URL/data-URL `input_image` | `image_url` content block with detail |
| `function_call` input | Assistant `tool_calls`, preserve `call_id`, name, arguments |
| `function_call_output` input | Tool message using matching `call_id` |
| Flattened function tools | Nested `function` schema including strict/parameters |
| Named tool choice | Nested Chat function choice |
| `max_output_tokens` | `max_tokens` |
| `text.format` | `response_format`, nesting JSON-schema fields as required |
| `reasoning.effort` | `reasoning_effort` |
| `temperature`, `top_p`, `parallel_tool_calls` | Preserve |

Validate types and unknown semantic features before selecting an account. Reject non-null `previous_response_id` or `conversation`, `background:true`, explicit `store:true`, hosted tools, files/audio and opaque encrypted input with HTTP 400 and a specific unsupported-feature message. Accept stateless full input history and `store:false`; return an unstored response. An optional `include:["reasoning.encrypted_content"]` output projection can yield no encrypted content; never invent state.

### Response and stream contract

Produce stable `resp_` IDs and output items. Map assistant content to an assistant message containing `output_text` blocks. Map each Chat tool call to a separate `function_call` item with stable item ID and preserved call ID. Convert refusal explicitly. Map length termination to `status:incomplete` and `incomplete_details.reason:max_output_tokens`; successful text and tool requests complete normally.

Emit named SSE events with matching `type` and increasing `sequence_number`: `response.created`, `response.in_progress`, `response.output_item.added`, `response.content_part.added`, text deltas/done or function-arguments deltas/done, content-part done, output-item done, then `response.completed` or `response.incomplete`. Retain `output_index`, `item_id`, `content_index` consistently. Support interleaved tool indices, arbitrarily split UTF-8 bytes, CRLF and trailing usage events. Do not announce success on premature EOF, malformed Chat events, upstream errors or missing terminal choice. Bound pending events and accumulated response state.

Convert Chat prompt/completion/cache usage into Responses input/output/details usage. Do not fabricate usage when the worker reports `usage_estimated:true`.

### Tests

Add focused mapper tests and gateway integration tests with a mock upstream that exposes only Chat. Cover authentication/CORS, text/history/images, parallel tools and tool results, JSON-schema formatting, split SSE boundaries, length/refusal, malformed input and unsupported state, upstream errors/retries, disconnect/idle timeout, diagnostics and exact usage accounting. Assert upstream never receives `/v1/responses`. Existing Chat/Messages tests must pass unchanged.

## Related Specs

- `.trellis/spec/backend/routing.md`: affinity derives from original semantic request; retain retries and usage option merging.
- `.trellis/spec/backend/request-overrides.md`: protected credentials, post-conversion rewrites and bounded diagnostics.
- `.trellis/spec/backend/logging-guidelines.md`: preserve client route and privacy; record actual emitted bytes.

## External References

OpenAI Docs skill loaded; official primary pages fetched on 2026-10-29:

- Responses migration: `https://developers.openai.com/api/docs/guides/migrate-to-responses`
- Function calling: `https://developers.openai.com/api/docs/guides/function-calling`
- Streaming event schemas: `https://developers.openai.com/api/reference/resources/responses/streaming-events`
- Responses creation schema: `https://developers.openai.com/api/reference/cli/resources/responses/methods/create`

The mapping and rejection policy above are implementation recommendations inferred from those schemas and this gateway's capabilities.

## Caveats / Not Found

- Local worker `../cnb2api-main/src/proxy.mjs:10-16,42` deliberately strips reasoning settings to avoid reasoning consuming the answer budget. Mapping an effort field does not establish provider support. Do not fabricate reasoning summaries or encrypted state.
- `src/token-usage.mjs:29-32` classifies input/output token fields as Anthropic. Feeding converted Responses usage through that collector could double-count cache tokens. Capture original Chat usage instead.
- Local worker source/version does not establish the deployed worker version. No live provider request was made during research.
- GET/DELETE stored-response operations require a separate persistence contract and are outside the proposed stateless bridge.
