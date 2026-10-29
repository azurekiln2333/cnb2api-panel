# Research: Workspace probe timeouts

- Query: Why do connected workspaces fail manual or automatic health probes?
- Scope: internal
- Date: 2026-10-29

## Findings

### Files found

- `src/pool.mjs`: probe deduplication, authenticated model-list check, health state, scheduling.
- `src/store.mjs`: endpoint validation and probe timeout settings.
- `src/app.mjs`: manual probe, registration and account-update routes.
- `web/src/api.ts`: management request timeout and error diagnostics.
- `web/src/console.ts`: manual probe result notifications.
- `test/panel.test.mjs`: existing mock workspace and routing tests.
- `../cnb2api-main/src/server.mjs`: local workspace route implementation.

### Confirmed behavior

1. `src/pool.mjs:264` probes `${endpoint}/v1/models` with the workspace proxy key. The request uses the configured connect timeout (default 20 seconds in `src/store.mjs:74`) for both headers and body.
2. `../cnb2api-main/src/server.mjs:148` answers this models route locally after authentication. It does not call the model provider. Workspace WebIDE connectivity alone does not prove the panel server can reach the public worker tunnel.
3. `src/store.mjs:299` keeps a validated endpoint origin. It substitutes `{{port}}` with 9001. It does not strip a required path because only root endpoints are accepted.
4. `web/src/api.ts:162` allows POST management actions 150 seconds, whereas GET requests allow 12 seconds. A browser notification reading `请求超时` comes from management request cancellation (`web/src/api.ts:245`), rather than the current backend probe error, which is generic.
5. `src/pool.mjs:314` collapses timeout, DNS, TLS, redirect, interrupted response and invalid models into `工作区无法连接或模型响应无效` and status 502. This prevents identifying the actual failed hop. An authentication HTTP failure does retain its HTTP status.

### Reproduced defect: connection changes reuse an obsolete probe

- `src/pool.mjs:257-260` keys the in-flight promise only by account ID.
- Registration immediately calls `probe(id)` after replacing the endpoint (`src/pool.mjs:328-349`). Account updates also probe (`src/app.mjs:693`).
- A second probe started after endpoint/key changes reuses the obsolete endpoint request. The stale-response guard in `src/pool.mjs:288-294` discards its result. The new valid endpoint receives no request, and the account remains pending until a later cycle.
- Local real-HTTP experiment used a delayed old worker and an immediately responding new worker. Start old probe, wait 50 ms, replace endpoint, then probe again. Actual result: `{"samePromise":true,"newEndpointStatus":"pending","discoveredModels":null}`.
- Minimal correction: distinguish probe connection generations by endpoint and proxy key. Deduplicate only when that generation matches. A stale promise finalizer must not delete a newer in-flight probe entry. Preserve existing stale-result protection and secret redaction.

### Minimal validation plan

- A valid authenticated models response marks healthy and discovers model IDs.
- Endpoint and proxy-key changes during a pending probe start a new probe immediately.
- Concurrent requests for the same generation reuse one request.
- An obsolete probe cannot delete the new pending entry or mark the new endpoint unhealthy.
- Header/body timeouts produce a bounded, sanitized timeout diagnosis. DNS, refused connections, TLS and invalid JSON have distinct safe messages where supported.
- HTTP 401 remains unhealthy. An unauthenticated `/health` response must not bypass the proxy-key check.
- Existing registration, disabled-account and routing recovery tests remain green.

### Related specs

- `.trellis/spec/backend/routing.md`: health controls routing eligibility and retries.
- `.trellis/spec/backend/logging-guidelines.md`: sanitize runtime diagnostics and retain no secret values.
- `.trellis/spec/backend/error-handling.md`: currently a placeholder.

### External references

None. Investigation used repository source and local real HTTP servers. No external factual claims are needed.

## Caveats / Not Found

- Production account data, deployment logs and live worker endpoints were not available in this checkout. The all-workspace production timeout origin is not verified.
- Do not claim increasing the timeout repairs the actual issue. Do not claim a reachable WebIDE proves the external API tunnel works.
- No product code was edited.

### Response body bound

`src/pool.mjs:285` calls `response.json()` without a byte cap. Its time is bounded by the request signal, but an unexpectedly large or continuously streaming models response can consume excessive memory. Use a small explicit byte cap for model metadata, cancel on overflow, and keep body-read timeout failures distinct from header connection failures.
