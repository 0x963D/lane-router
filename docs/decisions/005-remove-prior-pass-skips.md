# Remove skips based on a past passing lane

## Context

An earlier version let a push to `main` skip a lane that had passed on an earlier commit, when nothing the lane reads had changed since. The only record of that pass lane-router can read is GitHub API metadata: a check run's name and app, and the event and branch of the workflow run behind it. That metadata can be forged or confused:

- Any GitHub App with `checks: write` can create a passing check run with the lane's name.
- Any other workflow in the repository can do the same.
- A tag can have the same name as a branch. A run for a push of the tag `main` reports the branch `main`.
- Refs change between the run and the check. A tag named like the branch can be deleted before lane-router looks, and the API shows only the refs that exist now.

Each extra check on the metadata closes one gap and leaves the others open. The removal commit records this reasoning. Read it with `git show b356231`.

## Decision

Remove skips based on past passing checks from v0.1. Route each push from `before` to `after`.

The [Action](../../src/action.ts) builds the event's range. The [compare adapter](../../src/adapters/github.ts) verifies that a push extends its base. [`planLanes`](../../src/core/plan.ts) decides every lane from that change. The [config loader](../../src/load/config.ts) rejects unknown keys, including removed lane settings.

## Consequences

A past passing check cannot justify a skip. Each matrix entry uses the event's base. The [Action tests](../../test/action.test.ts) cover push routing, and the [config tests](../../test/config.test.ts) cover unknown keys.

A future version needs proof that the lane itself signs and records when it passes. That proof is not built.
