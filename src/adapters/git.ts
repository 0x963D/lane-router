import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changedFiles, incomplete, type ChangeSource } from "../core/change.ts";
import { pathRefusal, type Refusal, type RepoTree, type TreeRead } from "../load/index.ts";

const execFileAsync = promisify(execFile);

/** Paths relative to the top of the repository whatever `diff.relative` says. */
const DIFF = ["diff", "--name-only", "--no-renames", "--no-relative", "-z"] as const;

/** Entry modes whose content is not a file in this tree. A blob of mode 120000 holds a link target. */
const LINKS: ReadonlyMap<string, Refusal> = new Map([
  ["120000", "symbolic-link"],
  ["160000", "submodule"],
]);

/** Local git, run as a child process with argument arrays, never through a shell. */
export interface GitRepo {
  /** The full SHA of the commit a ref names, or undefined when git does not know it. */
  resolve(ref: string): Promise<string | undefined>;
  /** The routed root at one commit. Nothing here reads the working tree or the index. */
  treeAt(commit: string): RepoTree;
  /**
   * The files changed between the merge base of the range, which the list carries, and its head. With
   * rename detection off, a rename arrives as its deleted and its added path. Rejects when git fails,
   * such as for unrelated histories.
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
      let listing: Promise<ReadonlyMap<string, string>> | undefined;
      const modes = (): Promise<ReadonlyMap<string, string>> =>
        (listing ??= git(["ls-tree", "-r", "-z", commit]).then(parseModes));
      return {
        files: async () => [...(await modes()).keys()].sort(),
        read: async (path): Promise<TreeRead> => {
          const refusal = pathRefusal(path);
          if (refusal !== undefined) return { kind: "refused", refusal };
          const mode = (await modes()).get(path);
          if (mode === undefined) return { kind: "missing" };
          const link = LINKS.get(mode);
          if (link !== undefined) return { kind: "refused", refusal: link };
          return { kind: "file", text: await git(["cat-file", "blob", `${commit}:./${path}`]) };
        },
      };
    },
    changes: async (range) => {
      if (range.base === null) return incomplete({ kind: "no-base" });
      const mergeBase = (await git(["merge-base", range.base, range.head])).trim();
      const output = await git([...DIFF, mergeBase, range.head]);
      return changedFiles(
        split(output).map((path) => ({ path, previousPath: null })),
        { under: await prefix(), mergeBase },
      );
    },
    prefix,
  };
}

/** `ls-tree -z` prints `<mode> <type> <object>`, a tab, the path and a NUL for each entry. */
function parseModes(output: string): ReadonlyMap<string, string> {
  return new Map(
    split(output).map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf(" "))] as const),
  );
}

function split(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

function stderrOf(error: unknown): string {
  const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
  return typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(error);
}
