import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { build } from "esbuild";
import { git } from "./action-scenarios.js";
import { checkHistory } from "./check-action-soundness.js";
import { actionBundleOptions } from "./build.ts";

const project = fileURLToPath(new URL("../", import.meta.url));
const coverage = resolve(process.argv[2] ?? join(project, "coverage"));
mkdirSync(coverage, { recursive: true });
const scratch = mkdtempSync(join(coverage, "action-mutations-"));
const seed = 20261120;
const mutations = [
  ["use a stale payload base for the merge", "action.ts", "base = first;", "base = range.base;"],
  [
    "trust any implicit pull request checkout",
    "action.ts",
    "checkout !== pullRequest.eventSha && checkout !== pullRequest.head",
    "false",
  ],
  ["trust any implicit push checkout", "action.ts", "if (checkout !== range.head)", "if (false)"],
  ["accept a different explicit head", "action.ts", "if (supplied !== checkout)", "if (false)"],
  [
    "accept a rewind as a fast-forward",
    "adapters/github.ts",
    'requireBaseAncestor || mode === "push"',
    "requireBaseAncestor",
  ],
  [
    "judge a custom PR checkout from a nonancestor",
    "action.ts",
    "requireBaseAncestor: invocation.requireBaseAncestor || (pullRequest !== undefined && !branchDiff)",
    "requireBaseAncestor: false",
  ],
  [
    "ignore the PR file count",
    "adapters/github.ts",
    "expectedCount !== null && listed.length !== expectedCount",
    "false",
  ],
  ["trust the capped compare listing", "adapters/github.ts", "listed.length >= COMPARE_LIMIT", "false"],
  [
    "use the API subset after verifying a larger local diff",
    "adapters/github.ts",
    "if (files.paths.every((path) => available.has(path))) return local;",
    "if (files.paths.every((path) => available.has(path))) return files;",
  ],
  [
    "ignore disagreement between the API and the local list",
    "adapters/github.ts",
    "files.paths.every((path) => available.has(path))",
    "true",
  ],
  [
    "ignore a PR count when recovering a capped list",
    "adapters/github.ts",
    "(expectedCount === null || local.paths.length === expectedCount)",
    "true",
  ],
  ["drop the old name of a rename", "adapters/github.ts", "previousPath: previousPath ?? null", "previousPath: null"],
  [
    "discard paths outside the routed root",
    "core/change.ts",
    "if (outside !== undefined) return incomplete",
    "if (false) return incomplete",
  ],
  ["resolve the local base as HEAD", "adapters/git.ts", "`${ref}^{commit}`", '"HEAD^{commit}"'],
  [
    "load the base model at the payload base",
    "adapters/github.ts",
    "changedFiles(listed, { under, mergeBase })",
    "changedFiles(listed, { under, mergeBase: base })",
  ],
  ["enable rename detection in the capped local diff", "adapters/git.ts", '  "--no-renames",\n', "", true],
  [
    "ignore disagreement about the merge base of a capped diff",
    "adapters/github.ts",
    "            local.mergeBase === mergeBase &&\n",
    "",
    true,
  ],
  [
    "allow a divergent merge group in explicit PR mode",
    "action.ts",
    'requireBaseAncestor: event.kind === "merge_group" && mode === "pr",',
    "requireBaseAncestor: false,",
    true,
  ],
  [
    "drop paths outside the routed root from the local diff",
    "adapters/git.ts",
    "return changedFiles(\n        split(output).map((path) => ({ path, previousPath: null })),",
    "const root = await prefix();\n      return changedFiles(\n        split(output).filter((path) => path.startsWith(root)).map((path) => ({ path, previousPath: null })),",
  ],
];

const control = { path: join(project, "dist", "index.js"), control: true };
const released = { label: "released v0.1.1 PR-branch listing", path: join(scratch, "released.mjs"), requireSkip: true };

try {
  writeFileSync(
    released.path,
    execFileSync("git", ["show", "v0.1.1:dist/index.js"], {
      cwd: project,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
  const variants = [released];
  for (const [label, file, before, after, requireSkip] of mutations) {
    const path = join(project, "src", file);
    const source = readFileSync(path, "utf8");
    assert.equal(source.split(before).length, 2, "expected one patch match for " + label);
    const outfile = join(scratch, "fault-" + variants.length + ".mjs");
    await build({
      ...actionBundleOptions,
      absWorkingDir: project,
      outfile,
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
    variants.push({ label, path: outfile, requireSkip });
  }

  const fingerprint = createHash("sha256").update(
    JSON.stringify({
      seed,
      node: process.version,
      platform: process.platform,
      git: git(project, ["--version"]).trim(),
    }),
  );
  for (const file of [
    import.meta.filename,
    ...["check-action-soundness.js", "action-oracle.js", "action-scenarios.js"].map(
      (name) => new URL("./" + name, import.meta.url),
    ),
    ...[control, ...variants].map(({ path }) => path),
  ]) {
    fingerprint.update(readFileSync(file));
  }
  const checkpoint = join(coverage, "faults-" + fingerprint.digest("hex").slice(0, 16) + ".jsonl");
  const rows = readCheckpoint(checkpoint);
  const completed = new Set(rows.map(({ name }) => name));
  const pending = await checkHistory(scratch, seed, [control, ...variants], {
    completed,
    jobs: 2,
    onCase(row) {
      appendFileSync(checkpoint, JSON.stringify(row) + "\n");
      rows.push(row);
    },
  });
  assert.equal(rows.length, completed.size + pending.cases);

  for (const { label, requireSkip } of variants) {
    const failures = rows.flatMap((row) => row.failures.filter((failure) => failure.label === label));
    const falseSkip = failures.find(
      ({ reason, actual }) => /skipped a required lane/.test(reason) && Object.values(actual.outputs).includes("skip"),
    );
    const counterexample = falseSkip ?? failures[0];
    assert.ok(counterexample, label + " survived all " + rows.length + " cases");
    if (requireSkip) assert.ok(falseSkip, label + " failed without exhibiting an unsafe skip");
    process.stdout.write(
      JSON.stringify({
        ...counterexample,
        kind: falseSkip ? "false-skip" : "contract",
        cases: rows.length,
        counterexamples: failures.length,
      }) + "\n",
    );
  }
  process.stdout.write(`Caught all ${variants.length} seam faults across ${rows.length} cases per bundle.\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
}

function readCheckpoint(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  writeFileSync(path, complete);
  return complete
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
