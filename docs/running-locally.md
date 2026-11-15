# Run locally

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
