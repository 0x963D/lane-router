# Judge a change against the base and head lanes

## Context

A config change can delete or rename a lane while changing code that the lane reads. Selecting every head lane leaves the removed lane out of the outputs.

## Decision

When the routing config changes, read the base config as well as the head config. Emit head lanes in head order, then base-only lanes in base order. A base-only lane runs with the reason `removed from the routing config in this change`.

Resolve each config against its own workspace. Use its lane packages and extra edges for its dependency graph. Keep a lane's floor flag if either config sets it. The config change itself selects every lane in the union.

A missing config at an available base commit is a new config only when the changed paths include its path. Then the head lanes are the whole set. An unreadable, invalid or otherwise missing base config follows the existing incomplete-plan rule and runs every known head lane.

## Consequences

A rename emits both lane names for that change. Workflows must still handle the removed name until the config change lands. Changing packages or removing a floor flag cannot reduce the base lane's coverage in that change.

Config changes now need base history. A shallow checkout cannot discover removed lane names, so it emits an incomplete plan with all known head lanes selected. Use a full checkout to preserve the base lane set.

[`loadModel`](../../src/load/index.ts) reads both configs. [`compile`](../../src/core/model.ts) combines the lane set and dependency coverage. [`planLanes`](../../src/core/plan.ts) emits decisions from that combined model. [Base config tests](../../test/base-config.test.ts) cover the CLI and Action outputs.
