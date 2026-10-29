# Registration relay design

## Boundary

This feature keeps workspace registration consistent across independently deployed panels. The primary persists its local registration and a durable delivery record, then sends the current URI to configured peers. It does not forward inference traffic or provision accounts. Each peer already has the workspace's REG_TOKEN and PROXY_KEY. An external load balancer can distribute client traffic across those panels.

## Configuration and console

Add `settings.registrationRelay = { enabled: false, servers: [] }`. Each server has a stable generated `id`, bounded `name`, canonical HTTPS `origin` and boolean `enabled`. Permit at most 20 servers, reject duplicate canonical origins, and reject an obvious self-origin when the configured panel public origin is known. Allow loopback HTTP only under the existing local-upstream test/development capability. Do not reuse the CNB-only workspace validator.

Integrate a registration-relay section into RoutingView's existing settings form. The total switch labels this panel as the primary for outgoing relay. Receivers need no outgoing configuration. Show the pre-created-account/same-token prerequisite. Keep polling status outside the settings draft so background refresh cannot overwrite edits.

Existing authenticated GET/PATCH `/api/settings` handles configuration. Authenticated GET `/api/registration-relay` returns bounded per-server status and counts. Authenticated POST `/api/registration-relay/sync` schedules current registered account endpoints for enabled peers and also serves as manual retry. Audit the manual operation. Adding/enabling/changing a peer schedules the latest known registrations rather than requiring workspace restarts.

## Registration data flow

1. Authenticate the workspace token using the existing registration route.
2. Read at most the existing 4 KiB body and validate the CNB workspace origin.
3. Commit the local endpoint/runtime update and pending relay generations together.
4. Return the existing `{ ok: true, accountId }` acknowledgement to original CNB requests.
5. Continue the existing local probe independently. Start background relay without awaiting remote servers.
6. POST `{ uri: normalizedEndpoint }` to each enabled peer's `/ops/register` using X-Reg-Token from the matched account's encrypted secrets. Never forward the primary's local account ID.
7. Verify a bounded, structured peer acknowledgement. Record a static safe outcome and schedule retry when necessary.

## Relay envelope and ordering

Use a versioned single-hop relay marker plus a persisted source instance ID and monotonic registration revision in headers. Parse it only after ordinary REG_TOKEN authentication. Malformed partial relay headers return a safe 400 without mutation. A received relay always skips outgoing fanout, even if that receiver also has outgoing relay enabled.

Persist the highest accepted revision per account/source. A duplicated or older revision returns an idempotent acknowledgement without resetting the endpoint or probe state. Store the endpoint update and receipt cursor atomically. Echo source/revision and protocol support in the relay acknowledgement so senders can distinguish an upgraded peer from an older panel that merely accepts `/ops/register`.

Original CNB payloads and responses remain unchanged. Peers need the new release for loop and old-update protection. An unsupported peer reports a safe version/capability failure. Do not claim safe distributed ordering for an older server that ignores the relay envelope.

## Durable delivery and lifecycle

Persist relay identity, latest delivery generations and receipt cursors in `stats.json`, independently of editable settings and encrypted account definitions. Add optional defaults for existing and legacy stores. Store references, normalized URI, revisions and retry timestamps, never token values. Use the existing Store journal and multi-document commit instead of an ad hoc queue file.

Keep one latest delivery per account/peer. A new registration supersedes pending older work. Dispatch with a global concurrency limit of four, serialize each account/peer, use a ten-second request/read deadline, reject redirects and bound peer response bodies. Use exponential retry from five seconds up to five minutes. Reconcile persisted work when the pool starts and clear timers/abort fetches when it stops.

Before dispatch and after completion, compare account identity/current endpoint, registration revision, token generation and peer identity/origin. Deleted or superseded work cannot be sent or acknowledge a newer delivery. Disabled peers or disabled relay stop network work; enabling or manual sync schedules current snapshots. Token rotation does not retain plaintext tokens in the outbox and creates a fresh authenticated generation when synchronization is retried.

Use static diagnostic categories for HTTP authentication, unsupported peer version, invalid acknowledgement, timeout and connection failure. Never copy peer bodies or raw fetch errors into status/logs. Expose only bounded identifiers, configured server names/origins, timestamps, pending/failed counts and safe errors. Delivery jobs remain separate from the settings response.

## Compatibility and rollout

- Relay defaults to disabled and old settings/statistics still load.
- Accounts keep their existing local IDs and encrypted credentials.
- All linked nodes run the feature release. Configure matching account tokens and proxy keys before enabling the primary.
- Configure each peer's origin without an account-ID registration suffix.
- Disable outgoing relay to stop fanout without changing normal registration.
- Preserve each panel's own data and logs. No shared storage is introduced.
- Publish versioned images and release tags to GitHub/CNB/GitLab through the current workflow after verification.

## Verification

Use multiple real temporary panel servers with different local account IDs and shared synthetic workspace tokens. Prove local persistence before remote completion, all-peer delivery, one-hop loop suppression, idempotent/older receipts, durable restart retry, latest-generation replacement, token/peer/account changes, redirect refusal, bounded time/body/concurrency and credential-free diagnostics. Browser tests cover settings lifecycle, drafts, state/retry controls and mobile layout. Re-run existing registration, probes, persistence, audit and routing coverage.

## Model-list extension authorized during implementation

Add a dedicated read-only model page and navigation entry. Derive the catalog from account model allowlists and probe-discovered IDs. Distinguish those sources, whether an ID is advertised by the public model endpoint, and current routing eligibility. Reuse Pool eligibility instead of inventing a separate readiness rule. The management endpoint requires the existing administrator session and contains no credentials. Loading the model page must not fetch logs or block session startup. Search and copying operate on the displayed catalog. No hardcoded nine-model list or unverified capability expansion is authorized by this page request.

## New API quota extension authorized during implementation

The inspected adjacent New API `controller/channel-billing.go` uses OpenAI-channel `GET /v1/dashboard/billing/subscription` and `GET /v1/dashboard/billing/usage`, subtracting `total_usage / 100` from `hard_limit_usd`. Add those paths and their `/dashboard/...` aliases to existing gateway-key authentication and CORS handling. Return a CNB-credit numeric mirror: limit is total credits, billed usage includes used plus frozen credits and is multiplied by 100 for that legacy schema. Clamp the mirrored consumed amount to the limit to keep an exhausted balance at zero. Expose explicit `unit: cnb_credits`; these numbers are not USD exchange rates. Date query parameters do not turn cached current-period CNB quotas into historical usage.

Add native `GET /v1/quota` with `{ object: quota, unit: cnb_credits, total, used, frozen, remaining, organizations, syncedAt }`. Select organizations from enabled accounts by repository organization. Pick the newest matching-org finite nonnegative quota snapshot for each organization, including shared snapshots on other accounts for the same enabled organization. Never count an organization twice or include a disabled-only organization. If any enabled organization lacks a valid snapshot, or no enabled organizations exist, return a safe 503 instead of misleading zero/partial totals. Read cached state only; existing quota synchronization owns refresh and credentials. No credential, organization name or account detail enters these public gateway responses.
