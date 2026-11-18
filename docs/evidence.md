# Routing evidence

## Mutation testing

The focused campaign mutates every file under `src/core/` and runs the routing, invariant, rendering and workspace tests. The full configuration covers all of `src/`.

Run the baseline from the checkout below with the same runner and test discovery settings.

```sh
git worktree add --detach ../lane-router-before 49707ec2fc167d4b843e1181a71806fb15e3c3d1
cp scripts/test-mutation.js scripts/routing-test.config.ts ../lane-router-before/scripts/
cd ../lane-router-before
npm ci
VITEST_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=640 node scripts/test-mutation.js --scope core --workers 1
```

The score includes timeouts. The assertion-only percentage uses the same denominator. Runtime errors are reported separately.

| Run and settings                                                 |  Score | Killed by assertions | Timeouts | Survived | No coverage | Runtime errors |     Elapsed |
| ---------------------------------------------------------------- | -----: | -------------------: | -------: | -------: | ----------: | -------------: | ----------: |
| Baseline command above, one worker, 640 MiB Node old-space limit | 79.35% |         331 (76.80%) |       11 |       55 |          34 |              1 | 20 min 31 s |
| Current command below, one worker, 640 MiB Node old-space limit  | 96.57% |         421 (96.34%) |        1 |       10 |           5 |              1 |   6 min 4 s |

Use the same checkout and settings when resuming a campaign. The runner saves each mutant result and prints the final report path.

```sh
npm ci
VITEST_MAX_WORKERS=1 NODE_OPTIONS=--max-old-space-size=640 node scripts/test-mutation.js --scope core --workers 1
node scripts/mutation-report.js <report-path> --details
```

Both campaigns used Node 24.14.0 on Windows. The current report locates the remaining results as follows. Locations are relative to `src/core/`.

| Location          | Result        | Explanation                                                                                                                              |
| ----------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `change.ts:80:66` | Survived      | Flips a private type brand on the complete change. Routing never reads the symbol.                                                       |
| `glob.ts:15:7`    | Survived      | Bypasses the empty-list shortcut. A matcher built from zero patterns also returns false for every path.                                  |
| `model.ts:169:7`  | No coverage   | Alters the default block of a switch whose cases exhaust the two resolved row target variants.                                           |
| `model.ts:169:16` | No coverage   | Replaces the body of the same unreachable default block.                                                                                 |
| `model.ts:239:37` | Survived      | Makes graph access unconditional. The compiler admits an explicit edge only when its source is a workspace package already in the graph. |
| `model.ts:249:90` | Survived      | Inserts a string into the queue. It has no package name, so it has no outgoing edges and the loop records nothing for it.                |
| `model.ts:251:9`  | Runtime error | Removes the visited guard. The cyclic graph in the tests makes the queue grow indefinitely and the test worker exits.                    |
| `model.ts:257:43` | No coverage   | Replaces the fallback for an absent graph entry. Every queued package comes from a resolved lane root or dependency of a known package.  |
| `plan.ts:70:113`  | Survived      | Flips a private type brand on the completed plan. Neither output renderer reads the symbol.                                              |
| `route.ts:91:109` | Survived      | Flips a private type brand on incomplete routing. The decision reads the discriminant and cause.                                         |
| `route.ts:92:68`  | Survived      | Flips a private type brand on empty routing. The decision reads the discriminant.                                                        |
| `route.ts:97:15`  | Survived      | Flips a private type brand on complete nonempty routing. The decision reads the discriminant and placements.                             |
| `route.ts:123:41` | Survived      | Looks up one extra directory at depth zero. The workspace excludes the repository root, so the empty string has no entry.                |
| `route.ts:123:52` | Timeout       | Increments the directory depth on every iteration. A path outside the workspace makes the lookup fail to terminate.                      |
| `route.ts:152:5`  | No coverage   | Alters the default block of a switch that handles every variant returned by the routing function.                                        |
| `route.ts:152:14` | No coverage   | Replaces the body of the same unreachable default block.                                                                                 |
| `route.ts:160:45` | Survived      | Flips a private type brand on a skip. Neither output renderer reads the symbol.                                                          |

## Soundness oracle

The oracle computes reachability by repeatedly scanning the generated edges until every reachable package has been seen. It checks package membership and explicit claims against that reachability. A `tests` claim uses the lane's root packages. Floor, unmatched and built-in runs count as excess if the oracle found no affected package or explicit lane claim. A lane can have more than one reason.

| Command                                                                  |   Seed |   Cases | Affected | Unaffected | Excess runs | Reasons for excess runs                            | False skips | Local elapsed |
| ------------------------------------------------------------------------ | -----: | ------: | -------: | ---------: | ----------: | -------------------------------------------------- | ----------: | ------------: |
| `NODE_OPTIONS=--max-old-space-size=640 npm run test:soundness`           | 619473 |   5,000 |    7,088 |      9,988 |       6,653 | floor 4,772, unmatched 4,375, built-in 3,781       |           0 |         2.3 s |
| `NODE_OPTIONS=--max-old-space-size=640 npm run test:soundness -- 250000` | 619473 | 250,000 |  364,758 |    501,100 |     332,637 | floor 241,577, unmatched 225,179, built-in 191,158 |           0 |       125.2 s |

Each measurement used a single Node 24.14.0 process on Windows. CI runs the shorter command with the same seed. The generator includes nested packages, cycles, development and configured edges, overlapping rules, floor lanes and empty changes.

## Field replay

The recorded run used Node 24.14.0 and Git 2.50.1 on Windows with the build at `e893f5d2346e35679c95679efb0bd559391a0176`. Use Git with `clone --revision` support and a configured commit identity for the local replay trees.

```sh
git worktree add --detach ../lane-router-replay e893f5d2346e35679c95679efb0bd559391a0176
cd ../lane-router-replay
npm ci
npm run build
NODE_OPTIONS=--max-old-space-size=768 node scripts/field-replay.js --root ../lane-router-field --output ../lane-router-field/serial
node scripts/field-summary.js ../lane-router-field/serial/summary.json
```

Each revision gets one lane for each non-root workspace package with the exact script key `test`, plus one floor lane. A workspace with no such package contributes only the floor lane. The replay uses first-parent changes from pinned default-branch tips. A synthetic config is added to each revision tree, so additions or removals of generated lanes show up as config fallbacks. The workspace audit uses an independent manifest inventory. The replay invokes the built CLI for every pair and consumes its JSON stream.

The runner replays one repository at a time. Repeating the command reuses completed repository results and the completed rows of an interrupted repository. The timings include process startup, Git reads, routing and JSON I/O. They were recorded on a shared machine with concurrent mutation runs. The Windows measurement used the native Git executable on `PATH`. To select it in PowerShell, run `$env:Path = (Join-Path (git --exec-path) '../../bin') + ';' + $env:Path`. Set `$env:NODE_OPTIONS = '--max-old-space-size=768'` before running the replay command.

The table counts a fallback once per plan and lists every reason that forced all lanes to run. `config`, `lockfile`, `root` and `workspace` are built-in paths. Run-all plans where every lane has a reader or floor reason are ordinary plans.

| Repository at replay tip                                                                                                                                     | Workspace | Head packages / test lanes | Read errors |       Plans | Skipped / lane verdicts | Fallbacks and reasons                                                   | Rejected / crashed | p50 / p95 ms |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | -------------------------: | ----------: | ----------: | ----------------------: | ----------------------------------------------------------------------- | -----------------: | -----------: |
| [babel/babel @ bf3497da72a3](https://github.com/babel/babel/commit/bf3497da72a3c6385d049675955ffdb6b81c5fa0)                                                 | yarn      |                    165 / 0 |           0 |   200 / 200 |                 0 / 200 | 84 (lockfile 23, root 17, unmatched 62)                                 |              0 / 0 |   509 / 1311 |
| [changesets/changesets @ 9a035ec36045](https://github.com/changesets/changesets/commit/9a035ec36045aeb6141dd0bbac9ab9e3c69ac0bc)                             | pnpm      |                     24 / 1 |           0 |   200 / 200 |                 2 / 216 | 172 (config 1, lockfile 39, root 25, workspace 12, unmatched 152)       |              0 / 0 |    338 / 628 |
| [effect-ts/effect @ 0daa5aa98f3c](https://github.com/effect-ts/effect/commit/0daa5aa98f3c08c069ffe05e6e4d0e86866fe75f)                                       | pnpm      |                     47 / 0 |           0 |   200 / 200 |                 0 / 200 | 184 (lockfile 4, root 3, workspace 2, unmatched 184)                    |              0 / 0 |    382 / 625 |
| [microsoft/playwright @ 8124fc39233c](https://github.com/microsoft/playwright/commit/8124fc39233c4c349b9dbebd4abc4103738eae81)                               | npm       |                     16 / 0 |           0 |   200 / 200 |                 0 / 200 | 179 (lockfile 5, root 3, unmatched 174)                                 |              0 / 0 |   560 / 1463 |
| [npm/cli @ cfd03796843c](https://github.com/npm/cli/commit/cfd03796843cc9ae26c7034ab99bae6c002a4ba4)                                                         | npm       |                    16 / 16 |           0 |   200 / 200 |              354 / 3400 | 160 (lockfile 89, root 67, unmatched 150)                               |              0 / 0 |   596 / 1394 |
| [pnpm/pnpm @ b0a7dac0fe88](https://github.com/pnpm/pnpm/commit/b0a7dac0fe88264cdef0f258cdb755d5d28c4a8f)                                                     | pnpm      |                  236 / 221 |           0 |   200 / 200 |             625 / 44394 | 197 (config 1, lockfile 19, root 5, workspace 1, unmatched 197)         |              0 / 0 |  1050 / 3875 |
| [puppeteer/puppeteer @ 4ee6cff57442](https://github.com/puppeteer/puppeteer/commit/4ee6cff57442b7e03f7b27fb8018ee5ebaeab68b)                                 | npm       |                     10 / 3 |           0 |   200 / 200 |               261 / 800 | 109 (lockfile 31, root 10, unmatched 91)                                |              0 / 0 |    433 / 800 |
| [reduxjs/redux-toolkit @ 1a7d3b5251ce](https://github.com/reduxjs/redux-toolkit/commit/1a7d3b5251ceda61b77928e357a22086b45aaab1)                             | pnpm      |                      9 / 8 |           0 |   200 / 200 |              489 / 2097 | 46 (config 2, lockfile 26, root 8, workspace 3, unmatched 35)           |              0 / 0 |    352 / 613 |
| [rollup/plugins @ b09437adcd70](https://github.com/rollup/plugins/commit/b09437adcd7010c2a6cd20c778be0e4626f640f3)                                           | pnpm      |                    31 / 31 |           0 |   200 / 200 |             2435 / 6400 | 32 (lockfile 21, root 7, workspace 1, unmatched 15)                     |              0 / 0 |    474 / 730 |
| [sveltejs/kit @ c5cc48f1a09b](https://github.com/sveltejs/kit/commit/c5cc48f1a09bda4698a81ed094b728f4e2d7da6e)                                               | pnpm      |                    74 / 30 |           0 |   200 / 200 |               43 / 6441 | 194 (config 4, lockfile 37, root 14, workspace 15, unmatched 180)       |              0 / 0 |    321 / 611 |
| [sveltejs/svelte @ dc5d1dc76bd1](https://github.com/sveltejs/svelte/commit/dc5d1dc76bd104c44673f4d88d852b472b3e2803)                                         | pnpm      |                      2 / 0 |           0 |   200 / 200 |                 0 / 200 | 171 (lockfile 7, root 3, unmatched 167)                                 |              0 / 0 |    338 / 582 |
| [TanStack/query @ 7ed5ea920e12](https://github.com/TanStack/query/commit/7ed5ea920e124ca8aa117b295851ad199b83ff97)                                           | pnpm      |                    205 / 0 |           0 |   200 / 200 |                 0 / 200 | 156 (lockfile 73, root 3, workspace 14, unmatched 132)                  |              0 / 0 |    341 / 635 |
| [TanStack/router @ 0b6d4f3f6b42](https://github.com/TanStack/router/commit/0b6d4f3f6b42e704555d9ff0014ddbf8b44f8e09)                                         | pnpm      |                   313 / 25 |           0 |   200 / 200 |              257 / 5332 | 178 (config 1, lockfile 46, root 5, workspace 9, unmatched 175)         |              0 / 0 |    291 / 592 |
| [TanStack/table @ 564a459b7483](https://github.com/TanStack/table/commit/564a459b74834c77631e0d6fdba7661383bbc1b4)                                           | pnpm      |                    418 / 2 |           0 |   200 / 200 |                17 / 600 | 155 (lockfile 35, root 22, workspace 9, unmatched 151)                  |              0 / 0 |    395 / 527 |
| [trpc/trpc @ e57a6448bdb6](https://github.com/trpc/trpc/commit/e57a6448bdb67fb5ceabcc5cf601cb74b25b8c92)                                                     | pnpm      |                     56 / 2 |           0 |   200 / 200 |               134 / 777 | 55 (config 1, lockfile 36, root 6, workspace 11, unmatched 26)          |              0 / 0 |    260 / 503 |
| [typescript-eslint/typescript-eslint @ a53584297a1f](https://github.com/typescript-eslint/typescript-eslint/commit/a53584297a1fa65f4cc91387b0a7da834ab73ed7) | pnpm      |                    19 / 16 |           0 |   200 / 200 |             1057 / 3400 | 113 (lockfile 76, root 47, workspace 3, unmatched 42)                   |              0 / 0 |    248 / 467 |
| [vercel/ai @ 486e08f0446a](https://github.com/vercel/ai/commit/486e08f0446a5986c2f6fd5bcf8c9b00770e51f7)                                                     | pnpm      |                   123 / 89 |           0 |   200 / 200 |             652 / 17438 | 192 (config 4, lockfile 11, root 1, workspace 2, unmatched 190)         |              0 / 0 |    261 / 525 |
| [vercel/turborepo @ 9e884b49f67f](https://github.com/vercel/turborepo/commit/9e884b49f67f11bd449ea4e2d54dffa7a04afb6d)                                       | pnpm      |                     20 / 1 |           0 |   200 / 200 |                30 / 400 | 170 (lockfile 17, unmatched 153)                                        |              0 / 0 |    243 / 444 |
| [vitejs/vite @ d7dfe9b7beed](https://github.com/vitejs/vite/commit/d7dfe9b7beedb756f56e509ed425e18af2aa065c)                                                 | pnpm      |                    275 / 0 |           0 |   200 / 200 |                 0 / 200 | 50 (lockfile 35, root 18, workspace 9, unmatched 23)                    |              0 / 0 |    244 / 475 |
| [vitest-dev/vitest @ 19d62e36d618](https://github.com/vitest-dev/vitest/commit/19d62e36d618054736c4b544bda353a90294c850)                                     | pnpm      |                    41 / 25 |           0 |   200 / 200 |              411 / 5155 | 42 (config 1, lockfile 22, root 8, workspace 17, unmatched 20)          |              0 / 0 |    237 / 408 |
| [vuejs/core @ 148fdacdc3a6](https://github.com/vuejs/core/commit/148fdacdc3a67aaa2b8d1b615da227c3fcc2df53)                                                   | pnpm      |                     17 / 0 |           0 |   200 / 200 |                 0 / 200 | 63 (lockfile 41, root 31, workspace 15, unmatched 26)                   |              0 / 0 |    228 / 382 |
| [vuejs/pinia @ 4817135a2543](https://github.com/vuejs/pinia/commit/4817135a25431172d363bd928476db7cdbf875c4)                                                 | pnpm      |                      7 / 1 |           0 |   200 / 200 |                60 / 400 | 92 (lockfile 41, root 34, workspace 3, unmatched 52)                    |              0 / 0 |    228 / 421 |
| [vuejs/router @ 4f8fc1bcdef6](https://github.com/vuejs/router/commit/4f8fc1bcdef619b832b55caf9e5583b441ce71a1)                                               | pnpm      |                      5 / 1 |           0 |   200 / 200 |                37 / 400 | 21 (lockfile 9, root 8, workspace 5, unmatched 17)                      |              0 / 0 |    236 / 387 |
| [withastro/astro @ 01c942da6308](https://github.com/withastro/astro/commit/01c942da6308d5b89bd5e3910559f7c255acae20)                                         | pnpm      |                   601 / 37 |           0 |   200 / 200 |              274 / 6561 | 185 (config 2, lockfile 71, root 10, workspace 5, unmatched 158)        |              0 / 0 |    283 / 537 |
| **Total (24 repositories)**                                                                                                                                  |           |                            |           0 | 4800 / 4800 |           7138 / 105611 | 3000 (lockfile 814, root 355, unmatched 2572, config 17, workspace 136) |              0 / 0 |              |

### Limits

The oracle samples the declared dependency graph and treats the generator's docs rules as claims about documentation. Package manager installation, undeclared imports and real test inputs remain outside that model. The field replay measures routing behaviour. It runs no skipped lanes and observes no test outcomes. The generated configs have no project-specific path rules, so unmatched paths often run every lane.
