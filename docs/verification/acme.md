# Acme verification

Baseline `2af90f2d50bd8a5f6782164a85879b35cf857503` (`v0.2.0`). Windows, Node 24.14.0, npm 11.11.0 and Git 2.50.1. Local `npm ci` stalled. The checks used a copy of the dependency tree from the release candidate checkout, whose lockfile differs only in the root package version. `npm ls --all` exited 0.

## Built CLI

`npm run demo` committed `packages/ui/src/button.tsx` in a temporary Acme repository. The CLI returned `complete` and these decisions:

```text
api   skip  nothing it reads changed
web   run   packages/ui/src/button.tsx is in @acme/ui, read through @acme/web
e2e   run   packages/ui/src/button.tsx is in @acme/ui, read through @acme/web-e2e > @acme/web
lint  run   floor lane, runs for every change that is not docs-only
```

The second demo commit included `docs/api/users.md` and selected all four lanes. On a separate Acme commit with the UI change, `node dist/cli.js explain --mode push --head <commit> --json` exited 0 with `complete: false`, `incomplete.kind: no-base`, and `api`, `web`, `e2e`, and `lint` all set to `run`. Supplying the real base for that commit returned `complete: true` and skipped `api`.

## Injected fault

The CI command `npm run test:soundness:mutations` passed the clean control and reported `Caught: skip on unmatched paths` and `Caught all 16 injected bugs.`

The ordinary test command also caught that fault. With the unmatched placement's reach changed from `model.everyLane` to `NO_LANES` in `src/core/route.ts`, the test for `tsconfig.json` expected all four lanes and got only `lint`. After restoring the source bytes, the same command passed.

```sh
npm test -- test/routing.test.ts -t "select every lane, and the root is never a package"
```

## Bundle parity

After the fresh build in `npm run demo`, `git diff --exit-code -- dist` exited 0. A binary comparison against the tracked blobs confirmed exact equality for `dist/cli.js` (380,546 bytes) and `dist/index.js` (1,206,667 bytes).
