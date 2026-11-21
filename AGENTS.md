# lane-router project rules

- The Action and CLI select named CI lanes from workspace dependencies and explicit file rules. An incomplete diff runs every known lane. An invalid head routing model fails the invocation. See [the fail-closed contract](docs/fail-closed.md).
- Route both entry points through `planLanes`. Keep Git and compare requests in `src/adapters/`, workspace and config decoding in `src/load/`, and routing decisions in `src/core/`. The import boundaries are enforced by [eslint.config.js](eslint.config.js).
- Use the Acme fixture and existing helpers in `test/support/` for regressions. Check the lanes, completeness and reason exposed by the Action or CLI when changing range or file-list handling.
- Build the tracked Action and CLI bundles with `npm run build`. Verify with [verify-lane-router](.agents/skills/verify-lane-router/SKILL.md) before handing off a change. Coordinate releases and tag changes with the maintainer.
