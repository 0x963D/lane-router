import { posix } from "node:path";
import { compileGlobs, globProblem, type GlobSet } from "../core/glob.ts";
import { parsePackageName, parseRepoPath, type PackageName, type RepoPath } from "../core/ids.ts";
import { MANIFEST, WORKSPACE_FILE, type Workspace, type WorkspacePackage } from "../core/model.ts";
import {
  array,
  decode,
  entries,
  formatDataPath,
  INVALID,
  isValid,
  object,
  parseJson,
  refine,
  string,
  withDefault,
  type Decoder,
  type Issue,
} from "../decode.ts";
import { err, isNonEmpty, mapNonEmpty, ok, type NonEmpty, type Result } from "../result.ts";
import type { Discovery } from "./config.ts";
import { fileProblem, type Problem } from "./problem.ts";
import { listFiles, readFile, type RepoTree } from "./tree.ts";
import { parseYaml } from "./yaml.ts";

const IN_PACKAGE = `/${MANIFEST}`;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
const IGNORE = { unknownKeys: "ignore" } as const;

interface Manifest {
  readonly name: PackageName;
  readonly dir: RepoPath;
  readonly dependencies: readonly Dependency[];
}

interface Dependency {
  readonly key: string;
  readonly specifier: string;
  readonly where: string;
}

interface WorkspaceDefinition {
  readonly globs: GlobSet;
  readonly catalogs: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly overrides: readonly { readonly file: string; readonly dependency: Dependency }[];
}

export async function discoverWorkspace(
  tree: RepoTree,
  discovery: Discovery,
): Promise<Result<Workspace, NonEmpty<Problem>>> {
  const definition = await workspaceDefinition(tree, discovery);
  if (!definition.ok) return definition;
  const files = await listFiles(tree);
  if (!files.ok) return files;

  const isPackageDir = compileGlobs(definition.value.globs);
  const dirs = files.value.flatMap((path) => {
    const dir = path.endsWith(IN_PACKAGE) ? parseRepoPath(path.slice(0, -IN_PACKAGE.length)) : undefined;
    return dir !== undefined && isPackageDir(dir) ? [dir] : [];
  });
  const read = await Promise.all(dirs.map((dir) => readManifest(tree, dir)));

  const problems: Problem[] = read.flatMap((result) => (result.ok ? [] : result.error));
  const byName = new Map<string, Manifest>();
  for (const manifest of read.flatMap((result) => (result.ok && result.value !== undefined ? [result.value] : []))) {
    const claimed = byName.get(manifest.name);
    if (claimed === undefined) byName.set(manifest.name, manifest);
    else {
      problems.push({
        file: manifest.dir + IN_PACKAGE,
        at: null,
        where: "name",
        message: `${manifest.name} is also the name of ${claimed.dir}`,
      });
    }
  }
  if (isNonEmpty(problems)) return err(problems);

  const byDir = new Map<string, Manifest>([...byName.values()].map((manifest) => [manifest.dir, manifest]));
  const pathPackages = [...byDir.values()].sort((a, b) => b.dir.length - a.dir.length);
  const collect = (key: string, specifier: string, dirs: readonly string[], targets: Set<PackageName>): boolean => {
    const keyed = byName.get(key);
    if (keyed !== undefined) targets.add(keyed.name);
    if (specifier.startsWith("catalog:")) {
      specifier = definition.value.catalogs.get(specifier.slice("catalog:".length).trim() || "default")?.get(key) ?? "";
      if (specifier.startsWith("catalog:")) return true;
      // pnpm releases differ on the base of catalog paths. Both are safe candidates.
      dirs = [...dirs, ""];
    }
    const local = /^(workspace:|link:|file:)(.*)$/.exec(specifier);
    const protocol = local?.[1];
    const value = (local?.[2] ?? specifier).replaceAll("\\", "/");
    if (
      protocol === "link:" ||
      protocol === "file:" ||
      /^(\.{1,2}(?:\/|$)|~\/|\/|[A-Za-z]:\/)/.test(value) ||
      (!protocol &&
        !value.includes(":") &&
        !value.includes("#") &&
        (value.split("/").length > 2 || /\.(?:tar|tar\.gz|tgz)$/.test(value)))
    ) {
      for (const dir of dirs) {
        if (/^[~/]|^[A-Za-z]:/.test(value)) continue;
        const path = posix.join(dir, value).replace(/\/+$/, "");
        for (const caseSensitive of [true, false]) {
          const candidatePath = caseSensitive ? path : path.toLowerCase();
          const candidates = pathPackages.filter(({ dir }) => {
            const candidateDir = caseSensitive ? dir : dir.toLowerCase();
            return candidatePath === candidateDir || candidatePath.startsWith(candidateDir + "/");
          });
          const depth = candidates[0]?.dir.length;
          for (const candidate of candidates) {
            if (candidate.dir.length === depth) targets.add(candidate.name);
          }
        }
      }
      return true;
    }
    const name =
      protocol === "workspace:"
        ? (/^workspace:(?:(?<alias>[^._/][^@]*)@)?(?<version>.*)$/.exec(specifier)?.groups?.alias ?? key)
        : /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?((?:@[^/]+\/)?[^@/:]+)(?:@.*)?$/.exec(specifier)?.[1];
    const dependency = name === undefined ? undefined : byName.get(name);
    if (dependency !== undefined) targets.add(dependency.name);
    return protocol !== "workspace:" || dependency !== undefined;
  };
  const overridden = new Set<PackageName>();
  for (const {
    file,
    dependency: { key, specifier, where },
  } of definition.value.overrides) {
    // A nested override can resolve a relative path at a consumer, while a root override uses the root.
    if (!collect(key, specifier, ["", ...byDir.keys()], overridden)) {
      problems.push({ file, at: null, where, message: "does not resolve to a workspace package" });
    }
  }
  const packages = new Map<string, WorkspacePackage>();
  for (const { name, dir, dependencies } of byName.values()) {
    const resolved = new Set(overridden);
    for (const { key, specifier, where } of dependencies) {
      if (!collect(key, specifier, [dir], resolved))
        problems.push({
          file: dir + IN_PACKAGE,
          at: null,
          where,
          message: "does not resolve to a workspace package",
        });
    }
    packages.set(name, { name, dir, dependencies: [...resolved] });
  }
  return isNonEmpty(problems) ? err(problems) : ok({ packages });
}

async function workspaceDefinition(
  tree: RepoTree,
  discovery: Discovery,
): Promise<Result<WorkspaceDefinition, NonEmpty<Problem>>> {
  const manifest = await readFile(tree, MANIFEST);
  if (!manifest.ok) return manifest;
  const json = manifest.value === undefined ? ok(undefined) : jsonFile(MANIFEST, manifest.value);
  if (!json.ok) return json;
  const overrides = decode(rootOverrides, json.value ?? {});
  if (!overrides.ok) return err(jsonProblems(MANIFEST, overrides.error));
  const withOverrides = (definition: WorkspaceDefinition): WorkspaceDefinition => ({
    ...definition,
    overrides: expandOverrideReferences(
      [...definition.overrides, ...overrides.value.overrides],
      overrides.value.references,
    ),
  });
  if (discovery !== "npm") {
    const pnpm = await readFile(tree, WORKSPACE_FILE);
    if (!pnpm.ok) return pnpm;
    if (pnpm.value !== undefined) {
      const definition = pnpmWorkspace(pnpm.value);
      return definition.ok ? ok(withOverrides(definition.value)) : definition;
    }
    if (discovery === "pnpm") return err([fileProblem(WORKSPACE_FILE, "not found, and workspace.discovery is pnpm")]);
  }
  if (json.value === undefined) {
    return err([
      fileProblem(
        MANIFEST,
        discovery === "npm"
          ? "not found, and workspace.discovery is npm"
          : `not found, and neither is ${WORKSPACE_FILE}, so there is no workspace to discover`,
      ),
    ]);
  }
  const definition = npmWorkspace(json.value);
  return definition.ok ? ok(withOverrides(definition.value)) : definition;
}

function emptyMapping<T>(decoder: Decoder<readonly T[]>): Decoder<readonly T[]> {
  return (input, context) => (input === null || input === undefined ? [] : decoder(input, context));
}

function pnpmWorkspace(source: string): Result<WorkspaceDefinition, NonEmpty<Problem>> {
  const file = parseYaml(WORKSPACE_FILE, source);
  if (!file.ok) return file;
  const decoded = decode(
    object((field) => {
      const packages = field("packages", withDefault(array(workspaceGlob), []));
      const catalog = field("catalog", emptyMapping(entries(string, string)));
      const catalogs = field("catalogs", emptyMapping(entries(string, entries(string, string))));
      const overrides = field("overrides", emptyMapping(overrideValues));
      if (!isValid(packages) || !isValid(catalog) || !isValid(catalogs) || !isValid(overrides)) return INVALID;
      return {
        globs: globSet(packages),
        overrides: overrides.map((dependency) => ({ file: WORKSPACE_FILE, dependency })),
        catalogs: new Map([
          ["default", new Map(catalog)],
          ...catalogs.map(([name, values]) => [name, new Map(values)] as const),
        ]),
      };
    }, IGNORE),
    file.value.value,
  );
  return decoded.ok ? ok(decoded.value) : err(mapNonEmpty(decoded.error, file.value.locate));
}

const npmWorkspaces: Decoder<readonly WorkspaceGlob[]> = (input, context) =>
  Array.isArray(input)
    ? array(workspaceGlob)(input, context)
    : object<readonly WorkspaceGlob[]>((field) => field("packages", array(workspaceGlob)), IGNORE)(input, context);

function npmWorkspace(input: unknown): Result<WorkspaceDefinition, NonEmpty<Problem>> {
  const decoded = decode(
    object<readonly WorkspaceGlob[]>((field) => field("workspaces", npmWorkspaces), IGNORE),
    input,
  );
  return decoded.ok
    ? ok({ globs: globSet(decoded.value), catalogs: new Map(), overrides: [] })
    : err(jsonProblems(MANIFEST, decoded.error));
}

interface WorkspaceGlob {
  readonly glob: string;
  readonly excluded: boolean;
}

/** pnpm writes an exclusion as `!glob`, and npm users often write `./packages/*`. */
const workspaceGlob: Decoder<WorkspaceGlob> = refine(string, (raw, context) => {
  const excluded = raw.startsWith("!");
  const glob = (excluded ? raw.slice(1) : raw).replace(/^\.\//, "").replace(/\/+$/, "");
  const problem = globProblem(glob);
  return problem === undefined ? { glob, excluded } : context.fail(problem);
});

function globSet(globs: readonly WorkspaceGlob[]): GlobSet {
  return {
    match: globs.filter(({ excluded }) => !excluded).map(({ glob }) => glob),
    except: globs.filter(({ excluded }) => excluded).map(({ glob }) => glob),
  };
}

const manifestDecoder = object((field) => {
  const name = field("name", withDefault(string, ""));
  const dependencies = DEPENDENCY_FIELDS.map((fieldName) => {
    const values = field(fieldName, withDefault(entries(string, string), []));
    return isValid(values)
      ? values.map(([key, specifier]) => ({ key, specifier, where: formatDataPath([fieldName, key]) }))
      : INVALID;
  });
  if (!isValid(name) || !dependencies.every(isValid)) return INVALID;
  return { name, dependencies: dependencies.flat() };
}, IGNORE);

const overrideValues: Decoder<readonly Dependency[]> = (input, context) => {
  if (typeof input === "string") {
    const selector = context.path.toReversed().find((part) => typeof part === "string" && part !== ".") ?? "";
    const key = /^((?:@[^/]+\/)?[^@]+)(?:@.*)?$/.exec(String(selector).split(">").at(-1) ?? "")?.[1] ?? "";
    return [{ key, specifier: input, where: formatDataPath(context.path) }];
  }
  const nested = entries(string, overrideValues)(input, context);
  return isValid(nested) ? nested.flatMap(([, values]) => values) : INVALID;
};

const rootOverrides = object((field) => {
  const npm = field("overrides", emptyMapping(overrideValues));
  const pnpm = field("pnpm", emptyMapping(object((field) => field("overrides", emptyMapping(overrideValues)), IGNORE)));
  const dependencies = DEPENDENCY_FIELDS.map((name) => field(name, withDefault(entries(string, string), [])));
  if (!isValid(npm) || !isValid(pnpm) || !dependencies.every(isValid)) return INVALID;
  return {
    overrides: [...npm, ...pnpm].map((dependency) => ({ file: MANIFEST, dependency })),
    references: new Map(dependencies.flat()),
  };
}, IGNORE);

function expandOverrideReferences(
  overrides: WorkspaceDefinition["overrides"],
  references: ReadonlyMap<string, string>,
): WorkspaceDefinition["overrides"] {
  return overrides.flatMap((entry) => {
    const { dependency } = entry;
    const key = dependency.specifier.slice(1);
    const specifier = dependency.specifier.startsWith("$") ? references.get(key) : undefined;
    return specifier === undefined ? [entry] : [entry, { ...entry, dependency: { ...dependency, key, specifier } }];
  });
}

/** Undefined when the directory has a package.json without a name, which makes it not a package. */
async function readManifest(tree: RepoTree, dir: RepoPath): Promise<Result<Manifest | undefined, NonEmpty<Problem>>> {
  const file = dir + IN_PACKAGE;
  const source = await readFile(tree, file);
  if (!source.ok || source.value === undefined) return source.ok ? ok(undefined) : source;
  const json = jsonFile(file, source.value);
  if (!json.ok) return json;
  const decoded = decode(manifestDecoder, json.value);
  if (!decoded.ok) return err(jsonProblems(file, decoded.error));
  const name = parsePackageName(decoded.value.name);
  return ok(name === undefined ? undefined : { name, dir, dependencies: decoded.value.dependencies });
}

function jsonFile(file: string, source: string): Result<unknown, NonEmpty<Problem>> {
  const json = parseJson(source);
  return json.ok ? json : err([{ file, at: json.error, where: null, message: "is not valid JSON" }]);
}

function jsonProblems(file: string, issues: NonEmpty<Issue>): NonEmpty<Problem> {
  return mapNonEmpty(issues, ({ path, message }) => ({
    file,
    at: null,
    where: path.length === 0 ? null : formatDataPath(path),
    message,
  }));
}
