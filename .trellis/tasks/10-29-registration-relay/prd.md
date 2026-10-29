# Relay workspace registrations to linked servers

## Goal

Configure a primary panel to update workspace registration locally and forward the update to linked panel domains for multi-server load balancing.

## Background and Evidence

- The user requested a registration-forwarding feature for one primary and several linked servers. CNB workspaces call the primary, which updates locally before forwarding to the linked domains.
- The user approved task creation and planning on 2026-10-29, then approved the final summary with “继续”.
- `src/app.mjs:369-391` supports token-only `POST /ops/register` and local-ID `POST /ops/register/:id`. Linked panels can have different local account IDs.
- `src/pool.mjs:429-453` persists the normalized workspace URI before acknowledgement and probes independently.
- `README.md:410-417` requires pre-existing accounts. Unknown registration tokens return 403; registration does not create accounts.
- `src/store.mjs:301-329` validates CNB workspace origins only. Ordinary panel domains require their own validator.
- Detailed repository evidence lives in `research/backend.md` and `research/frontend.md`.

## Requirements

- R1: Add a registration-relay section to the routing settings page. Provide a primary relay switch and a bounded list of server names, HTTPS origins and enabled states. Default to disabled.
- R2: After valid local registration, durably save the workspace URI and pending deliveries before acknowledging CNB. Deliver to enabled linked servers asynchronously so an unavailable peer does not delay or fail the local acknowledgement.
- R3: Send only the normalized URI and registration authentication to each target's `/ops/register`. Peers must contain the corresponding account with the same REG_TOKEN and correct PROXY_KEY. Local account IDs may differ. Do not copy admin keys, gateway keys, proxy keys or PATs.
- R4: Authenticate all relay requests with the existing per-workspace registration token. Add a single-hop marker so receivers update locally without forwarding again. Persist source/revision receipts so a late retry cannot replace a newer registration from the same primary.
- R5: Persist and retry the latest pending update per account/peer with bounded concurrency, timeouts and backoff. Discard superseded or deleted work. Resume pending work after restart. Pause delivery for disabled relay/peers.
- R6: Show per-server pending/success/failure state, last success and safe failure reason. Provide manual synchronization/retry of current workspace endpoints. Adding or enabling a peer schedules current eligible registrations.
- R7: Keep configuration separate from runtime status. Preserve existing registration response compatibility for original CNB calls, existing accounts and settings. Relay safety requires linked servers to run the new release.
- R8: Document setup, matching-token prerequisites, HTTPS origins, local-only test exceptions, retries and independent load balancer responsibilities. Publish the completed feature through the existing cloud release workflow after checks pass.
- R9: The user's 2026-10-29 continuation adds a model-list page. Show known model IDs, upstream discovery versus configured scope, associated accounts and current routing readiness. Include search and copying model IDs. Reuse actual panel data rather than a hardcoded CodeBuddy catalog. Explain that catalog discovery does not prove successful inference. Investigate the adjacent `cnb2api-main` model mapping and report whether its IDs select distinct upstream models.
- R10: The user additionally requested model discovery and quota access for New API. Preserve gateway-key-authenticated `/v1/models`. Add New API's OpenAI-channel subscription/usage billing contract and a native CNB-credit quota response. Aggregate each enabled organization once from cached snapshots, subtract used and frozen credits, and report unavailable data as an error rather than a zero balance. Clearly disclose CNB-credit units instead of claiming a USD conversion.

## Acceptance Criteria

- [x] AC1 (R1, R7): Old persisted settings load with relay disabled, and original registration routes keep their response contracts.
- [x] AC2 (R2, R3): Two real panels with different account IDs and matching REG_TOKEN receive the same normalized workspace URI. All enabled peers receive updates; disabled peers receive none.
- [x] AC3 (R2, R5): A stalled peer does not delay local registration acknowledgement or local probes. Failure remains visible and automatically retries after restart.
- [x] AC4 (R3, R4): Invalid tokens/URIs do not mutate either server or create pending deliveries. A missing peer account returns a visible safe authentication failure without creating an account.
- [x] AC5 (R4): A↔B peer configurations do not loop. Duplicate and late old relay revisions do not overwrite newer accepted endpoints.
- [x] AC6 (R5): A newer URI supersedes queued older work; stale completions cannot acknowledge newer work. Account/token/peer changes cannot send an obsolete job using unrelated credentials.
- [x] AC7 (R1, R6): Administrators can add, edit, enable, disable and remove peers, preserve drafts across refreshes, inspect state, and manually retry from desktop and mobile layouts.
- [x] AC8 (R3, R6): Management responses, statistics documents, audit/runtime logs and transport errors contain no registration-token values or raw peer response bodies.
- [ ] AC9 (R7, R8): Backend tests, browser tests, build/typecheck/format, documentation checks and cloud release validation pass.
- [x] AC10 (R9): The model page is available from desktop/mobile navigation, supports searching and copying IDs, distinguishes discovered/configured models, and reflects disabled/offline/cooling account readiness. Empty and failed loads remain usable. The documented model-selection explanation matches the inspected upstream source.
- [x] AC11 (R10): New API's actual `hard_limit_usd - total_usage / 100` calculation returns the deduplicated available CNB-credit amount. Both billing URL prefixes require the gateway key. Disabled organizations, frozen/overdrawn credits, missing quota, and credential/privacy boundaries have regression coverage. Setup instructions identify OpenAI channel type, root base URL and the credit-unit interpretation.

## Out of Scope

- Proxying model traffic between panel servers.
- Installing or configuring an external load balancer.
- Shared runtime state, distributed quotas, shared logs or database replication.
- Automatically creating peer accounts or synchronizing account definitions, credentials, enabled states or routing policies.
- Automatic primary election or multi-primary conflict resolution.

## Planning Status

- Proposed scope follows the user's registration-forwarding request and preserves the existing pre-created-account contract.
- Research and final planning review are complete. The user's “继续” authorizes implementation of this summary.
