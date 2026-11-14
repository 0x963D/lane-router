import { err, ok, type Result } from "../result.ts";

/** Each lane is also an Action output key, so a lane cannot take the name of a fixed output. */
export type LaneName = string & { readonly __brand: "LaneName" };

/** The `name` of a discovered package.json. Config strings become one only by lookup in the workspace. */
export type PackageName = string & { readonly __brand: "PackageName" };

/** A path relative to the routed root: posix separators, no leading `./` or `/`, no `.` or `..` segment. */
export type RepoPath = string & { readonly __brand: "RepoPath" };

/** The single list behind the reserved lane names, the rendered outputs and the `action.yml` contract test. */
export const FIXED_OUTPUTS = ["lanes", "matrix", "reasons", "complete", "docs-only", "none-required"] as const;

export type FixedOutput = (typeof FIXED_OUTPUTS)[number];

const LANE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function isLaneName(raw: string): raw is LaneName {
  return LANE_NAME.test(raw) && !FIXED_OUTPUTS.some((output) => output === raw);
}

export function parseLaneName(raw: string): Result<LaneName, "malformed" | "reserved"> {
  if (isLaneName(raw)) return ok(raw);
  return err(LANE_NAME.test(raw) ? "reserved" : "malformed");
}

function isPackageName(raw: string): raw is PackageName {
  return raw.length > 0;
}

export function parsePackageName(raw: string): PackageName | undefined {
  return isPackageName(raw) ? raw : undefined;
}

function isRepoPath(path: string): path is RepoPath {
  return (
    !path.includes("\0") && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  );
}

/** Undefined for a path that is not inside the root. A caller must fail closed on it, never drop it. */
export function parseRepoPath(raw: string): RepoPath | undefined {
  const canonical = raw.replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/");
  return isRepoPath(canonical) ? canonical : undefined;
}
