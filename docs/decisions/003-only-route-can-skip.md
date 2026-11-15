# Only the routing module can construct a skip

## Context

A skip needs proof that a complete change reaches no input of the lane. Code that handles errors must be able to request a run without constructing an unsupported skip.

## Decision

Keep the skip constructor and its private symbol in [`src/core/route.ts`](../../src/core/route.ts). The exported `Skip` type requires that symbol. Other modules cannot construct a `Skip` object literal through the typed API.

`Routing` requires another private symbol from the same module. Only `route` constructs it. A caller cannot hand `decide` a plain routing whose only placement is `docs` to obtain a skip. A caller can call `decide` with a routing returned by `route`.

The complete file list has a separate private symbol in [`src/core/change.ts`](../../src/core/change.ts). Only `changedFiles` can construct that proof. [`test/type-claims.ts`](../../test/type-claims.ts) checks these restrictions with `@ts-expect-error` claims.

## Consequences

Every other module can construct a run decision directly. A skip comes from `decide` after `route` constructs a routing from a complete change. `npm run typecheck` fails if a forbidden plain object becomes constructible in the type claims.

The symbols constrain construction at compile time. They do not validate a caller's model or file list at runtime, and they do not prevent copying an existing branded value or bypassing types with assertions.
