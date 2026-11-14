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
  unknownValue,
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
  readonly dependencies: readonly string[];
}

export async function discoverWorkspace(
  tree: RepoTree,
  discovery: Discovery,
): Promise<Result<Workspace, NonEmpty<Problem>>> {
  const globs = await workspaceGlobs(tree, discovery);
  if (!globs.ok) return globs;
  const files = await listFiles(tree);
  if (!files.ok) return files;

  const isPackageDir = compileGlobs(globs.value);
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

  const packages = new Map<string, WorkspacePackage>();
  for (const { name, dir, dependencies } of byName.values()) {
    const resolved = dependencies.flatMap((dependency) => byName.get(dependency)?.name ?? []);
    packages.set(name, { name, dir, dependencies: [...new Set(resolved)] });
  }
  return ok({ packages });
}

async function workspaceGlobs(tree: RepoTree, discovery: Discovery): Promise<Result<GlobSet, NonEmpty<Problem>>> {
  if (discovery !== "npm") {
    const pnpm = await readFile(tree, WORKSPACE_FILE);
    if (!pnpm.ok) return pnpm;
    if (pnpm.value !== undefined) return pnpmGlobs(pnpm.value);
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
  return npmGlobs(manifest.value);
}

function pnpmGlobs(source: string): Result<GlobSet, NonEmpty<Problem>> {
  const file = parseYaml(WORKSPACE_FILE, source);
  if (!file.ok) return file;
  const decoded = decode(
    object<readonly WorkspaceGlob[]>((field) => field("packages", withDefault(array(workspaceGlob), [])), IGNORE),
    file.value.value,
  );
  return decoded.ok ? ok(globSet(decoded.value)) : err(mapNonEmpty(decoded.error, file.value.locate));
}

const npmWorkspaces: Decoder<readonly WorkspaceGlob[]> = (input, context) =>
  Array.isArray(input)
    ? array(workspaceGlob)(input, context)
    : object<readonly WorkspaceGlob[]>((field) => field("packages", array(workspaceGlob)), IGNORE)(input, context);

function npmGlobs(source: string): Result<GlobSet, NonEmpty<Problem>> {
  const json = jsonFile(MANIFEST, source);
  if (!json.ok) return json;
  const decoded = decode(
    object<readonly WorkspaceGlob[]>((field) => field("workspaces", npmWorkspaces), IGNORE),
    json.value,
  );
  return decoded.ok ? ok(globSet(decoded.value)) : err(jsonProblems(MANIFEST, decoded.error));
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
  const dependencies = DEPENDENCY_FIELDS.map((key) => field(key, withDefault(entries(string, unknownValue), [])));
  if (!isValid(name) || !dependencies.every(isValid)) return INVALID;
  return { name, dependencies: dependencies.flat().map(([dependency]) => dependency) };
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
