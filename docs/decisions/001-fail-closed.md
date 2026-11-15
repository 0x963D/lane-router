# Fail closed on an unverifiable change

## Context

A wrong skip can merge a break that no lane tested. A partial file list cannot prove that a lane is untouched. Unclaimed paths have no rule that can justify a skip.

## Decision

Run every lane when the change cannot be verified. [`planLanes`](../../src/core/plan.ts) converts exceptions after model loading into incomplete plans. [`decide`](../../src/core/route.ts) runs every lane for an incomplete plan. Built-in and unclaimed paths also reach every lane.

An invalid config or workspace fails before planning. The [Action](../../src/action.ts) and [CLI](../../src/cli.ts) cannot plan without a trusted model.

## Consequences

An incomplete plan gives each lane a reason to run. The Action reports the cause and succeeds so downstream lanes can run. Config and workspace errors keep the build red.

[Routing tests](../../test/routing.test.ts) cover incomplete lists and exceptions. [Action tests](../../test/action.test.ts) cover API failures and errors before a model exists. [Routing invariants](../../test/invariants.test.ts) check that built-in and unclaimed paths select every lane.
