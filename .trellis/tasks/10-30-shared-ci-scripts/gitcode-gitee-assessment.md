# GitCode and Gitee assessment

Question (R7): can GitCode and Gitee host the same build + release + package
pipeline as CNB, GitHub and GitLab?

## Verdict

Neither is added. Both can build, but neither provides durable package storage
comparable to a real package registry, and Gitee's CI is quota-limited in a way
that breaks a per-tag release pipeline.

## Gitee

| Capability | Status | Evidence |
| --- | --- | --- |
| CI workflow | Partial — Gitee Go | Separate product from the repo; requires activation per repository |
| Release | Yes — 发行版 with attachments | Attachments are capped per release and per repository |
| Package registry | No dedicated registry | Artifacts live as release attachments, not a versioned registry |
| Container registry | No | No first-party image registry |

Decision: not added. The release step would work, but there is no package
registry, and the image job has no destination. Attaching the archive to a
release duplicates what CNB and GitLab already store.

## GitCode

| Capability | Status | Evidence |
| --- | --- | --- |
| CI workflow | Yes | Repository-level pipeline configuration |
| Release | Yes | Releases with asset upload |
| Package registry | Limited / not a general registry | No generic-registry equivalent to GitLab's Package Registry |
| Container registry | Limited | Availability depends on account tier |

Decision: not added. `scripts/ci-backend.sh` and `scripts/ci-console.sh` are
platform-neutral, so a GitCode pipeline is a thin wrapper if GitCode later
exposes a generic package registry. Until then it would only re-publish artifacts
that already exist on three other platforms.

## What would change this decision

Add a pipeline when the platform provides both:

1. A `v*` tag trigger that runs without a separate paid/activated CI product.
2. Durable artifact storage addressable by version, not a time-limited run
   artifact or a manually managed release attachment.

Both shared scripts already satisfy the build half.
