import { runCli, type ExitCode } from "../../src/cli.ts";
import type { PlanJson } from "../../src/render.ts";

export interface CliRun {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI in this process with `cwd` as its working directory, capturing both streams. */
export async function cli(args: readonly string[], cwd: string): Promise<CliRun> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(args, {
    cwd,
    stdout: (text) => {
      stdout.push(text);
    },
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

/** `lane-router explain --json` for the range, run at `cwd`. Throws unless it printed a plan. */
export async function explainJson(base: string, head: string, cwd: string): Promise<PlanJson> {
  const run = await cli(["explain", "--base", base, "--head", head, "--json"], cwd);
  if (run.code !== 0) throw new Error(`explain exited with ${String(run.code)}: ${run.stderr}`);
  const json: unknown = JSON.parse(run.stdout);
  if (!isPlanJson(json)) throw new Error(`explain printed something other than a plan: ${run.stdout}`);
  return json;
}

/** The CLI prints the document from the PlanJson type, so checking its two lists is enough here. */
function isPlanJson(value: unknown): value is PlanJson {
  return (
    typeof value === "object" &&
    value !== null &&
    "lanes" in value &&
    Array.isArray(value.lanes) &&
    "paths" in value &&
    Array.isArray(value.paths)
  );
}

export function runningLanes(plan: PlanJson): string[] {
  return plan.lanes.filter((lane) => lane.decision === "run").map(({ lane }) => lane);
}
