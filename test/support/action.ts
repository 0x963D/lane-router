import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { tempDir } from "./fixtures.ts";
import { REPOSITORY, type FakeGitHub } from "./fake-github.ts";

/*
 * Runs the Action the way the runner does: a separate Node process with INPUT_* and GITHUB_* set,
 * every input default filled in from action.yml, and outputs read back from the files @actions/core wrote.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY = join(ROOT, "src/bin/action.ts");

export interface ActionRun {
  readonly exitCode: number | null;
  readonly outputs: Readonly<Record<string, string>>;
  readonly summary: string;
  readonly annotations: readonly { readonly level: string; readonly message: string }[];
}

export interface ActionEvent {
  readonly name: string;
  readonly payload: unknown;
}

function isMapping(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a JSON output that holds an object, such as `matrix` or `reasons`. */
export function jsonObject(text: string | undefined): Readonly<Record<string, unknown>> {
  return mapping(JSON.parse(text ?? "null"), "the output");
}

function mapping(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (!isMapping(value)) throw new Error(`${what} is not a mapping`);
  return value;
}

export function actionYml() {
  const root = mapping(parse(readFileSync(join(ROOT, "action.yml"), "utf8")), "action.yml");
  return {
    inputs: mapping(root.inputs, "inputs"),
    outputs: mapping(root.outputs, "outputs"),
    runs: mapping(root.runs, "runs"),
  };
}

function defaultOf(spec: unknown, name: string): string {
  const fallback = mapping(spec, `input ${name}`).default;
  return typeof fallback === "string" ? fallback : "";
}

/** What the runner puts in a default of `${{ github.token }}`. */
const RUNNER_TOKEN = "token-from-the-runner";

/** `workspace` is the checkout the runner starts the Action in. `working-directory` is relative to it. */
export async function runAction(options: {
  readonly workspace: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly event: ActionEvent;
  readonly github?: FakeGitHub;
}): Promise<ActionRun> {
  const scratch = tempDir();
  const files = {
    output: join(scratch, "output"),
    summary: join(scratch, "summary"),
    event: join(scratch, "event.json"),
  };
  writeFileSync(files.output, "");
  writeFileSync(files.summary, "");
  writeFileSync(files.event, JSON.stringify(options.event.payload));

  const inputs: Record<string, string> = {};
  for (const [name, spec] of Object.entries(actionYml().inputs)) {
    inputs[name] = defaultOf(spec, name).replace("${{ github.token }}", RUNNER_TOKEN);
  }
  Object.assign(inputs, options.inputs);

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^(INPUT_|GITHUB_|RUNNER_|ACTIONS_)/.test(key)) env[key] = value;
  }
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  Object.assign(env, {
    GITHUB_WORKSPACE: options.workspace,
    GITHUB_EVENT_NAME: options.event.name,
    GITHUB_EVENT_PATH: files.event,
    GITHUB_OUTPUT: files.output,
    GITHUB_STEP_SUMMARY: files.summary,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_SHA: "f".repeat(40),
    GITHUB_API_URL: options.github?.url ?? "http://127.0.0.1:9",
  });

  const { exitCode, stdout } = await node(ENTRY, { cwd: options.workspace, env });
  return {
    exitCode,
    outputs: parseOutputs(readFileSync(files.output, "utf8")),
    summary: readFileSync(files.summary, "utf8"),
    annotations: parseAnnotations(stdout),
  };
}

function node(entry: string, options: { readonly cwd: string; readonly env: Record<string, string> }) {
  return new Promise<{ readonly exitCode: number | null; readonly stdout: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { cwd: options.cwd, env: options.env });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/** The runner's file command format: `name<<delimiter`, the value, then the delimiter. */
function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  for (const match of text.matchAll(/^(.+?)<<(ghadelimiter_[\w-]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm)) {
    const [, name, , value] = match;
    if (name !== undefined && value !== undefined) outputs[name] = value;
  }
  return outputs;
}

function parseAnnotations(stdout: string) {
  return stdout.split(/\r?\n/).flatMap((line) => {
    const match = /^::(error|warning|notice)[^:]*::(.*)$/.exec(line);
    const level = match?.[1];
    const message = match?.[2];
    if (level === undefined || message === undefined) return [];
    return [{ level, message: message.replaceAll("%0A", "\n").replaceAll("%0D", "\r").replaceAll("%25", "%") }];
  });
}
