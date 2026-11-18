import picomatch from "picomatch/posix.js";
import { messageOf } from "../result.ts";

export type PathMatcher = (path: string) => boolean;

export interface GlobSet {
  readonly match: readonly string[];
  readonly except?: readonly string[];
}

const OPTIONS = { dot: true } as const;

/** Rows, docs-only and workspace globs all compile here, so no two rules disagree on what a glob means. */
export function compileGlobs({ match, except }: GlobSet): PathMatcher {
  if (match.length === 0) return () => false;
  return picomatch([...match], except === undefined ? OPTIONS : { ...OPTIONS, ignore: [...except] });
}

/** Config and workspace validation call this on every glob, which keeps `compileGlobs` total afterwards. */
export function globProblem(glob: string): string | undefined {
  if (glob.trim() === "") return "a glob cannot be empty";
  if (glob.includes("\\")) return "use / as the path separator";
  if (glob.startsWith("/") || glob.startsWith("./")) return "globs are relative to the repository root";
  if (glob.startsWith("!")) return "a glob cannot start with !";
  if (glob.split("/").includes("..")) return "a glob cannot reach outside the repository root";
  try {
    picomatch(glob, OPTIONS);
    return undefined;
  } catch (error) {
    return messageOf(error);
  }
}
