import { err, messageOf, ok, type NonEmpty, type Result } from "../result.ts";
import { fileProblem, type Problem } from "./problem.ts";

/** Directories that are never part of the repository's content, at any depth. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

/**
 * A read-only view of the repository at one revision: a checked-out directory for the Action, a git
 * commit for the CLI. Both feed one loader, so the CLI and the Action cannot read a config two ways.
 * Paths are relative to the routed root, with posix separators.
 */
export interface RepoTree {
  /** Every file. A tree may list files under IGNORED_DIRECTORIES, and the loader skips them. */
  files(): Promise<readonly string[]>;
  /** Undefined when the file does not exist. Rejects when it exists but cannot be read. */
  read(path: string): Promise<string | undefined>;
}

export async function readFile(tree: RepoTree, path: string): Promise<Result<string | undefined, NonEmpty<Problem>>> {
  try {
    return ok(await tree.read(path));
  } catch (error) {
    return err([fileProblem(path, `cannot be read: ${messageOf(error)}`)]);
  }
}

export async function listFiles(tree: RepoTree): Promise<Result<readonly string[], NonEmpty<Problem>>> {
  try {
    const files = await tree.files();
    return ok(files.filter((path) => !path.split("/").some((segment) => IGNORED_DIRECTORIES.has(segment))));
  } catch (error) {
    return err([fileProblem(".", `cannot list the repository files: ${messageOf(error)}`)]);
  }
}
