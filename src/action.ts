import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as core from "@actions/core";
import { directoryTree } from "./adapters/directory.ts";
import { gitRepo } from "./adapters/git.ts";
import { githubRepo, readEvent, type GitHubEvent } from "./adapters/github.ts";
import { changedFiles, type ChangedFiles, type ChangeSource, type Range } from "./core/change.ts";
import { planLanes, type Mode, type Plan, type PlanRequest } from "./core/plan.ts";
import { formatProblems, loadModel } from "./load/index.ts";
import { actionOutputs, notices, summaryMarkdown } from "./render.ts";
import { err, isNonEmpty, messageOf, ok, type NonEmpty, type Result } from "./result.ts";

/*
 * The Action shell. Before a model exists, lane names are unknown, so any failure fails the step
 * and the failed plan job keeps the build red. After, `planLanes` is total, so every failure is a
 * plan in which every lane runs and the step succeeds.
 */

/** The inputs `action.yml` declares. Defaults live only there, where the runner applies them. */
export const INPUT_NAMES = ["config", "working-directory", "base", "head", "files", "token", "mode"] as const;

type InputName = (typeof INPUT_NAMES)[number];

interface Invocation {
  /** Absolute `working-directory`: the routed root. */
  readonly root: string;
  readonly config: string;
  readonly mode: Mode;
  readonly range: Range;
  readonly source:
    | { readonly kind: "files"; readonly files: ChangedFiles }
    /** `expectedCount` is the pull request's `changed_files` when the range is the event's own. */
    | { readonly kind: "compare"; readonly expectedCount: number | null };
  readonly github: { readonly apiUrl: string; readonly repository: string; readonly token: string };
}

export async function runAction(): Promise<void> {
  try {
    const invocation = readInvocation((name) => core.getInput(name), process.env);
    if (!invocation.ok) {
      core.setFailed(invocation.error.join("\n"));
      return;
    }
    const model = await loadModel(directoryTree(invocation.value.root), invocation.value.config);
    if (!model.ok) {
      core.setFailed(formatProblems(model.error));
      return;
    }
    await publish(await planLanes(model.value, requestFor(invocation.value)));
  } catch (error) {
    core.setFailed(messageOf(error));
  }
}

/** Reads every input and the event, and reports every usage problem at once. */
function readInvocation(
  input: (name: InputName) => string,
  env: NodeJS.ProcessEnv,
): Result<Invocation, NonEmpty<string>> {
  const problems: string[] = [];
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const event = readEventFile(eventName, env.GITHUB_EVENT_PATH);
  if (!event.ok) problems.push(...event.error);
  const known: GitHubEvent = event.ok ? event.value : { kind: "other", name: eventName };

  const mode = modeOf(input("mode"), known);
  if (!mode.ok) problems.push(mode.error);

  const fromEvent = eventRange(known);
  const base = input("base") === "" ? fromEvent.base : input("base");
  const head = input("head") === "" ? (fromEvent.head ?? env.GITHUB_SHA ?? "") : input("head");
  const files = input("files");
  if (files === "") {
    if (base === undefined) problems.push(`base is required for a ${eventName || "manual"} event unless files is set`);
    if (head === "") problems.push(`head is required for a ${eventName || "manual"} event unless files is set`);
    if ((env.GITHUB_REPOSITORY ?? "") === "")
      problems.push("GITHUB_REPOSITORY is not set, so the compare API cannot be called");
  }

  if (!isNonEmpty(problems) && mode.ok) {
    const ownRange = input("base") === "" && input("head") === "";
    return ok({
      root: resolve(input("working-directory")),
      config: input("config"),
      mode: mode.value,
      range: { base: base ?? null, head },
      source:
        files === ""
          ? { kind: "compare", expectedCount: known.kind === "pull_request" && ownRange ? known.changedFiles : null }
          : { kind: "files", files: changedFiles(lines(files).map((path) => ({ path, previousPath: null }))) },
      github: {
        apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
        repository: env.GITHUB_REPOSITORY ?? "",
        token: input("token"),
      },
    });
  }
  return err(isNonEmpty(problems) ? problems : ["the inputs are not valid"]);
}

function readEventFile(name: string, path: string | undefined): Result<GitHubEvent, NonEmpty<string>> {
  if (path === undefined || path === "") return readEvent(name, {});
  try {
    const payload: unknown = JSON.parse(readFileSync(path, "utf8"));
    return readEvent(name, payload);
  } catch (error) {
    return err([`cannot read the event payload at ${path}: ${messageOf(error)}`]);
  }
}

function modeOf(value: string, event: GitHubEvent): Result<Mode, string> {
  if (value === "pr" || value === "push") return ok(value);
  if (value !== "") return err(`mode must be pr or push, not ${value}`);
  if (event.kind === "pull_request") return ok("pr");
  if (event.kind === "push") return ok("push");
  return err(`mode is required for a ${event.name || "manual"} event`);
}

/** `base` is undefined when the event has none, and null when it has one that cannot be compared. */
function eventRange(event: GitHubEvent): {
  readonly base: string | null | undefined;
  readonly head: string | undefined;
} {
  switch (event.kind) {
    case "pull_request":
      return { base: event.base, head: event.head };
    case "push":
      return { base: event.before, head: event.after };
    case "other":
      return { base: undefined, head: undefined };
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Builds closures only. Every read happens inside `planLanes`, where a failure fails closed. */
function requestFor(invocation: Invocation): PlanRequest {
  const { source, mode, range } = invocation;
  const github = githubRepo(invocation.github);
  const under = (): Promise<string> =>
    relative(process.cwd(), invocation.root) === "" ? Promise.resolve("") : gitRepo(invocation.root).prefix();
  const changes: ChangeSource =
    source.kind === "files"
      ? () => Promise.resolve(source.files)
      : async (requested) => github.compare(requested, { expectedCount: source.expectedCount, under: await under() });
  return { mode, range, changes };
}

/** Renders everything before the first write, so a rendering bug cannot leave half the outputs set. */
async function publish(plan: Plan): Promise<void> {
  const outputs = actionOutputs(plan);
  const summary = summaryMarkdown(plan);
  const annotations = notices(plan);
  for (const [name, value] of Object.entries(outputs.fixed)) core.setOutput(name, value);
  for (const [lane, decision] of outputs.lanes) core.setOutput(lane, decision);
  for (const { level, message } of annotations) {
    if (level === "error") core.error(message);
    else core.warning(message);
  }
  await core.summary.addRaw(summary).write();
}
