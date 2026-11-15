# Fail-closed guarantees

A wrong skip merges an untested break. lane-router runs every lane, and says why in each reason, for a change that holds:

- a changed path that no placement claims,
- a built-in file: the routing config, `pnpm-workspace.yaml`, the root `package.json` or a root lockfile.

It also runs every lane when it cannot trust the list of changed files. Then `complete` is `false`, an annotation gives the cause, and the step succeeds so the lanes run. These are the cases:

- a package manifest change whose base graph cannot be built, because there is no base commit, the commit was not fetched, a manifest there does not parse, a name in the config does not resolve there, or reading it failed,
- a compare listing of 300 or more files, which is the most the endpoint returns,
- a pull request whose compare listing differs from its `changed_files` count,
- a push with no `before` commit to compare against, such as the first push of a branch, whose `before` is all zeros,
- a push whose head does not extend its base, such as a force push,
- a compare status other than `ahead`, `identical`, `behind` or `diverged`,
- a changed path outside `working-directory`,
- any API error, git error or unexpected exception after the config has loaded.

A push is routed from `before` to `after`, and the compare API lists the change from the merge base of the two. After a force push the merge base is not `before`, so the listing leaves out what the dropped commits changed. In push mode lane-router trusts the listing only when the compare API reports `ahead` or `identical` and the merge base is the base commit. That holds for a `base` input in push mode too. A `mode` input that contradicts its event fails the step, so a push cannot opt out of this rule. A pull request is exempt, because its base branch often moves on after it opens and its change is meant to start at the merge base.

A shallow checkout, the `actions/checkout` default, has no base commit. A change to a package manifest then runs every lane. Check out with `fetch-depth: 0` to keep those changes precise. Other changes never need the base commit.

A config or workspace error is different. The lane names are unknown, so lane-router fails the step and lists every problem. Downstream jobs never start, so the build stays red and no lane is skipped by mistake.

The code enforces the rule as well. A skip decision and a complete file list each carry a key that only one module can name, so no other code can construct either one. `npm run typecheck` checks this in `test/type-claims.ts`. Every other module can build only a decision to run.
