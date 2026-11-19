# Outputs

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

Lane order is head config order, then base-only lanes in base config order. When the base config can be read, removed lanes run and appear in every output and the summary. An unreadable base leaves only the known head lanes in the plan.

Every lane in `matrix` gets the same `base`. It is the `base` input when one is set, else the pull request's base SHA or the push's `before`. It is empty when there is none.

The step also writes a job summary. It opens with a line that gives the mode, base, head, file count, completeness and docs-only state. A table with one row per lane follows.

## Use the outputs in a workflow

The `test` job uses `none-required` to skip the matrix when no lane runs.

For a fixed lane, use `if: steps.lanes.outputs.api != 'skip'`. A missing lane output therefore runs the job. A full checkout lets the matrix include removed lanes. If the base config cannot be read, a matrix cannot discover those lanes.

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  plan:
    runs-on: ubuntu-latest
    outputs:
      matrix: ${{ steps.lanes.outputs.matrix }}
      none-required: ${{ steps.lanes.outputs.none-required }}
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - id: lanes
        uses: 0x963D/lane-router@v0

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

Pin `actions/checkout` and this action to full commit SHAs, following [GitHub's security hardening guidance](https://docs.github.com/en/actions/reference/security/secure-use#using-third-party-actions).

## Inputs

| Input               | Default               | Meaning                                                                                                                            |
| ------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `config`            | `.github/lanes.yml`   | The routing config, relative to `working-directory`.                                                                               |
| `working-directory` | `.`                   | The repository root to read the config and the workspace from.                                                                     |
| `base`, `head`      | see below             | The revisions to compare. Setting either skips the pull request file-count check.                                                  |
| `files`             | empty                 | Newline-separated changed paths, relative to `working-directory`. They are trusted as complete, and the compare API is not called. |
| `token`             | `${{ github.token }}` | The token for the compare endpoint.                                                                                                |
| `mode`              | from the event        | `pr` or `push`. Must match a `pull_request`, `pull_request_target` or `push` event. Required for any other event.                  |

The token needs only `contents: read`, which the compare endpoint requires.

The Action reads the config and workspace from the checked-out tree. For `pull_request`, `base` defaults to `pull_request.base.sha`. When `files` is empty, the Action chooses the compare head as follows.

| `base` | `head` | `files` | What the Action plans                                                                                                                   |
| ------ | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Empty  | Empty  | Empty   | Event base to the checked-out merge commit (`GITHUB_SHA`) or PR head (`pull_request.head.sha`). Checks `changed_files` for the PR head. |
| Set    | Empty  | Empty   | Input base to the checked-out merge commit or PR head.                                                                                  |
| Empty  | Set    | Empty   | Event base to the input head. The input head must resolve to `HEAD` in the checkout.                                                    |
| Set    | Set    | Empty   | Input base to the input head. The input head must resolve to `HEAD` in the checkout.                                                    |
| Empty  | Empty  | Set     | The supplied paths for the checkout. No base model is available if the planner needs one.                                               |
| Set    | Empty  | Set     | The supplied paths for the checkout. Uses the input base if the planner needs a base model.                                             |
| Empty  | Set    | Set     | The supplied paths. The input head must resolve to `HEAD`. No base model is available if the planner needs one.                         |
| Set    | Set    | Set     | The supplied paths. The input head must resolve to `HEAD`. Uses the input base if the planner needs a base model.                       |

For the event base and PR head pair, the compare starts at their merge base. All other comparisons on `pull_request` require the head to extend the named base. Supply a full base SHA for these comparisons so the Action can verify the compare response. When the checkout matches neither event commit, supply `head` to route it by comparison. If a checkout or comparison fails these checks, every known lane runs and the Action explains why.

With `files`, supply all changed paths for the tested checkout, including both sides of a rename. The Action trusts this list and calls no compare endpoint.

For example, these steps check out and route the PR head. Use the same checkout ref in the jobs that run the lanes. You can also omit both routing inputs to enable the `changed_files` check.

```yaml
- uses: actions/checkout@v7
  with:
    ref: ${{ github.event.pull_request.head.sha }}
    fetch-depth: 0
- id: lanes
  uses: 0x963D/lane-router@v0
  with:
    base: ${{ github.event.pull_request.base.sha }}
    head: ${{ github.event.pull_request.head.sha }}
```

On other events with a default range, `pull_request_target` uses the event's PR base and head. `push` uses the event's `before` and `after`.
