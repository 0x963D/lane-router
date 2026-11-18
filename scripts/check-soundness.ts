import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { changedFiles } from "../src/core/change.ts";
import { planLanes } from "../src/core/plan.ts";
import { formatProblems, loadModel, type RepoTree } from "../src/load/index.ts";

const CONFIG = ".github/lanes.yml";
const RANGE = { base: "base", head: "head" };
const SEED = 619473;
const RUNS = 5_000;

const via = fc.constantFrom("code", "tests", "name");
const scenario = fc.integer({ min: 1, max: 8 }).chain((size) => {
  const index = fc.integer({ min: 0, max: size - 1 });
  const roots = fc.uniqueArray(index, { maxLength: 3 });
  const claim = fc.integer({ min: 0, max: 3 });
  const edge = fc.tuple(index, index);
  return fc.record({
    nested: fc.array(fc.boolean(), { minLength: size, maxLength: size }),
    dependencies: fc.array(edge, { maxLength: size * 2 }),
    devDependencies: fc.array(edge, { maxLength: size * 2 }),
    extra: fc.array(edge, { maxLength: size }),
    lanes: fc.array(fc.record({ roots, floor: fc.boolean() }), { minLength: 1, maxLength: 6 }),
    packageRules: fc.array(fc.record({ claim, packages: roots, via }), { maxLength: 6 }),
    laneRules: fc.array(fc.record({ claim, all: fc.boolean() }), { maxLength: 4 }),
    change: fc.array(
      fc.oneof(
        fc.record({ kind: fc.constant("package"), owner: index, note: fc.boolean() }),
        fc.record({ kind: fc.constant("claim"), claim }),
        fc.record({ kind: fc.constant("docs") }),
        fc.record({ kind: fc.constant("unmatched") }),
        fc.record({ kind: fc.constant("lockfile") }),
      ),
      { maxLength: 6 },
    ),
  });
});

type Scenario = ReturnType<typeof scenario.generate>["value"];

function name(index: number): string {
  return `package-${index}`;
}

function laneName(index: number): string {
  return `lane-${index}`;
}

function claimPath(index: number): string {
  return `shared/${index}/fixture.txt`;
}

function tree(files: ReadonlyMap<string, string>): RepoTree {
  return {
    files: () => Promise.resolve([...files.keys()]),
    read: (path) => {
      const text = files.get(path);
      return Promise.resolve(text === undefined ? { kind: "missing" } : { kind: "file", text });
    },
  };
}

function materialize(input: Scenario) {
  const dirs = input.nested.map((nested, index) =>
    index > 0 && nested ? `packages/${name(0)}/children/${name(index)}` : `packages/${name(index)}`,
  );
  const dependencies = (edges: readonly (readonly [number, number])[], from: number) =>
    Object.fromEntries(edges.filter(([source]) => source === from).map(([, target]) => [name(target), "*"]));
  const files = new Map<string, string>();
  files.set("package.json", JSON.stringify({ workspaces: dirs }));
  dirs.forEach((dir, index) =>
    files.set(
      `${dir}/package.json`,
      JSON.stringify({
        name: name(index),
        dependencies: dependencies(input.dependencies, index),
        devDependencies: dependencies(input.devDependencies, index),
      }),
    ),
  );
  const lanes = input.lanes.map(({ roots, floor }, index) => ({
    name: laneName(index),
    roots,
    floor: floor || roots.length === 0,
  }));
  const config = {
    lanes: Object.fromEntries(
      lanes.map(({ name, roots, floor }) => [name, { packages: roots.map((root) => `package-${root}`), floor }]),
    ),
    workspace: { edges: input.extra.map(([from, to]) => ({ from: name(from), to: name(to) })) },
    paths: [
      ...input.packageRules
        .filter(({ packages }) => packages.length > 0)
        .map(({ claim, packages, via }) => ({
          match: [`shared/${claim}/**`],
          packages: packages.map(name),
          via,
          why: "A package reads the shared file.",
        })),
      ...input.laneRules.map(({ claim, all }) => ({
        match: [claimPath(claim)],
        lanes: all ? "all" : [laneName(claim % lanes.length)],
        why: "The lane reads the shared file.",
      })),
    ],
    "docs-only": { match: ["docs/**", "shared/0/**"] },
    unmatched: "all",
  };
  files.set(CONFIG, JSON.stringify(config));
  return { tree: tree(files), dirs, lanes };
}

function oracle(input: Scenario, roots: readonly number[], lane: number): boolean {
  const reachable = new Set(roots);
  const edges = [...input.dependencies, ...input.devDependencies, ...input.extra];
  for (let pass = 0; pass < input.nested.length; pass++) {
    for (const [from, to] of edges) if (reachable.has(from)) reachable.add(to);
  }
  return input.change.some((file) => {
    if (file.kind === "package") return reachable.has(file.owner);
    if (file.kind !== "claim") return false;
    return (
      input.packageRules.some(
        (rule) =>
          rule.claim === file.claim &&
          rule.packages.some((pkg) => (rule.via === "tests" ? roots.includes(pkg) : reachable.has(pkg))),
      ) ||
      input.laneRules.some(
        (rule) => rule.claim === file.claim && (rule.all || lane === rule.claim % input.lanes.length),
      )
    );
  });
}

function changePath(file: Scenario["change"][number], dirs: readonly string[]): string {
  switch (file.kind) {
    case "package":
      return `${dirs[file.owner] ?? ""}/src/${file.note ? "input.md" : "index.ts"}`;
    case "claim":
      return claimPath(file.claim);
    case "docs":
      return "docs/notes.md";
    case "unmatched":
      return "tool.config.js";
    case "lockfile":
      return "package-lock.json";
  }
}

export async function checkSoundness(numRuns = RUNS) {
  const counts = {
    cases: 0,
    affected: 0,
    unaffected: 0,
    falseSkips: 0,
    excessRuns: 0,
    reasons: new Map<string, number>(),
  };
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const { tree, dirs, lanes } = materialize(input);
      const model = await loadModel(tree, CONFIG);
      assert.ok(model.ok, model.ok ? undefined : formatProblems(model.error));
      const files = changedFiles(
        input.change.map((file) => ({ path: changePath(file, dirs), previousPath: null })),
        { mergeBase: RANGE.base },
      );
      const plan = await planLanes(model.value, {
        mode: "pr",
        range: RANGE,
        changes: () => Promise.resolve(files),
        baseGraph: () => Promise.resolve(model),
      });
      assert.deepEqual(
        plan.lanes.map(({ lane }) => lane.name),
        lanes.map(({ name }) => name),
      );
      counts.cases++;
      for (const [index, { lane, decision }] of plan.lanes.entries()) {
        if (oracle(input, lanes[index]?.roots ?? [], index)) {
          counts.affected++;
          if (decision.kind === "skip") counts.falseSkips++;
          assert.equal(decision.kind, "run", `${lane.name} skipped an affected lane`);
        } else {
          counts.unaffected++;
          if (decision.kind === "skip") continue;
          counts.excessRuns++;
          const reasons = new Set(
            decision.because.map((reason) => (reason.kind === "placement" ? reason.placement.kind : reason.kind)),
          );
          for (const reason of reasons) counts.reasons.set(reason, (counts.reasons.get(reason) ?? 0) + 1);
        }
      }
    }),
    { seed: SEED, numRuns },
  );
  return { seed: SEED, ...counts, reasons: Object.fromEntries([...counts.reasons].sort()) };
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const runs = process.argv[2] === undefined ? RUNS : Number(process.argv[2]);
  assert.ok(Number.isSafeInteger(runs) && runs > 0, "pass a positive number of cases");
  const start = performance.now();
  const result = await checkSoundness(runs);
  process.stdout.write(JSON.stringify({ ...result, elapsedMs: Math.round(performance.now() - start) }, null, 2) + "\n");
}
