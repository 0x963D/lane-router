import { runCli, type ExitCode } from "../../src/cli.ts";

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
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}
