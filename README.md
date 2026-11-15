# lane-router

lane-router works out which CI test lanes a change can affect in a JavaScript monorepo, so a workflow can skip the rest. It explains every decision, and it runs every lane when it cannot be sure. It ships as a GitHub Action and as a CLI that makes the same decisions on a local diff.

A wrong skip can merge a break that no lane tested. lane-router follows workspace dependencies and explicit file rules. An unclaimed path or an unverifiable change runs every lane. An invalid config or workspace fails the step.

Run `npm run demo` to see two decisions on the bundled fixture. A change to one UI file skips the `api` lane.

```text
lane  decision  reason
api   skip      nothing it reads changed
web   run       packages/ui/src/button.tsx is in @acme/ui, read through @acme/web
e2e   run       packages/ui/src/button.tsx is in @acme/ui, read through @acme/web-e2e > @acme/web
lint  run       floor lane, runs for every change that is not docs-only
```

A path filter would treat `docs/api/users.md` as documentation. The config says the api serves that file by name, so adding it to the change runs `api`.

```text
api   run       docs/api/users.md matches paths[3] for @acme/api via name: The api serves these files by name.
```

## Add it to a workflow

Add [a routing config](docs/config.md). This workflow runs an existing `test:api` script when the `api` lane is selected.

```yaml
on: pull_request
permissions:
  contents: read
jobs:
  api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - id: lanes
        uses: 0x963D/lane-router@v0
      - run: npm ci
        if: steps.lanes.outputs.api == 'run'
      - run: npm run test:api
        if: steps.lanes.outputs.api == 'run'
```

A shallow checkout runs every lane when a package manifest changes. Use the [full workflow example](docs/action.md#use-the-outputs-in-a-workflow) for a full checkout and a matrix. There is no Marketplace listing yet.

## Routing and config

[How routing works](docs/routing.md) explains why path filters miss dependencies and how the base and head graphs prevent a change from rewriting its own test coverage. The [config reference](docs/config.md) includes the full demo config and validation rules.

## Action and CLI

[Outputs and inputs](docs/action.md) covers the Action contract and matrix workflow. [Run locally](docs/running-locally.md) covers the CLI, the demo, and development commands.

## Guarantees and limits

[Fail-closed guarantees](docs/fail-closed.md) lists the cases that run every lane or fail the step. [Reading the repository](docs/reading-the-repository.md) explains path boundaries and error messages that do not quote file contents.

The [prior-pass threat model](docs/prior-passes.md) explains why a past passing check is not proof that a lane can skip. [What's next](docs/limitations.md) lists unsupported cases. The [decision records](docs/decisions/README.md) link the design choices to their implementation.

## When Turborepo or Nx is the better tool

Choose Turborepo or Nx when you want affected detection to run tasks and reuse cached results. Turborepo's [`--affected` option](https://turborepo.dev/docs/reference/run#--affected) selects changed packages and their dependents by default. [`nx affected`](https://nx.dev/docs/features/ci-features/affected) selects tasks from changed inputs and dependent task outputs. It runs the selected tasks and their dependencies, with unchanged dependencies restored from cache.

lane-router selects named CI lanes and emits decisions with reasons. It does not run tasks or cache results. It fits existing workflow jobs that need explicit routing rules for workspace dependencies and files read by name.

## Origin

lane-router started as CI routing I built for a private production monorepo, where every change ran every test lane. This repository is a rewrite of that idea as a standalone Action and CLI, built from a written description of the behaviour and not from the original code.
