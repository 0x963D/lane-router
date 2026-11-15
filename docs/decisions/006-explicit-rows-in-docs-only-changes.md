# Explicit path rows count in docs-only changes

## Context

Markdown can be a code generator template or a test fixture. An explicit path row says that a lane reads those files, regardless of the file extension.

## Decision

In a docs-only change, built-in files and every matching explicit `paths` row count, whatever its `via`. `via` still controls which lanes the row reaches. Package placements do not count. A path claimed only by `docs-only.match` selects no lane.

## Consequences

The fixture's browser Markdown fixtures select `web` through `via: tests`. Its Markdown code generator templates select the lanes that read `@acme/api` through `via: code`.

Markdown that a package reads at build or test time needs a `paths` row or a `docs-only.except` glob. Without either, `packages/api/src/welcome.md` selects nothing under the fixture config. Package membership alone cannot distinguish a package's documentation from its build or test inputs.
