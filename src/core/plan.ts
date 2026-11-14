import { messageOf } from "../result.ts";
import { incomplete, type ChangeSource, type Range } from "./change.ts";
import type { Lane, RoutingModel } from "./model.ts";
import { decide, route, type LaneDecision, type Routing } from "./route.ts";

/*
 * The one entry point both shells call. It owns turning any failure into a plan in which every lane runs.
 */

export type Mode = "pr" | "push";

export interface PlanRequest {
  readonly mode: Mode;
  readonly range: Range;
  readonly changes: ChangeSource;
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
    return decideAll(model, request.mode, route(model, request.range, await request.changes(request.range)));
  } catch (error) {
    const files = incomplete({ kind: "error", message: messageOf(error) });
    return decideAll(model, request.mode, route(model, request.range, files));
  }
}

function decideAll(model: RoutingModel, mode: Mode, event: Routing): Plan {
  return { mode, event, lanes: model.lanes.map((lane) => ({ lane, decision: decide(event, lane) })), [planned]: true };
}
