import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { IGNORED_DIRECTORIES, pathRefusal, type RepoTree, type TreeRead } from "../load/index.ts";

export function directoryTree(root: string): RepoTree {
  let realRoot: Promise<string> | undefined;
  return {
    files: async () => (await walk(root, "")).sort(),
    read: async (path): Promise<TreeRead> => {
      const refusal = pathRefusal(path);
      if (refusal !== undefined) return { kind: "refused", refusal };
      const file = join(root, path);
      try {
        if ((await lstat(file)).isSymbolicLink()) return { kind: "refused", refusal: "symbolic-link" };
        realRoot ??= realpath(root);
        if (!isInside(await realRoot, await realpath(file))) return { kind: "refused", refusal: "outside-root" };
        return { kind: "file", text: await readFile(file, "utf8") };
      } catch (error) {
        if (isMissing(error)) return { kind: "missing" };
        throw error;
      }
    },
  };
}

/** `lstat` sees only the last segment, so a linked parent directory shows up here. */
function isInside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * Lists a link as a file and never descends into a linked directory, the way git stores a link, so
 * a read of it is refused. Skips ignored directories, so an installed workspace costs no more to read.
 */
async function walk(root: string, dir: string): Promise<string[]> {
  const found = await readdir(join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(
    found.map(async (entry) => {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) return IGNORED_DIRECTORIES.has(entry.name) ? [] : walk(root, path);
      return entry.isFile() || entry.isSymbolicLink() ? [path] : [];
    }),
  );
  return nested.flat();
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
