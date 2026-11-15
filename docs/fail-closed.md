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

The typed API requires private symbol keys on `Skip`, `Routing` and `CompleteFiles`. A plain object in another module cannot construct any of those types. `changedFiles` constructs complete file lists, `route` constructs routings, and `decide` constructs skips from a routing. Other modules can call these functions, but cannot pass a plain fabricated routing to `decide`. They can construct run decisions directly.

`npm run typecheck` checks those restrictions in `test/type-claims.ts`. These are compile-time construction constraints, not runtime validation. They do not establish that a caller supplied an accurate model or file list, and they do not prevent copying an existing branded value or bypassing types with assertions.
