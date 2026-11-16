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

`code` and `name` reach the same lanes. They differ only in the word the reason line prints. `tests` reaches only lanes that list the package as a root.

In a docs-only change, every matching explicit `paths` row counts, whatever its `via`. Package placements do not count. A path claimed only by `docs-only.match` selects no lane. Markdown that a package reads at build or test time needs a `paths` row or a `docs-only.except` glob. Without either, a file such as `packages/api/src/welcome.md` selects nothing under this config.

A package is a directory that matches a workspace glob and holds a `package.json` with a `name`. pnpm `!` negations are honoured. The repository root is never a package. Dependencies come from `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`. Each value must be a string.

Dependency specifiers have three kinds. Lookup ignores version compatibility, which can run extra lanes.

- **Must be local.** Every `workspace:` form, `link:`, `file:` and bare local paths must resolve to a discovered package. `workspace:`, `workspace:*`, `workspace:^`, `workspace:~` and workspace version ranges use the key. Workspace aliases such as `"ui": "workspace:@acme/ui@*"` use the target name. Local paths use the directory relative to the declaring manifest.
- **May be local.** Ordinary versions, ranges and tags use the key. Registry aliases such as `npm:@acme/ui@^1`, `jsr:@acme/ui@1`, `gh:@acme/ui` and `corp:@acme/ui@^1` use the target name. Scoped and unscoped npm aliases work, with or without a version. A JSR selector without a target name, such as `jsr:^1`, `jsr:1.0.0` or `jsr:latest`, uses the key. A named-registry tag paired with a scoped key also uses that key. A workspace match keeps the dependency edge. A missing match is an external dependency and is ignored.
- **Never local.** Git sources, remote tarballs and provisioned tools name no workspace target. They retain the conservative lookup by key and are ignored when that key is not a workspace package. lane-router does not inspect their contents.

A missing must-be-local target is a workspace error that names the manifest and dependency key. This includes local archives, absolute paths, home-relative paths and paths outside the workspace. Directory lookup uses the discovered workspace, without reading outside it. A head workspace error fails the step. A base workspace error makes the change incomplete, so every lane runs.

`catalog:`, `catalog:default` and named catalogs such as `catalog:react19` select an entry by dependency key in `pnpm-workspace.yaml`. The entry is classified by the same rules. Version ranges need only key lookup. Aliases and local references need their expanded target. Catalog paths are relative to the workspace root. A missing entry or a recursive catalog reference retains key lookup and is ignored when the key is not a workspace package.

The syntax follows the pnpm [workspace protocol](https://pnpm.io/workspaces), pnpm [package sources](https://pnpm.io/package-sources), pnpm [catalogs](https://pnpm.io/catalogs), npm [package spec](https://docs.npmjs.com/cli/v11/using-npm/package-spec/) and npm [local paths](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#local-paths).

Globs are [picomatch](https://github.com/micromatch/picomatch) globs, relative to the repository root, with posix separators and `dot: true`.

Validation reports every problem in one error, each with its line and column. These are problems:

- an unknown key, with the closest known key as a suggestion,
- a lane name that does not match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, or that is a fixed output name such as `lanes` or `matrix`,
- a package or lane name that does not exist,
- a row without `match`, with both or neither of `lanes` and `packages`, with `via` on a `lanes` row, without `via` on a `packages` row, or without `why`,
- a glob with a backslash, a leading `/`, a leading `!` or a `..` segment.
