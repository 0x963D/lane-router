import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { actionBundleOptions } from "./build.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const coverage = resolve(process.argv[2] ?? join(project, "coverage"));
mkdirSync(coverage, { recursive: true });
const scratch = mkdtempSync(join(coverage, "action-mutations-"));
const seed = "20261120";
const mutations = [
  [
    "use a stale payload base for the merge",
    "merge-stale-base",
    "action.ts",
    "base = first;",
    "base = range.base;",
    "precision",
  ],
  [
    "trust any implicit pull request checkout",
    "pr-wrong-checkout",
    "action.ts",
    "checkout !== pullRequest.eventSha && checkout !== pullRequest.head",
    "false",
  ],
  [
    "trust any implicit push checkout",
    "push-wrong-checkout",
    "action.ts",
    "if (checkout !== range.head)",
    "if (false)",
  ],
  [
    "accept a different explicit head",
    "push-explicit-wrong-head",
    "action.ts",
    "if (supplied !== checkout)",
    "if (false)",
  ],
  [
    "accept a rewind as a fast-forward",
    "push-rewind",
    "adapters/github.ts",
    'requireBaseAncestor || mode === "push"',
    "requireBaseAncestor",
  ],
  [
    "judge a custom PR checkout from a nonancestor",
    "pr-custom-nonancestor",
    "action.ts",
    "requireBaseAncestor: pullRequest !== undefined && !branchDiff",
    "requireBaseAncestor: false",
  ],
  [
    "ignore the PR file count",
    "pr-count-mismatch",
    "adapters/github.ts",
    "expectedCount !== null && listed.length !== expectedCount",
    "false",
  ],
  [
    "trust the capped compare listing",
    "push-capped-shallow",
    "adapters/github.ts",
    "listed.length >= COMPARE_LIMIT",
    "false",
  ],
  [
    "use the API subset after verifying a larger local diff",
    "push-capped",
    "adapters/github.ts",
    "if (files.paths.every((path) => available.has(path))) return local;",
    "if (files.paths.every((path) => available.has(path))) return files;",
  ],
  [
    "ignore disagreement between the API and the local list",
    "push-capped-disagreement",
    "adapters/github.ts",
    "files.paths.every((path) => available.has(path))",
    "true",
  ],
  [
    "ignore a PR count when recovering a capped list",
    "pr-capped-count-disagreement",
    "adapters/github.ts",
    "(expectedCount === null || local.paths.length === expectedCount)",
    "true",
  ],
  [
    "drop the old name of a rename",
    "push-renames-and-deletes",
    "adapters/github.ts",
    "previousPath: previousPath ?? null",
    "previousPath: null",
  ],
  [
    "discard paths outside the routed root",
    "push-outside-root",
    "core/change.ts",
    "if (outside !== undefined) return incomplete",
    "if (false) return incomplete",
  ],
  ["resolve the local base as HEAD", "push-local-base", "adapters/git.ts", "`${ref}^{commit}`", '"HEAD^{commit}"'],
  [
    "load the base model at the payload base",
    "pr-base-graph-from-diff",
    "adapters/github.ts",
    "changedFiles(listed, { under, mergeBase })",
    "changedFiles(listed, { under, mergeBase: base })",
    "precision",
  ],
];

function check(cases, action) {
  const args = ["scripts/check-action-soundness.js", "--seed", seed, "--output", scratch];
  if (cases !== undefined) args.push("--case", cases);
  if (action !== undefined) args.push("--action", action);
  const result = spawnSync(process.execPath, args, {
    cwd: project,
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

function caught(label, cases, action, expected = "false-skip") {
  const result = check(cases, action);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const counterexample = result.stderr.split(/\r?\n/).find((line) => line.startsWith("Counterexample: "));
  assert.ok(counterexample, label + " failed without an oracle counterexample: " + result.stderr);
  const evidence = JSON.parse(counterexample.slice("Counterexample: ".length));
  assert.equal(evidence.scenario.name, cases);
  if (expected === "false-skip") {
    assert.match(evidence.reason, /skipped a required lane/, label);
    assert.ok(Object.values(evidence.actual.outputs).includes("skip"), "the Action must return a skip");
  }
  process.stdout.write(JSON.stringify({ label, kind: expected, ...evidence }) + "\n");
}

try {
  const control = check();
  assert.equal(control.status, 0, control.stderr);
  process.stdout.write(control.stdout);
  const bundle = join(scratch, "index.mjs");
  writeFileSync(
    bundle,
    execFileSync("git", ["show", "v0.1.1:dist/index.js"], { cwd: project, maxBuffer: 8 * 1024 * 1024 }),
  );
  caught("released v0.1.1 PR-branch listing", "merge-stale-base", bundle);
  for (const [label, cases, file, before, after, expected] of mutations) {
    const path = join(project, "src", file);
    const source = readFileSync(path, "utf8");
    assert.equal(source.split(before).length, 2, "expected one patch match for " + label);
    await build({
      ...actionBundleOptions,
      absWorkingDir: project,
      outfile: bundle,
      plugins: [
        {
          name: "inject-change",
          setup(builder) {
            builder.onLoad({ filter: /\.ts$/ }, (args) =>
              args.path === path ? { contents: source.replace(before, after), loader: "ts" } : undefined,
            );
          },
        },
      ],
    });
    caught(label, cases, bundle, expected);
  }
  process.stdout.write("Caught all " + (mutations.length + 1) + " seam faults.\n");
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}
