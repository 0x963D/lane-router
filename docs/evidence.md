# Routing evidence

The planner soundness, field replay and release mutation figures on this page are for `v0.1.1`. The Action checks cover the range and file listing before planning.

lane-router promises to skip a CI lane only when the change cannot affect the inputs the lane declares. When it cannot make that decision safely, it runs the lane.

- **Soundness oracle.** No false skip in 250,000 generated changes within the model of declared inputs. All 16 injected bugs produced a false skip.
- **Field replay.** 4,800 plans across 24 real repositories, with no discovery mismatches or skips in fallback plans. The replay checks plans without executing test lanes.
- **Mutation testing.** 96.57% of eligible decision-code mutations caused a test failure or timeout. The `v0.1.0` score was 77.26%. Each score covers its named files.

## Pull request merge paths

In `v0.1.1`, the default pull request checkout was a merge commit, but the Action used the pull request branch's changed paths. If the base branch moved a file that the pull request edited, the Action could skip the lane for the file's destination in the tested merge.

The 250,000 generated changes did not find this bug. The oracle tests planning with a supplied workspace model and file list. It does not test whether the Action gets the diff for the tree that CI checks out.

The bug surfaced while [replaying lane-router on the author's own CI history](own-history.md). In the [checkout regression matrix](../test/action-pr-checkout.test.ts), `v0.1.1` skips the API lane for a file the base branch moved into the API package. The matrix reproduces the skip on both pull request events. The directory rename fixture has its own category because Git needs `merge.directoryRenames=true` to resolve that merge. The matrix also labels cases that check the new range rules.

The matrix uses depth-1 clones for default merge checkouts on both pull request events. It checks the exact lane list from the first-parent diff, including when the payload base differs, and requires `complete=true` with no annotation. It covers the payload-base fallback when the checkout has one parent, three parents, or a different second parent. A manifest change uses the first parent's model in a full checkout and gives fetch-depth advice when the parent object is missing. The [Action tests](../test/action.test.ts) also check requested ranges and the file count check for the pull request head.

The matrix answers compare requests from a local fixture. The `compare` job in [this repository's CI](../.github/workflows/ci.yml) calls the real endpoint on every pull request, from the default shallow checkout. It checks that the plan starts at the merge's first parent and that the endpoint returned a listing.

## Action soundness

The [Action oracle](../scripts/check-action-soundness.js) runs the built Action in a fresh process with a real checkout. Its loopback compare endpoint resolves requested commits and lists the merge-base diff with Git rename detection. The oracle independently compares blob IDs and modes from both tree inventories and reads package dependencies and lane names from the fixture's committed manifests and config.

Each seed changes the package roles, file names and size of a capped diff. Its cases include base-branch moves, cross-package renames, deletes, config and dependency changes, stale and newer payloads, full and depth-1 checkouts, and all combinations of base, head and supplied files. Fail-closed cases require every known lane and a reason. The cases with a verifiable range require the exact lane set, including skips. The suite does not model GitHub's internal rename heuristics, other package managers, or edits to a checkout after Git creates it.

At seed `20261120`, the release baseline passed 42 cases with no false skips. It produced 23 exact plans, 17 fail-closed plans and two usage errors. The exact plans included 50 skips. The 12-history sample starting at seed `20261120` passed 504 cases with 276 exact plans, 204 fail-closed plans, 24 usage errors and 600 skips. The CI sample runs one history. Use an output directory to save one row per completed seed. Reuse the seed and output directory with the same bundle and a larger history count to extend the run.

```sh
npm run build
npm run test:action-soundness
node scripts/check-action-soundness.js --seed 20261120 --histories 12 --output coverage/action-sample
npm run test:action-soundness:mutations
```

The fault check needs the `v0.1.1` tag to run that release's committed Action bundle. It also builds one bundle per injected source change. A counterexample includes the seed, compare requests, expected lanes and observed outputs.

The automated Action seam campaign mutates `src/action.ts`, the GitHub, Git and directory adapters, and the path list boundary in `src/core/change.ts`. The campaign runs the Action and CLI against fast protocol fixtures. The built-Action oracle above runs separately with real Git and HTTP. The first run scored 61.15% (541 killed by tests, 10 timeouts, 242 survivors, 108 uncovered). After adding tests for supplied paths, nested roots and error handling, the run scored 68.81% (609 killed by tests, 11 timeouts, 222 survivors, 59 uncovered). Both runs assessed 901 eligible mutations. The scores include timeouts and the workers differed between runs.

```sh
VITEST_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=640 node scripts/test-mutation.js --scope seam --workers 2
node scripts/mutation-report.js "$report_path" --details
```

## Soundness oracle

The oracle derives required runs from the generated scenario before passing manifests, config, and changed paths to lane-router. It computes reachability by scanning edges repeatedly and imports no production code. Any required lane that skips fails the run at the first such case and prints the counterexample.

|   Cases | Required lane verdicts | Cases with a graph-dependent verdict | Graph-dependent share of required verdicts |
| ------: | ---------------------: | -----------------------------------: | -----------------------------------------: |
|   5,000 |                 19,340 |                       3,435 (68.70%) |                                     30.16% |
| 250,000 |                967,320 |                     169,729 (67.89%) |                                     30.24% |

A verdict is graph-dependent when a non-floor lane needs to run solely because it reads a changed package through a dependency. An all-lane fallback, matching path rule, or changed lane root would require that run without the edge. The generator emphasizes cases where the graph can change the verdict.

The oracle checks required runs for these cases.

- Direct and transitive edges from all four manifest dependency fields and configured edges, including cycles and deepest package ownership.
- Both graphs when a changed package manifest renames a dependency target, and both paths in a file rename.
- Package and lane rows, including `lanes: all`, overlapping rows, and rows matching a path inside a package. The `tests` target uses only roots. The `code` and `name` targets use the closure.
- Floor lanes on ordinary changes, unclaimed paths, and the root `package-lock.json` even when a docs rule matches it. Docs-only changes still honor rows and built-in paths. Empty changes require no runs.

The [routing](../test/routing.test.ts), [base graph](../test/base-graph.test.ts), [base config](../test/base-config.test.ts), and [workspace](../test/workspace.test.ts) tests cover cases outside the oracle, including incomplete diffs, other built-in files, package deletions, changed configs and removed lanes, explicit rows with an empty lane list, and docs exclusions. Those tests also check reasons and workspace discovery cases such as pnpm declarations, aliases, local paths, catalogs, and overrides. The oracle allows extra runs. It cannot infer undeclared imports or inputs introduced during installation.

The [injection check](../scripts/check-soundness-mutations.js) tests the original code and the 16 reviewed bugs individually in a temporary copy. All 16 produced a false-skip counterexample. The CI check job runs the same injection check.

## Field replay

The replay completed 4,800 plans and skipped 7,138 of 105,611 lane verdicts. The build agreed with an independent package inventory on every audited revision. No CLI plan was rejected or crashed. Every plan with a built-in, unmatched-path, or incomplete-change fallback ran all its lanes.

The replay uses consecutive first-parent revisions from pinned repository tips. It creates a lane for each workspace package with a string-valued `test` script and adds a floor lane. Seven repositories had only the floor lane throughout their replay. Those 1,400 plans check discovery and stability. They have no package test lane to route. The generated configs have no project-specific path rules, so many outside-package paths run every lane. The replay observes routing decisions without executing any of the repository tests.

### What the replay fixed

The first replay exposed three failures in `v0.1.0`. All three fixes are in the code for `v0.1.1`.

- pnpm workspaces with repeated names failed to load. Each directory now keeps its placement and a reference to the shared name includes every copy's dependencies. [Repeated-name regression](../test/workspace.test.ts#L566)
- Manifests with a UTF-8 byte order mark failed to parse. The loader now strips the leading mark before validation. [Manifest regression](../test/workspace.test.ts#L580)
- The CLI threw `Invalid string length` when it serialized a very large pnpm workspace plan as one JSON string. It now writes the explanation in parts and waits for the output sink. [Streaming regression](../test/cli.test.ts#L19)

<details>
<summary>Repositories, commits, and results</summary>

A fallback counts once per plan. Its reason counts can overlap.

| Repository at replay tip                                                                                                                                     | Workspace | Head packages / test lanes | Discovery mismatches |       Plans | Skipped / lane verdicts | Fallbacks and reasons                                                   | Rejected / crashed |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------------------: | -------------------: | ----------: | ----------------------: | ----------------------------------------------------------------------- | -----------------: |
| [babel/babel @ bf3497da72a3](https://github.com/babel/babel/commit/bf3497da72a3c6385d049675955ffdb6b81c5fa0)                                                 | yarn      |                    165 / 0 |                    0 |   200 / 200 |                 0 / 200 | 84 (lockfile 23, root 17, unmatched 62)                                 |              0 / 0 |
| [changesets/changesets @ 9a035ec36045](https://github.com/changesets/changesets/commit/9a035ec36045aeb6141dd0bbac9ab9e3c69ac0bc)                             | pnpm      |                     24 / 1 |                    0 |   200 / 200 |                 2 / 216 | 172 (config 1, lockfile 39, root 25, workspace 12, unmatched 152)       |              0 / 0 |
| [effect-ts/effect @ 0daa5aa98f3c](https://github.com/effect-ts/effect/commit/0daa5aa98f3c08c069ffe05e6e4d0e86866fe75f)                                       | pnpm      |                     47 / 0 |                    0 |   200 / 200 |                 0 / 200 | 184 (lockfile 4, root 3, workspace 2, unmatched 184)                    |              0 / 0 |
| [microsoft/playwright @ 8124fc39233c](https://github.com/microsoft/playwright/commit/8124fc39233c4c349b9dbebd4abc4103738eae81)                               | npm       |                     16 / 0 |                    0 |   200 / 200 |                 0 / 200 | 179 (lockfile 5, root 3, unmatched 174)                                 |              0 / 0 |
| [npm/cli @ cfd03796843c](https://github.com/npm/cli/commit/cfd03796843cc9ae26c7034ab99bae6c002a4ba4)                                                         | npm       |                    16 / 16 |                    0 |   200 / 200 |              354 / 3400 | 160 (lockfile 89, root 67, unmatched 150)                               |              0 / 0 |
| [pnpm/pnpm @ b0a7dac0fe88](https://github.com/pnpm/pnpm/commit/b0a7dac0fe88264cdef0f258cdb755d5d28c4a8f)                                                     | pnpm      |                  236 / 221 |                    0 |   200 / 200 |             625 / 44394 | 197 (config 1, lockfile 19, root 5, workspace 1, unmatched 197)         |              0 / 0 |
| [puppeteer/puppeteer @ 4ee6cff57442](https://github.com/puppeteer/puppeteer/commit/4ee6cff57442b7e03f7b27fb8018ee5ebaeab68b)                                 | npm       |                     10 / 3 |                    0 |   200 / 200 |               261 / 800 | 109 (lockfile 31, root 10, unmatched 91)                                |              0 / 0 |
| [reduxjs/redux-toolkit @ 1a7d3b5251ce](https://github.com/reduxjs/redux-toolkit/commit/1a7d3b5251ceda61b77928e357a22086b45aaab1)                             | pnpm      |                      9 / 8 |                    0 |   200 / 200 |              489 / 2097 | 46 (config 2, lockfile 26, root 8, workspace 3, unmatched 35)           |              0 / 0 |
| [rollup/plugins @ b09437adcd70](https://github.com/rollup/plugins/commit/b09437adcd7010c2a6cd20c778be0e4626f640f3)                                           | pnpm      |                    31 / 31 |                    0 |   200 / 200 |             2435 / 6400 | 32 (lockfile 21, root 7, workspace 1, unmatched 15)                     |              0 / 0 |
| [sveltejs/kit @ c5cc48f1a09b](https://github.com/sveltejs/kit/commit/c5cc48f1a09bda4698a81ed094b728f4e2d7da6e)                                               | pnpm      |                    74 / 30 |                    0 |   200 / 200 |               43 / 6441 | 194 (config 4, lockfile 37, root 14, workspace 15, unmatched 180)       |              0 / 0 |
| [sveltejs/svelte @ dc5d1dc76bd1](https://github.com/sveltejs/svelte/commit/dc5d1dc76bd104c44673f4d88d852b472b3e2803)                                         | pnpm      |                      2 / 0 |                    0 |   200 / 200 |                 0 / 200 | 171 (lockfile 7, root 3, unmatched 167)                                 |              0 / 0 |
| [TanStack/query @ 7ed5ea920e12](https://github.com/TanStack/query/commit/7ed5ea920e124ca8aa117b295851ad199b83ff97)                                           | pnpm      |                    205 / 0 |                    0 |   200 / 200 |                 0 / 200 | 156 (lockfile 73, root 3, workspace 14, unmatched 132)                  |              0 / 0 |
| [TanStack/router @ 0b6d4f3f6b42](https://github.com/TanStack/router/commit/0b6d4f3f6b42e704555d9ff0014ddbf8b44f8e09)                                         | pnpm      |                   313 / 25 |                    0 |   200 / 200 |              257 / 5332 | 178 (config 1, lockfile 46, root 5, workspace 9, unmatched 175)         |              0 / 0 |
| [TanStack/table @ 564a459b7483](https://github.com/TanStack/table/commit/564a459b74834c77631e0d6fdba7661383bbc1b4)                                           | pnpm      |                    418 / 2 |                    0 |   200 / 200 |                17 / 600 | 155 (lockfile 35, root 22, workspace 9, unmatched 151)                  |              0 / 0 |
| [trpc/trpc @ e57a6448bdb6](https://github.com/trpc/trpc/commit/e57a6448bdb67fb5ceabcc5cf601cb74b25b8c92)                                                     | pnpm      |                     56 / 2 |                    0 |   200 / 200 |               134 / 777 | 55 (config 1, lockfile 36, root 6, workspace 11, unmatched 26)          |              0 / 0 |
| [typescript-eslint/typescript-eslint @ a53584297a1f](https://github.com/typescript-eslint/typescript-eslint/commit/a53584297a1fa65f4cc91387b0a7da834ab73ed7) | pnpm      |                    19 / 16 |                    0 |   200 / 200 |             1057 / 3400 | 113 (lockfile 76, root 47, workspace 3, unmatched 42)                   |              0 / 0 |
| [vercel/ai @ 486e08f0446a](https://github.com/vercel/ai/commit/486e08f0446a5986c2f6fd5bcf8c9b00770e51f7)                                                     | pnpm      |                   123 / 89 |                    0 |   200 / 200 |             652 / 17438 | 192 (config 4, lockfile 11, root 1, workspace 2, unmatched 190)         |              0 / 0 |
| [vercel/turborepo @ 9e884b49f67f](https://github.com/vercel/turborepo/commit/9e884b49f67f11bd449ea4e2d54dffa7a04afb6d)                                       | pnpm      |                     20 / 1 |                    0 |   200 / 200 |                30 / 400 | 170 (lockfile 17, unmatched 153)                                        |              0 / 0 |
| [vitejs/vite @ d7dfe9b7beed](https://github.com/vitejs/vite/commit/d7dfe9b7beedb756f56e509ed425e18af2aa065c)                                                 | pnpm      |                    275 / 0 |                    0 |   200 / 200 |                 0 / 200 | 50 (lockfile 35, root 18, workspace 9, unmatched 23)                    |              0 / 0 |
| [vitest-dev/vitest @ 19d62e36d618](https://github.com/vitest-dev/vitest/commit/19d62e36d618054736c4b544bda353a90294c850)                                     | pnpm      |                    41 / 25 |                    0 |   200 / 200 |              411 / 5155 | 42 (config 1, lockfile 22, root 8, workspace 17, unmatched 20)          |              0 / 0 |
| [vuejs/core @ 148fdacdc3a6](https://github.com/vuejs/core/commit/148fdacdc3a67aaa2b8d1b615da227c3fcc2df53)                                                   | pnpm      |                     17 / 0 |                    0 |   200 / 200 |                 0 / 200 | 63 (lockfile 41, root 31, workspace 15, unmatched 26)                   |              0 / 0 |
| [vuejs/pinia @ 4817135a2543](https://github.com/vuejs/pinia/commit/4817135a25431172d363bd928476db7cdbf875c4)                                                 | pnpm      |                      7 / 1 |                    0 |   200 / 200 |                60 / 400 | 92 (lockfile 41, root 34, workspace 3, unmatched 52)                    |              0 / 0 |
| [vuejs/router @ 4f8fc1bcdef6](https://github.com/vuejs/router/commit/4f8fc1bcdef619b832b55caf9e5583b441ce71a1)                                               | pnpm      |                      5 / 1 |                    0 |   200 / 200 |                37 / 400 | 21 (lockfile 9, root 8, workspace 5, unmatched 17)                      |              0 / 0 |
| [withastro/astro @ 01c942da6308](https://github.com/withastro/astro/commit/01c942da6308d5b89bd5e3910559f7c255acae20)                                         | pnpm      |                   601 / 37 |                    0 |   200 / 200 |              274 / 6561 | 185 (config 2, lockfile 71, root 10, workspace 5, unmatched 158)        |              0 / 0 |
| **Total (24 repositories)**                                                                                                                                  |           |                            |                    0 | 4800 / 4800 |           7138 / 105611 | 3000 (lockfile 814, root 355, unmatched 2572, config 17, workspace 136) |              0 / 0 |

</details>

## Mutation testing

Each mutation changes the source and reruns tests against it. The score counts failing tests and timeouts over all eligible mutations, including survivors and mutations with no coverage. Runtime errors are reported separately. Timeouts can vary between runs. A surviving mutation can indicate equivalent behavior or a missing assertion.

| Scope and release               |  Score | Eligible | Killed by a failing test | Timeouts | Survived | No coverage | Runtime errors |
| ------------------------------- | -----: | -------: | -----------------------: | -------: | -------: | ----------: | -------------: |
| Decision code at `v0.1.0`       | 77.26% |      431 |             332 (77.03%) |        1 |       64 |          34 |              1 |
| Decision code at `v0.1.1`       | 96.57% |      437 |             421 (96.34%) |        1 |       10 |           5 |              1 |
| Workspace discovery at `v0.1.1` | 84.78% |      460 |             390 (84.78%) |        0 |       66 |           4 |              0 |

The release comparison mutates `src/core/`. Workspace discovery is outside that comparison. A separate run mutates `src/load/workspace.ts`. Both scopes use the routing, invariant, rendering, and workspace tests from the version under test. No score is published for `src/` as a whole. The [package-manager link audit](limitations.md#dependency-boundaries) separately checks installed links against discovered edges.

<details>
<summary>What remained in the release campaigns</summary>

In the decision-code campaign, the surviving mutations changed private type brands, an empty glob shortcut, already-validated graph lookups, an extra queue entry with no edges, or a lookup beyond the last possible package directory. The uncovered mutations were in exhaustive switch defaults and an absent graph entry. The timeout made a directory walk advance in the wrong direction. The runtime error removed the visited guard from a traversal of a cyclic graph.

In workspace discovery, survivors include alternative dependency-specifier matches and validation branches. The suite exercises the catalog, local-link, override, and inventory cases added after the first survey. The remaining cases include gaps as well as equivalent changes.

The report command below lists each mutation by file and location.

</details>

## Reproduce

Use Node 24.14.0, Git with `clone --revision`, and a configured Git commit identity for the replay overlays. The commands below use a POSIX-compatible shell, one mutation worker, and one repository at a time. Mutation and replay runs can resume from their saved output directories.

```sh
git switch --detach v0.1.1
npm ci
NODE_OPTIONS=--max-old-space-size=640 npm run test:soundness:mutations
NODE_OPTIONS=--max-old-space-size=640 node scripts/check-soundness.ts 250000
```

The large run's [saved output](evidence-soundness.json) includes the seed and verdict totals.

```sh
npm run build
NODE_OPTIONS=--max-old-space-size=768 node scripts/field-replay.js --root ../lane-router-field --output coverage/field-replay
node scripts/field-summary.js coverage/field-replay/summary.json
```

Run the mutation campaigns from the release checkout. For each run, set `report_path` to its printed report path before invoking the summary command.

```sh
export VITEST_MAX_WORKERS=1
export NODE_OPTIONS=--max-old-space-size=640
npm run test:mutation -- --scope core --workers 1
npm run test:mutation -- --scope core --file src/load/workspace.ts --workers 1
node scripts/mutation-report.js "$report_path" --details
```

For the baseline, use source and tests from `v0.1.0` with the release's measurement runner and locked dependencies.

```sh
git worktree add --detach ../lane-router-before v0.1.0
cp package.json package-lock.json stryker.config.json ../lane-router-before/
cp scripts/test-mutation.js scripts/routing-test.config.ts scripts/mutation-report.js ../lane-router-before/scripts/
cd ../lane-router-before
npm ci
npm run test:mutation -- --scope core --workers 1
node scripts/mutation-report.js "$report_path" --details
```
