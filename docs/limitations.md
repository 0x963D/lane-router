# Limitations

These are not built:

- Workspace discovery reads pnpm and npm declarations. Yarn and Bun also use the `workspaces` field. The [field replay](evidence.md#field-replay) checked manifest discovery in Babel, a Yarn workspace. Yarn and Bun installation and dependency resolution are outside that replay.
- Dependencies come from manifests and configured edges. Imports in source files are not read.
- `unmatched` accepts only `all`.
- The compare endpoint lists at most 300 files. Large changes need enough local history to verify the full diff. A default PR head comparison can still run every lane if Git lists both paths of a rename and the resulting path count disagrees with the payload.
- A depth-1 merge checkout has enough history for the first-parent compare. If a routing config or package manifest changes, use `fetch-depth: 0` to give the Action the base model too.
- There is no Marketplace listing yet.

## Dependency boundaries

The loader reads workspace manifests, pnpm catalogs, overrides in the workspace YAML and both root manifest locations, and configured edges. It does not run a package manager or inspect installed packages when routing.

- pnpm [`packageExtensions`](https://pnpm.io/settings/dependency-resolution#packageextensions) can add dependencies and peer dependencies that the graph does not contain.
- [pnpmfile hooks](https://pnpm.io/pnpmfile) in `.pnpmfile.cjs`, `.pnpmfile.mjs` or a configured global pnpmfile can rewrite manifests, settings and lockfiles. Custom resolvers and fetchers can change what installs too. The loader does not execute them.
- pnpm [settings](https://pnpm.io/settings) supplied through the command line, environment or global configuration can change resolution. Only the repository files listed above contribute override edges.
- npm [lifecycle scripts](https://docs.npmjs.com/cli/v11/using-npm/scripts/) and other install scripts can modify manifests or installed files. The loader does not execute scripts or model their effects.
- Registry packages, remote archives and Git sources can contain dependencies that lead back into the workspace. The loader does not inspect their contents, transitive dependencies or lockfile resolutions. npm packages can also publish an [`npm-shrinkwrap.json`](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/) that fixes their dependency tree.
- npm links every workspace package into the root `node_modules`, and pnpm's `shamefullyHoist` and `publicHoistPattern` settings can do the same, so a package can import a workspace package that its manifest does not list. The loader adds no edge for such an import. List the dependency in the manifest or add it to `workspace.edges`.
- A link to a subdirectory adds an edge to the workspace package that owns it, but the loader does not read a `package.json` inside that subdirectory. Dependencies declared there, such as a `dist/package.json` that depends on another workspace package, need `workspace.edges`.
- A local path that is absolute, starts with `~/`, or leaves the repository adds no path edge, even when it resolves back into a workspace package. Use a relative path inside the repository or add the edge to `workspace.edges`.
- A `link:` or `file:` path inside a workspace package adds an edge to its deepest workspace owner, even when the target has no manifest. A path outside every discovered workspace package has only path-rule coverage. Add a `paths` row for its readers. An unclaimed path runs every lane, but a path claimed as docs-only or assigned to fewer lanes needs rules that name all of its readers.

Every row of `npm run check:linking` runs pnpm with `linkWorkspacePackages: true`. The check does not cover installations with that setting disabled. pnpm copies some `file:` dependencies into its virtual store, and the check does not yet trace such a copy back to its source directory, so those rows assert only that the workspace loads.

A string override keyed by a workspace package's own name adds that package to every package's closure, even when the replacement names something else. A change to that package therefore runs every lane, subject to the configured docs-only and path rules.

Use `workspace.edges` for dependencies these mechanisms introduce and `paths` rows for files read outside workspace packages. Changes to the root manifest, workspace YAML and recognised lockfiles already run every lane. Hook files and external configuration need their own coverage rules.
