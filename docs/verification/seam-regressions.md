# Range and completeness regressions

These ten IDs come from the [v0.2.0 Action seam campaign](../evidence.md#action-seam-mutation-testing). The source in that report matched the release checkout byte for byte for all five mutated files. Each run applied one report replacement at its recorded location, ran the matching Action cases with `npm test -- test/action-seam-mutation.test.js -t <case>`, then restored the source and reran the same command. For #274, the command ran the entire test file.

| ID and source                              | Mutation                                               | Disposition                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [#274](../../src/action.ts#L237)           | Initialize `branchDiff` to `true`                      | Equivalent. Range selection overwrites it before compare. Supplied paths ignore it, and a compare without a base returns before using it. |
| [#283](../../src/action.ts#L238)           | Require a checkout even for a compare without a base   | Gap. A new branch with no Git checkout still reports `no base commit` and runs all lanes.                                                 |
| [#326](../../src/action.ts#L261)           | Apply the checkout mismatch guard to the target event  | Gap. A default `pull_request` whose checkout matches neither the event SHA nor its head must fail closed before comparing.                |
| [#390](../../src/action.ts#L295)           | Drop the PR checkout ancestry requirement              | Gap. A merge checkout must fail closed if the compare response says it diverges from the chosen base.                                     |
| [#896](../../src/adapters/github.ts#L178)  | Require both base validation checks to fail            | Gap. A present but malformed `base_commit.sha` cannot certify a push, even if the response repeats it as the merge base.                  |
| [#952](../../src/adapters/github.ts#L198)  | Try capped recovery for a PR count below 300           | Gap. A 299-file payload with a capped listing reports truncation even if a local path would be invalid.                                   |
| [#987](../../src/adapters/github.ts#L206)  | Accept a recovery diff with fewer than 300 local paths | Gap. Distinct listed names can normalize to the same path. A shorter local list cannot certify the capped response.                       |
| [#1014](../../src/adapters/github.ts#L224) | Remove the opening SHA anchor                          | Gap. A leading prefix on the reported base SHA cannot certify a push.                                                                     |
| [#1015](../../src/adapters/github.ts#L224) | Remove the closing SHA anchor                          | Gap. A trailing suffix on the reported base SHA cannot certify a push.                                                                    |
| [#1058](../../src/core/change.ts#L84)      | Supply an invented path for an incomplete change       | Gap. A new branch lists zero paths in the Action summary.                                                                                 |

Each gap failed an output, warning, or summary assertion with the mutation and passed with the released source restored. The #274 mutant passed the seam test file. The regressions use the existing Acme Action test and its Git and compare fixtures.

## Check results

- `npm test` passed 499 tests across 17 files on Windows. The symlink capability test was skipped.
- `npm run test:action-soundness` passed 65 cases against the rebuilt Action. It verified 81 skips.
- `npm run check:linking` checked 223 rows with npm 11.11.0 and pnpm 11.18.0. The managers installed and checked 118 cases and rejected 328 as expected. The check reported zero failures.
