import type { IncompleteCause } from "./core/change.ts";
import type { FixedOutput, LaneName } from "./core/ids.ts";
import type { Through } from "./core/model.ts";
import { baseOf, isComplete, type Mode, type Plan, type PlannedLane } from "./core/plan.ts";
import { isCounted, type Placement, type Routing, type RunReason, type SkipReason } from "./core/route.ts";

/*
 * Plan in, text out. Every user-visible sentence about a plan comes from here, so the Action
 * outputs, the job summary and the CLI never word one decision two ways.
 */

type ReasonKind = Exclude<RunReason["kind"], "placement"> | Placement["kind"];

/** The headline is the most decisive reason. A fail-closed cause beats any path. */
const HEADLINE_RANK: Readonly<Record<ReasonKind, number>> = {
  incomplete: 0,
  "no-proof": 1,
  config: 2,
  unmatched: 3,
  row: 4,
  package: 5,
  docs: 6,
  floor: 7,
};

function reasonKind(reason: RunReason): ReasonKind {
  return reason.kind === "placement" ? reason.placement.kind : reason.kind;
}

export function reasonLine(planned: PlannedLane): string {
  const { decision, since, lane } = planned;
  const proof = since?.range.base;
  const suffix = proof === undefined || proof === null ? "" : ` since ${shortRevision(proof)}`;
  if (decision.kind === "skip") return `${SKIP_TEXT[decision.because]}${suffix}`;
  const [headline, ...rest] = [...decision.because].sort(
    (a, b) => HEADLINE_RANK[reasonKind(a)] - HEADLINE_RANK[reasonKind(b)],
  );
  const more = rest.length === 0 ? "" : ` (+${String(rest.length)} more)`;
  return `${headline === undefined ? "" : describeReason(headline, lane.check)}${more}${suffix}`;
}

const SKIP_TEXT: Readonly<Record<SkipReason, string>> = {
  untouched: "nothing it reads changed",
  "docs-only": "docs-only change, and nothing it reads as text changed",
  "no-changes": "no changed files",
};

function describeReason(reason: RunReason, check: string): string {
  switch (reason.kind) {
    case "incomplete":
      return `fail closed, ${describeCause(reason.cause)}`;
    case "no-proof":
      return `no green ${check} check in the last ${String(reason.depth)} commits`;
    case "floor":
      return "floor lane, runs for every change that is not docs-only";
    case "placement":
      return describePlacement(reason.path, reason.placement, reason.through);
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

function describePlacement(path: string, placement: Placement, through: Through): string {
  switch (placement.kind) {
    case "config":
      return `${path} is the routing config`;
    case "unmatched":
      return `${path} matches no package, paths row or docs rule`;
    case "docs":
      return `${path} is documentation`;
    case "package":
      return `${path} is in ${placement.package}${readThrough(through)}`;
    case "row": {
      const { index, why, target } = placement.row;
      const subject =
        target.kind === "packages" && through.kind === "reads"
          ? ` for ${through.chain.at(-1) ?? ""} via ${target.via}`
          : "";
      return `${path} matches paths[${String(index)}]${subject}${readThrough(through)}: ${why}`;
    }
    default: {
      const _exhaustive: never = placement;
      return _exhaustive;
    }
  }
}

function readThrough(through: Through): string {
  if (through.kind === "named" || through.chain.length < 2) return "";
  return `, read through ${through.chain.slice(0, -1).join(" > ")}`;
}

function fileCount(count: number): string {
  return `${String(count)} ${count === 1 ? "file" : "files"}`;
}

export function describeCause(cause: IncompleteCause): string {
  switch (cause.kind) {
    case "truncated":
      return `the compare API lists at most ${fileCount(cause.limit)} and listed ${String(cause.listed)}`;
    case "count-mismatch":
      return `the compare API listed ${fileCount(cause.listed)} but the pull request changes ${String(cause.expected)}`;
    case "no-base":
      return "there is no base commit to compare against";
    case "invalid-path":
      return `${cause.raw} is not a path inside the routed root`;
    case "error":
      return cause.message;
    default: {
      const _exhaustive: never = cause;
      return _exhaustive;
    }
  }
}

export interface ActionOutputs {
  /** Typed by FIXED_OUTPUTS, so a fixed output cannot be dropped or added without a compile error here. */
  readonly fixed: Readonly<Record<FixedOutput, string>>;
  /** One entry per configured lane. Config validation keeps lane names apart from the fixed names. */
  readonly lanes: readonly (readonly [LaneName, "run" | "skip"])[];
}

export function actionOutputs(plan: Plan): ActionOutputs {
  const running = plan.lanes.filter(({ decision }) => decision.kind === "run");
  const include = running.map((planned) => ({
    lane: planned.lane.name,
    base: baseOf(plan, planned) ?? "",
    reason: reasonLine(planned),
  }));
  return {
    fixed: {
      lanes: JSON.stringify(running.map(({ lane }) => lane.name)),
      matrix: JSON.stringify({ include }),
      reasons: JSON.stringify(
        Object.fromEntries(plan.lanes.map((planned) => [planned.lane.name, reasonLine(planned)])),
      ),
      complete: String(isComplete(plan)),
      "docs-only": String(plan.event.kind === "docs-only"),
      "none-required": String(running.length === 0),
    },
    lanes: plan.lanes.map(({ lane, decision }) => [lane.name, decision.kind] as const),
  };
}

function pathsOf(routing: Routing) {
  return routing.kind === "empty" ? [] : routing.paths;
}

function shortRevision(revision: string | null): string {
  if (revision === null) return "none";
  return /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision;
}

export function headerLine(plan: Plan): string {
  const files = pathsOf(plan.event).length;
  return [
    `mode ${plan.mode}`,
    `base ${shortRevision(plan.event.range.base)}`,
    `head ${shortRevision(plan.event.range.head)}`,
    `${fileCount(files)}${plan.event.kind === "incomplete" ? " listed" : ""}`,
    isComplete(plan) ? "complete" : "incomplete",
    plan.event.kind === "docs-only" ? "docs-only" : "not docs-only",
  ].join(", ");
}

export function summaryMarkdown(plan: Plan): string {
  const cell = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ");
  const rows = plan.lanes.map(
    (planned) => `| ${cell(planned.lane.name)} | ${planned.decision.kind} | ${cell(reasonLine(planned))} |`,
  );
  return [
    "### lane-router",
    "",
    headerLine(plan),
    "",
    "| Lane | Decision | Reason |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Aligned columns. A row's last cell is never padded, so it does not widen its column. */
function table(rows: readonly (readonly string[])[]): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.slice(0, -1).forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

function placementLabel(placement: Placement): string {
  switch (placement.kind) {
    case "config":
    case "docs":
    case "unmatched":
      return placement.kind;
    case "package":
      return `package ${placement.package}`;
    case "row": {
      const { index, target } = placement.row;
      return target.kind === "packages"
        ? `paths[${String(index)}] ${target.packages.join(", ")} via ${target.via}`
        : `paths[${String(index)}]`;
    }
    default: {
      const _exhaustive: never = placement;
      return _exhaustive;
    }
  }
}

function placementLanes(routing: Routing, placement: Placement): string {
  const lanes = [...placement.reach.keys()].join(", ") || "no lane";
  return isCounted(routing, placement) ? lanes : `${lanes} (not counted in a docs-only change)`;
}

export function explainText(plan: Plan): string {
  const lanes = table([
    ["lane", "decision", "reason"],
    ...plan.lanes.map((planned) => [planned.lane.name, planned.decision.kind, reasonLine(planned)]),
  ]);
  const { event } = plan;
  const placed = pathsOf(event);
  const paths = table(
    placed.flatMap(({ path, placements }) => [
      [path],
      ...placements.map((placement) => [
        `  ${placementLabel(placement)}`,
        placementLanes(event, placement),
        placement.kind === "row" ? placement.row.why : "",
      ]),
    ]),
  );
  return [headerLine(plan), "", ...lanes, "", ...pathsSection(event, paths)].join("\n");
}

function pathsSection(event: Routing, paths: readonly string[]): readonly string[] {
  if (event.kind === "empty") return ["no changed files"];
  if (event.kind !== "incomplete") return paths;
  const failed = `fail closed, ${describeCause(event.cause)}.`;
  return paths.length === 0 ? [failed] : [`${failed} The listed paths below decide nothing.`, "", ...paths];
}

/** The `--json` document. Declared field by field, so the internal Plan can change without breaking scripts. */
export interface PlanJson {
  readonly mode: Mode;
  readonly base: string | null;
  readonly head: string;
  readonly files: number;
  readonly complete: boolean;
  readonly docsOnly: boolean;
  readonly noneRequired: boolean;
  readonly incomplete: IncompleteCause | null;
  readonly lanes: readonly LaneJson[];
  readonly paths: readonly { readonly path: string; readonly placements: readonly PlacementJson[] }[];
}

export type LaneJson = {
  readonly lane: string;
  readonly base: string | null;
  /** The last-green proof commit the lane was decided against, or null. */
  readonly since: string | null;
  readonly reason: string;
} & (
  | { readonly decision: "run"; readonly because: readonly RunReasonJson[] }
  | { readonly decision: "skip"; readonly because: SkipReason }
);

export type PlacementJson = { readonly lanes: readonly string[] } & (
  | { readonly kind: "config" | "docs" | "unmatched" }
  | { readonly kind: "row"; readonly row: number; readonly why: string }
  | { readonly kind: "package"; readonly package: string }
);

export type RunReasonJson =
  | {
      readonly kind: "placement";
      readonly path: string;
      readonly placement: PlacementJson;
      readonly through: readonly string[];
      readonly counted: boolean;
    }
  | { readonly kind: "floor" }
  | { readonly kind: "incomplete"; readonly cause: IncompleteCause }
  | { readonly kind: "no-proof"; readonly depth: number };

function placementJson(placement: Placement): PlacementJson {
  const lanes = [...placement.reach.keys()];
  switch (placement.kind) {
    case "config":
    case "docs":
    case "unmatched":
      return { kind: placement.kind, lanes };
    case "row":
      return { kind: "row", row: placement.row.index, why: placement.row.why, lanes };
    case "package":
      return { kind: "package", package: placement.package, lanes };
    default: {
      const _exhaustive: never = placement;
      return _exhaustive;
    }
  }
}

function reasonJson(routing: Routing, reason: RunReason): RunReasonJson {
  switch (reason.kind) {
    case "placement":
      return {
        kind: "placement",
        path: reason.path,
        placement: placementJson(reason.placement),
        through: reason.through.kind === "reads" ? reason.through.chain : [],
        counted: isCounted(routing, reason.placement),
      };
    case "floor":
    case "incomplete":
    case "no-proof":
      return reason;
    default: {
      const _exhaustive: never = reason;
      return _exhaustive;
    }
  }
}

export function explainJson(plan: Plan): string {
  const { event } = plan;
  const lanes = plan.lanes.map((planned): LaneJson => {
    const { decision, since } = planned;
    const common = {
      lane: planned.lane.name,
      base: baseOf(plan, planned),
      since: since?.range.base ?? null,
      reason: reasonLine(planned),
    };
    return decision.kind === "run"
      ? { ...common, decision: "run", because: decision.because.map((reason) => reasonJson(since ?? event, reason)) }
      : { ...common, decision: "skip", because: decision.because };
  });
  const json: PlanJson = {
    mode: plan.mode,
    base: event.range.base,
    head: event.range.head,
    files: pathsOf(event).length,
    complete: isComplete(plan),
    docsOnly: event.kind === "docs-only",
    noneRequired: lanes.every((lane) => lane.decision === "skip"),
    incomplete: event.kind === "incomplete" ? event.cause : null,
    lanes,
    paths: pathsOf(event).map(({ path, placements }) => ({ path, placements: placements.map(placementJson) })),
  };
  return JSON.stringify(json, null, 2);
}

export interface Notice {
  readonly level: "error" | "warning";
  readonly message: string;
}

export function notices(plan: Plan): readonly Notice[] {
  const causes = new Map<string, IncompleteCause>();
  for (const routing of [plan.event, ...plan.lanes.map(({ since }) => since)]) {
    if (routing?.kind === "incomplete") causes.set(JSON.stringify(routing.cause), routing.cause);
  }
  return [...causes.values()].map((cause) => ({
    level: cause.kind === "error" ? "error" : "warning",
    message: `lane-router could not trust a file list, so every lane decided from it runs: ${describeCause(cause)}`,
  }));
}
