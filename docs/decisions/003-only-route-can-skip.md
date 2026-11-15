# Only the routing module can construct a skip

## Context

A skip needs proof that a complete change reaches no input of the lane. Code that handles errors must be able to request a run without constructing an unsupported skip.

## Decision

Keep the skip constructor and its private symbol in [`src/core/route.ts`](../../src/core/route.ts). The exported `Skip` type requires that symbol. Other modules cannot construct a skip through the typed API.

The complete file list has a separate private symbol in [`src/core/change.ts`](../../src/core/change.ts). Only `changedFiles` can construct that proof. [`test/type-claims.ts`](../../test/type-claims.ts) checks both restrictions with `@ts-expect-error` claims.

## Consequences

Every other module can construct a run decision. A skip comes from `decide` after routing a complete change. The restriction is a compile-time contract. `npm run typecheck` fails if a forbidden value becomes constructible in the type claims.
