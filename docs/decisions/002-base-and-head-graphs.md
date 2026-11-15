# Judge a change against the base and head graphs

## Context

A change can remove a dependency or rename a package while editing code that its old dependents still read. The head graph alone would lose that relationship.

## Decision

Compute each lane's dependency closure in the base graph and the head graph separately. Use the union of those closures. Keep package ownership from both graphs.

[`compile`](../../src/core/model.ts) combines the reaches from the graphs. [`route`](../../src/core/route.ts) resolves changed paths against their package directories. [`planLanes`](../../src/core/plan.ts) requests the base graph when a package manifest changes. [`baseGraphOf`](../../src/load/index.ts) loads it from the commit the change was diffed from.

## Consequences

A deleted dependency or renamed package still selects the lanes that read it in base. A reason names the base graph when that graph supplies the relationship. If a required base graph cannot load, every lane runs.

Changes without a package manifest do not need the base graph. The config, workspace file, and root manifest already select every lane. [Base graph tests](../../test/base-graph.test.ts) cover these cases.
