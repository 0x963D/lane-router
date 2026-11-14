import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoTree } from "../load/index.ts";

const PRUNED = new Set([".git", "node_modules"]);

/** A RepoTree over a directory on disk: the Action's checkout, or a fixture in the tests. */
export function directoryTree(root: string): RepoTree {
  return {
    files: async () => (await walk(root, "")).sort(),
    read: async (path) => {
      try {
        return await readFile(join(root, path), "utf8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
  };
}

async function walk(root: string, dir: string): Promise<string[]> {
  const found = await readdir(join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(
    found.map(async (entry) => {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) return PRUNED.has(entry.name) ? [] : walk(root, path);
      return entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat();
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
