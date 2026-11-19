import argparse
import json
import os
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path


RELEASE = "v0.1.1"
RUNS = (
    (44045338989, "80a17d44ce9e4db001ba0c5295c2b197b82b5ec6", "52b751a5e1cbaea376fd9c51dc1237dcaffd9eb8"),
    (44049397569, "52b751a5e1cbaea376fd9c51dc1237dcaffd9eb8", "6f2e50eb60f5d8fb2f8693fddd244e9decbdc839"),
    (44094611325, "6f2e50eb60f5d8fb2f8693fddd244e9decbdc839", "036eec84effc491534f48b8ec6647e0a02557dff"),
)
LANES = ("demo", "check", "integration", "browser")


def git(repo, *args, **kwargs):
    return subprocess.check_output(["git", "-C", str(repo), *args], **kwargs)


def replay(relay, cli, config, scratch):
    original_objects = git(relay, "rev-parse", "--path-format=absolute", "--git-path", "objects", text=True).strip()
    objects = scratch / "objects"
    objects.mkdir()
    env = dict(
        os.environ,
        GIT_OBJECT_DIRECTORY=str(objects),
        GIT_ALTERNATE_OBJECT_DIRECTORIES=original_objects,
        GIT_INDEX_FILE=str(scratch / "index"),
    )
    blob = git(relay, "hash-object", "-w", "--stdin", input=config, env=env).decode().strip()

    def overlay(revision, parent=None):
        git(relay, "read-tree", revision, env=env)
        git(relay, "update-index", "--add", "--cacheinfo", f"100644,{blob},.github/lanes.yml", env=env)
        tree = git(relay, "write-tree", env=env, text=True).strip()
        parents = [] if parent is None else ["-p", parent]
        return git(
            relay, "-c", "user.name=Replay", "-c", "user.email=replay@example.invalid", "-c", "commit.gpgsign=false",
            "commit-tree", tree, *parents, "-m", "Apply replay config", env=env, text=True,
        ).strip()

    def plan(before, after):
        base = overlay(before)
        head = overlay(after, base)
        raw = subprocess.check_output(
            ["node", str(cli), "explain", "--cwd", str(relay), "--base", base, "--head", head, "--json"], env=env
        )
        return {row["lane"]: row["decision"] for row in json.loads(raw)["lanes"]}

    totals = dict.fromkeys(LANES, 0)
    skipped = dict.fromkeys(LANES, 0)
    for run, before, after in RUNS:
        if git(relay, "merge-base", before, after, text=True).strip() != before:
            raise ValueError(f"Expected a fast-forward range for run {run}")
        decisions = plan(before, after)
        endpoint = f"repos/0x963D/relay-crm/actions/runs/{run}/attempts/1/jobs?per_page=100"
        jobs = json.loads(subprocess.check_output(["gh", "api", "--method", "GET", endpoint]))["jobs"]
        if sorted(job["name"] for job in jobs) != sorted(LANES):
            raise ValueError(f"Unexpected jobs for run {run}")
        print(f"Run {run}: " + ", ".join(f"{lane}={decisions[lane]}" for lane in LANES))
        for job in jobs:
            lane = job["name"]
            seconds = int((datetime.fromisoformat(job["completed_at"]) - datetime.fromisoformat(job["started_at"])).total_seconds())
            totals[lane] += seconds
            if decisions[lane] == "skip":
                skipped[lane] += seconds

    # The first push's before SHA was unavailable. Its README rule covers any earlier fast-forward base.
    first_head = RUNS[0][2]
    ancestors = git(relay, "rev-list", first_head + "^@", text=True).splitlines()
    first_readme = git(relay, "rev-parse", first_head + ":README.md", text=True).strip()
    lookup = "".join(f"{sha}:README.md\n" for sha in ancestors)
    blobs = git(relay, "cat-file", "--batch-check", input=lookup, text=True).splitlines()
    same_readme = sum(row.startswith(first_readme + " ") for row in blobs)
    print(f"First push: {same_readme} of {len(ancestors)} earlier ancestors have the same README")
    print(f"{len(RUNS)} runs: {sum(skipped.values())} of {sum(totals.values()):,} job seconds skipped "
          f"({100 * sum(skipped.values()) / sum(totals.values()):.2f}%)")


def main():
    parser = argparse.ArgumentParser(description="Replay the three recorded CI runs in the Relay CRM sample.")
    parser.add_argument("relay_checkout", type=Path)
    args = parser.parse_args()
    router = Path(__file__).resolve().parent.parent
    config = (router / "scripts" / "replay-relay-ci.yml").read_bytes()
    with tempfile.TemporaryDirectory(prefix="relay-ci-replay-") as tmp:
        scratch = Path(tmp)
        cli = scratch / "cli.mjs"
        cli.write_bytes(git(router, "show", f"{RELEASE}:dist/cli.js"))
        replay(args.relay_checkout.resolve(), cli, config, scratch)


if __name__ == "__main__":
    main()
