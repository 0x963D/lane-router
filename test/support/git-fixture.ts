import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/*
 * A real git repository built from a fixture monorepo. The CLI tests and `npm run demo` both use it.
 * The caller owns `dir` and removes it.
 */

export interface GitFixture {
  /** The top of the repository. */
  readonly dir: string;
  /** Where the fixture was copied: `dir`, or a directory below it. */
  readonly root: string;
  /** The SHA of the commit that holds the fixture as copied. */
  readonly base: string;
  git(...args: readonly string[]): string;
  write(path: string, text: string): void;
  remove(path: string): void;
  move(from: string, to: string): void;
  /** Commits everything in the working tree and returns the new SHA. */
  commit(message: string): string;
}

export function gitFixture(source: string, dir: string, options: { readonly at?: string } = {}): GitFixture {
  const root = options.at === undefined ? dir : join(dir, options.at);
  mkdirSync(root, { recursive: true });
  cpSync(source, root, { recursive: true });

  const git = (...args: readonly string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const inRoot = (path: string): string => join(root, path);
  const commit = (message: string): string => {
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "--message", message);
    return git("rev-parse", "HEAD");
  };

  git("init", "--quiet", "--initial-branch=main");
  for (const [key, value] of [
    ["user.name", "lane-router fixture"],
    ["user.email", "fixture@example.invalid"],
    ["commit.gpgsign", "false"],
    ["core.autocrlf", "false"],
  ] as const) {
    git("config", key, value);
  }

  return {
    dir,
    root,
    base: commit("Add the fixture monorepo"),
    git,
    write: (path, text) => {
      mkdirSync(dirname(inRoot(path)), { recursive: true });
      writeFileSync(inRoot(path), text);
    },
    remove: (path) => {
      rmSync(inRoot(path));
    },
    move: (from, to) => {
      mkdirSync(dirname(inRoot(to)), { recursive: true });
      renameSync(inRoot(from), inRoot(to));
    },
    commit,
  };
}
