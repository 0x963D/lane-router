import { compileGlobs, type GlobSet } from "../core/glob.ts";
import { parsePackageName, parseRepoPath, type PackageName, type RepoPath } from "../core/ids.ts";
import type { Workspace, WorkspacePackage } from "../core/model.ts";
import {
  array,
  decode,
  entries,
  formatDataPath,
  INVALID,
  isValid,
  object,
  string,
  unknownValue,
  withDefault,
  type Decoder,
  type Issue,
} from "../decode.ts";
import { err, isNonEmpty, mapNonEmpty, messageOf, ok, type NonEmpty, type Result } from "../result.ts";
import type { Discovery } from "./config.ts";
import { fileProblem, type Problem } from "./problem.ts";
import { listFiles, readFile, type RepoTree } from "./tree.ts";
import { parseYaml } from "./yaml.ts";

/* How package managers describe a workspace: pnpm-workspace.yaml, package.json `workspaces`, and the dependency fields. */

const PNPM_FILE = "pnpm-workspace.yaml";
const ROOT_MANIFEST = "package.json";
const MANIFEST = "/package.json";
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
    const dir = path.endsWith(MANIFEST) ? parseRepoPath(path.slice(0, -MANIFEST.length)) : undefined;
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
        file: manifest.dir + MANIFEST,
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
    const pnpm = await readFile(tree, PNPM_FILE);
    if (!pnpm.ok) return pnpm;
    if (pnpm.value !== undefined) return pnpmGlobs(pnpm.value);
    if (discovery === "pnpm") return err([fileProblem(PNPM_FILE, "not found, and workspace.discovery is pnpm")]);
  }
  const manifest = await readFile(tree, ROOT_MANIFEST);
  if (!manifest.ok) return manifest;
  if (manifest.value === undefined) {
    return err([
      fileProblem(
        ROOT_MANIFEST,
        discovery === "npm"
          ? "not found, and workspace.discovery is npm"
          : `not found, and neither is ${PNPM_FILE}, so there is no workspace to discover`,
      ),
    ]);
  }
  return npmGlobs(manifest.value);
}

function pnpmGlobs(source: string): Result<GlobSet, NonEmpty<Problem>> {
  const file = parseYaml(PNPM_FILE, source);
  if (!file.ok) return file;
  const decoded = decode(
    object<readonly string[]>((field) => field("packages", withDefault(array(string), [])), IGNORE),
    file.value.value,
  );
  return decoded.ok ? ok(globSet(decoded.value)) : err(mapNonEmpty(decoded.error, file.value.locate));
}

const npmWorkspaces: Decoder<readonly string[]> = (input, context) =>
  Array.isArray(input)
    ? array(string)(input, context)
    : object<readonly string[]>((field) => field("packages", array(string)), IGNORE)(input, context);

function npmGlobs(source: string): Result<GlobSet, NonEmpty<Problem>> {
  const json = parseJson(ROOT_MANIFEST, source);
  if (!json.ok) return json;
  const decoded = decode(
    object<readonly string[]>((field) => field("workspaces", npmWorkspaces), IGNORE),
    json.value,
  );
  return decoded.ok ? ok(globSet(decoded.value)) : err(jsonProblems(ROOT_MANIFEST, decoded.error));
}

/** pnpm writes exclusions as `!glob`. npm users often write `./packages/*`. Both become one GlobSet. */
function globSet(globs: readonly string[]): GlobSet {
  const normalize = (glob: string): string => glob.replace(/^\.\//, "").replace(/\/+$/, "");
  return {
    match: globs.filter((glob) => !glob.startsWith("!")).map(normalize),
    except: globs.filter((glob) => glob.startsWith("!")).map((glob) => normalize(glob.slice(1))),
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
  const file = dir + MANIFEST;
  const source = await readFile(tree, file);
  if (!source.ok || source.value === undefined) return source.ok ? ok(undefined) : source;
  const json = parseJson(file, source.value);
  if (!json.ok) return json;
  const decoded = decode(manifestDecoder, json.value);
  if (!decoded.ok) return err(jsonProblems(file, decoded.error));
  const name = parsePackageName(decoded.value.name);
  return ok(name === undefined ? undefined : { name, dir, dependencies: decoded.value.dependencies });
}

function parseJson(file: string, source: string): Result<unknown, NonEmpty<Problem>> {
  try {
    const value: unknown = JSON.parse(source);
    return ok(value);
  } catch (error) {
    return err([fileProblem(file, `is not valid JSON: ${messageOf(error)}`)]);
  }
}

function jsonProblems(file: string, issues: NonEmpty<Issue>): NonEmpty<Problem> {
  return mapNonEmpty(issues, ({ path, message }) => ({
    file,
    at: null,
    where: path.length === 0 ? null : formatDataPath(path),
    message,
  }));
}
