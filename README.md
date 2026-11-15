# lane-router

lane-router works out the smallest set of CI test lanes a change can affect in a JavaScript monorepo. It explains every decision, and it runs every lane when it cannot be sure. It ships as a GitHub Action and as a CLI that makes the same decisions on a local diff.

A wrong skip can merge a break that no lane tested. lane-router follows workspace dependencies and explicit file rules. An unclaimed path or an unverifiable change runs every lane. An invalid config or workspace fails the step.

Run `npm run demo` to see a routing decision and its reason. This is an excerpt of its output.

```text
lane  decision  reason
api   run       docs/api/users.md matches paths[3] for @acme/api via name: The api serves these files by name.
```

## Add it to a workflow

Add [a routing config](docs/config.md). Replace `OWNER` with the account that will host this repository. This workflow runs an existing `test:api` script when the `api` lane is selected.

```yaml
on: pull_request
permissions:
  contents: read
jobs:
  api:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@main
      - id: lanes
        uses: OWNER/lane-router@main
      - run: npm ci
        if: steps.lanes.outputs.api == 'run'
      - run: npm run test:api
        if: steps.lanes.outputs.api == 'run'
```

A shallow checkout runs every lane when a package manifest changes. Use the [full workflow example](docs/action.md#use-the-outputs-in-a-workflow) for a full checkout and a matrix. This repository has no release tag or Marketplace listing yet.

## Routing and config

[How routing works](docs/routing.md) explains why path filters miss dependencies and how the base and head graphs prevent a change from rewriting its own test coverage. The [config reference](docs/config.md) includes the full demo config and validation rules.

## Action and CLI

[Outputs and inputs](docs/action.md) covers the Action contract and matrix workflow. [Run locally](docs/running-locally.md) covers the CLI, the demo, and development commands.

## Guarantees and limits

[Fail-closed guarantees](docs/fail-closed.md) lists the cases that run every lane or fail the step. [Reading the repository](docs/reading-the-repository.md) explains path boundaries and error messages that do not quote file contents.

The [prior-pass threat model](docs/prior-passes.md) explains why a past passing check is not proof that a lane can skip. [What's next](docs/limitations.md) lists unsupported cases.

## Origin

Dan, write this section in your own words.
