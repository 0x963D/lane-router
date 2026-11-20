import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { changedFiles, incomplete, type ChangedFiles, type Range } from "../core/change.ts";
import type { Mode } from "../core/plan.ts";
import { pathRefusal, type Refusal, type RepoTree, type TreeRead } from "../load/index.ts";

const execFileAsync = promisify(execFile);

/** Paths relative to the top of the repository whatever `diff.relative` says. */
const DIFF = [
  "diff",
  "--name-only",
  "--no-renames",
  "--no-relative",
  "--no-ext-diff",
  "--no-textconv",
  "--ignore-submodules=none",
  "-z",
] as const;

/** Entry modes whose content is not a file in this tree. A blob of mode 120000 holds a link target. */
const LINKS: ReadonlyMap<string, Refusal> = new Map([
  ["120000", "symbolic-link"],
  ["160000", "submodule"],
]);

/** Local git, run as a child process with argument arrays, never through a shell. */
export interface GitRepo {
  /** The full SHA of the commit a ref names, or undefined when git does not know it. */
  resolve(ref: string): Promise<string | undefined>;
  /** Ordered parent SHAs from the commit object, even at a shallow boundary. */
  parentsOf(commit: string): Promise<readonly string[]>;
  /** The routed root at one commit. Nothing here reads the working tree or the index. */
  treeAt(commit: string): RepoTree;
  /**
   * The files changed between the merge base of the range, which the list carries, and its head. With
   * rename detection off, a rename arrives as its deleted and its added path. Rejects when git fails,
   * such as for unrelated histories. In push mode a head that does not extend base is incomplete.
   */
  readonly changes: (range: Range, mode?: Mode) => Promise<ChangedFiles>;
  /** Where the routed root sits inside the repository, empty at the top level. */
  prefix(): Promise<string>;
}

/** `cwd` is the routed root. It may sit below the top of the repository. */
export function gitRepo(cwd: string): GitRepo {
  const runGit = async (args: readonly string[], input?: string, fetchMissing = false): Promise<Buffer> => {
    try {
      const run = execFileAsync("git", ["--no-replace-objects", ...args], {
        cwd,
        env: fetchMissing ? process.env : { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        encoding: "buffer",
        maxBuffer: 256 * 1024 * 1024,
      });
      run.child.stdin?.on("error", () => {});
      run.child.stdin?.end(input);
      const { stdout } = await run;
      return stdout;
    } catch (error) {
      throw new Error(`git ${args.join(" ")} failed: ${stderrOf(error)}`, { cause: error });
    }
  };
  const git = async (args: readonly string[]): Promise<string> => (await runGit(args)).toString("utf8");
  const prefix = async (): Promise<string> => (await git(["rev-parse", "--show-prefix"])).trim();

  return {
    resolve: async (ref) => {
      try {
        return (await git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).trim();
      } catch {
        return undefined;
      }
    },
    parentsOf: async (commit) => {
      try {
        // Revision walks hide the recorded parents of shallow commits.
        const object = await git(["cat-file", "commit", commit]);
        const [headers = ""] = object.split("\n\n", 1);
        const parents = headers
          .split("\n")
          .filter((line) => line.startsWith("parent "))
          .map((line) => line.slice(7));
        return parents.every((parent) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parent)) ? parents : [];
      } catch {
        return [];
      }
    },
    treeAt: (commit) => {
      let listing: Promise<ReadonlyMap<string, TreeEntry>> | undefined;
      const entries = (): Promise<ReadonlyMap<string, TreeEntry>> =>
        (listing ??= runGit(["ls-tree", "-r", "-z", commit], undefined, true).then((output) =>
          parseEntries(output.toString("utf8")),
        ));
      const pending: { id: string; resolve: (text: string) => void; reject: (error: unknown) => void }[] = [];
      const readBlob = (id: string): Promise<string> =>
        new Promise((resolve, reject) => {
          pending.push({ id, resolve, reject });
          if (pending.length > 1) return;
          // Workspace discovery asks for its manifests together. Share one Git process for those reads.
          queueMicrotask(() => {
            const batch = pending.splice(0);
            const ids = batch.map(({ id }) => id);
            void runGit(["cat-file", "--batch"], ids.join("\n") + "\n", true)
              .then((output) => {
                const blobs = parseBlobs(output, ids);
                for (const { id, resolve } of batch) resolve(blobs.get(id) ?? "");
              })
              .catch((error: unknown) => {
                for (const { reject } of batch) reject(error);
              });
          });
        });
      return {
        files: async () => [...(await entries()).keys()].sort(),
        read: async (path): Promise<TreeRead> => {
          const refusal = pathRefusal(path);
          if (refusal !== undefined) return { kind: "refused", refusal };
          const entry = (await entries()).get(path);
          if (entry === undefined) return { kind: "missing" };
          const link = LINKS.get(entry.mode);
          if (link !== undefined) return { kind: "refused", refusal: link };
          return { kind: "file", text: await readBlob(entry.id) };
        },
      };
    },
    changes: async (range, mode = "pr") => {
      if (range.base === null) return incomplete({ kind: "no-base" });
      const mergeBase = (await git(["merge-base", range.base, range.head])).trim();
      if (mode === "push" && mergeBase !== range.base) {
        return incomplete({
          kind: "not-fast-forward",
          status: mergeBase === range.head ? "behind" : "diverged",
          mergeBase,
        });
      }
      const output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await runGit([...DIFF, mergeBase, range.head, "--"]),
      );
      return changedFiles(
        split(output).map((path) => ({ path, previousPath: null })),
        { under: await prefix(), mergeBase },
      );
    },
    prefix,
  };
}

interface TreeEntry {
  readonly mode: string;
  readonly id: string;
}

function parseEntries(output: string): ReadonlyMap<string, TreeEntry> {
  return new Map(
    split(output).map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, , id] = entry.slice(0, tab).split(" ");
      if (mode === undefined || id === undefined) throw new Error("git returned an invalid tree entry");
      return [entry.slice(tab + 1), { mode, id }] as const;
    }),
  );
}

/** `cat-file --batch` frames each blob with a byte count and a trailing newline. */
function parseBlobs(output: Buffer, ids: readonly string[]): ReadonlyMap<string, string> {
  const blobs = new Map<string, string>();
  let start = 0;
  for (const id of ids) {
    const headerEnd = output.indexOf(10, start);
    const [found, type, rawSize] = output.toString("ascii", start, headerEnd).split(" ");
    const size = Number(rawSize);
    const end = headerEnd + 1 + size;
    if (found === id && type === "missing") {
      throw new Error(
        `Git object ${id} is missing. Fetch the required objects or use a checkout without a partial-clone filter`,
      );
    }
    if (found !== id || type !== "blob" || !Number.isSafeInteger(size) || size < 0 || output[end] !== 10) {
      throw new Error(`git returned an invalid blob for ${id}`);
    }
    blobs.set(id, output.toString("utf8", headerEnd + 1, end));
    start = end + 1;
  }
  if (start !== output.length) throw new Error("git returned extra data after the blob batch");
  return blobs;
}

function split(output: string): string[] {
  return output.split("\0").filter((entry) => entry !== "");
}

function stderrOf(error: unknown): string {
  const stderr = error instanceof Error && "stderr" in error ? error.stderr : undefined;
  const message = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim() : "";
  return message || String(error);
}
