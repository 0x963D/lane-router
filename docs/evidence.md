# Routing evidence

The planner soundness and public field replay results are from `v0.1.1`. The Action results cover the range and file listing before planning, and are from the source and tests released as `v0.2.0`. They ran against local git and a local compare endpoint. A live comparison above 300 files and a hosted merge queue run have not been tried.

lane-router promises to skip a CI lane only when the change cannot affect the inputs the lane declares. When it cannot make that decision safely, it runs the lane.

- **Soundness oracle.** No false skip in 250,000 generated changes within the model of declared inputs. All 16 injected bugs produced a false skip.
- **Field replay.** 4,800 plans across 24 real repositories, with no discovery mismatches or skips in fallback plans. The replay checks plans without executing test lanes.
- **Action soundness.** The built-Action suite checks that the compare range matches the tested Git tree and fails closed when that range cannot be verified.

## Pull request merge paths

In `v0.1.1`, the default pull request checkout was a merge commit, but the Action used the pull request branch's changed paths. If the base branch moved a file that the pull request edited, the Action could skip the lane for the file's destination in the tested merge.

The 250,000 generated changes did not find this bug. The oracle tests planning with a supplied workspace model and file list. It does not test whether the Action gets the diff for the tree that CI checks out.

The bug surfaced while [replaying lane-router on the author's own CI history](own-history.md). In the [checkout regression matrix](../test/action-pr-checkout.test.ts), `v0.1.1` skips the API lane for a file the base branch moved into the API package. The matrix reproduces the skip on both pull request events. The directory rename fixture has its own category because Git needs `merge.directoryRenames=true` to resolve that merge. The matrix also labels cases that check the new range rules.

The matrix uses depth-1 clones for default merge checkouts on both pull request events. It checks the exact lane list from the first-parent diff, including when the payload base differs, and requires `complete=true` with no annotation. It covers the payload-base fallback when the checkout has one parent, three parents, or a different second parent. A manifest change uses the first parent's model in a full checkout and gives fetch-depth advice when the parent object is missing. The [Action tests](../test/action.test.ts) also check requested ranges and the file count check for the pull request head.

The matrix answers compare requests from a local fixture. The `compare` job in [this repository's CI](../.github/workflows/ci.yml) calls the real endpoint on every pull request, from the default shallow checkout. It checks that the plan starts at the merge's first parent and that the endpoint returned a listing.

## Action soundness

The [Action oracle](../scripts/check-action-soundness.js) runs the built Action with a real checkout and a loopback compare endpoint. The [oracle rule](../scripts/action-oracle.js) reads the checkout's commit, its recorded parents, and the common ancestors of the event or supplied revisions. It selects the range for the tested tree, applies the event's ancestry and PR count requirements, and checks what the local clone can verify at the compare cap. It compares tree entries by object ID and mode. Package manifests and the routing config determine the lanes that must run.

Each seed varies package roles, branch edits, advances to the base, merge shapes, checkout depth, working directory, event and inputs. The suite includes a default merge checkout at the cap, a criss-cross history with different merge-base choices, a capped rename whose old path requires a lane, and merge queue events. Cases with a verified range require the exact runs and skips. Cases with unverifiable changes require every known lane and an annotation. The four hand-written cases describe a corrupt listing, an unavailable endpoint, invalid JSON, and a missing file list.

The default CI sample uses seed `20261120`. It passed 65 cases with 61 derived and 4 hand-written expectations. It included 20 shallow checkouts, 37 exact plans, 25 fail-closed plans, 3 rejected invocations and 81 skips. It found zero false skips. The 12-seed run passed 780 cases (732 derived, 48 hand-written) with 991 verified skips and zero false skips.

Use Git 2.49 or later for `clone --revision`. An output directory stores one row per completed history. Reuse the seed and output directory with the same bundle to resume or extend a sample.

```sh
npm run build
npm run test:action-soundness
node scripts/check-action-soundness.js --seed 20261120 --histories 12 --output coverage/action-sample
node scripts/check-action-mutations.js coverage/action-faults
```

The fault check runs every case from the default sample against the control and each of 20 faulty bundles. It needs the `v0.1.1` tag for the released bundle. Reuse its output directory to resume at the first unfinished case. The report gives a counterexample per fault, with requests, expected lanes and actual outputs. The local endpoint uses Git rename detection. Hosted comparison behavior and edits to a checkout after Git creates it are outside this sample.

### Action seam mutation testing

The campaign on the source and tests released as `v0.2.0` scored 76.05%. It assessed 1,044 eligible mutations. 782 failed a test, 12 timed out, 202 survived, and 48 had no coverage. The score includes test failures and timeouts. The campaign independently mutates these files and runs the Action and CLI against Git and HTTP protocol fixtures.

- `src/action.ts`
- `src/adapters/directory.ts`
- `src/adapters/git.ts`
- `src/adapters/github.ts`
- `src/core/change.ts`

4 survivors were judged equivalent for the supported entry points. The other survivors remain unclassified.

- #67 in `src/action.ts:131` (ObjectLiteral) is equivalent because the input map is built from the declared keys before decoding.
- #68 in `src/action.ts:131` (StringLiteral) is equivalent because the input map is built from the declared keys before decoding.
- #1032 in `src/core/change.ts:69` (Regex) is equivalent because Git emits a single trailing slash for a nonempty prefix.
- #1057 in `src/core/change.ts:80` (BooleanLiteral) is equivalent because the private type brand is never read at runtime.

Run from the clean checkout containing this page and record its commit before starting. Pass the printed report path to the summary command to list each survivor by file and location. Reuse the output directory to resume.

```sh
git rev-parse HEAD
mkdir -p coverage
VITEST_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=640 node scripts/test-mutation.js --scope seam --workers 1 --output coverage/seam | tee coverage/seam-run.log
report_path=$(sed -n 's/^Report path //p' coverage/seam-run.log)
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

## Reproduce

For the historical planner and field results, use Node 24.14.0, Git 2.49 or later, and a configured Git commit identity for the replay overlays. The commands below use a POSIX-compatible shell, one mutation worker, and one repository at a time. Mutation and replay runs can resume from their saved output directories.

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
