# Collect a superset of dependency targets

## Context

Three attempts to resolve each dependency specifier to one precise workspace target failed on package-manager behavior. A specifier can preserve the dependency key, carry another package name, or change through a catalog or override. Dropping a candidate can skip a lane that reads changed code.

The router already computes a safe larger set of lanes. Dependency discovery needs the same policy.

## Decision

Collect candidates in a set. Every dependency key that names a workspace package adds an edge, regardless of its value. Local paths add their deepest workspace owner, whether the target equals a package directory or lies inside it. Keep case-sensitive and case-insensitive candidates. Names inside aliases add targets alongside the key. Version compatibility does not remove edges.

A `link:`, `file:` or bare path inside a workspace package adds an edge to its deepest owner. This includes subdirectories without manifests and archives stored inside a package. A path outside every workspace package adds no path edge and is not an error. Files outside all workspace packages use path rules. An unclaimed changed file runs every lane through `unmatched: all`.

An unresolved `workspace:` name fails closed because pnpm refuses that installation. A `workspace:` path follows the local-path rule. pnpm 11.18.0 accepts dangling workspace paths.

Expand catalogs by dependency key. Trim their names and use `default` for an empty name. Keep key lookup when an entry is absent or recursive. Empty top-level catalog mappings count as absent. Collect catalog paths relative to both the consumer and the workspace root because pnpm releases use different bases.

Read overrides in the workspace YAML and both root manifest locations. Traverse nested values and expand root dependency references in all three sources. Add every possible workspace target to every workspace package. Include path candidates at the root and each consumer. A registry dependency can introduce an override target through a dependency tree the router cannot see.

Keep the package-manager check as `npm run check:linking` and a CI job with pinned versions. One table defines the specifier cases. Successful offline installations must load, and every installed workspace link must have a direct dependency edge. Identify a link by its real path and assign it to the workspace directory that equals it or is its deepest ancestor. Expected install outcomes prevent a broken invocation from turning linked cases into ignored rejections.

## Consequences

An extra edge can run extra lanes. A missing edge can skip a required lane. The implementation accepts the first cost to avoid the second within the dependency inputs it reads.

The graph does not claim to reproduce an installation. Hooks, package extensions, external settings and other dependency rewrites still need explicit configured edges or path rules. Local code outside the discovered packages has only path-rule coverage. The [limitations](../limitations.md#dependency-boundaries) describe those boundaries.
