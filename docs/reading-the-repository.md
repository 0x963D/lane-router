# Reading the repository

A pull request controls every file lane-router reads, and the Action may run in a privileged workflow such as `pull_request_target`. lane-router reads only inside the repository root. Syntax errors omit source excerpts. Validation errors can include dependency keys from manifests, and decisions include config values.

- A path that is absolute, contains a backslash, has a `.` or `..` segment, or is inside `.git` is never read. This applies to the `config` input too.
- A symbolic link is never followed. In a checked-out directory, a file that is a link is refused, and so is a file whose real path is outside the root, which catches a linked parent directory. A linked directory is never walked into. In a git commit, an entry stored as a link or a submodule is refused.
- A workspace glob with a `..` segment is a config problem.
- A refused read is a problem that names the path and the reason, such as `packages/api/package.json  is a symbolic link`. A refused read in the head config or workspace makes the Action fail the step and the CLI exit with 1. A refused read in the base commit makes the change incomplete, so every lane runs and the step succeeds.
- A parse error gives the file, the line and column when they are known, and a fixed reason such as `is not valid JSON`. It omits source excerpts. Validation messages may quote dependency keys from manifests and name lanes and packages, including duplicate names and suggestions. The job summary, the `reasons` and `matrix` outputs, and the CLI include each matching path row's `why` text from the config.
