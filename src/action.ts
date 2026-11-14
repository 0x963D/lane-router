import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import * as core from "@actions/core";
import { directoryTree } from "./adapters/directory.ts";
import { gitRepo } from "./adapters/git.ts";
import { githubRepo, readEvent, type GitHubEvent } from "./adapters/github.ts";
import { changedFiles, type ChangedFiles, type ChangeSource, type Range } from "./core/change.ts";
import { planLanes, type Mode, type Plan, type PlanRequest } from "./core/plan.ts";
import {
  allValid,
  decode,
  formatDataPath,
  INVALID,
  literal,
  object,
  refine,
  string,
  type DecodeContext,
  type Decoder,
  type Invalid,
  type Issue,
} from "./decode.ts";
import { formatProblems, loadModel } from "./load/index.ts";
import { actionOutputs, notices, summaryMarkdown } from "./render.ts";
import { err, mapNonEmpty, messageOf, type NonEmpty, type Result } from "./result.ts";

/*
 * The Action shell. Before a model exists, lane names are unknown, so any failure fails the step
 * and the failed plan job keeps the build red. After, `planLanes` is total, so every failure is a
 * plan in which every lane runs and the step succeeds.
 */

/** The inputs `action.yml` declares. Defaults live only there, where the runner applies them. */
export const INPUT_NAMES = [
  "config",
  "working-directory",
  "base",
  "head",
  "files",
  "token",
  "mode",
  "last-green",
  "last-green-depth",
] as const;

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
  /** Set only for `last-green: auto` on a push. */
  readonly lastGreenDepth: number | null;
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

/** Reports every usage problem at once. */
function readInvocation(
  input: (name: InputName) => string,
  env: NodeJS.ProcessEnv,
): Result<Invocation, NonEmpty<string>> {
  const eventName = env.GITHUB_EVENT_NAME ?? "";
  const event = readEventFile(eventName, env.GITHUB_EVENT_PATH);
  const known: GitHubEvent = event.ok ? event.value : { kind: "other", name: eventName };
  const inputs = Object.fromEntries(INPUT_NAMES.map((name) => [name, input(name)]));
  const decoded = decode(invocationDecoder(known, env), inputs);
  if (!event.ok) {
    const problems: NonEmpty<string> = [...event.error, ...(decoded.ok ? [] : decoded.error.map(inputProblem))];
    return err(problems);
  }
  return decoded.ok ? decoded : err(mapNonEmpty(decoded.error, inputProblem));
}

function inputProblem({ path, message }: Issue): string {
  return path.length === 0 ? message : `the ${formatDataPath(path)} input ${message}`;
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

/** An empty input means "use the default", so a choice input accepts "" as absent. */
function blankOr<T>(decoder: Decoder<T>): Decoder<T | undefined> {
  return (input, context) => (input === "" ? undefined : decoder(input, context));
}

const positiveInteger: Decoder<number> = refine(string, (text, context) =>
  /^[1-9][0-9]*$/.test(text) ? Number(text) : context.fail("expected a whole number of at least 1"),
);

const inputsDecoder = object(
  (field) => {
    const fields = {
      config: field("config", string),
      workingDirectory: field("working-directory", string),
      base: field("base", string),
      head: field("head", string),
      files: field("files", string),
      token: field("token", string),
      mode: field("mode", blankOr(literal("pr", "push"))),
      lastGreen: field("last-green", literal("auto", "off")),
      depth: field("last-green-depth", positiveInteger),
    };
    return allValid(fields) ? fields : INVALID;
  },
  { unknownKeys: "reject" },
);

type Inputs = Exclude<ReturnType<typeof inputsDecoder>, Invalid>;

function invocationDecoder(event: GitHubEvent, env: NodeJS.ProcessEnv): Decoder<Invocation> {
  return refine(inputsDecoder, (inputs, context) => toInvocation(inputs, event, env, context));
}

function toInvocation(inputs: Inputs, event: GitHubEvent, env: NodeJS.ProcessEnv, context: DecodeContext) {
  const fromEvent = eventDefaults(event);
  const mode = inputs.mode ?? fromEvent?.mode;
  const base = inputs.base === "" ? fromEvent?.base : inputs.base;
  const head = inputs.head === "" ? (fromEvent?.head ?? env.GITHUB_SHA ?? "") : inputs.head;
  const repository = env.GITHUB_REPOSITORY ?? "";
  const usesApi = inputs.files === "" || (mode === "push" && inputs.lastGreen === "auto");
  const eventText = event.kind === "other" ? `a ${event.name || "manual"} event` : `a ${event.kind} event`;

  const failures = [
    mode === undefined && context.at("mode").fail(`is required for ${eventText}`),
    inputs.files === "" &&
      base === undefined &&
      context.at("base").fail(`is required for ${eventText} unless files is set`),
    inputs.files === "" && head === "" && context.at("head").fail(`is required for ${eventText} unless files is set`),
    inputs.files !== "" &&
      mode === "push" &&
      inputs.lastGreen === "auto" &&
      context
        .at("files")
        .fail(
          "cannot be combined with last-green: auto on a push, which compares each lane's proof commit through the API",
        ),
    usesApi && repository === "" && context.fail("GITHUB_REPOSITORY is not set, so the GitHub API cannot be called"),
  ];
  if (mode === undefined || failures.some((failure) => failure !== false)) return INVALID;

  const ownRange = inputs.base === "" && inputs.head === "";
  return {
    root: resolve(inputs.workingDirectory),
    config: inputs.config,
    mode,
    range: { base: base ?? null, head },
    source:
      inputs.files === ""
        ? { kind: "compare", expectedCount: event.kind === "pull_request" && ownRange ? event.changedFiles : null }
        : { kind: "files", files: changedFiles(lines(inputs.files).map((path) => ({ path, previousPath: null }))) },
    lastGreenDepth: mode === "push" && inputs.lastGreen === "auto" ? inputs.depth : null,
    github: { apiUrl: env.GITHUB_API_URL ?? "https://api.github.com", repository, token: inputs.token },
  } satisfies Invocation;
}

/** The mode and range an event implies. Undefined for an event that carries neither, such as workflow_dispatch. */
function eventDefaults(
  event: GitHubEvent,
): { readonly mode: Mode; readonly base: string | null; readonly head: string } | undefined {
  switch (event.kind) {
    case "pull_request":
      return { mode: "pr", base: event.base, head: event.head };
    case "push":
      return { mode: "push", base: event.before, head: event.after };
    case "other":
      return undefined;
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
  const { source, range, lastGreenDepth } = invocation;
  const github = githubRepo(invocation.github);
  const under = (): Promise<string> =>
    relative(process.cwd(), invocation.root) === "" ? Promise.resolve("") : gitRepo(invocation.root).prefix();
  const changes: ChangeSource =
    source.kind === "files"
      ? () => Promise.resolve(source.files)
      : async (requested) => github.compare(requested, { expectedCount: source.expectedCount, under: await under() });
  if (invocation.mode === "pr") return { mode: "pr", range, changes };
  const lastGreen = lastGreenDepth === null ? null : github.lastGreen({ head: range.head, depth: lastGreenDepth });
  return { mode: "push", range, changes, lastGreen };
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
