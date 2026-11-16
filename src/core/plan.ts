import { err, messageOf, type Result } from "../result.ts";
import { incomplete, type ChangeSource, type Range } from "./change.ts";
import { MANIFEST, type Lane, type RoutingModel } from "./model.ts";
import { decide, route, type LaneDecision, type Routing } from "./route.ts";

export type Mode = "pr" | "push";

/**
 * Loads both configs and workspaces. A missing base config is new only when its path changed.
 */
export type BaseGraph = (
  commit: string,
  options: { readonly allowNewConfig: boolean },
) => Promise<Result<RoutingModel, string>>;

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
  /** Head lanes in config order, then lanes found only in base, in base config order. */
  readonly lanes: readonly PlannedLane[];
  readonly [planned]: true;
}

/** Total: resolves a plan for every input. Anything that throws, a bug included, runs every lane. */
export async function planLanes(model: RoutingModel, request: PlanRequest): Promise<Plan> {
  let judged = model;
  try {
    const { range } = request;
    let files = await request.changes(range);
    if (files.kind === "complete") {
      const configChanged = files.paths.some((path) => model.builtIns.get(path) === "config");
      if (configChanged || files.paths.some((path) => path.endsWith(`/${MANIFEST}`))) {
        const { mergeBase } = files;
        const withBase =
          mergeBase === null
            ? err("the change names no base commit")
            : await request
                .baseGraph(mergeBase, { allowNewConfig: configChanged })
                .catch((error: unknown) => err(messageOf(error)));
        if (withBase.ok) judged = withBase.value;
        else files = incomplete({ kind: "no-base-graph", commit: mergeBase, reason: withBase.error }, files.paths);
      }
    }
    return decideAll(judged, request.mode, route(judged, range, files));
  } catch (error) {
    const files = incomplete({ kind: "error", message: messageOf(error) });
    return decideAll(judged, request.mode, route(judged, request.range, files));
  }
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
