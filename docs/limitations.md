# What's next

These are not built:

- Workspace discovery reads pnpm and npm files only. Yarn and Bun also use the `workspaces` field, so `discovery: npm` may read them, but no test covers it.
- Dependencies come from manifests and configured edges. Imports in source files are not read.
- `unmatched` accepts only `all`.
- A compare listing of 300 or more files fails closed. Paging through a larger diff would let such a change skip lanes safely.
- A `merge_group` event needs `mode`, `base` and `head` set by hand.
- There is no Marketplace listing yet.
