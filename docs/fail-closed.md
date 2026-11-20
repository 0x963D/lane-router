# Fail-closed guarantees

A wrong skip merges an untested break. lane-router runs every lane, and says why in each reason, for a change that holds:

- a changed path that no placement claims,
- a built-in file: the routing config, `pnpm-workspace.yaml`, the root `package.json` or a root lockfile.

It also runs every lane when it cannot trust the list of changed files. Then `complete` is `false`, an annotation gives the cause, and the step succeeds so the lanes run. These are the cases:

- a routing config or package manifest change whose base model cannot be built, because there is no base commit, the commit was not fetched, its config or a manifest does not parse, a name in the base config does not resolve there, or reading it failed,
- a compare listing that reaches 300 files, unless local Git can verify the complete diff,
- a default pull request branch diff whose verified listing differs from its `changed_files` count,
- a `pull_request` comparison whose checkout matches neither the merge commit nor the PR head, with no explicit `head` input,
- a `head` input that cannot resolve to the checkout on any event,
- a comparison on a non-PR event whose checkout differs from the implicit event head,
- a checkout that cannot be resolved for a comparison or for an explicit `head` check,
- a comparison that requires ancestry but cannot resolve the base or establish that the checkout extends it,
- a push with no `before` commit to compare against, such as the first push of a branch, whose `before` is all zeros,
- a push whose head does not extend its base, such as a force push,
- a compare status other than `ahead`, `identical`, `behind` or `diverged`,
- a changed path outside `working-directory`,
- any API error, git error or unexpected exception after the config has loaded.

A push is routed from `before` to `after`, and the compare API lists the change from the merge base of the two. After a force push the merge base is not `before`, so the listing leaves out what the dropped commits changed. In push mode lane-router trusts the listing only when the compare API reports `ahead` or `identical` and the merge base is the base commit. That holds for a `base` input in push mode too. A `mode` input that contradicts its event fails the step, so a push cannot opt out of this rule.

A merge group compares its payload base and head, or supplied revisions, with the same checkout and ancestry rules. A queue base must be an ancestor in either mode.

On either pull request event, a PR head checkout uses the diff from the merge base, even with a custom base. Routing the proposed change on the default `pull_request_target` base-tip checkout also uses the diff from the merge base. Other PR checkouts require the base to be an ancestor. With `base` omitted, a checkout with exactly two parents and the PR head as its second parent uses its first parent. If that shape cannot be verified, the ancestry check uses the payload base. See the [checkout and input tables](action.md#inputs).

A capped listing can use local Git when both compare revisions are available. The local merge base must match the API response. Every listed path, including old rename paths, must appear in the local diff. When the PR count check applies, the complete path count must match the payload. A path outside the routed root still makes the plan incomplete, including when local Git finds it beyond the cap.

A depth-1 checkout retains the parent SHAs in the commit object. The compare endpoint checks ancestry and lists the paths with those SHAs. If the routing config or a package manifest changed, the Action needs the local commit the diff starts from. A missing commit runs every known head lane with `complete=false` and reports how to set `fetch-depth`. Use `fetch-depth: 0` to read the base config and graph.

With a readable base, a config change selects the union of base and head lanes. A lane found only in base runs and says it was removed. A renamed lane emits both names. A lane keeps the packages it read and any floor flag from base for this change. A newly added config has no base lanes. A missing base config fails closed unless the changed paths include the config. See [base and head lanes](decisions/007-base-and-head-lanes.md).

A config or workspace error is different. The lane names are unknown, so lane-router fails the step and lists every problem. Downstream jobs never start, so the build stays red and no lane is skipped by mistake.

The typed API requires private symbol keys on `Skip`, `Routing` and `CompleteFiles`. A plain object in another module cannot construct any of those types. `changedFiles` constructs complete file lists, `route` constructs routings, and `decide` constructs skips from a routing. Other modules can call these functions, but cannot pass a plain fabricated routing to `decide`. They can construct run decisions directly.

`npm run typecheck` checks those restrictions in `test/type-claims.ts`. These are compile-time construction constraints, not runtime validation. They do not establish that a caller supplied an accurate model or file list, and they do not prevent copying an existing branded value or bypassing types with assertions.

## Reading files

A pull request controls every file lane-router reads, and the Action may run in a privileged workflow such as `pull_request_target`. lane-router reads only inside the repository root. Syntax errors omit source excerpts. Validation errors can include dependency keys from manifests, and decisions include config values.

- A path that is absolute, contains a backslash, has a `.` or `..` segment, or is inside `.git` is never read. This applies to the `config` input too.
- A symbolic link is never followed. In a checked-out directory, a file that is a link is refused, and so is a file whose real path is outside the root, which catches a linked parent directory. A linked directory is never walked into. In a git commit, an entry stored as a link or a submodule is refused.
- A workspace glob with a `..` segment is a config problem.
- A refused read is a problem that names the path and the reason, such as `packages/api/package.json  is a symbolic link`. A refused read in the head config or workspace makes the Action fail the step and the CLI exit with 1. A refused read in the base commit makes the change incomplete, so every lane runs and the step succeeds.
- A parse error gives the file, the line and column when they are known, and a fixed reason such as `is not valid JSON`. It omits source excerpts. Validation messages may quote dependency keys from manifests and name lanes and packages, including duplicate names and suggestions. The job summary, the `reasons` and `matrix` outputs, and the CLI include each matching path row's `why` text from the config.

## Workflow changes

lane-router guards against wrong skips caused by a change's files, dependency graph and routing config. It does not protect the workflow that invokes it.

GitHub runs [the workflow version at the event's ref](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows#workflow-triggers). For `pull_request`, that ref is [the pull request's merge branch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request), so the pull request can change the workflow itself.

To protect that boundary, use [required status checks and required code-owner reviews](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches). Require review for the workflow and routing config paths.
