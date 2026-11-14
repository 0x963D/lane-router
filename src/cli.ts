import { parseArgs } from "node:util";
import { gitRepo } from "./adapters/git.ts";
import { planLanes } from "./core/plan.ts";
import { baseGraphOf, formatProblems, loadModel } from "./load/index.ts";
import { explainJson, explainText } from "./render.ts";
import { err, messageOf, ok, type Result } from "./result.ts";

/*
 * `lane-router explain` makes the decisions the Action would make in PR mode, for a local diff. It
 * reads the config and the workspace at `--head`, not from the working tree.
 */

/**
 * 0: a plan or the usage was printed, fail-closed plans included. 1: the config or the workspace did not
 * load. 2: a usage error.
 */
export type ExitCode = 0 | 1 | 2;

export interface CliIo {
  readonly cwd: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export const USAGE = "usage: lane-router explain --base <ref> --head <ref> [--config <path>] [--cwd <dir>] [--json]";

interface Invocation {
  readonly base: string;
  readonly head: string;
  readonly config: string;
  readonly cwd: string | undefined;
  readonly json: boolean;
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  const invocation = parse(argv);
  if (!invocation.ok) {
    io.stderr(`${invocation.error}\n${USAGE}`);
    return 2;
  }
  if (invocation.value === "help") {
    io.stdout(USAGE);
    return 0;
  }
  const { config, json } = invocation.value;
  const repo = gitRepo(invocation.value.cwd ?? io.cwd);
  const [base, head] = await Promise.all([repo.resolve(invocation.value.base), repo.resolve(invocation.value.head)]);
  if (base === undefined || head === undefined) {
    const unknown = base === undefined ? `--base ${invocation.value.base}` : `--head ${invocation.value.head}`;
    io.stderr(`${unknown} does not name a commit in this repository\n${USAGE}`);
    return 2;
  }
  try {
    const tree = repo.treeAt(head);
    const model = await loadModel(tree, config);
    if (!model.ok) {
      io.stderr(formatProblems(model.error));
      return 1;
    }
    const plan = await planLanes(model.value, {
      mode: "pr",
      range: { base, head },
      changes: repo.changes,
      baseGraph: baseGraphOf(tree, config, repo),
    });
    io.stdout(json ? explainJson(plan) : explainText(plan));
    return 0;
  } catch (error) {
    io.stderr(messageOf(error));
    return 1;
  }
}

function parse(argv: readonly string[]): Result<Invocation | "help", string> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        base: { type: "string" },
        head: { type: "string" },
        config: { type: "string", default: ".github/lanes.yml" },
        cwd: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    return err(messageOf(error));
  }
  const { values, positionals } = parsed;
  if (values.help) return ok("help");
  if (positionals.length !== 1 || positionals[0] !== "explain") return err("the only command is explain");
  if (values.base === undefined || values.head === undefined) return err("--base and --head are required");
  return ok({ base: values.base, head: values.head, config: values.config, cwd: values.cwd, json: values.json });
}
