# lane-router

lane-router works out the smallest set of CI test lanes a change can affect in a JavaScript monorepo. It explains every decision, and it runs every lane when it cannot be sure. It ships as a GitHub Action and as a CLI that makes the same decisions on a local diff.

## The problem

A monorepo CI usually runs every test lane on every change. Most changes touch one package, so most of that time goes to lanes the change cannot affect.

Skipping a lane is safe only when you can show that nothing it reads changed. A lane reads its own packages, their workspace dependencies, and files that no manifest mentions, such as code generators, test fixtures and docs served by name. A wrong skip is worse than a slow build, because it merges a break that no lane tested.

## Why path filters are unsafe

The usual tool is a path filter on each workflow, such as `paths: ["packages/web/**"]`. It fails open in three ways.

- **It does not follow dependencies.** A filter on `packages/web/**` does not fire for a change in `packages/ui`, even when `@acme/web` imports `@acme/ui`. Someone has to keep every filter in step with the dependency graph by hand.
- **A path that no filter lists runs nothing.** A new top-level file, a renamed directory or a new config file matches no filter, so no lane tests it.
- **It does not run when a diff is very large.** The GitHub docs on [triggering a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) say that if a diff has more than 3,000 files and the matching files are not in the first 3,000, the workflow does not run.

lane-router handles each case. It follows dependencies, it runs every lane for a path that nothing claims, and it runs every lane when it cannot trust the file list.

## How routing works

```
changed paths --> placements per path --> one decision per lane --> outputs
                  built-in                run, with every reason     lanes, matrix,
                  paths rows              skip, with one reason      reasons, one per lane,
                  package                                            summary, explain
                  docs
                  unmatched
```

Each changed path gets every placement that applies to it.

1. **Built-in.** The path is the routing config, `pnpm-workspace.yaml`, the root `package.json`, or a root lockfile: `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` or `bun.lock`. It selects every lane, and its reason says which file it is, such as `pnpm-workspace.yaml defines the workspace`. No row can turn this off, because a change could otherwise rewrite the routing that judges it.
2. **Rows.** Every `paths` row whose `match` hits the path applies, inside a package or not. Rows add up.
3. **Package.** The path is inside a workspace package. The deepest package directory wins. It selects every lane whose closure holds that package.
4. **Docs.** The path matches `docs-only.match` and no `docs-only.except` glob. It is known and selects no lane by itself.
5. **Unmatched.** Nothing above placed the path. It selects every lane.

A lane's closure is its root packages, their workspace dependencies, and the configured extra edges, all followed transitively. When a lane reads a package indirectly, its reason names the chain, for example `packages/ui/src/button.tsx is in @acme/ui, read through @acme/web-e2e > @acme/web`.

### The base graph

A change could reshape the graph that judges it. Say a pull request renames `@acme/ui` in `packages/ui/package.json` and edits `packages/ui/src/button.tsx`. `@acme/web` still depends on `@acme/ui` by name, which no longer resolves, so in the new graph no lane reads the button.

So a change is judged against two graphs. The head graph is the workspace the change ends in. The base graph is the workspace at the commit the change was diffed from. A lane's closure is the union of its closure in each graph, worked out in each graph on its own. A path inside a package reaches the lanes that read its head package or its base package, so a package that exists only in base still owns its directory. When a lane reads a path only in the base graph, its reason says so: `packages/ui/src/button.tsx is in @acme/ui, read through @acme/web in the base graph`.

The graph comes from the config, `pnpm-workspace.yaml`, the root `package.json` and the package manifests. The first three are built in and select every lane. So lane-router reads the base graph only when a package manifest other than the root one changed. Every other change needs no base commit, so a shallow checkout routes it precisely.

The base commit is the merge base the compare API reports for the event's range. The CLI uses the merge base of `--base` and `--head`. With the `files` input it is the `base` input, when one is given. lane-router reads the base graph from git in `working-directory`'s repository.

Rules about the whole change come after that.

- **Docs-only.** A change is docs-only when it has at least one path and every path is docs. In a docs-only change, only the placements that read a file as text count. Those are the built-in files, `lanes` rows and `via: name` rows. Package placements and `via: code` or `via: tests` rows do not count, because Markdown is not compiled.
- **Floor.** A lane with `floor: true` runs for every change that has paths and is not docs-only.
- **Empty.** A change with no paths requires no lane.
- **Renames.** The old and the new path are both changed paths.

## Config reference

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

## Outputs

Every output is a string, as Actions requires.

| Output          | Value                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `lanes`         | A JSON array of the lanes that run, in config order.                                                      |
| `matrix`        | A JSON object `{"include":[{"lane","base","reason"}]}` for `strategy.matrix`. `base` is the event's base. |
| `<lane>`        | `run` or `skip`, one output per lane, keyed by the lane name.                                             |
| `reasons`       | A JSON object from every lane name to its one-line reason.                                                |
| `complete`      | `true` when the list of changed files was complete.                                                       |
| `docs-only`     | `true` when the event's change was docs-only.                                                             |
| `none-required` | `true` when no lane runs.                                                                                 |

Every lane in `matrix` gets the same `base`. It is the `base` input when one is set, else the pull request's base SHA or the push's `before`. It is empty when there is none.

The step also writes a job summary. It opens with a line that gives the mode, base, head, file count, completeness and docs-only state. A table with one row per lane follows.

### Use the outputs in a workflow

`OWNER` is the account that hosts this repository. The `test` job uses `none-required` to skip the matrix when no lane runs.

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    outputs:
      matrix: ${{ steps.lanes.outputs.matrix }}
      none-required: ${{ steps.lanes.outputs.none-required }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: lanes
        uses: OWNER/lane-router@v0

  test:
    needs: plan
    if: needs.plan.outputs.none-required != 'true'
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - run: npm run "test:${{ matrix.lane }}"
```

### Inputs

| Input               | Default               | Meaning                                                                                                                            |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `config`            | `.github/lanes.yml`   | The routing config, relative to `working-directory`.                                                                               |
| `working-directory` | `.`                   | The repository root to read the config and the workspace from.                                                                     |
| `base`, `head`      | the event's           | The revisions to compare. Setting either skips the pull request file-count check.                                                  |
| `files`             | empty                 | Newline-separated changed paths, relative to `working-directory`. They are trusted as complete, and the compare API is not called. |
| `token`             | `${{ github.token }}` | The token for the compare endpoint.                                                                                                |
| `mode`              | from the event        | `pr` or `push`. Must match a `pull_request`, `pull_request_target` or `push` event. Required for any other event.                  |

The token needs only `contents: read`, which the compare endpoint requires.

The Action reads the config and the workspace from the checked-out tree. On a pull request the default checkout is the merge commit, which is also what CI tests.

## Fail-closed guarantees

A wrong skip merges an untested break. lane-router runs every lane, and says why in each reason, for a change that holds:

- a changed path that no placement claims,
- a built-in file: the routing config, `pnpm-workspace.yaml`, the root `package.json` or a root lockfile.

It also runs every lane when it cannot trust the list of changed files. Then `complete` is `false`, an annotation gives the cause, and the step succeeds so the lanes run. These are the cases:

- a package manifest change whose base graph cannot be built, because there is no base commit, the commit was not fetched, a manifest there does not parse, a name in the config does not resolve there, or reading it failed,
- a compare listing of 300 or more files, which is the most the endpoint returns,
- a pull request whose compare listing differs from its `changed_files` count,
- a push with no `before` commit to compare against, such as the first push of a branch, whose `before` is all zeros,
- a push whose head does not extend its base, such as a force push,
- a compare status other than `ahead`, `identical`, `behind` or `diverged`,
- a changed path outside `working-directory`,
- any API error, git error or unexpected exception after the config has loaded.

A push is routed from `before` to `after`, and the compare API lists the change from the merge base of the two. After a force push the merge base is not `before`, so the listing leaves out what the dropped commits changed. In push mode lane-router trusts the listing only when the compare API reports `ahead` or `identical` and the merge base is the base commit. That holds for a `base` input in push mode too. A `mode` input that contradicts its event fails the step, so a push cannot opt out of this rule. A pull request is exempt, because its base branch often moves on after it opens and its change is meant to start at the merge base.

A shallow checkout, the `actions/checkout` default, has no base commit. A change to a package manifest then runs every lane. Check out with `fetch-depth: 0` to keep those changes precise. Other changes never need the base commit.

A config or workspace error is different. The lane names are unknown, so lane-router fails the step and lists every problem. Downstream jobs never start, so the build stays red and no lane is skipped by mistake.

The code enforces the rule as well. A skip decision and a complete file list each carry a key that only one module can name, so no other code can construct either one. `npm run typecheck` checks this in `test/type-claims.ts`. Every other module can build only a decision to run.

### Reading the repository

A pull request controls every file lane-router reads, and the Action may run in a privileged workflow such as `pull_request_target`. lane-router reads only inside the repository root, and it never shows what a file holds.

- A path that is absolute, contains a backslash, has a `.` or `..` segment, or is inside `.git` is never read. This applies to the `config` input too.
- A symbolic link is never followed. In a checked-out directory, a file that is a link is refused, and so is a file whose real path is outside the root, which catches a linked parent directory. A linked directory is never walked into. In a git commit, an entry stored as a link or a submodule is refused.
- A workspace glob with a `..` segment is a config problem.
- A refused read is a problem that names the path and the reason, such as `packages/api/package.json  is a symbolic link`. The Action fails the step and the CLI exits with 1, as for any other config or workspace error.
- No problem, annotation, job summary or output quotes a file. A parse error gives the file, the line and column when they are known, and a fixed reason such as `is not valid JSON`. A message may still name a lane or package that the config refers to.

## Run locally

The CLI makes the decisions the Action would make in PR mode for a local diff. It reads the config and the workspace at `--head`, not from the working tree.

```sh
npm ci
npm run build
node dist/cli.js explain --base origin/main --head HEAD
```

```
lane-router explain --base <ref> --head <ref> [--config <path>] [--cwd <dir>] [--json]
```

The CLI exits with 0 when it printed a plan, fail-closed plans included. It exits with 1 when the config or the workspace does not load, and with 2 on a usage error. `--json` prints the plan as a JSON document.

To see a full explanation, run `npm run demo`. It commits a change to the `acme` fixture in a temporary git repository and runs the built CLI on it. The commit SHAs differ on every run. The rest of the output looks like this:

```
lane  decision  reason
api   run       docs/api/users.md matches paths[3] for @acme/api via name: The api serves these files by name.
web   run       docs/api/users.md matches paths[3] for @acme/api via name, read through @acme/web: The api serves these files by name. (+2 more)
e2e   run       docs/api/users.md matches paths[3] for @acme/api via name, read through @acme/web-e2e > @acme/web: The api serves these files by name. (+1 more)
lint  run       floor lane, runs for every change that is not docs-only

.vscode/settings.json
  paths[6]                      no lane        Editor settings affect no lane.
README.md
  docs                          no lane
docs/api/users.md
  paths[3] @acme/api via name   api, web, e2e  The api serves these files by name.
  docs                          no lane
fixtures/browser/login.json
  paths[2] @acme/web via tests  web            The browser tests load these fixtures.
packages/ui/src/button.tsx
  package @acme/ui              web, e2e
```

To work on lane-router itself, use these commands. CI runs all of them and fails if `dist/` differs from a fresh build.

```sh
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

## Not in v0.1: skipping lanes that already passed

A push to `main` could skip a lane that already passed on an earlier commit, when nothing the lane reads changed since then. lane-router v0.1 does not do this. It routes every push from `before` to `after`, the same way it routes a pull request.

Such a skip needs proof that the lane passed. The record of a past run that lane-router can read is metadata in the GitHub API: a check run's name and app, and the event and branch of the workflow run behind it. That metadata can be forged or confused:

- Any GitHub App with `checks: write` can create a passing check run with the lane's name.
- Any other workflow in the repository can do the same.
- A tag can have the same name as a branch. A run for a push of the tag `main` reports the branch `main`.
- Refs change between the run and the check. A tag named like the branch can be deleted before lane-router looks, and the API shows only the refs that exist now.

Each extra check on the metadata closes one gap and leaves the others open. A safe version needs a proof that the lane itself signs and records when it passes. That is future work.

## What's next

These are not built:

- Workspace discovery reads pnpm and npm files only. Yarn and Bun also use the `workspaces` field, so `discovery: npm` may read them, but no test covers it.
- Dependencies come from manifests and configured edges. Imports in source files are not read.
- `unmatched` accepts only `all`.
- A compare listing of 300 or more files fails closed. Paging through a larger diff would let such a change skip lanes safely.
- A `merge_group` event needs `mode`, `base` and `head` set by hand.
- There is no release tag and no Marketplace listing yet.

## Origin

Dan, write this section in your own words.
