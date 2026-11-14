import { isNonEmpty, type NonEmpty } from "../result.ts";
import type { ChangedFiles, IncompleteCause, Range } from "./change.ts";
import type { PackageName, RepoPath } from "./ids.ts";
import { VIA, type Lane, type PackageScope, type Reach, type Row, type RoutingModel, type Through } from "./model.ts";

/*
 * The routing rules. `route` places every changed path, and `decide` derives one lane's verdict from
 * those placements. Placements are stored once, so the decision and its explanation cannot disagree.
 */

/** Why a changed path belongs somewhere. Every variant carries the lanes it reaches, fixed at compile time. */
export type Placement =
  /** The routing config itself. No row can turn it off, or a change could rewrite its own routing. */
  | { readonly kind: "config"; readonly reach: Reach }
  /** A `paths` row whose `match` hits the path. Rows add up, inside a package or not. */
  | { readonly kind: "row"; readonly row: Row; readonly reach: Reach }
  /** The deepest package directory that holds the path. */
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

export type Routing =
  | {
      readonly kind: "incomplete";
      readonly range: Range;
      readonly cause: IncompleteCause;
      readonly paths: readonly PlacedPath[];
    }
  | { readonly kind: "empty"; readonly range: Range }
  | { readonly kind: "docs-only"; readonly range: Range; readonly paths: NonEmpty<PlacedPath> }
  | { readonly kind: "ordinary"; readonly range: Range; readonly paths: NonEmpty<PlacedPath> };

export type RunReason =
  | {
      readonly kind: "placement";
      readonly path: RepoPath;
      readonly placement: Placement;
      readonly through: Through;
    }
  /** A floor lane in a change that has paths and is not docs-only. */
  | { readonly kind: "floor" }
  | { readonly kind: "incomplete"; readonly cause: IncompleteCause }
  /** Last-green found no commit within `depth` where the lane's check passed. */
  | { readonly kind: "no-proof"; readonly depth: number };

/** `untouched` means nothing the lane reads changed. */
export type SkipReason = "no-changes" | "docs-only" | "untouched";

export interface Run {
  readonly kind: "run";
  readonly because: NonEmpty<RunReason>;
}

const proven: unique symbol = Symbol("proven");

/** Only `decide` can name `proven`, so every other module can express "run" and nothing else. */
export interface Skip {
  readonly kind: "skip";
  readonly because: SkipReason;
  readonly [proven]: true;
}

export type LaneDecision = Run | Skip;

const NO_LANES: Reach = new Map();

export function route(model: RoutingModel, range: Range, files: ChangedFiles): Routing {
  const paths = files.paths.map((path) => ({ path, placements: place(model, path) }));
  if (files.kind === "incomplete") return { kind: "incomplete", range, cause: files.cause, paths };
  if (!isNonEmpty(paths)) return { kind: "empty", range };
  return { kind: paths.every(({ path }) => model.isDocs(path)) ? "docs-only" : "ordinary", range, paths };
}

function place(model: RoutingModel, path: RepoPath): NonEmpty<Placement> {
  const placements: Placement[] = [];
  if (path === model.configPath) placements.push({ kind: "config", reach: model.everyLane });
  for (const { row, hits, reach } of model.rows) {
    if (hits(path)) placements.push({ kind: "row", row, reach });
  }
  const owner = owningPackage(model, path);
  if (owner !== undefined) placements.push({ kind: "package", package: owner.name, reach: owner.reach });
  if (model.isDocs(path)) placements.push({ kind: "docs", reach: NO_LANES });
  return isNonEmpty(placements) ? placements : [{ kind: "unmatched", reach: model.everyLane }];
}

/** Walks the ancestor directories from the deepest up, so the deepest package wins without sorting. */
function owningPackage(model: RoutingModel, path: RepoPath): PackageScope | undefined {
  const segments = path.split("/");
  for (let depth = segments.length - 1; depth > 0; depth--) {
    const scope = model.packagesByDir.get(segments.slice(0, depth).join("/"));
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

/** Whether a placement selects its lanes in this routing. The explanation marks the ones that do not. */
export function isCounted(routing: Routing, placement: Placement): boolean {
  return routing.kind !== "docs-only" || readsAsText(placement);
}

/** The docs-only rule. In a docs-only change only placements that read the file as text count. */
function readsAsText(placement: Placement): boolean {
  switch (placement.kind) {
    case "config":
      return true;
    case "row": {
      const { target } = placement.row;
      return target.kind === "lanes" || VIA[target.via].readsAsText;
    }
    case "package":
      return false;
    case "docs":
    case "unmatched":
      return true;
    default: {
      const _exhaustive: never = placement;
      return _exhaustive;
    }
  }
}
