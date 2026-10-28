# Request Parameter and Header Overrides

## Goal

Let an operator configure how the panel modifies incoming JSON requests and
upstream request headers, and verify which rules ran for a failed request.

## Background

- New API channel 43 points to this panel. A DSH request reached that channel
  after other channels failed and returned a channel-validation HTTP 400.
- The user supplied New API-style operations for `set`, `copy`, `delete`, and
  `regex_replace`, including conditional `system`/`developer` role checks and
  case-insensitive `(?i)` regular expressions.
- Native JavaScript `RegExp` rejects the supplied inline `(?i)` syntax. A
  compatible implementation cannot blindly pass this configuration to it.
- The panel constructs workspace request headers and does not forward the
  caller's `User-Agent` or `Accept` as configured values (`src/pool.mjs:751`).
  The local workspace proxy constructs a second header set for the final
  provider (`../cnb2api-main/src/proxy.mjs:36`). The deployed proxy may differ.
- The user approved modifying the workspace proxy alongside the panel so
  configured headers can reach the final provider.
- The user requested a built-in DSH preset in the panel and stated that the
  panel is responsible for deployment. A local workspace edit does not prove
  that the running proxy has been updated.
- On 2026-10-28, short, direct tests of the user-provided workspace returned
  HTTP 200 for a neutral `system` message and HTTP 400 / 11128 for a `system`
  message containing the DSH identity sentence. The same result occurred for
  an assistant-history identity sentence with an otherwise neutral system
  message. A neutral assistant-history control returned 200.
- In the same tests, neutral `developer` messages returned 400 / 11128 both
  as the first message and after a `system` message. Two neutral `system`
  messages and a user-only request returned 200. The tests used synthetic
  content, not the user's private conversation.
- The current local DSH profile uses `openai-completions`. A local simulation
  using its installed serializer and current model configuration produced a
  first `developer` message with string content, the DSH identity sentence,
  `max_completion_tokens`, `store: false`, and `stream: true`. This simulation
  did not capture the actual New API or provider wire request.
- Direct neutral requests using either `max_completion_tokens` plus `store`,
  or `max_tokens` without `store`, both returned 200. These controls do not
  prove that every real request using those fields will succeed.
- The panel serializes the request body before account selection and currently
  constructs headers per upstream attempt (`src/pool.mjs:698`).
- Current request records intentionally exclude system prompts, assistant
  history, tool bodies, credentials, and upstream response bodies
  (`.trellis/spec/backend/logging-guidelines.md`).

## Requirements

- Provide authenticated panel settings for ordered JSON parameter overrides
  and upstream HTTP header overrides. Existing behavior remains unchanged when
  overrides are disabled or absent.
- Support the supplied operation types, path selection, conditions and ordered
  execution for the user's example configuration. Define the supported New API
  compatibility subset and reject unsupported syntax rather than ignoring it.
- Include `(?i)` in the compatibility contract. Validate configuration before
  activation and report invalid regexes, invalid paths and incompatible types
  without logging sensitive values.
- Define header precedence and protect account credentials, transport headers,
  and client authentication. Header overrides must not expose secrets in logs
  or management responses.
- Report bounded per-request rule outcomes, including applied, unmatched,
  skipped and failed conditions, without exposing sensitive values by default.
- Distinguish a regex that executed but matched nothing from one that changed
  text. Identify the affected attempt and the representation being modified.
- Coordinate rewrite order with routing, protocol conversion, retries and the
  request diagnostics task. The UI must identify whether it shows the received
  or forwarded representation.
- Supply a visible DSH preset covering the confirmed role and identity cases.
  Record matched and unmatched rules separately. Preserve user and tool text.
- Preserve streaming and non-streaming delivery, cancellation, usage accounting,
  persisted settings, and existing behavior for unconfigured installations.

## Acceptance Criteria

- [x] A test replays the user's configuration against synthetic DSH-style
      requests and verifies each resulting field and ordered operation.
- [x] Tests cover role conditions, `(?i)` regexes, missing fields, invalid
      configuration, arrays, retries, and protected headers.
- [x] Synthetic DSH replays cover `developer` messages, system identity text,
      and the accepted scope for assistant-history identity text.
- [x] Logs distinguish a matched rule from an unmatched or skipped rule without
      retaining sensitive values beyond the approved capture policy.
- [x] The panel can save, inspect, disable and restore overrides after restart.
- [x] End-to-end tests exercise requests with overrides on and off, streaming
      and non-streaming delivery, failover and management authorization.

## Dependencies

- `10-27-request-diagnostics` displays request structure and rule outcomes.
- `10-27-ai-protocol-compatibility` defines the representation to rewrite when
  protocols are converted. Retry and routing semantics must be tested together.
- `10-28-workspace-header-propagation` defines and implements the workspace's
  side of the approved header-propagation contract.

## Implementation Decisions

- Use a global, disableable preset. In assistant history, rewrite only the
  confirmed identity sentence. This changes history sent to the model and must
  be described in the UI and release notes.
- Convert every developer role to system for Chat Completions while the preset
  is enabled, including messages after index zero. Synthetic tests against the
  supplied workspace showed the neutral developer role receiving 11128.
  This can change instruction priority and is not a universal CNB guarantee.
- Support the documented bounded subset of New API operations. Reject invalid
  settings rather than silently ignoring them.
- Restrict request headers to an explicit non-credential allowlist.
- Retain bounded structure and rule results, not request bodies. Authenticated
  detail requests read one record. Bulk logs omit the diagnostic structure.

