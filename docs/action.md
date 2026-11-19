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
| `base`, `head`      | the event's           | The revisions to compare. Setting either skips the pull request file-count check.                                                  |
| `files`             | empty                 | Newline-separated changed paths, relative to `working-directory`. They are trusted as complete, and the compare API is not called. |
| `token`             | `${{ github.token }}` | The token for the compare endpoint.                                                                                                |
| `mode`              | from the event        | `pr` or `push`. Must match a `pull_request`, `pull_request_target` or `push` event. Required for any other event.                  |

The token needs only `contents: read`, which the compare endpoint requires.

The Action reads the config and the workspace from the checked-out tree. On a `pull_request` event with the default checkout and no range overrides, it compares the pull request base to the merge commit in `GITHUB_SHA`. This includes paths moved by the merge. The merge commit must match the checkout and extend the pull request base. The pull request file count describes the branch diff, so it is checked only when the default range uses the pull request's own head.

If your workflow checks out the pull request head or another revision, set `base` and `head` to the range you want to route.
