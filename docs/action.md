# Outputs

Every output is a string, as Actions requires.

| Output          | Value                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `lanes`         | A JSON array of the lanes that run, in config order.                                                               |
| `matrix`        | A JSON object `{"include":[{"lane","base","reason"}]}` for `strategy.matrix`. `base` is the selected compare base. |
| `<lane>`        | `run` or `skip`, one output per lane, keyed by the lane name.                                                      |
| `reasons`       | A JSON object from every lane name to its one-line reason.                                                         |
| `complete`      | `true` when the list of changed files was complete.                                                                |
| `docs-only`     | `true` when the event's change was docs-only.                                                                      |
| `none-required` | `true` when no lane runs.                                                                                          |

Lane order is head config order, then base-only lanes in base config order. When the base config can be read, removed lanes run and appear in every output and the summary. An unreadable base leaves only the known head lanes in the plan.

Every lane in `matrix` gets the same `base`. A supplied `base` wins. For an automatic compare, the Action otherwise uses the [event and checkout defaults](#inputs). With `files` set, the output defaults to the event's base. It is empty when there is no base.

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

| Input               | Default               | Meaning                                                                                                                                                                    |
| ------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config`            | `.github/lanes.yml`   | The routing config, relative to `working-directory`.                                                                                                                       |
| `working-directory` | `.`                   | The repository root to read the config and the workspace from.                                                                                                             |
| `base`, `head`      | see below             | The revisions to compare. A supplied `head` must resolve to the checked-out commit.                                                                                        |
| `files`             | empty                 | Newline-separated changed paths, relative to `working-directory`. They are trusted as complete, and the compare API is not called.                                         |
| `token`             | `${{ github.token }}` | The token for the compare endpoint.                                                                                                                                        |
| `mode`              | from the event        | `pr` or `push`. Must match a `pull_request`, `pull_request_target` or `push` event. A `merge_group` defaults to `push` and accepts either mode. Required for other events. |

The token needs only `contents: read`, which the compare endpoint requires.

The Action reads the config and workspace from the checkout. With `files` empty and `head` omitted, it selects the compare range from this table.

| Event                                  | Checkout                                   | Default base                                           | Compare head                                                     | Base must be an ancestor |
| -------------------------------------- | ------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------ |
| `pull_request`                         | PR head                                    | `pull_request.base.sha`                                | Checkout                                                         | No                       |
| `pull_request`                         | Test merge (`GITHUB_SHA`)                  | First parent if verified, else `pull_request.base.sha` | Checkout                                                         | Yes                      |
| `pull_request`                         | Any other commit                           | `pull_request.base.sha`                                | Runs every lane and asks for `head`                              | Yes with `head`          |
| `pull_request_target`                  | PR head                                    | `pull_request.base.sha`                                | Checkout                                                         | No                       |
| `pull_request_target`                  | Base tip (`GITHUB_SHA`)                    | `pull_request.base.sha`                                | PR head, to route the proposed PR change with the base workspace | No                       |
| `pull_request_target`                  | Any other commit, including the test merge | First parent if verified, else `pull_request.base.sha` | Checkout                                                         | Yes                      |
| `push`                                 | Event `after`                              | Event `before`                                         | Checkout                                                         | Yes                      |
| `push`                                 | Any other commit                           | Event `before`                                         | Runs every lane and asks for `head` or the event checkout        | Yes with `head`          |
| `merge_group`                          | Queue commit from `merge_group.head_sha`   | `merge_group.base_sha`                                 | Checkout                                                         | Yes                      |
| `merge_group`                          | Any other commit                           | `merge_group.base_sha`                                 | Runs every lane and asks for `head` or the event checkout        | Yes with `head`          |
| `workflow_dispatch` or any other event | `GITHUB_SHA`                               | Set `base`                                             | Checkout                                                         | In `push` mode           |
| `workflow_dispatch` or any other event | Any other commit                           | Set `base`                                             | Runs every lane and asks for `head` or the event checkout        | In `push` mode           |

For a merge queue, add `merge_group` to the workflow trigger and use the queue commit in the plan and lane jobs. The Action reads the two SHAs from the event payload. Omit `base`, `head` and `mode` for the default queue comparison. A configured `mode: pr` remains accepted and also requires an ancestor base. [Merge group workflow event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group).

The Action verifies a PR merge by reading the checkout's commit object. It must record exactly two parents, with `pull_request.head.sha` second. The first parent is the base branch commit used to create the tested merge. The payload's base SHA can differ from that commit. A supplied `head` that matches the merge still allows this default base.

The compare starts at the merge base. If the table requires ancestry, that merge base must equal the resolved base commit. A push with no `before` and no `base` runs every lane. With both revision inputs omitted, the Action checks the listing against `changed_files` when routing the proposed PR change or a PR head checkout. A supplied `base` or `head` disables this count check.

GitHub limits a compare response to 300 changed files. At that limit, lane-router can use a local diff when the checkout has both revisions, confirms the same merge base and includes every path the API listed. When the PR count check applies, the local path count must match the payload. Use `fetch-depth: 0` for local recovery. If the listing cannot be verified or a changed path is outside `working-directory`, every lane runs.

The default depth-1 checkout contains the merge commit and its parent SHAs. The compare endpoint checks ancestry and lists the files without needing local parent objects. If the diff changes the routing config or a package manifest, the Action also needs the model at the commit the diff starts from. Set `fetch-depth: 0` to make that model available. If the commit is missing, the Action selects every known lane with `complete=false`.

| `base` | `head` | `files` | What the Action plans                                                                     |
| ------ | ------ | ------- | ----------------------------------------------------------------------------------------- |
| Empty  | Empty  | Empty   | The event range in the table above.                                                       |
| Set    | Empty  | Empty   | The same range with the supplied base.                                                    |
| Empty  | Set    | Empty   | Default base to the checked-out commit, using the checkout's ancestry rule.               |
| Set    | Set    | Empty   | Supplied base to the checked-out commit, using the checkout's ancestry rule.              |
| Empty  | Empty  | Set     | Supplied paths. A base model is unavailable.                                              |
| Set    | Empty  | Set     | Supplied paths. Reads the supplied base if a base model is needed.                        |
| Empty  | Set    | Set     | Supplied paths after verifying `head`. A base model is unavailable.                       |
| Set    | Set    | Set     | Supplied paths after verifying `head`. Reads the supplied base if a base model is needed. |

A supplied `head` lets `push` and other events route a checkout that differs from the event head. It also routes a custom `pull_request` checkout if the base is an ancestor. That checkout qualifies for the first-parent default if it passes the same parent check. A head that cannot be resolved or differs from the checkout runs every known lane and reports the cause.

With `files`, supply all changed paths for the tested checkout, including both paths of a rename. The Action trusts the list and calls no compare endpoint.

On `pull_request`, check out `pull_request.head.sha` in the plan and lane jobs to route the PR head. Omit both revision inputs for the default PR range and count check. These steps show the equivalent explicit range without the count check.

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

If your `pull_request_target` workflow checks out `refs/pull/<number>/merge` or the SHA of that merge, use the same merge commit in the plan and lane jobs. With the revision inputs omitted, the Action verifies the merge and applies the first-parent rule above.

To use a custom base, set `base` to a branch, a remote ref such as `origin/main`, a short SHA, or a full SHA. The compare API resolves the base when it recognizes the revision. For a ref found only in the checkout, fetch the ref so the Action can resolve it locally. A full SHA pins the base even if a branch moves. A custom base on a PR head checkout can diverge from the head. For a test merge or another checkout with an ancestry requirement, choose a base contained in the checkout's history.
