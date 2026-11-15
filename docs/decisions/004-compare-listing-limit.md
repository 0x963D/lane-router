# Fail closed at the compare listing limit

## Context

The compare endpoint returns at most 300 changed files. A listing at that limit cannot establish that no files were omitted.

## Decision

Treat a listing of 300 or more files as incomplete. [`src/adapters/github.ts`](../../src/adapters/github.ts) defines `COMPARE_LIMIT` and returns the `truncated` cause when the listing reaches it.

## Consequences

Every lane runs even when the listed files would otherwise select fewer lanes. The Action emits `complete: false` and an annotation. [Action tests](../../test/action.test.ts) cover a listing at the limit. [Routing tests](../../test/routing.test.ts) check that the listed paths of an incomplete change never decide which lanes run.

Larger diffs cannot skip lanes through the compare endpoint. Paging through a larger diff remains unbuilt, as the [limitations](../limitations.md) state.
