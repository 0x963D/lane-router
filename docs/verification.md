# Documentation verification

## Checks

The documentation split preserves the original section bodies. A Node check compared each moved section with the original README after it removed heading prefixes and the new page title on the routing page. It also compared the config example in [the config reference](config.md) with [the demo fixture](../test/fixtures/acme/.github/lanes.yml). They match.

The link check walks `README.md` and every Markdown file under `docs/`. It ignores fenced code blocks, resolves relative link destinations from each source file, and checks heading fragments against heading slugs. Every relative link resolves. External links returned successful HTTP responses to HEAD requests.

The only numeric value in the README is `paths[3]`. It appears next to `npm run demo`. The quoted decision matches the output of that command. The workflow example parses as YAML, and its test commands depend on the selected lane.

To measure the README size in bytes, run this command from the repository root.

```sh
node -e "console.log(require('node:fs').statSync('README.md').size)"
```

## Command results

The following commands passed.

```sh
npm run typecheck
npm run lint
npm run format:check
npm run demo
```

`npm test` reports a failure in [`test/readme.test.ts`](../test/readme.test.ts). That test reads only the README and expects the full config example under `## Config reference`. The example now lives in `docs/config.md`. The independent comparison above confirms that it still matches the fixture. The documentation task leaves the test unchanged.

The original test run passed before the move. The final run has 174 passing tests, one failing test, and one skipped test. The skipped test requires file symbolic links. This Windows account cannot create them.

## Limits of verification

The workflow example has not run on GitHub. This repository has no remote or release tag. `OWNER` remains a placeholder for the future hosting account.

The original reference text remains unchanged apart from heading levels and the routing page title. Its full workflow still uses the future `v0` tag. The [limitations](limitations.md) already state that there is no release tag or Marketplace listing.
