---
name: verify-lane-router
description: Verify lane-router's CLI and Action using the Acme fixture, fail-closed checks, and the same build and checks as CI.
---

# Verify lane-router

Run from the checkout root. Check that `npm version` reports Node 24 and `git --version` reports Git 2.49 or later. Run `npm ci` to prepare the checkout. The fixture needs no credentials or running service.

## Drive the fixture

- Run `npm run demo`. It creates and removes a temporary Acme Git repository and drives the built CLI. The first committed change is `packages/ui/src/button.tsx`. Expect `api` to skip and `web`, `e2e`, and `lint` to run. The second change includes `docs/api/users.md` and selects all four lanes.
- Run `npm test -- test/cli.test.ts -t "runs every lane in push mode if the base is absent or unavailable"`. The Acme test exercises the CLI with no base, a zero base and an unavailable base. Expect `complete: false` and all four lanes in every case.

## Run the CI checks

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:soundness:mutations
npm run build
npm run test:action-soundness
git diff --exit-code -- dist
```

The mutation check runs a clean control and must print `Caught: skip on unmatched paths` among its 16 detections. It restores each injected fault inside its temporary copy. The build check covers `dist/cli.js` and `dist/index.js`. Review the staged bundle diff too if the change includes regenerated bundles.

Run `npm run check:linking` with npm 11.11.0 and pnpm 11.18.0 for workspace linking. The hosted `Dogfood` and `Compare the pull request merge` jobs check the Action's workflow outputs and live compare request. See [ci.yml](../../../.github/workflows/ci.yml) for the exact jobs.

## Save evidence

Record the commit, command, exit code and relevant output under `coverage/verification/`. Keep the fixture diff, the lane decisions and the fallback reason. Use [the routing evidence guide](../../../docs/evidence.md#action-seam-mutation-testing) to look up mutation survivors when changing range selection or completeness.
