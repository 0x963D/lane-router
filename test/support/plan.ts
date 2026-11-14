import { expect } from "vitest";
import { changedFiles, type ChangeEntry, type ChangeSource } from "../../src/core/change.ts";
import { planLanes, type Plan } from "../../src/core/plan.ts";
import type { LaneDecision, Placement } from "../../src/core/route.ts";
import type { Overrides } from "./fixtures.ts";
import { modelOf } from "./model.ts";

export type Change = readonly (string | ChangeEntry)[];

export function entries(change: Change): readonly ChangeEntry[] {
  return change.map((entry) => (typeof entry === "string" ? { path: entry, previousPath: null } : entry));
}

export function planFor(fixture: string, change: Change, overrides?: Overrides): Promise<Plan> {
  return planWith(fixture, () => Promise.resolve(changedFiles(entries(change))), overrides);
}

export async function planWith(fixture: string, changes: ChangeSource, overrides?: Overrides): Promise<Plan> {
  const model = await modelOf(fixture, overrides);
  const plan = await planLanes(model, { mode: "pr", range: { base: "base", head: "head" }, changes });
  expect(plan.lanes.map(({ lane }) => lane.name)).toEqual(model.lanes.map((lane) => lane.name));
  return plan;
}

export function running(plan: Plan): string[] {
  return plan.lanes.filter(({ decision }) => decision.kind === "run").map(({ lane }) => lane.name);
}

export function decisionOf(plan: Plan, lane: string): LaneDecision {
  const found = plan.lanes.find((planned) => planned.lane.name === lane);
  if (found === undefined) throw new Error(`no lane ${lane} in the plan`);
  return found.decision;
}

/**
 * The evidence behind a decision. A run lists each reason's kind, or the placement's kind for a
 * placement. A skip gives its reason.
 */
export function evidenceOf(plan: Plan, lane: string): readonly string[] {
  const decision = decisionOf(plan, lane);
  return decision.kind === "skip"
    ? [decision.because]
    : decision.because.map((reason) => (reason.kind === "placement" ? reason.placement.kind : reason.kind));
}

export function placementsOf(plan: Plan, path: string): readonly Placement[] {
  const routing = plan.event;
  const paths = routing.kind === "empty" ? [] : routing.paths;
  const found = paths.find((placed) => placed.path === path);
  if (found === undefined) throw new Error(`${path} is not in the plan`);
  return found.placements;
}

export function placementKinds(plan: Plan, path: string): readonly string[] {
  return placementsOf(plan, path).map((placement) => placement.kind);
}
