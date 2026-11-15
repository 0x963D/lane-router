import type { NonEmpty } from "../result.ts";
import { compileGlobs, type GlobSet, type PathMatcher } from "./glob.ts";
import type { LaneName, PackageName, RepoPath } from "./ids.ts";

export const VIAS = ["code", "tests", "name"] as const;

export type Via = (typeof VIAS)[number];

/** `closure` reaches every lane that reads the package, `roots` only lanes that list it. */
export const VIA: { readonly [V in Via]: "closure" | "roots" } = {
  code: "closure",
  tests: "roots",
  name: "closure",
};

/** The file name of every package manifest, the root one included. */
export const MANIFEST = "package.json";

export const WORKSPACE_FILE = "pnpm-workspace.yaml";

const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock"] as const;

/**
 * A root file that reaches every lane whatever the rows say: the routing config, the two files that
 * define the workspace, and the lockfiles that pin what every package installs. No row can turn one
 * off, or a change could rewrite the routing that judges it.
 */
export type BuiltIn = "config" | "workspace" | "root-manifest" | "lockfile";

export interface LaneSpec {
  readonly name: LaneName;
  readonly packages: readonly PackageName[];
  readonly floor: boolean;
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
}

/** `base` is the workspace at the commit the change was diffed from, `head` the one it ends in. */
export type Graph = "head" | "base";

/**
 * How a placement reaches a lane. `reads` holds the shortest chain from one of the lane's root
 * packages to the placed package, through declared dependencies and configured edges, in `graph`.
 */
export type Through =
  { readonly kind: "named" } | { readonly kind: "reads"; readonly chain: NonEmpty<PackageName>; readonly graph: Graph };

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

/** One graph's packages by directory. */
export type PackageDirs = ReadonlyMap<string, PackageScope>;

/** The resolved routing table. The dependency graphs are spent in `compile`, so routing is lookups. */
export interface RoutingModel {
  readonly builtIns: ReadonlyMap<string, BuiltIn>;
  readonly lanes: readonly Lane[];
  readonly rows: readonly CompiledRow[];
  readonly isDocs: PathMatcher;
  /** A path finds its package in each graph on its own, because the deepest directory can differ. */
  readonly packageDirs: readonly [head: PackageDirs] | readonly [head: PackageDirs, base: PackageDirs];
  readonly everyLane: Reach;
}

const NAMED: Through = { kind: "named" };

const NO_LANES: Reach = new Map();

/**
 * Pure and total: the loader already rejected unknown names and bad globs, in both workspaces. With
 * `base`, a lane reaches what it reads in either graph. Each graph's closures are computed on their
 * own and joined per lane, because one graph made of both would invent chains that neither holds.
 */
export function compile(input: {
  readonly configPath: RepoPath;
  readonly config: Config;
  readonly workspace: Workspace;
  readonly base?: Workspace;
}): RoutingModel {
  const { config } = input;
  const lanes: readonly Lane[] = config.lanes.map(({ name, floor }) => ({ name, floor }));
  const head = compileGraph(input.workspace, config, "head");
  const base = input.base === undefined ? undefined : compileGraph(input.base, config, "base");
  const graphs = base === undefined ? [head] : [head, base];
  const everyLane: Reach = new Map(lanes.map((lane) => [lane.name, NAMED] as const));

  const rowReach = (target: RowTarget): Reach => {
    switch (target.kind) {
      case "lanes": {
        const named = target.lanes;
        if (named === "all") return everyLane;
        return new Map(lanes.filter((lane) => named.includes(lane.name)).map((lane) => [lane.name, NAMED] as const));
      }
      case "packages": {
        const index = VIA[target.via];
        return joinReach(
          lanes,
          graphs.flatMap((graph) => target.packages.map((name) => graph[index].get(name) ?? NO_LANES)),
        );
      }
      default: {
        const _exhaustive: never = target;
        return _exhaustive;
      }
    }
  };

  return {
    builtIns: new Map<string, BuiltIn>([
      [WORKSPACE_FILE, "workspace"],
      [MANIFEST, "root-manifest"],
      ...LOCKFILES.map((file) => [file, "lockfile"] as const),
      [input.configPath, "config"],
    ]),
    lanes,
    rows: config.rows.map(({ match, target, why }, index) => ({
      row: { index, why, target },
      hits: compileGlobs({ match, except: [] }),
      reach: rowReach(target),
    })),
    isDocs: compileGlobs(config.docsOnly),
    packageDirs: base === undefined ? [head.dirs] : [head.dirs, base.dirs],
    everyLane,
  };
}

/** Per lane, in config order, the first of `reaches` that holds it. Earlier reaches explain first. */
export function joinReach(lanes: readonly Lane[], reaches: readonly Reach[]): Reach {
  const joined = new Map<LaneName, Through>();
  for (const lane of lanes) {
    const through = reaches.map((reach) => reach.get(lane.name)).find((found) => found !== undefined);
    if (through !== undefined) joined.set(lane.name, through);
  }
  return joined;
}

interface CompiledGraph {
  /** Per package, the lanes whose closure holds it. */
  readonly closure: ReadonlyMap<PackageName, Reach>;
  /** Per package, the lanes that list it as a root. */
  readonly roots: ReadonlyMap<PackageName, Reach>;
  readonly dirs: PackageDirs;
}

function compileGraph(workspace: Workspace, config: Config, graph: Graph): CompiledGraph {
  const dependencies = dependencyGraph(workspace, config.edges);
  const closure = new Map<PackageName, Map<LaneName, Through>>();
  const roots = new Map<PackageName, Map<LaneName, Through>>();
  for (const lane of config.lanes) {
    for (const [name, chain] of shortestChains(dependencies, lane.packages)) {
      addReach(closure, name, lane.name, { kind: "reads", chain, graph });
    }
    for (const name of lane.packages) addReach(roots, name, lane.name, { kind: "reads", chain: [name], graph });
  }
  const dirs = new Map(
    [...workspace.packages.values()].map(
      ({ name, dir }) => [dir, { name, dir, reach: closure.get(name) ?? NO_LANES }] as const,
    ),
  );
  return { closure, roots, dirs };
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
