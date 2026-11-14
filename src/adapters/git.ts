import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changedFiles, incomplete, type ChangeSource } from "../core/change.ts";
import type { RepoTree } from "../load/index.ts";

const execFileAsync = promisify(execFile);

/** Paths relative to the top of the repository whatever `diff.relative` says. */
const DIFF = ["diff", "--name-only", "--no-renames", "--no-relative", "-z"] as const;

/** Local git, run as a child process with argument arrays, never through a shell. */
export interface GitRepo {
  /** The full SHA of the commit a ref names, or undefined when git does not know it. */
  resolve(ref: string): Promise<string | undefined>;
  /** The routed root at one commit. Nothing here reads the working tree or the index. */
  treeAt(commit: string): RepoTree;
  /**
   * The files changed between the merge base of the range and its head. With rename detection off, a
   * rename arrives as its deleted and its added path. Rejects when git fails, such as for unrelated histories.
   */
  readonly changes: ChangeSource;
  /** Where the routed root sits inside the repository, empty at the top level. */
  prefix(): Promise<string>;
}

/** `cwd` is the routed root. It may sit below the top of the repository. */
export function gitRepo(cwd: string): GitRepo {
  const git = async (args: readonly string[]): Promise<string> => {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      throw new Error(`git ${args.join(" ")} failed: ${stderrOf(error)}`, { cause: error });
    }
  };
  const prefix = async (): Promise<string> => (await git(["rev-parse", "--show-prefix"])).trim();

  return {
    resolve: async (ref) => {
      try {
        return (await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).trim();
      } catch {
        return undefined;
      }
    },
    treeAt: (commit) => {
      let listing: Promise<ReadonlySet<string>> | undefined;
      const files = (): Promise<ReadonlySet<string>> =>
        (listing ??= git(["ls-tree", "-r", "--name-only", "-z", commit]).then((output) => new Set(split(output))));
      return {
        files: async () => [...(await files())].sort(),
        read: async (path) =>
          (await files()).has(path) ? git(["cat-file", "blob", `${commit}:./${path}`]) : undefined,
      };
    },
    changes: async (range) => {
      if (range.base === null) return incomplete({ kind: "no-base" });
      const output = await git([...DIFF, `${range.base}...${range.head}`]);
      return changedFiles(
        split(output).map((path) => ({ path, previousPath: null })),
        await prefix(),
      );
    },
    prefix,
  };
}

function split(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

function stderrOf(error: unknown): string {
  const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
  return typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(error);
}
