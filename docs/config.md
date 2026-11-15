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

| `via`   | The path behaves like                                 | Selects                                        | Counts in a docs-only change |
| ------- | ----------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| `code`  | the package's source                                  | every lane whose closure holds the package     | no                           |
| `tests` | a file only the package's own tests read              | only the lanes that list the package as a root | no                           |
| `name`  | a file the package reads as text, by name, at runtime | every lane whose closure holds the package     | yes                          |

A package is a directory that matches a workspace glob and holds a `package.json` with a `name`. pnpm `!` negations are honoured. The repository root is never a package. Dependencies come from `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`, whatever the version specifier.

Globs are [picomatch](https://github.com/micromatch/picomatch) globs, relative to the repository root, with posix separators and `dot: true`.

Validation reports every problem in one error, each with its line and column. These are problems:

- an unknown key, with the closest known key as a suggestion,
- a lane name that does not match `^[A-Za-z0-9][A-Za-z0-9_-]*$`, or that is a fixed output name such as `lanes` or `matrix`,
- a package or lane name that does not exist,
- a row without `match`, with both or neither of `lanes` and `packages`, with `via` on a `lanes` row, without `via` on a `packages` row, or without `why`,
- a glob with a backslash, a leading `/`, a leading `!` or a `..` segment.
