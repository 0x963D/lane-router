import type { NonEmpty } from "../result.ts";
import { compileGlobs, type GlobSet, type PathMatcher } from "./glob.ts";
import type { LaneName, PackageName, RepoPath } from "./ids.ts";

export const VIAS = ["code", "tests", "name"] as const;

export type Via = (typeof VIAS)[number];

/**
 * `closure` reaches every lane whose packages read the named package, `roots` only the lanes that
 * list it. `readsAsText` placements still count in a docs-only change, because Markdown is read as
 * text and never compiled.
 */
export const VIA: { readonly [V in Via]: { readonly reaches: "closure" | "roots"; readonly readsAsText: boolean } } = {
  code: { reaches: "closure", readsAsText: false },
  tests: { reaches: "roots", readsAsText: false },
  name: { reaches: "closure", readsAsText: true },
};

export interface LaneSpec {
  readonly name: LaneName;
  readonly packages: readonly PackageName[];
  readonly floor: boolean;
  readonly check: string;
}

export type RowTarget =
  | { readonly kind: "lanes"; readonly lanes: "all" | readonly LaneName[] }
  | { readonly kind: "packages"; readonly packages: readonly PackageName[]; readonly via: Via };

export interface RowSpec {
  readonly match: NonEmpty<string>;
  readonly target: RowTarget;
  readonly why: string;
}

/** A dependency the manifests do not declare: `from` reads `to`. */
export interface DependencyEdge {
  readonly from: PackageName;
  readonly to: PackageName;
}

/** `.github/lanes.yml` after validation. Every name in it resolves. */
export interface Config {
  readonly lanes: readonly LaneSpec[];
  readonly edges: readonly DependencyEdge[];
  readonly rows: readonly RowSpec[];
  readonly docsOnly: GlobSet;
}

export interface WorkspacePackage {
  readonly name: PackageName;
  readonly dir: RepoPath;
  readonly dependencies: readonly PackageName[];
}

/** Keyed by plain string so that a config reference can be looked up before it is branded. */
export interface Workspace {
  readonly packages: ReadonlyMap<string, WorkspacePackage>;
}

export interface Lane {
  readonly name: LaneName;
  readonly floor: boolean;
  readonly check: string;
}

/**
 * How a placement reaches a lane. `reads` holds the shortest chain from one of the lane's root
 * packages to the placed package, through declared dependencies and configured edges.
 */
export type Through = { readonly kind: "named" } | { readonly kind: "reads"; readonly chain: NonEmpty<PackageName> };

/** The lanes a placement selects, in config order. A lane is selected exactly when it is a key. */
export type Reach = ReadonlyMap<LaneName, Through>;

/** A `paths` row as evidence: plain data, so plans compare and serialise without a matcher inside. */
export interface Row {
  readonly index: number;
  readonly why: string;
  readonly target: RowTarget;
}

export interface CompiledRow {
  readonly row: Row;
  readonly hits: PathMatcher;
  readonly reach: Reach;
}

export interface PackageScope {
  readonly name: PackageName;
  readonly dir: RepoPath;
  readonly reach: Reach;
}

/** The resolved routing table. The dependency graph is spent in `compile`, so routing is lookups. */
export interface RoutingModel {
  readonly configPath: RepoPath;
  readonly lanes: readonly Lane[];
  readonly rows: readonly CompiledRow[];
  readonly isDocs: PathMatcher;
  readonly packagesByDir: ReadonlyMap<string, PackageScope>;
  readonly everyLane: Reach;
}

const NAMED: Through = { kind: "named" };

const NO_LANES: Reach = new Map();

/** Pure and total: the loader already rejected unknown names and bad globs. */
export function compile(input: {
  readonly configPath: RepoPath;
  readonly config: Config;
  readonly workspace: Workspace;
}): RoutingModel {
  const { config, workspace } = input;
  const lanes: readonly Lane[] = config.lanes.map(({ name, floor, check }) => ({ name, floor, check }));
  const graph = dependencyGraph(workspace, config.edges);
  const reaches = {
    closure: new Map<PackageName, Map<LaneName, Through>>(),
    roots: new Map<PackageName, Map<LaneName, Through>>(),
  };
  for (const lane of config.lanes) {
    for (const [name, chain] of shortestChains(graph, lane.packages)) {
      addReach(reaches.closure, name, lane.name, { kind: "reads", chain });
    }
    for (const name of lane.packages) addReach(reaches.roots, name, lane.name, { kind: "reads", chain: [name] });
  }
  const everyLane: Reach = new Map(lanes.map((lane) => [lane.name, NAMED] as const));

  const rowReach = (target: RowTarget): Reach => {
    switch (target.kind) {
      case "lanes": {
        const named = target.lanes;
        if (named === "all") return everyLane;
        return new Map(lanes.filter((lane) => named.includes(lane.name)).map((lane) => [lane.name, NAMED] as const));
      }
      case "packages": {
        const index = reaches[VIA[target.via].reaches];
        const reach = new Map<LaneName, Through>();
        for (const lane of lanes) {
          const through = target.packages.map((name) => index.get(name)?.get(lane.name)).find((found) => !!found);
          if (through) reach.set(lane.name, through);
        }
        return reach;
      }
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  };

  return {
    configPath: input.configPath,
    lanes,
    rows: config.rows.map(({ match, target, why }, index) => ({
      row: { index, why, target },
      hits: compileGlobs({ match, except: [] }),
      reach: rowReach(target),
    })),
    isDocs: compileGlobs(config.docsOnly),
    packagesByDir: new Map(
      [...workspace.packages.values()].map(
        ({ name, dir }) => [dir, { name, dir, reach: reaches.closure.get(name) ?? NO_LANES }] as const,
      ),
    ),
    everyLane,
  };
}

function dependencyGraph(
  workspace: Workspace,
  edges: readonly DependencyEdge[],
): ReadonlyMap<PackageName, readonly PackageName[]> {
  const graph = new Map<PackageName, PackageName[]>();
  for (const { name, dependencies } of workspace.packages.values()) graph.set(name, [...dependencies]);
  for (const { from, to } of edges) graph.get(from)?.push(to);
  return graph;
}

/** Breadth first, so the first chain recorded for a package is a shortest one. */
function shortestChains(
  graph: ReadonlyMap<PackageName, readonly PackageName[]>,
  roots: readonly PackageName[],
): ReadonlyMap<PackageName, NonEmpty<PackageName>> {
  const chains = new Map<PackageName, NonEmpty<PackageName>>();
  const queue: { readonly name: PackageName; readonly chain: NonEmpty<PackageName> }[] = [];
  const visit = (name: PackageName, chain: NonEmpty<PackageName>): void => {
    if (chains.has(name)) return;
    chains.set(name, chain);
    queue.push({ name, chain });
  };
  for (const root of roots) visit(root, [root]);
  for (const { name, chain } of queue) {
    for (const next of graph.get(name) ?? []) visit(next, [...chain, next]);
  }
  return chains;
}

function addReach(
  index: Map<PackageName, Map<LaneName, Through>>,
  name: PackageName,
  lane: LaneName,
  through: Through,
): void {
  const reach = index.get(name) ?? new Map<LaneName, Through>();
  index.set(name, reach);
  reach.set(lane, through);
}
