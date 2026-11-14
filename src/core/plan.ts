import { err, messageOf, type Result } from "../result.ts";
import { incomplete, type ChangeSource, type Range } from "./change.ts";
import type { RepoPath } from "./ids.ts";
import { MANIFEST, type Lane, type RoutingModel } from "./model.ts";
import { decide, route, type LaneDecision, type Routing } from "./route.ts";

export type Mode = "pr" | "push";

/**
 * The port for the base graph: the model again, with the workspace at `commit` as a second graph.
 * Resolves an error that says why when that workspace cannot be read or does not load.
 */
export type BaseGraph = (commit: string) => Promise<Result<RoutingModel, string>>;

export interface PlanRequest {
  readonly mode: Mode;
  readonly range: Range;
  readonly changes: ChangeSource;
  readonly baseGraph: BaseGraph;
}

export interface PlannedLane {
  readonly lane: Lane;
  readonly decision: LaneDecision;
}

const planned: unique symbol = Symbol("planned");

/**
 * Everything the Action outputs and the CLI prints is rendered from this value. `planned` is a symbol
 * only this module can name, so a plan with a lane missing, which would read as "skip", cannot be assembled elsewhere.
 */
export interface Plan {
  readonly mode: Mode;
  readonly event: Routing;
  /** One entry per lane of the model, in config order. */
  readonly lanes: readonly PlannedLane[];
  readonly [planned]: true;
}

/** Total: resolves a plan for every input. Anything that throws, a bug included, runs every lane. */
export async function planLanes(model: RoutingModel, request: PlanRequest): Promise<Plan> {
  try {
    return decideAll(model, request.mode, await routeChange(model, request));
  } catch (error) {
    const files = incomplete({ kind: "error", message: messageOf(error) });
    return decideAll(model, request.mode, route(model, request.range, files));
  }
}

async function routeChange(model: RoutingModel, request: PlanRequest): Promise<Routing> {
  const { range } = request;
  const files = await request.changes(range);
  // The graph is a function of the config, the workspace file, the root manifest and the package
  // manifests. A change to any of the first three already reaches every lane as a built-in, so the
  // base graph can differ only when a package manifest changed. Reading it only then keeps a
  // shallow checkout, which lacks the base commit, routing every other change precisely.
  if (files.kind === "incomplete" || !files.paths.some(isPackageManifest)) return route(model, range, files);
  const { mergeBase } = files;
  const withBase =
    mergeBase === null
      ? err("the change names no base commit")
      : await request.baseGraph(mergeBase).catch((error: unknown) => err(messageOf(error)));
  if (withBase.ok) return route(withBase.value, range, files);
  return route(
    model,
    range,
    incomplete({ kind: "no-base-graph", commit: mergeBase, reason: withBase.error }, files.paths),
  );
}

function isPackageManifest(path: RepoPath): boolean {
  return path.endsWith(`/${MANIFEST}`);
}

function decideAll(model: RoutingModel, mode: Mode, event: Routing): Plan {
  return { mode, event, lanes: model.lanes.map((lane) => ({ lane, decision: decide(event, lane) })), [planned]: true };
}

export function isComplete(plan: Plan): boolean {
  return plan.event.kind !== "incomplete";
}

export function baseOf(plan: Plan): string | null {
  return plan.event.range.base;
}
