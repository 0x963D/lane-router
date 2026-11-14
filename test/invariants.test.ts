import { beforeAll, describe, expect, it } from "vitest";
import { changedFiles } from "../src/core/change.ts";
import type { RoutingModel } from "../src/core/model.ts";
import { planLanes, type Plan } from "../src/core/plan.ts";
import { CONFIG, modelOf } from "./support/model.ts";
import { running } from "./support/plan.ts";

/* Every subset of a fixed list of paths, at least one per kind of placement. Small enough to enumerate. */
const UNIVERSE = [
  CONFIG,
  "pnpm-lock.yaml",
  "fixtures/browser/login.json",
  "docs/api/users.md",
  "docs/guide.md",
  ".vscode/settings.json",
  "packages/ui/src/button.tsx",
  "packages/api/README.md",
  "README.md",
  "tsconfig.json",
  "tools/scripts/run.mjs",
  ".changeset/quiet-frogs.md",
];

const UNMATCHED = ["tsconfig.json", ".changeset/quiet-frogs.md"];

let model: RoutingModel;
const plans = new Map<number, Plan>();

function pathsOf(mask: number): string[] {
  return UNIVERSE.filter((_, index) => (mask & (1 << index)) !== 0);
}

function plan(paths: readonly string[]): Promise<Plan> {
  const files = changedFiles(paths.map((path) => ({ path, previousPath: null })));
  return planLanes(model, { mode: "pr", range: { base: "base", head: "head" }, changes: () => Promise.resolve(files) });
}

beforeAll(async () => {
  model = await modelOf("acme");
  for (let mask = 0; mask < 1 << UNIVERSE.length; mask++) plans.set(mask, await plan(pathsOf(mask)));
});

function everyPlan(): [number, Plan][] {
  return [...plans];
}

describe("routing invariants over every subset", () => {
  it("never stops a lane from running when a path is added", () => {
    const shrinks = everyPlan().flatMap(([mask, before]) =>
      UNIVERSE.flatMap((path, index) => {
        const after = plans.get(mask | (1 << index));
        const lost = after === undefined ? [] : running(before).filter((lane) => !running(after).includes(lane));
        return lost.length === 0 ? [] : [{ paths: pathsOf(mask), added: path, lost }];
      }),
    );
    expect(shrinks).toEqual([]);
  });

  it("runs every lane when an unmatched path or the config is in the change", () => {
    const lanes = model.lanes.map((lane) => lane.name);
    const short = everyPlan().filter(
      ([mask, result]) =>
        pathsOf(mask).some((path) => path === CONFIG || UNMATCHED.includes(path)) &&
        running(result).length !== lanes.length,
    );
    expect(short.map(([mask]) => pathsOf(mask))).toEqual([]);
  });

  it("decides every configured lane exactly once, in config order", () => {
    const lanes = model.lanes.map((lane) => lane.name);
    expect(
      everyPlan().filter(([, result]) => result.lanes.map(({ lane }) => lane.name).join() !== lanes.join()),
    ).toEqual([]);
  });

  it("gives the same plan for the same change in any order", async () => {
    for (const [mask, result] of everyPlan().filter(([mask]) => mask % 97 === 0)) {
      expect(await plan([...pathsOf(mask)].reverse())).toEqual(result);
    }
  });
});
