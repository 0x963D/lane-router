import { parseRepoPath } from "../core/ids.ts";
import { compile, type RoutingModel } from "../core/model.ts";
import type { BaseGraph } from "../core/plan.ts";
import { err, ok, type NonEmpty, type Result } from "../result.ts";
import { openConfig } from "./config.ts";
import { fileProblem, formatProblems, type Problem } from "./problem.ts";
import { readFile, type RepoTree } from "./tree.ts";
import { discoverWorkspace } from "./workspace.ts";

export { formatProblems, type Problem } from "./problem.ts";
export { IGNORED_DIRECTORIES, pathRefusal, type Refusal, type RepoTree, type TreeRead } from "./tree.ts";

/**
 * The boundary. A repository tree goes in, and out comes a routing model the core can trust, or
 * every problem with the config and the workspace in one list. An unreadable file is a problem.
 * With `base`, the workspace there becomes the base graph, and every name in the config must
 * resolve in it too.
 */
export async function loadModel(
  tree: RepoTree,
  configPath: string,
  base?: RepoTree,
): Promise<Result<RoutingModel, NonEmpty<Problem>>> {
  const path = parseRepoPath(configPath);
  if (path === undefined) return err([fileProblem(configPath, "is not a path inside the repository")]);
  const source = await readFile(tree, path);
  if (!source.ok) return source;
  if (source.value === undefined) return err([fileProblem(path, "not found")]);
  const config = openConfig(path, source.value);
  if (!config.ok) return config;

  const workspace = await discoverWorkspace(tree, config.value.discovery);
  if (!workspace.ok) {
    const problems: NonEmpty<Problem> = [...workspace.error, ...config.value.problems()];
    return err(problems);
  }
  const resolved = config.value.resolve(workspace.value);
  if (!resolved.ok) return resolved;
  const head = { configPath: path, config: resolved.value, workspace: workspace.value };
  if (base === undefined) return ok(compile(head));

  const baseWorkspace = await discoverWorkspace(base, config.value.discovery);
  if (!baseWorkspace.ok) return baseWorkspace;
  const resolvedInBase = config.value.resolve(baseWorkspace.value);
  if (!resolvedInBase.ok) return resolvedInBase;
  return ok(compile({ ...head, base: baseWorkspace.value }));
}

/** The commits a base graph can be read from. */
export interface Commits {
  /** Undefined for a commit the repository does not have, as in a shallow checkout. */
  resolve(ref: string): Promise<string | undefined>;
  treeAt(commit: string): RepoTree;
}

/** The port planLanes reads a base graph through. `head` and `configPath` are what the model loaded from. */
export function baseGraphOf(head: RepoTree, configPath: string, commits: Commits): BaseGraph {
  return async (commit) => {
    const sha = await commits.resolve(commit);
    if (sha === undefined) {
      return err("the commit is not in the local repository, so fetch more history, for example with fetch-depth: 0");
    }
    const loaded = await loadModel(head, configPath, commits.treeAt(sha));
    return loaded.ok ? loaded : err(formatProblems(loaded.error).replaceAll("\n", "; "));
  };
}
