/*
 * Compile-time claims. `npm run typecheck` compiles this file and nothing runs it. Each
 * `@ts-expect-error` line is a value the design says cannot be written. If one becomes writable,
 * the directive is unused and the typecheck fails.
 */
import type { ChangedFiles, CompleteFiles } from "../src/core/change.ts";
import type { RepoPath } from "../src/core/ids.ts";
import type { Plan } from "../src/core/plan.ts";
import type { LaneDecision, PlacedPath, Routing, Run, Skip } from "../src/core/route.ts";

declare const somePath: RepoPath;
declare const someRouting: Routing;

// @ts-expect-error a Skip carries a key only route.ts can name
export const forgedSkip: Skip = { kind: "skip", because: "untouched" };

// @ts-expect-error the same, through the decision union
export const forgedDecision: LaneDecision = { kind: "skip", because: "no-changes" };

export const honestRun: Run = { kind: "run", because: [{ kind: "incomplete", cause: { kind: "no-base" } }] };

// @ts-expect-error a Run has at least one reason
export const reasonlessRun: Run = { kind: "run", because: [] };

// @ts-expect-error a complete file list carries a key only change.ts can name
export const forgedComplete: CompleteFiles = { kind: "complete", paths: [], mergeBase: null };

// @ts-expect-error the same, through the file list union
export const forgedFiles: ChangedFiles = { kind: "complete", paths: [], mergeBase: null };

export const honestIncomplete: ChangedFiles = { kind: "incomplete", cause: { kind: "no-base" }, paths: [] };

// @ts-expect-error a plan carries a key only plan.ts can name
export const forgedPlan: Plan = { mode: "pr", event: someRouting, lanes: [] };

// @ts-expect-error a changed path always has a placement
export const unplaced: PlacedPath = { path: somePath, placements: [] };

// @ts-expect-error an empty routing has no paths to read
export const emptyHasPaths: keyof Extract<Routing, { kind: "empty" }> = "paths";

// @ts-expect-error a plain string is not a RepoPath
export const rawPath: RepoPath = "packages/api/src/user.ts";
