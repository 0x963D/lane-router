import { parseRepoPath } from "../core/ids.ts";
import { compile, type RoutingModel } from "../core/model.ts";
import { err, ok, type NonEmpty, type Result } from "../result.ts";
import { openConfig } from "./config.ts";
import { fileProblem, type Problem } from "./problem.ts";
import { readFile, type RepoTree } from "./tree.ts";
import { discoverWorkspace } from "./workspace.ts";

export { formatProblems, type Problem } from "./problem.ts";
export { IGNORED_DIRECTORIES, type RepoTree } from "./tree.ts";

/**
 * The boundary. A repository tree goes in, and out comes a routing model the core can trust, or
 * every problem with the config and the workspace in one list. An unreadable file is a problem.
 */
export async function loadModel(tree: RepoTree, configPath: string): Promise<Result<RoutingModel, NonEmpty<Problem>>> {
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
  return ok(compile({ configPath: path, config: resolved.value, workspace: workspace.value }));
}
