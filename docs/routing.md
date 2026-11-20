# Routing

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

lane-router reads the base config and workspace when the routing config or a package manifest other than the root one changes. Each config resolves against its own workspace and supplies that graph's lane packages and extra edges. Changes to `pnpm-workspace.yaml` and the root `package.json` already select every lane. Other changes need no base commit, so a shallow checkout routes them precisely.

The base commit is the merge base the compare API reports for the event's range. The CLI uses the merge base of `--base` and `--head` in PR mode. In push mode that commit must equal `--base`. With the `files` input it is the `base` input, when one is given. lane-router reads the base graph from git in `working-directory`'s repository.

### The lane set

A config change selects the lanes in both configs. The plan lists head lanes in head config order, then lanes found only in base, in base config order. A removed lane runs with the reason `removed from the routing config in this change`. It appears in the per-lane outputs, `lanes`, matrix and summary. Renaming a lane keeps the old name for this change and adds the new one.

Changing a lane's packages or removing its `floor` flag cannot remove its base coverage. The base graph uses its original packages, and a lane is a floor if either config says so. The config change itself selects every lane in the combined set. See [the decision record](decisions/007-base-and-head-lanes.md).

If the config is new and absent at an available base commit, the head lanes are the whole set. An unreadable or invalid base config makes the plan incomplete and runs every known head lane. A missing base config is an error unless the changed paths include the config.

Rules about the whole change come after that.

- **Docs-only.** A change is docs-only when it has at least one path and every path is docs. In a docs-only change, built-in files and every matching explicit `paths` row count, whatever its `via`. A row says that the lane reads those files. Package placements do not count, and a path claimed only by `docs-only.match` selects no lane. Markdown that a package reads at build or test time needs a `paths` row or a `docs-only.except` glob. For example, `packages/api/src/welcome.md` selects nothing under the fixture config until one of those rules covers it. See [the decision record](decisions/006-explicit-rows-in-docs-only-changes.md).
- **Floor.** A lane with `floor: true` runs for every change that has paths and is not docs-only.
- **Empty.** A change with no paths requires no lane.
- **Renames.** The old and the new path are both changed paths.
