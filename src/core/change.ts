import { parseRepoPath, type RepoPath } from "./ids.ts";

/** Two revisions to compare. `base` is null when there is none, such as the first push of a branch. */
export interface Range {
  readonly base: string | null;
  readonly head: string;
}

export type IncompleteCause =
  | { readonly kind: "truncated"; readonly listed: number; readonly limit: number }
  | { readonly kind: "count-mismatch"; readonly listed: number; readonly expected: number }
  | { readonly kind: "no-base" }
  | { readonly kind: "invalid-path"; readonly raw: string }
  | { readonly kind: "error"; readonly message: string };

const vetted: unique symbol = Symbol("vetted");

/**
 * A file list known to be the whole change. `vetted` is a symbol no other module can name, so only
 * `changedFiles` can build one. It and `Skip` are the only values that can keep a lane from running.
 */
export interface CompleteFiles {
  readonly kind: "complete";
  readonly paths: readonly RepoPath[];
  readonly [vetted]: true;
}

/** The paths that were listed are kept to explain the plan, and never decide anything. */
export interface IncompleteFiles {
  readonly kind: "incomplete";
  readonly cause: IncompleteCause;
  readonly paths: readonly RepoPath[];
}

export type ChangedFiles = CompleteFiles | IncompleteFiles;

/**
 * The port every source of changed files implements. A source resolves `incomplete` for a condition
 * it understands and rejects for anything else, which `planLanes` turns into a fail-closed plan.
 */
export type ChangeSource = (range: Range) => Promise<ChangedFiles>;

export interface ChangeEntry {
  readonly path: string;
  readonly previousPath: string | null;
}

/**
 * The only constructor of a complete list. A rename contributes both of its paths. `under` is where
 * the routed root sits inside the repository, and its prefix is removed from every path. A path
 * outside `under`, or one that is not a valid path, makes the list incomplete rather than being dropped.
 */
export function changedFiles(entries: readonly ChangeEntry[], under = ""): ChangedFiles {
  const prefix = under === "" ? "" : `${under.replace(/\/+$/, "")}/`;
  const paths = new Set<RepoPath>();
  let outside: string | undefined;
  const listed = entries.flatMap(({ path, previousPath }) => (previousPath === null ? [path] : [previousPath, path]));
  for (const raw of listed) {
    const path = raw.startsWith(prefix) ? parseRepoPath(raw.slice(prefix.length)) : undefined;
    if (path === undefined) outside ??= raw;
    else paths.add(path);
  }
  const sorted = [...paths].sort();
  if (outside !== undefined) return incomplete({ kind: "invalid-path", raw: outside }, sorted);
  return { kind: "complete", paths: sorted, [vetted]: true };
}

/** Failing closed is always allowed, so any module may build this. */
export function incomplete(cause: IncompleteCause, paths: readonly RepoPath[] = []): IncompleteFiles {
  return { kind: "incomplete", cause, paths };
}
