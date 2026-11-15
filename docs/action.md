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

Every lane in `matrix` gets the same `base`. It is the `base` input when one is set, else the pull request's base SHA or the push's `before`. It is empty when there is none.

The step also writes a job summary. It opens with a line that gives the mode, base, head, file count, completeness and docs-only state. A table with one row per lane follows.

## Use the outputs in a workflow

The `test` job uses `none-required` to skip the matrix when no lane runs.

```yaml
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  plan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
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

The Action reads the config and the workspace from the checked-out tree. On a pull request the default checkout is the merge commit, which is also what CI tests.
