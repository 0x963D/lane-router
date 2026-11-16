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
  const packages = new Map<string, WorkspacePackage>();
  for (const { name, dir, dependencies } of byName.values()) {
    const resolved: PackageName[] = [];
    for (const { key, specifier, where } of dependencies) {
      const { kind, target } = dependencyTarget(key, specifier, dir, definition.value.catalogs);
      const dependency =
        "path" in target
          ? /^[~/]|^[A-Za-z]:/.test(target.path)
            ? undefined
            : byDir.get(target.path)
          : byName.get(target.name);
      if (dependency !== undefined) resolved.push(dependency.name);
      else if (kind === "must-be-local")
        problems.push({
          file: dir + IN_PACKAGE,
          at: null,
          where,
          message: "does not resolve to a workspace package",
        });
    }
    packages.set(name, { name, dir, dependencies: [...new Set(resolved)] });
  }
  return isNonEmpty(problems) ? err(problems) : ok({ packages });
}

type DependencyTarget =
  | { readonly kind: "must-be-local"; readonly target: { readonly name: string } | { readonly path: string } }
  | { readonly kind: "may-be-local" | "never-local"; readonly target: { readonly name: string } };

function dependencyTarget(
  key: string,
  specifier: string,
  dir: string,
  catalogs: WorkspaceDefinition["catalogs"],
): DependencyTarget {
  if (specifier.startsWith("catalog:")) {
    const entry = catalogs.get(specifier.slice("catalog:".length) || "default")?.get(key);
    return entry === undefined || entry.startsWith("catalog:")
      ? { kind: "never-local", target: { name: key } }
      : dependencyTarget(key, entry, "", catalogs);
  }
  const local = /^(workspace:|link:|file:)(.*)$/.exec(specifier);
  const protocol = local?.[1];
  const value = (local?.[2] ?? specifier).replaceAll("\\", "/");
  const isPath = /^(\.{1,2}(?:\/|$)|~\/|\/|[A-Za-z]:\/)/.test(value);
  if (
    protocol === "link:" ||
    protocol === "file:" ||
    isPath ||
    (!protocol &&
      !value.includes(":") &&
      !value.includes("#") &&
      (value.split("/").length > 2 || /\.(?:tar|tar\.gz|tgz)$/.test(value)))
  ) {
    const path = /^[~/]|^[A-Za-z]:/.test(value) ? value : posix.join(dir, value).replace(/\/+$/, "");
    return { kind: "must-be-local", target: { path } };
  }
  if (protocol === "workspace:") {
    const alias = /^(?:v?\d|[xX]$)/.test(value)
      ? undefined
      : /^(@[^/]+\/[^@]+|[a-zA-Z_][a-zA-Z0-9._-]*)(?:@.*)?$/.exec(value)?.[1];
    return { kind: "must-be-local", target: { name: alias ?? key } };
  }
  const registry = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/.exec(specifier);
  if (
    registry !== null &&
    !/^(?:https?|git(?:\+.*)?|ssh|github|gitlab|bitbucket|gist|tool|runtime|crate|pypi)$/i.test(registry[1] ?? "")
  ) {
    const body = registry[2] ?? "";
    const usesKey =
      !body.startsWith("@") && (/^jsr$/i.test(registry[1] ?? "") || (registry[1] !== "npm" && key.startsWith("@")));
    const name = usesKey ? key : /^((?:@[^/]+\/)?[A-Za-z0-9_][A-Za-z0-9._-]*)(?:@.*)?$/.exec(body)?.[1];
    return { kind: "may-be-local", target: { name: name ?? key } };
  }
  return { kind: registry !== null || value.includes("/") ? "never-local" : "may-be-local", target: { name: key } };
}

async function workspaceDefinition(
  tree: RepoTree,
  discovery: Discovery,
): Promise<Result<WorkspaceDefinition, NonEmpty<Problem>>> {
  if (discovery !== "npm") {
    const pnpm = await readFile(tree, WORKSPACE_FILE);
    if (!pnpm.ok) return pnpm;
    if (pnpm.value !== undefined) return pnpmWorkspace(pnpm.value);
    if (discovery === "pnpm") return err([fileProblem(WORKSPACE_FILE, "not found, and workspace.discovery is pnpm")]);
  }
  const manifest = await readFile(tree, MANIFEST);
  if (!manifest.ok) return manifest;
  if (manifest.value === undefined) {
    return err([
      fileProblem(
        MANIFEST,
        discovery === "npm"
          ? "not found, and workspace.discovery is npm"
          : `not found, and neither is ${WORKSPACE_FILE}, so there is no workspace to discover`,
      ),
    ]);
  }
  return npmWorkspace(manifest.value);
}

function pnpmWorkspace(source: string): Result<WorkspaceDefinition, NonEmpty<Problem>> {
  const file = parseYaml(WORKSPACE_FILE, source);
  if (!file.ok) return file;
  const decoded = decode(
    object((field) => {
      const packages = field("packages", withDefault(array(workspaceGlob), []));
      const catalog = field("catalog", withDefault(entries(string, string), []));
      const catalogs = field("catalogs", withDefault(entries(string, entries(string, string)), []));
      if (!isValid(packages) || !isValid(catalog) || !isValid(catalogs)) return INVALID;
      return {
        globs: globSet(packages),
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

function npmWorkspace(source: string): Result<WorkspaceDefinition, NonEmpty<Problem>> {
  const json = jsonFile(MANIFEST, source);
  if (!json.ok) return json;
  const decoded = decode(
    object<readonly WorkspaceGlob[]>((field) => field("workspaces", npmWorkspaces), IGNORE),
    json.value,
  );
  return decoded.ok
    ? ok({ globs: globSet(decoded.value), catalogs: new Map() })
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
