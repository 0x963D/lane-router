# Config reference

lane-router reads `.github/lanes.yml`. This is the config of the `test/fixtures/acme` monorepo that the tests route.

```yaml
lanes:
  api:
    packages: ["@acme/api"]
  web:
    packages: ["@acme/web"]
  e2e:
    packages: ["@acme/web-e2e"]
  lint:
    floor: true

workspace:
  edges:
    - from: "@acme/web"
      to: "@acme/api"

paths:
  - match: [".github/workflows/**"]
    lanes: all
    why: CI changes can affect every lane.
  - match: ["tools/codegen/**"]
    packages: ["@acme/api"]
    via: code
    why: The api build runs the code generator.
  - match: ["fixtures/browser/**"]
    packages: ["@acme/web"]
    via: tests
    why: The browser tests load these fixtures.
  - match: ["docs/api/*.md"]
    packages: ["@acme/api"]
    via: name
    why: The api serves these files by name.
  - match: ["docs/guide.md"]
    lanes: [web]
    why: The web build inlines the guide.
  - match: ["packages/ui/tokens.json"]
    packages: ["@acme/api"]
    via: code
    why: The api reads the design tokens.
  - match: [".vscode/**", ".idea/**"]
    lanes: []
    why: Editor settings affect no lane.

docs-only:
  match: ["**/*.md"]
  except: [".changeset/**"]

unmatched: all
```

| Key                                   | Meaning                                                                                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lanes.<name>.packages`               | The lane's root packages, by `package.json` name. Required unless the lane is a floor lane.                                                         |
| `lanes.<name>.floor`                  | `true` to run the lane for every change that is not docs-only. Default `false`.                                                                     |
| `workspace.discovery`                 | `auto`, `pnpm` or `npm`. `auto` reads `pnpm-workspace.yaml` when it exists, else the `workspaces` field of the root `package.json`. Default `auto`. |
| `workspace.edges`                     | Extra dependencies that the manifests do not declare. `from` reads `to`.                                                                            |
| `paths[].match`                       | One or more globs.                                                                                                                                  |
| `paths[].lanes`                       | `all`, or a list of lane names. An empty list marks a known path that selects no lane.                                                              |
| `paths[].packages`                    | A list of package names. Needs `via`.                                                                                                               |
| `paths[].via`                         | How the packages read the path. See the next table.                                                                                                 |
| `paths[].why`                         | One sentence that explains the row. It appears in every reason the row produces.                                                                    |
| `docs-only.match`, `docs-only.except` | The globs that make a path docs.                                                                                                                    |
| `unmatched`                           | Must be `all`. It is required so the policy is written in the file.                                                                                 |

| `via`   | The path behaves like                                 | Selects                                        |
| ------- | ----------------------------------------------------- | ---------------------------------------------- |
| `code`  | the package's source                                  | every lane whose closure holds the package     |
| `tests` | a file only the package's own tests read              | only the lanes that list the package as a root |
| `name`  | a file the package reads as text, by name, at runtime | every lane whose closure holds the package     |

`code` and `name` reach the same lanes. Their word appears in the reason line and the job summary. `tests` reaches only lanes that list the package as a root.

In a docs-only change, every matching explicit `paths` row counts, whatever its `via`. Package placements do not count. A path claimed only by `docs-only.match` selects no lane. Markdown that a package reads at build or test time needs a `paths` row or a `docs-only.except` glob. Without either, a file such as `packages/api/src/welcome.md` selects nothing under this config.

## Workspace dependencies

A package is a directory that matches a workspace glob and holds a `package.json` with a `name`. pnpm `!` negations are honoured. The repository root is never a package. Dependencies come from `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`. Each value must be a string.

lane-router collects a safe larger set of dependency edges. It ignores version compatibility and keeps every workspace package an entry could name. For each entry:

1. Add the workspace package whose name matches the dependency key, whatever the specifier says.
2. Add a workspace package found through a local path. This includes `link:`, `file:`, bare paths and `workspace:` paths. A path that names no workspace package adds no path edge and is not an error. The loader never reads the target outside the discovered workspace.
3. Add any workspace name carried inside the specifier. For example, `"@acme/api": "npm:@acme/ui@^1"` adds both `@acme/api` and `@acme/ui`. The same name lookup covers `jsr:` and named-registry aliases. A version-only selector such as `npm:1.0.0` does not remove the key edge.
4. Expand a `catalog:` reference by dependency key, then apply the same rules to its value. Trim the catalog name and use `default` for an empty name. Missing entries and recursive catalog values retain the key edge. Empty top-level `catalog:` and `catalogs:` mappings act as missing ones. A null named catalog is invalid.

`workspace:`, `workspace:*`, `workspace:^`, `workspace:~` and workspace version ranges require the key's workspace package. Workspace aliases such as `workspace:@acme/ui@*` require the aliased package too. Aliases follow pnpm's workspace pattern, including names such as `3d` and `v1-compat`. An unresolved workspace name is an error naming the manifest and dependency key. A head workspace error fails the step. A base workspace error makes the change incomplete, so every lane runs.

Local paths in a manifest are relative to that manifest. Catalog path bases vary by pnpm version. The offline check with pnpm 11.18.0 resolves bare catalog paths relative to the declaring manifest and rejects `link:`, `file:` and `workspace:` catalog values. The [current pnpm catalog documentation](https://pnpm.io/catalogs#local-dependencies-in-a-catalog) describes root-relative local paths in later releases. lane-router includes candidates relative to both the declaring manifest and the workspace root.

The loader also reads `overrides` in `pnpm-workspace.yaml`, `pnpm.overrides` in the root `package.json`, and npm's root `overrides`, including nested objects and dependency references such as `$kit`. Every workspace package gets an edge to every workspace target an override could name. Override path candidates include the root and each workspace directory. This covers both root-relative replacements and replacements resolved at a nested consumer. An override can change a registry package's dependencies, which the loader cannot inspect.

A local directory outside the workspace packages needs [path rules](#config-reference) for any lanes that read it. If no rule claims a changed file there, `unmatched: all` runs every lane. See the [dependency limits](limitations.md#dependency-boundaries) for install-time changes the loader cannot see and the [decision record](decisions/008-dependency-superset.md) for the safety tradeoff.

The syntax follows the pnpm [workspace protocol](https://pnpm.io/workspaces), pnpm [package sources](https://pnpm.io/package-sources), pnpm [catalogs](https://pnpm.io/catalogs), npm [package spec](https://docs.npmjs.com/cli/v11/using-npm/package-spec/) and npm [local paths](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#local-paths).

Globs are [picomatch](https://github.com/micromatch/picomatch) globs, relative to the repository root, with posix separators and `dot: true`.

Validation reports every problem in one error, each with its line and column. These are problems:

- an unknown key, with the closest known key as a suggestion,
- a lane name that does not match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, or that is a fixed output name such as `lanes` or `matrix`,
- a package or lane name that does not exist,
- a row without `match`, with both or neither of `lanes` and `packages`, with `via` on a `lanes` row, without `via` on a `packages` row, or without `why`,
- a glob with a backslash, a leading `/`, a leading `!` or a `..` segment.
