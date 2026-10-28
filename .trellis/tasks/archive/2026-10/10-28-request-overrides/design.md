# Request overrides and diagnostics design

## Boundary

The panel owns management settings, rewriting received Chat Completions JSON,
and bounded structural diagnostics. The workspace owns the restricted header
carrier and provider forwarding. No credentials or message bodies are recorded.

## Contract

- Persist global settings through the authenticated settings endpoint. A visible
  CNB / DSH preset defaults on. Operators can disable it.
- Convert all developer roles to system for Chat Completions when enabled.
  This changes role semantics and is not proof of a universal CNB contract.
  For identified DSH requests, neutralize the confirmed DSH identity and brand
  in system/developer messages. Replace only
  the confirmed identity sentence in assistant history. Preserve user/tool text.
- Apply ordered custom `set`, `copy`, `delete`, and `regex_replace` operations
  with dotted paths, numeric array indices, and `full`, `prefix`, and `regex`
  conditions. Accept leading `(?i)`. Reject unsupported modes and unsafe paths.
  Keep the original payload for affinity and the initial message preview.
- Send only restricted management-configured headers in a panel-generated
  carrier. Never reuse a client-supplied carrier. Protect auth and transport.
  A workspace acknowledgement denotes support, not provider acceptance.
- Store bounded received/forwarded field names, message roles, content types and
  lengths, and rule outcomes. Never record prompt text, header values, tool
  bodies, credentials, or response bodies.
- Preserve unconfigured behavior. Do not claim live workspace support without
  an acknowledgement. Deployment and unrelated quota/protocol changes are out
  of scope for this child.

## Validation

Use synthetic requests for rule order, roles, assistant identity, streaming,
failover, invalid settings, protected headers, persistence and log redaction.
