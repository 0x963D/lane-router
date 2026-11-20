# Verify capped compare listings with local Git

## Context

The compare endpoint puts at most 300 changed files on its first page. Later pages contain commits. A listing at the limit cannot establish that no files were omitted. [Compare two commits](https://docs.github.com/en/rest/commits/commits#compare-two-commits).

## Decision

At the cap, diff the exact range with local Git. Accept that list when the merge base agrees, the local diff includes every path the API listed, and any applicable PR count matches. Both paths of a rename must be present. A path outside the routed root fails closed whether the API or local Git finds it.

## Consequences

Fetch the compare revisions to let capped changes skip lanes. If the revisions are missing, the listings disagree, or the local list cannot be read, the Action emits an incomplete plan and selects every lane. The [Action oracle](../evidence.md#action-soundness) exercises the recovery and fallback paths with real Git histories.
