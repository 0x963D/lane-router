# What's next

These are not built:

- Workspace discovery reads pnpm and npm files only. Yarn and Bun also use the `workspaces` field, so `discovery: npm` may read them, but no test covers it.
- Dependencies come from manifests and configured edges. Imports in source files are not read.
- `unmatched` accepts only `all`.
- A compare listing of 300 or more files fails closed. Paging through a larger diff would let such a change skip lanes safely.
- A `merge_group` event needs `mode`, `base` and `head` set by hand.
- There is no Marketplace listing yet.

## Dependency boundaries

The loader reads workspace manifests, pnpm catalogs, overrides in the workspace YAML and both root manifest locations, and configured edges. It does not run a package manager or inspect installed packages when routing.

- pnpm [`packageExtensions`](https://pnpm.io/settings/dependency-resolution#packageextensions) can add dependencies and peer dependencies that the graph does not contain.
- [pnpmfile hooks](https://pnpm.io/pnpmfile) in `.pnpmfile.cjs`, `.pnpmfile.mjs` or a configured global pnpmfile can rewrite manifests, settings and lockfiles. Custom resolvers and fetchers can change what installs too. The loader does not execute them.
- pnpm [settings](https://pnpm.io/settings) supplied through the command line, environment or global configuration can change resolution. Only the repository files listed above contribute override edges.
- npm [lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/) and other install scripts can modify manifests or installed files. The loader does not execute scripts or model their effects.
- Registry packages, remote archives and Git sources can contain dependencies that lead back into the workspace. The loader does not inspect their contents, transitive dependencies or lockfile resolutions. npm packages can also publish an [`npm-shrinkwrap.json`](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/) that fixes their dependency tree.
- Code read through a `link:` or `file:` path to a directory that is not a discovered workspace package has only path-rule coverage. Add a `paths` row for its readers. An unclaimed path runs every lane, but a path claimed as docs-only or assigned to fewer lanes needs rules that name all of its readers.

Use `workspace.edges` for dependencies these mechanisms introduce and `paths` rows for files read outside workspace packages. Changes to the root manifest, workspace YAML and recognised lockfiles already run every lane. Hook files and external configuration need their own coverage rules.
