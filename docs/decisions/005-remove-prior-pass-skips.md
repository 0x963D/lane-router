# Remove skips based on a past passing lane

## Context

GitHub API metadata about a past check does not prove that the lane ran and passed. A check name can come from another app or workflow. A tag can share a branch name, and refs can change before the check.

The removal commit records this reasoning. Read it with `git show b356231`. The [threat model](../prior-passes.md) describes the remaining gaps.

## Decision

Remove skips based on past passing checks from v0.1. Route each push from `before` to `after`.

The [Action](../../src/action.ts) builds the event's range. The [compare adapter](../../src/adapters/github.ts) verifies that a push extends its base. [`planLanes`](../../src/core/plan.ts) decides every lane from that change. The [config loader](../../src/load/config.ts) rejects unknown keys, including removed lane settings.

## Consequences

A past passing check cannot justify a skip. Each matrix entry uses the event's base. The [Action tests](../../test/action.test.ts) cover push routing, and the [config tests](../../test/config.test.ts) cover unknown keys.

A future version needs proof that the lane itself signs and records when it passes. That proof is not built.
