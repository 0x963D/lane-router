# Not in v0.1: skipping lanes that already passed

A push to `main` could skip a lane that already passed on an earlier commit, when nothing the lane reads changed since then. lane-router v0.1 does not do this. It routes every push from `before` to `after`, the same way it routes a pull request.

Such a skip needs proof that the lane passed. The record of a past run that lane-router can read is metadata in the GitHub API: a check run's name and app, and the event and branch of the workflow run behind it. That metadata can be forged or confused:

- Any GitHub App with `checks: write` can create a passing check run with the lane's name.
- Any other workflow in the repository can do the same.
- A tag can have the same name as a branch. A run for a push of the tag `main` reports the branch `main`.
- Refs change between the run and the check. A tag named like the branch can be deleted before lane-router looks, and the API shows only the refs that exist now.

Each extra check on the metadata closes one gap and leaves the others open. A safe version needs a proof that the lane itself signs and records when it passes. That is future work.
