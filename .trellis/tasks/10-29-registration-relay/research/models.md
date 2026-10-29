# Model inventory evidence

Inspected on 2026-10-29. Research used source files and public documentation only.
No `.env`, production account data, logs or credentials were read. No production
inference request was made.

## Change boundary

The console has account model scopes and probe-discovered IDs but no model
inventory endpoint. Add a read-only projection in `src/pool.mjs`, expose it
through the existing management-session boundary in `src/app.mjs`, and validate
the contract in `test/panel-models.test.mjs`. Do not change public model-list
semantics, inference routing, persisted state or the adjacent upstream project.
The UI is owned by the frontend worker. No local refactor is necessary.

## Adjacent upstream: `D:/My2KProjects/cnb2api-main`

- `src/config.mjs:15`: the fallback IDs are exactly
  `deepseek-v4.1-flash,glm-5.3-flash,kimi-k3`. `PROXY_MODELS` replaces this
  advertisement fallback. It is not a supported-model allowlist.
- `src/config.mjs:31`: the production destination is
  `https://api.cnb.cool/<repo>/-/ai/chat/completions`.
- `src/proxy.mjs:134`: forwarding uses that one configured destination.
  `src/proxy.mjs:137` spreads the original payload, removes the reasoning
  triggers, and sets `stream: true`. It retains `payload.model`. There is no
  local DeepSeek-only whitelist or alias-to-model mapping on this path.
- `src/proxy.mjs:13` and `src/proxy.mjs:46`: reasoning switches are removed.
  This implementation does not offer independent selectable thinking variants.
- `src/models.mjs:48`: model IDs are learned passively from response fields.
  `src/models.mjs:63` returns all observed IDs, falling back to the configured
  list only while the observed list is empty. IDs persist without expiry.
- `src/proxy.mjs:217` and `src/proxy.mjs:324`: streaming and aggregated replies
  supply observed IDs. Requests carrying upstream header overrides deliberately
  skip observation. The registry stores no requested-to-resolved model mapping,
  completion success, account entitlement or per-model freshness.
- `src/server.mjs:148`: authenticated `/v1/models` is generated from that local
  registry. It is not a live request to an upstream model-list service.
- `test/proxy.test.mjs:138`: a request for `glm-5.3-flash` can receive
  `mock-model`; `test/proxy.test.mjs:146` then expects only `mock-model` in the
  list. This mock proves observation behavior, not real model availability.
- `src/proxy.mjs:20`, `src/proxy.mjs:66` and `src/proxy.mjs:89` recognize the
  provider's unapproved-channel rejection / business code 11128. That is a
  channel diagnostic, not evidence of a model-name whitelist.
- `docs/SETUP.md:65` describes passive observation. `docs/SETUP.md:73` records
  a historical DeepSeek rename. These project notes cannot prove the current
  service exposes only that model, or that two requested aliases select
  different underlying models.

Conclusion: the proxy is not hardcoded to accept only DeepSeek. Source alone
cannot establish that all CodeBuddy catalog IDs work through this worker API,
or that their names select distinct backends. A single DeepSeek observation
does not establish that every other model is unsupported.

## Public official sources

- CNB's CodeBuddy repository: <https://cnb.cool/npc/CodeBuddy>.
  The public README describes the supported catalog for **CodeBuddy NPC**, with
  a per-task `model` configuration. The page inspected on this date contained
  eleven listed entries; the count is mutable and must not be copied into a
  static panel catalog. It does not document entitlement to every model through
  the worker's repository-scoped Chat endpoint.
- Official NPC guide: <https://docs.cnb.cool/zh/build/npc.html>.
  It describes NPC in CNB pipelines and directs users to NPC repositories and
  their task configuration. It is not an OpenAI-compatible model-list or
  inference authorization contract for the worker endpoint.

The inspected official pages provide no proof that all nine IDs observed by
the user are callable through this exact endpoint, token and organization.
No such claim should be made without direct authorized evidence. Do not treat
configured names, a CLI catalog or a mock test as production verification.

## Existing panel behavior

- `src/app.mjs:452`: public `/v1/models` unions enabled accounts. Each account
  contributes its configured `models` if nonempty, otherwise `discoveredModels`.
  It does not filter offline or cooling accounts, so listing is not readiness.
- `src/store.mjs:670`: account `models` is a persisted administrator scope.
  It is validated/deduplicated at `src/store.mjs:739`. No `defaultModels`
  setting exists in the inspected panel source.
- `src/pool.mjs:359`: probes authenticate `/v1/models` and record up to 100
  returned string IDs at `src/pool.mjs:393`. This verifies workspace reachability
  and records its advertisement. It does not run inference for those IDs.
- `src/pool.mjs:251`: routing applies readiness plus the configured allowlist.
  An empty allowlist permits any requested model, including models absent from
  the discovered list. Discovery must not become a new routing restriction.
- `src/pool.mjs:15`: readiness requires enabled, healthy, a nonempty endpoint,
  and no current cooldown. Reuse this through `Pool.eligible(model)`.

## Management API contract

`GET /api/models` requires the existing management session and returns:

```json
{
  "models": [{
    "id": "model-id",
    "listed": true,
    "configuredAccounts": [{ "id": "account-id", "name": "account name" }],
    "discoveredAccounts": [{ "id": "account-id", "name": "account name" }],
    "eligibleAccounts": [{ "id": "account-id", "name": "account name" }]
  }]
}
```

`models` is the sorted union of configured and discovered IDs from all accounts,
including disabled accounts. Provenance arrays preserve both sources.
`listed` exactly matches existing public listing rules. `eligibleAccounts`
comes from existing `Pool.eligible(id)` and includes healthy wildcard accounts.
Only account IDs and display names cross this API boundary. The projection
must not read logs, issue network requests, mutate state, or expose secrets.

The page labels these dimensions as catalog source, public advertisement and
current routing readiness. It must not claim successful model inference.
An empty inventory remains valid even when a wildcard account could route an
arbitrary client-supplied model ID.
