import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const mutations = [
  ["ignore dev dependencies", "load/workspace.ts", '"dependencies", "devDependencies",', '"dependencies",'],
  [
    "drop configured edges",
    "core/model.ts",
    "for (const { from, to } of edges) graph.get(from)?.push(to);",
    "void edges;",
  ],
  [
    "stop traversing on a revisit",
    "core/model.ts",
    "if (chains.has(name)) return;",
    "if (chains.has(name)) { queue.splice(0); return; }",
  ],
  [
    "drop floor runs",
    "core/route.ts",
    'if (routing.kind === "ordinary" && lane.floor) because.push',
    "if (false) because.push",
  ],
  ["ignore lockfiles", "core/model.ts", '...LOCKFILES.map((file) => [file, "lockfile"] as const),', ""],
  [
    "skip on unmatched paths",
    "core/route.ts",
    '{ kind: "unmatched", reach: model.everyLane }',
    '{ kind: "unmatched", reach: NO_LANES }',
  ],
  [
    "prefer shallow package ownership",
    "core/route.ts",
    "for (let depth = segments.length - 1; depth > 0; depth--)",
    "for (let depth = 1; depth < segments.length; depth++)",
  ],
  ["drop the old rename path", "core/change.ts", "(previousPath === null ? [path] : [previousPath, path])", "[path]"],
  ["ignore the base model", "core/plan.ts", "if (withBase.ok) judged = withBase.value;", "if (withBase.ok) void 0;"],
  ["limit code rows to roots", "core/model.ts", 'code: "closure"', 'code: "roots"'],
  [
    "ignore rows on docs-only changes",
    "core/route.ts",
    'return routing.kind !== "docs-only" || placement.kind !== "package";',
    'return routing.kind !== "docs-only";',
  ],
  [
    "limit dependencies to one hop",
    "core/model.ts",
    "for (const next of graph.get(name) ?? []) visit(next, [...chain, next]);",
    "if (chain.length === 1) for (const next of graph.get(name) ?? []) visit(next, [...chain, next]);",
  ],
  ["ignore peer dependencies", "load/workspace.ts", '"devDependencies", "peerDependencies",', '"devDependencies",'],
  [
    "drop package placement when a row matches",
    "core/route.ts",
    "if (owner !== undefined) {",
    "if (owner !== undefined && placements.length === 0) {",
  ],
  [
    "ignore rows targeting all lanes",
    "core/model.ts",
    'if (named === "all") return everyLane;',
    'if (named === "all") return new Map();',
  ],
  [
    "treat any docs path as a docs-only change",
    "core/route.ts",
    "kind: paths.every(({ path }) => model.isDocs(path))",
    "kind: paths.some(({ path }) => model.isDocs(path))",
  ],
];

const project = resolve(import.meta.dirname, "..");
const coverage = join(project, "coverage");
mkdirSync(coverage, { recursive: true });
const scratch = mkdtempSync(join(coverage, "soundness-"));
function check() {
  const result = spawnSync(process.execPath, ["scripts/check-soundness.ts"], {
    cwd: scratch,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

try {
  cpSync(join(project, "src"), join(scratch, "src"), { recursive: true });
  mkdirSync(join(scratch, "scripts"));
  for (const file of ["check-soundness.ts", "soundness-scenarios.ts"]) {
    cpSync(join(project, "scripts", file), join(scratch, "scripts", file));
  }
  const control = check();
  assert.equal(control.status, 0, control.stderr);
  process.stdout.write(control.stdout);
  const failed = [];
  for (const [label, file, before, after] of mutations) {
    const path = join(scratch, "src", file);
    const source = readFileSync(path, "utf8");
    assert.equal(source.split(before).length, 2, `expected exactly one patch match for ${label}`);
    writeFileSync(path, source.replace(before, after));
    const result = check();
    writeFileSync(path, source);
    if (
      result.status === 1 &&
      /Counterexample:/.test(result.stderr) &&
      /lane-\d+ skipped a required lane/.test(result.stderr)
    ) {
      process.stdout.write(`Caught: ${label}\n`);
    } else {
      failed.push(label);
      process.stderr.write(`Failed to catch ${label} with a false-skip counterexample.\n${result.stderr}`);
    }
  }
  assert.deepEqual(failed, [], "every injected bug must produce a false skip");
  process.stdout.write(`Caught all ${mutations.length} injected bugs.\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
