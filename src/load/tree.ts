import { err, messageOf, ok, type NonEmpty, type Result } from "../result.ts";
import { fileProblem, type Problem } from "./problem.ts";

/** Directories that are never part of the repository's content, at any depth. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([".git", "node_modules"]);

/** Why a tree will not read a path. A pull request controls every path and every link it reads. */
export type Refusal =
  "absolute" | "backslash" | "dot-segment" | "git-metadata" | "symbolic-link" | "submodule" | "outside-root";

const REFUSALS: Readonly<Record<Refusal, string>> = {
  absolute: "is an absolute path",
  backslash: "contains a backslash, which is not a path separator in a repository",
  "dot-segment": "has a . or .. segment",
  "git-metadata": "is inside .git",
  "symbolic-link": "is a symbolic link",
  submodule: "is a git submodule",
  "outside-root": "resolves outside the repository root",
};

export type TreeRead =
  | { readonly kind: "file"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly refusal: Refusal };

/**
 * A read-only view of the repository at one revision: a checked-out directory for the Action, a git
 * commit for the CLI. Both feed one loader, so the CLI and the Action cannot read a config two ways.
 * Paths are relative to the routed root, with posix separators.
 */
export interface RepoTree {
  /**
   * Every file, with a link listed as a file. A tree may list files under IGNORED_DIRECTORIES, and
   * the loader skips them.
   */
  files(): Promise<readonly string[]>;
  /** Refuses what `pathRefusal` refuses and never follows a link. Rejects when a file exists but cannot be read. */
  read(path: string): Promise<TreeRead>;
}

/** The rule every tree applies before it looks at storage. Each tree adds the checks only its storage can make. */
export function pathRefusal(path: string): Refusal | undefined {
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "absolute";
  if (path.includes("\\")) return "backslash";
  const segments = path.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return "dot-segment";
  if (segments.includes(".git")) return "git-metadata";
  return undefined;
}

export async function readFile(tree: RepoTree, path: string): Promise<Result<string | undefined, NonEmpty<Problem>>> {
  let read: TreeRead;
  try {
    read = await tree.read(path);
  } catch (error) {
    return err([fileProblem(path, `cannot be read: ${messageOf(error)}`)]);
  }
  switch (read.kind) {
    case "file":
      return ok(read.text);
    case "missing":
      return ok(undefined);
    case "refused":
      return err([fileProblem(path, REFUSALS[read.refusal])]);
    default: {
      const _exhaustive: never = read;
      return _exhaustive;
    }
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
