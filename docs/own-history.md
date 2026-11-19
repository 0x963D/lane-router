# Replaying lane-router on two repositories' CI history

I replayed lane-router on the CI history of two repositories I maintain, to see whether it would pay off there. It would not, so neither repository uses it. The public one had no job time to skip. The private one had jobs to skip, but the routing job would add time to every run.

## Relay CRM

The replay would have skipped 0 of 4,744 recorded job seconds across the three CI runs in the sample (0%). These jobs read shared code and repository-wide inputs. All four jobs were selected in each replayed run.

Run this from the lane-router checkout with Git, Node 24, Python 3.11 or later, and an authenticated `gh` CLI. The checkout needs the `v0.1.1` tag. The script reads that release's CLI bundle and fetches the job records for the three pinned runs. The job data is public.

```sh
git fetch origin tag v0.1.1
git clone https://github.com/0x963D/relay-crm.git ../relay-crm-replay
python scripts/replay-relay-ci.py ../relay-crm-replay
```

The first push's exact starting commit was unavailable. The script uses the tested commit's first parent. It also checks that the README changed from every earlier ancestor. The routing config selects every job for README changes. New branches and non-fast-forward pushes also run all jobs.

## Private monorepo

The private repository has five apps and 19 other workspace packages. Its current CI layout has one repository-wide check lane and two build lanes.

Across the recorded history, the replay would have skipped 3,369 of 134,323 job seconds (2.51%). That window includes an older layout with separate check jobs. In the current layout, the replay would have skipped 1,248 of 7,666 job seconds (16.3%), with skips in 9 of 44 attempts.

These figures add up the time of jobs that ran in parallel. The check lane accounts for the largest share of job time and always runs. In the proposed workflow it waits for the routing job on the same runner. That adds time to every run.

The replay used recovered commit ranges where available and first parents for the rest. Readers cannot reproduce the private figures because the history and job records are private.

Of the 82 failed jobs, 71 were in the always-run lane. Of the 11 in lanes routing could skip, eight recorded no steps and two had cancelled installs. One failed a check. The replay used the recovered range for that failure and selected the job.

The Turborepo affected-package comparison cross-checked manifest parsing. Both tools read the same workspace manifests. The comparison cannot check files a job reads directly or whether a workflow can safely skip a job.

## What the replay found

The exercise exposed a bug in `v0.1.1`. On a default pull request checkout, the Action read the merge tree and used paths from the pull request branch. If the base moved a file that the pull request edited, the lane for the destination could skip. The [checkout regression tests](../test/action-pr-checkout.test.ts) cover the tested tree, including a file move and a directory rename. `v0.1.2` fixes it.

Routing can pay off when costly jobs read distinct parts of the repository and unrelated changes are common. The gain shrinks when an always-run lane dominates job time or each job reads most of the repository.
