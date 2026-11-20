# Run locally

The CLI makes the decisions the Action would make for a local diff. PR mode is the default. It reads the config and the workspace at `--head`, not from the working tree.

```sh
npm ci
npm run build
node dist/cli.js explain --base origin/main --head HEAD
```

```
lane-router explain --base <ref> --head <ref> [--mode pr] [--config <path>] [--cwd <dir>] [--json]
lane-router explain --mode push --head <ref> [--base <ref>] [--config <path>] [--cwd <dir>] [--json]
```

Use `--mode push` to reproduce a push plan. Supply the event's `before` and `after` commits.

```sh
node dist/cli.js explain --mode push --base <before> --head <after> --json
```

Push mode needs an ancestor base to route a change. A force push, rewind, unavailable base, or history that Git cannot verify selects every lane and prints the cause. For a new branch, omit `--base` or pass the all-zero SHA. The CLI prints an incomplete plan with every lane selected. The head must name a commit with a readable workspace and config.

The CLI exits with 0 when it printed a plan, fail-closed plans included. It exits with 1 when the config or the workspace does not load, and with 2 on a usage error. `--json` prints the plan as a JSON document.

## Replay history with a routing config

Replay a local repository's recent first-parent commits before adopting lane-router. Each range starts at a commit's first parent and ends at that commit. The script uses the same config for every range and counts the runs and skips for each lane. It writes the replay to a separate clone and leaves the source checkout and its history alone.

```sh
npm run build
node scripts/field-replay.js --checkout ../my-monorepo --root coverage/my-replay --limit 20
node scripts/field-summary.js coverage/my-replay/summary.json
```

The default tip is `HEAD`. Set `--ref` to choose a branch or pin a commit. The default config is `.github/lanes.yml` from that tip. Use `--config` for a file on disk, with a path relative to the directory where you run the command. Use `--limit` to set the maximum number of changes, 200 by default. The replay uses the first-parent ranges available in the source checkout. Reuse the same inputs and output directory to resume an interrupted replay.

Run the example below from the lane-router checkout. It replays 12 first-parent changes from Relay CRM with the routing config in this repository. Git needs the `clone --revision` option.

```sh
git clone --no-checkout --depth 13 --revision 036eec84effc491534f48b8ec6647e0a02557dff https://github.com/0x963D/relay-crm.git ../relay-crm-replay
node scripts/field-replay.js --checkout ../relay-crm-replay --config scripts/replay-relay-ci.yml --root coverage/relay-replay --limit 12
node scripts/field-summary.js coverage/relay-replay/summary.json
```

| Lane        | Run | Skip |
| ----------- | --: | ---: |
| demo        |  12 |    0 |
| check       |  12 |    0 |
| integration |  12 |    0 |
| browser     |  11 |    1 |

The replay counts plans. It does not execute the lane jobs or recover the exact ranges of original workflow runs.

## Run the demo

To see full explanations, run `npm run demo`. It commits two changes to the `acme` fixture in a temporary git repository and runs the built CLI on each. The commit SHAs differ on every run. The first change is one UI file:

```
lane  decision  reason
api   skip      nothing it reads changed
web   run       packages/ui/src/button.tsx is in @acme/ui, read through @acme/web
e2e   run       packages/ui/src/button.tsx is in @acme/ui, read through @acme/web-e2e > @acme/web
lint  run       floor lane, runs for every change that is not docs-only

packages/ui/src/button.tsx
  package @acme/ui  web, e2e
```

The second change adds four more files, and one of them is a docs file the api serves by name:

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

`npm run check:linking` compares the dependency graph with real offline installations. It requires pnpm 11.18.0 and npm 11.11.0 on `PATH`. The `Check workspace links` CI job pins those versions and Node 24.14.0 on Windows. Tool provisioning and `npm ci` need the registry. The fixture installations use `--offline`, disable scripts and audits, and prohibit Git transports.

The case table is `scripts/linking-cases.ts`. Each row records which pinned managers install that workspace. A changed install outcome fails the check. Every successful install must load, and each linked workspace dependency must have a direct graph edge. Rejected installs do not assert loader behavior. Unit tests separately cover unresolved workspace names.

The script writes workspaces, install logs and `results.json` under the system temporary directory. Set `LANE_ROUTER_TMP` to choose the parent directory. Each install has its own cache and store. Logs remain after failure so a case can be inspected.
