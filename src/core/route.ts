import { isNonEmpty, type NonEmpty } from "../result.ts";
import type { ChangedFiles, IncompleteCause, Range } from "./change.ts";
import type { PackageName, RepoPath } from "./ids.ts";
import {
  joinReach,
  type BuiltIn,
  type Lane,
  type PackageDirs,
  type PackageScope,
  type Reach,
  type Row,
  type RoutingModel,
  type Through,
} from "./model.ts";

/*
 * The routing rules. `route` places every changed path, and `decide` derives one lane's verdict from
 * those placements. Placements are stored once, so the decision and its explanation cannot disagree.
 */

/** Why a changed path belongs somewhere. Each variant carries the lanes it reaches, fixed when `compile` ran. */
export type Placement =
  /** A file every lane reads, such as the routing config or a lockfile. */
  | { readonly kind: "built-in"; readonly input: BuiltIn; readonly reach: Reach }
  /** A `paths` row whose `match` hits the path. Rows add up, inside a package or not. */
  | { readonly kind: "row"; readonly row: Row; readonly reach: Reach }
  /**
   * The deepest package directory that holds the path, in head when one does, else in base. It
   * reaches the lanes that read the head package or the base package.
   */
  | { readonly kind: "package"; readonly package: PackageName; readonly reach: Reach }
  /** Matches `docs-only`. Known, and reaches no lane by itself. */
  | { readonly kind: "docs"; readonly reach: Reach }
  /** Nothing else placed the path. Reaches every lane. */
  | { readonly kind: "unmatched"; readonly reach: Reach };

/** A path with no placement cannot be built, so a path nothing claims has to carry `unmatched`. */
export interface PlacedPath {
  readonly path: RepoPath;
  readonly placements: NonEmpty<Placement>;
}

const routed: unique symbol = Symbol("routed");

export type Routing = { readonly [routed]: true } & (
  | {
      readonly kind: "incomplete";
      readonly range: Range;
      readonly cause: IncompleteCause;
      readonly paths: readonly PlacedPath[];
    }
  | { readonly kind: "empty"; readonly range: Range }
  | { readonly kind: "docs-only"; readonly range: Range; readonly paths: NonEmpty<PlacedPath> }
  | { readonly kind: "ordinary"; readonly range: Range; readonly paths: NonEmpty<PlacedPath> }
);

export type RunReason =
  | {
      readonly kind: "placement";
      readonly path: RepoPath;
      readonly placement: Placement;
      readonly through: Through;
    }
  /** A floor lane in a change that has paths and is not docs-only. */
  | { readonly kind: "floor" }
  | { readonly kind: "incomplete"; readonly cause: IncompleteCause };

export type SkipReason = "no-changes" | "docs-only" | "untouched";

export interface Run {
  readonly kind: "run";
  readonly because: NonEmpty<RunReason>;
}

const proven: unique symbol = Symbol("proven");

/** Only this module can name `proven` to construct a skip literal. */
export interface Skip {
  readonly kind: "skip";
  readonly because: SkipReason;
  readonly [proven]: true;
}

export type LaneDecision = Run | Skip;

const NO_LANES: Reach = new Map();

export function route(model: RoutingModel, range: Range, files: ChangedFiles): Routing {
  const paths = files.paths.map((path) => ({ path, placements: place(model, path) }));
  if (files.kind === "incomplete") return { kind: "incomplete", range, cause: files.cause, paths, [routed]: true };
  if (!isNonEmpty(paths)) return { kind: "empty", range, [routed]: true };
  return {
    kind: paths.every(({ path }) => model.isDocs(path)) ? "docs-only" : "ordinary",
    range,
    paths,
    [routed]: true,
  };
}

function place(model: RoutingModel, path: RepoPath): NonEmpty<Placement> {
  const placements: Placement[] = [];
  const builtIn = model.builtIns.get(path);
  if (builtIn !== undefined) placements.push({ kind: "built-in", input: builtIn, reach: model.everyLane });
  for (const { row, hits, reach } of model.rows) {
    if (hits(path)) placements.push({ kind: "row", row, reach });
  }
  const owners = model.packageDirs.flatMap((dirs) => owningPackage(dirs, path) ?? []);
  const [owner] = owners;
  if (owner !== undefined) {
    const reach = joinReach(
      model.lanes,
      owners.map((scope) => scope.reach),
    );
    placements.push({ kind: "package", package: owner.name, reach });
  }
  if (model.isDocs(path)) placements.push({ kind: "docs", reach: NO_LANES });
  return isNonEmpty(placements) ? placements : [{ kind: "unmatched", reach: model.everyLane }];
}

function owningPackage(dirs: PackageDirs, path: RepoPath): PackageScope | undefined {
  const segments = path.split("/");
  for (let depth = segments.length - 1; depth > 0; depth--) {
    const scope = dirs.get(segments.slice(0, depth).join("/"));
    if (scope !== undefined) return scope;
  }
  return undefined;
}

/** A skip is the residue: it comes only from a complete change in which nothing reached the lane. */
export function decide(routing: Routing, lane: Lane): LaneDecision {
  switch (routing.kind) {
    case "incomplete":
      return { kind: "run", because: [{ kind: "incomplete", cause: routing.cause }] };
    case "empty":
      return skip("no-changes");
    case "docs-only":
    case "ordinary": {
      const because = routing.paths.flatMap(({ path, placements }) =>
        placements.flatMap((placement): RunReason[] => {
          const through = placement.reach.get(lane.name);
          return through !== undefined && isCounted(routing, placement)
            ? [{ kind: "placement", path, placement, through }]
            : [];
        }),
      );
      if (routing.kind === "ordinary" && lane.floor) because.push({ kind: "floor" });
      if (isNonEmpty(because)) return { kind: "run", because };
      return skip(routing.kind === "docs-only" ? "docs-only" : "untouched");
    }
    default: {
      const _exhaustive: never = routing;
      return _exhaustive;
    }
  }
}

function skip(because: SkipReason): Skip {
  return { kind: "skip", because, [proven]: true };
}

/** False for a placement that a docs-only change ignores. */
export function isCounted(routing: Routing, placement: Placement): boolean {
  return routing.kind !== "docs-only" || placement.kind !== "package";
}
