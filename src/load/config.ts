import { globProblem } from "../core/glob.ts";
import { parseLaneName, type LaneName, type PackageName } from "../core/ids.ts";
import { VIAS, type Config, type Workspace } from "../core/model.ts";
import {
  allValid,
  array,
  boolean,
  closest,
  decode,
  entries,
  INVALID,
  isRecord,
  literal,
  nonEmptyArray,
  nonEmptyString,
  object,
  optional,
  refine,
  string,
  withDefault,
  type Decoder,
  type Invalid,
} from "../decode.ts";
import { err, isNonEmpty, mapNonEmpty, ok, type NonEmpty, type Result } from "../result.ts";
import type { Problem } from "./problem.ts";
import { parseYaml } from "./yaml.ts";

export const DISCOVERY_MODES = ["auto", "pnpm", "npm"] as const;

export type Discovery = (typeof DISCOVERY_MODES)[number];

/**
 * A config that parsed as YAML and waits for the workspace. Checking package names needs the
 * workspace, and discovering the workspace needs `workspace.discovery` from this file.
 */
export interface OpenConfig {
  /** Read leniently: an invalid value reads as `auto` here, and validation reports it. */
  readonly discovery: Discovery;
  /** Every problem that does not depend on the workspace, for when discovery itself failed. */
  problems(): readonly Problem[];
  resolve(workspace: Workspace): Result<Config, NonEmpty<Problem>>;
}

export function openConfig(file: string, source: string): Result<OpenConfig, NonEmpty<Problem>> {
  const yaml = parseYaml(file, source);
  if (!yaml.ok) return yaml;
  const { value, locate } = yaml.value;
  const laneNames = laneNamesIn(value);
  return ok({
    discovery: discoveryIn(value),
    problems: () => {
      const decoded = decode(documentDecoder(laneNames, nonEmptyString), value);
      return decoded.ok ? [] : decoded.error.map(locate);
    },
    resolve: (workspace) => {
      const decoded = decode(refine(documentDecoder(laneNames, packageIn(workspace)), toConfig), value);
      return decoded.ok ? decoded : err(mapNonEmpty(decoded.error, locate));
    },
  });
}

const REJECT = { unknownKeys: "reject" } as const;

function packageIn(workspace: Workspace): Decoder<PackageName> {
  const names = [...workspace.packages.keys()];
  return refine(nonEmptyString, (name, context) => {
    const found = workspace.packages.get(name);
    if (found !== undefined) return found.name;
    const suggestion = closest(name, names);
    return context.fail(`unknown package ${name}${suggestion === undefined ? "" : `, did you mean ${suggestion}?`}`);
  });
}

const glob: Decoder<string> = refine(string, (value, context) => {
  const problem = globProblem(value);
  return problem === undefined ? value : context.fail(problem);
});

const laneKey: Decoder<LaneName> = refine(string, (name, context) => {
  const parsed = parseLaneName(name);
  if (parsed.ok) return parsed.value;
  return context.fail(
    parsed.error === "reserved"
      ? `${name} is the name of a fixed output, so it cannot name a lane`
      : "a lane name starts with a letter or digit and holds only letters, digits, _ and -",
  );
});

const docsOnly = object((field) => {
  const fields = { match: field("match", array(glob)), except: field("except", withDefault(array(glob), [])) };
  return allValid(fields) ? fields : INVALID;
}, REJECT);

/** `packageRef` decides whether package names are looked up, so one decoder serves both passes. */
function documentDecoder<P>(laneNames: ReadonlyMap<string, LaneName>, packageRef: Decoder<P>) {
  const laneRef: Decoder<LaneName> = refine(string, (name, context) => {
    const known = laneNames.get(name);
    if (known !== undefined) return known;
    const suggestion = closest(name, [...laneNames.keys()]);
    return context.fail(`unknown lane ${name}${suggestion === undefined ? "" : `, did you mean ${suggestion}?`}`);
  });

  const lane = refine(
    object((field) => {
      const fields = {
        packages: field("packages", withDefault(array(packageRef), [])),
        floor: field("floor", withDefault(boolean, false)),
        check: field("check", optional(nonEmptyString)),
      };
      return allValid(fields) ? fields : INVALID;
    }, REJECT),
    (spec, context) =>
      spec.floor || spec.packages.length > 0 ? spec : context.fail("a lane lists packages unless it is a floor lane"),
  );

  const edge = object((field) => {
    const fields = { from: field("from", packageRef), to: field("to", packageRef) };
    return allValid(fields) ? fields : INVALID;
  }, REJECT);

  const workspaceSection = object((field) => {
    const fields = {
      discovery: field("discovery", withDefault(literal(...DISCOVERY_MODES), "auto")),
      edges: field("edges", withDefault(array(edge), [])),
    };
    return allValid(fields) ? fields : INVALID;
  }, REJECT);

  const rowLanes: Decoder<"all" | readonly LaneName[]> = (input, context) =>
    input === "all"
      ? "all"
      : Array.isArray(input)
        ? array(laneRef)(input, context)
        : context.fail("expected all or a list of lane names");

  const row = refine(
    object((field) => {
      const fields = {
        match: field("match", nonEmptyArray(glob)),
        lanes: field("lanes", optional(rowLanes)),
        packages: field("packages", optional(nonEmptyArray(packageRef))),
        via: field("via", optional(literal(...VIAS))),
        why: field("why", nonEmptyString),
      };
      return allValid(fields) ? fields : INVALID;
    }, REJECT),
    ({ match, lanes, packages, via, why }, context) => {
      if (lanes !== undefined && packages !== undefined) return context.fail("a row has lanes or packages, not both");
      if (lanes !== undefined) {
        if (via !== undefined) return context.at("via").fail("via goes with packages, not with lanes");
        return { match, why, target: { kind: "lanes", lanes } as const };
      }
      if (packages === undefined) return context.fail("a row needs lanes or packages");
      if (via === undefined) return context.fail(`a packages row needs via: ${VIAS.join(", ")}`);
      return { match, why, target: { kind: "packages", packages, via } as const };
    },
  );

  return object((field) => {
    const fields = {
      lanes: field(
        "lanes",
        refine(entries(laneKey, lane), (lanes, context) =>
          isNonEmpty(lanes) ? lanes : context.fail("list at least one lane"),
        ),
      ),
      workspace: field("workspace", withDefault(workspaceSection, { discovery: "auto", edges: [] })),
      paths: field("paths", withDefault(array(row), [])),
      docsOnly: field("docs-only", withDefault(docsOnly, { match: [], except: [] })),
      unmatched: field("unmatched", literal("all")),
    };
    return allValid(fields) ? fields : INVALID;
  }, REJECT);
}

type Document = Exclude<ReturnType<ReturnType<typeof documentDecoder<PackageName>>>, Invalid>;

function toConfig(document: Document): Config {
  return {
    lanes: document.lanes.map(([name, spec]) => ({
      name,
      packages: spec.packages,
      floor: spec.floor,
      check: spec.check ?? name,
    })),
    edges: document.workspace.edges,
    rows: document.paths,
    docsOnly: document.docsOnly,
  };
}

/** Row lane references are checked against the lane keys, so those keys are read before decoding. */
function laneNamesIn(raw: unknown): ReadonlyMap<string, LaneName> {
  const lanes = isRecord(raw) ? raw.lanes : undefined;
  if (!isRecord(lanes)) return new Map();
  return new Map(
    Object.keys(lanes).flatMap((key) => {
      const parsed = parseLaneName(key);
      return parsed.ok ? [[key, parsed.value] as const] : [];
    }),
  );
}

function discoveryIn(raw: unknown): Discovery {
  const section = isRecord(raw) ? raw.workspace : undefined;
  const discovery = isRecord(section) ? section.discovery : undefined;
  return DISCOVERY_MODES.find((mode) => mode === discovery) ?? "auto";
}
