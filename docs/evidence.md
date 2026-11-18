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

The recorded run used Node 24.14.0 on Windows and the build at `e893f5d2346e35679c95679efb0bd559391a0176`. Use Git with `clone --revision` support.

```sh
git worktree add --detach ../lane-router-replay e893f5d2346e35679c95679efb0bd559391a0176
cd ../lane-router-replay
npm ci
npm run build
NODE_OPTIONS=--max-old-space-size=768 node scripts/field-replay.js --root ../lane-router-field --output ../lane-router-field/serial
node scripts/field-summary.js ../lane-router-field/serial/summary.json
```

Each revision gets one lane for each non-root workspace package with a `test` script and one floor lane. The replay uses first-parent changes from pinned default-branch tips. A synthetic config is added to each revision tree, so additions or removals of generated lanes show up as config fallbacks. The workspace audit uses an independent manifest inventory. The replay invokes the built CLI for every pair and consumes its JSON stream.

The runner replays one repository at a time. Repeating the command reuses completed repository results and the completed rows of an interrupted repository. The timings include process startup, Git reads, routing and JSON I/O. The Windows measurement used the native Git executable on `PATH`. To select it in PowerShell, run `$env:Path = (Join-Path (git --exec-path) '../../bin') + ';' + $env:Path`. Set `$env:NODE_OPTIONS = '--max-old-space-size=768'` before running the replay command.

The table counts a fallback once per plan and lists every reason that forced all lanes to run. `config`, `lockfile`, `root` and `workspace` are built-in paths. Run-all plans where every lane has a reader or floor reason are ordinary plans.

### Limits

The oracle samples the declared dependency graph and treats the generator's docs rules as claims about documentation. Package manager installation, undeclared imports and real test inputs remain outside that model. The field replay measures routing behaviour. It runs no skipped lanes and observes no test outcomes. The generated configs have no project-specific path rules, so unmatched paths often run every lane.
