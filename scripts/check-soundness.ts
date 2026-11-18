import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { changedFiles } from "../src/core/change.ts";
import { planLanes } from "../src/core/plan.ts";
import { formatProblems, loadModel, type RepoTree } from "../src/load/index.ts";
import { expectedRuns, scenario, type File, type Scenario } from "./soundness-scenarios.ts";

const CONFIG = ".github/lanes.yml";
const RANGE = { base: "base", head: "head" };
const SEED = 619473;
const RUNS = 5_000;

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
  const pattern = (claim: number) => (claim < 4 ? claimPath(claim) : `${dirs[claim - 4] ?? ""}/src/**`);
  const config = {
    lanes: Object.fromEntries(
      input.lanes.map(({ roots, floor }, index) => [laneName(index), { packages: roots.map(name), floor }]),
    ),
    workspace: { edges: input.extra.map(([from, to]) => ({ from: name(from), to: name(to) })) },
    paths: [
      ...input.packageRules
        .filter(({ packages }) => packages.length > 0)
        .map(({ claim, packages, via }) => ({
          match: [pattern(claim)],
          packages: packages.map(name),
          via,
          why: "A package reads the shared file.",
        })),
      ...input.laneRules.map(({ claim, all }) => ({
        match: [pattern(claim)],
        lanes: all ? "all" : [laneName(claim % input.lanes.length)],
        why: "The lane reads the shared file.",
      })),
    ],
    "docs-only": { match: ["docs/**", "shared/0/**", "packages/**/input.md", "package-lock.json"] },
    unmatched: "all",
  };

  const files = new Map<string, string>([
    [CONFIG, JSON.stringify(config)],
    ["package.json", JSON.stringify({ workspaces: dirs })],
  ]);
  const manifest = (index: number, packageName: string) =>
    JSON.stringify({
      name: packageName,
      ...Object.fromEntries(
        Object.entries(input.dependencies).map(([field, edges]) => [
          field,
          Object.fromEntries(edges.filter(([source]) => source === index).map(([, target]) => [name(target), "*"])),
        ]),
      ),
    });
  dirs.forEach((dir, index) => files.set(`${dir}/package.json`, manifest(index, name(index))));
  const base = new Map(files);
  if (input.renamedPackage !== undefined) {
    const index = input.renamedPackage;
    files.set((dirs[index] ?? "") + "/package.json", manifest(index, "renamed-package"));
  }
  return { head: tree(files), base: tree(base), dirs };
}

function changePath(file: File, dirs: readonly string[]): string {
  switch (file.kind) {
    case "package":
      return `${dirs[file.owner] ?? ""}/src/${file.note ? "input.md" : "index.ts"}`;
    case "manifest":
      return `${dirs[file.owner] ?? ""}/package.json`;
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
  const counts = { cases: 0, required: 0, other: 0, excessRuns: 0, graphSensitiveCases: 0, graphSensitiveVerdicts: 0 };
  await fc.assert(
    fc.asyncProperty(scenario, async (input) => {
      const expected = expectedRuns(input);
      const { head, base, dirs } = materialize(input);
      const model = await loadModel(head, CONFIG);
      assert.ok(model.ok, model.ok ? undefined : formatProblems(model.error));
      const files = changedFiles(
        input.files.map((file) => ({
          path: changePath(file, dirs),
          previousPath: input.previous === undefined ? null : changePath(input.previous, dirs),
        })),
        { mergeBase: RANGE.base },
      );
      const plan = await planLanes(model.value, {
        mode: "pr",
        range: RANGE,
        changes: () => Promise.resolve(files),
        baseGraph: async () => {
          const result = await loadModel(head, CONFIG, base);
          return result.ok ? result : { ok: false, error: formatProblems(result.error) };
        },
      });
      assert.deepEqual(
        plan.lanes.map(({ lane }) => lane.name),
        input.lanes.map((_, index) => laneName(index)),
      );
      counts.cases++;
      if (expected.some(({ graphSensitive }) => graphSensitive)) counts.graphSensitiveCases++;
      for (const [index, { lane, decision }] of plan.lanes.entries()) {
        const verdict = expected[index];
        assert.ok(verdict !== undefined);
        if (verdict.required) {
          assert.equal(decision.kind, "run", `${lane.name} skipped a required lane`);
          counts.required++;
          if (verdict.graphSensitive) counts.graphSensitiveVerdicts++;
        } else {
          counts.other++;
          if (decision.kind === "run") counts.excessRuns++;
        }
      }
    }),
    { seed: SEED, numRuns, endOnFailure: true },
  );
  const share = (part: number, total: number) => Number(((100 * part) / total).toFixed(2));
  return {
    seed: SEED,
    ...counts,
    graphSensitiveCasePercent: share(counts.graphSensitiveCases, counts.cases),
    graphSensitiveVerdictPercent: share(counts.graphSensitiveVerdicts, counts.required),
  };
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const runs = process.argv[2] === undefined ? RUNS : Number(process.argv[2]);
  assert.ok(Number.isSafeInteger(runs) && runs > 0, "pass a positive number of cases");
  process.stdout.write(JSON.stringify(await checkSoundness(runs), null, 2) + "\n");
}
