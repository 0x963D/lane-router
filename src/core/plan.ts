import { messageOf } from "../result.ts";
import { incomplete, type ChangeSource, type Range } from "./change.ts";
import type { LaneName } from "./ids.ts";
import type { Lane, RoutingModel } from "./model.ts";
import { decide, route, type LaneDecision, type Routing } from "./route.ts";

export type Mode = "pr" | "push";

/**
 * The port for `last-green: auto`. `proofs` resolves, for each lane that has one, the newest
 * first-parent ancestor of head, head excluded, where the lane's check passed. A lane missing from
 * the map has no proof within `depth` commits.
 */
export interface LastGreen {
  readonly depth: number;
  readonly proofs: (lanes: readonly Lane[]) => Promise<ReadonlyMap<LaneName, string>>;
}

export type PlanRequest =
  | { readonly mode: "pr"; readonly range: Range; readonly changes: ChangeSource }
  | {
      readonly mode: "push";
      readonly range: Range;
      readonly changes: ChangeSource;
      readonly lastGreen: LastGreen | null;
    };

export interface PlannedLane {
  readonly lane: Lane;
  readonly decision: LaneDecision;
  /**
   * The change since this lane's proof commit, when last-green found one. Its base is the proof.
   * Lanes that share a proof hold the same routing, because one diff was fetched for all of them.
   */
  readonly since: Routing | null;
}

const planned: unique symbol = Symbol("planned");

/**
 * Everything the Action outputs and the CLI prints is rendered from this value. `planned` is a symbol
 * only this module can name, so a plan with a lane missing, which would read as "skip", cannot be assembled elsewhere.
 */
export interface Plan {
  readonly mode: Mode;
  /** The event's own change. The header, the file count and `docs-only` describe it in every mode. */
  readonly event: Routing;
  /** One entry per lane of the model, in config order. */
  readonly lanes: readonly PlannedLane[];
  readonly [planned]: true;
}

/** Total: resolves a plan for every input. Anything that throws, a bug included, runs every lane. */
export async function planLanes(model: RoutingModel, request: PlanRequest): Promise<Plan> {
  try {
    return await plan(model, request);
  } catch (error) {
    const event = route(model, request.range, incomplete({ kind: "error", message: messageOf(error) }));
    return sealed(request.mode, event, decideOver(model, event));
  }
}

async function plan(model: RoutingModel, request: PlanRequest): Promise<Plan> {
  const event = route(model, request.range, await request.changes(request.range));
  if (request.mode === "pr" || request.lastGreen === null) return sealed(request.mode, event, decideOver(model, event));

  const { depth, proofs: findProofs } = request.lastGreen;
  const proofs = await findProofs(model.lanes);
  const routeSince = async (proof: string): Promise<readonly [string, Routing]> => {
    if (proof === request.range.base) return [proof, event];
    const range = { base: proof, head: request.range.head };
    return [proof, route(model, range, await request.changes(range))];
  };
  const sinceProof = new Map(await Promise.all([...new Set(proofs.values())].map(routeSince)));

  const lanes = model.lanes.map((lane): PlannedLane => {
    const proof = proofs.get(lane.name);
    const since = proof === undefined ? undefined : sinceProof.get(proof);
    if (since === undefined)
      return { lane, since: null, decision: { kind: "run", because: [{ kind: "no-proof", depth }] } };
    return { lane, since, decision: decide(since, lane) };
  });
  return sealed(request.mode, event, lanes);
}

function decideOver(model: RoutingModel, event: Routing): readonly PlannedLane[] {
  return model.lanes.map((lane) => ({ lane, since: null, decision: decide(event, lane) }));
}

function sealed(mode: Mode, event: Routing, lanes: readonly PlannedLane[]): Plan {
  return { mode, event, lanes, [planned]: true };
}

/** True when every file list the plan read was complete. */
export function isComplete(plan: Plan): boolean {
  return [plan.event, ...plan.lanes.map(({ since }) => since)].every((routing) => routing?.kind !== "incomplete");
}

/** The revision a lane's job diffs against: its proof commit, else the event base. Null when there is none. */
export function baseOf(plan: Plan, lane: PlannedLane): string | null {
  return lane.since?.range.base ?? plan.event.range.base;
}
