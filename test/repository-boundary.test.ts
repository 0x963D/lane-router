import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { directoryTree } from "../src/adapters/directory.ts";
import { loadModel } from "../src/load/index.ts";
import { runAction, type ActionEvent } from "./support/action.ts";
import { cli } from "./support/cli.ts";
import { fakeGitHub } from "./support/fake-github.ts";
import { fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture } from "./support/git-fixture.ts";
import { CONFIG, problemsOf } from "./support/model.ts";

/*
 * A pull request controls every file lane-router reads, and the Action may run in a privileged
 * workflow. Nothing outside the repository may be read, and no error may quote a file.
 */

const SENTINEL = "Q7sentinel";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PULL_REQUEST: ActionEvent = {
  name: "pull_request",
  payload: { pull_request: { base: { sha: BASE }, head: { sha: HEAD }, changed_files: 1 } },
};

/** Windows grants the right to create a symbolic link only to some accounts. Junctions need no right. */
function canSymlink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "lane-router-probe-"));
  try {
    writeFileSync(join(dir, "target"), "");
    symlinkSync(join(dir, "target"), join(dir, "link"), "file");
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SYMLINKS = canSymlink();

const ACME = fixtureDir("acme");

/** A root at `<parent>/repo`, not yet created, beside `<parent>/outside`, which holds what it must not read. */
function besideSecrets(): { readonly root: string; readonly outside: string } {
  const parent = tempDir();
  const outside = join(parent, "outside");
  mkdirSync(outside);
  return { root: join(parent, "repo"), outside };
}

function acmeBesideSecrets(): { readonly root: string; readonly outside: string } {
  const layout = besideSecrets();
  cpSync(ACME, layout.root, { recursive: true });
  return layout;
}

async function loadProblems(root: string, config = CONFIG) {
  const loaded = await loadModel(directoryTree(root), config);
  if (loaded.ok) throw new Error("expected the model not to load");
  return loaded.error;
}

function problemLines(problems: readonly { readonly file: string; readonly message: string }[]): string[] {
  return problems.map(({ file, message }) => `${file}  ${message}`);
}

describe("the directory tree", () => {
  it.runIf(SYMLINKS)("refuses a package manifest that is a symbolic link, wherever it points", async () => {
    const { root, outside } = besideSecrets();
    writeFileSync(join(outside, "secret.json"), SENTINEL);
    const repo = gitFixture(ACME, root);
    rmSync(join(root, "packages/api/package.json"));
    symlinkSync(join(outside, "secret.json"), join(root, "packages/api/package.json"));
    const head = repo.commit("Point the api manifest outside the repository");

    const problems = await loadProblems(root);
    expect(problemLines(problems)).toEqual(["packages/api/package.json  is a symbolic link"]);

    const run = await runAction({ workspace: root, inputs: { files: "README.md" }, event: PULL_REQUEST });
    expect(run.exitCode).toBe(1);
    expect(run.annotations.map(({ message }) => message)).toEqual(["packages/api/package.json  is a symbolic link"]);

    const explained = await cli(["explain", "--base", repo.base, "--head", head], root);
    expect(explained.code).toBe(1);
    expect(explained.stderr).toBe("packages/api/package.json  is a symbolic link");

    expect(JSON.stringify({ problems, run, explained })).not.toContain(SENTINEL);
  });

  it("refuses a file under a linked directory that resolves outside the root", async () => {
    const { root, outside } = acmeBesideSecrets();
    mkdirSync(join(outside, "github"));
    writeFileSync(join(outside, "github/lanes.yml"), `lanes: *${SENTINEL}\n`);
    rmSync(join(root, ".github"), { recursive: true });
    symlinkSync(join(outside, "github"), join(root, ".github"), "junction");

    const problems = await loadProblems(root);
    expect(problemLines(problems)).toEqual([".github/lanes.yml  resolves outside the repository root"]);

    const run = await runAction({ workspace: root, inputs: { files: "README.md" }, event: PULL_REQUEST });
    expect(run.exitCode).toBe(1);
    expect(run.outputs).toEqual({});
    expect(run.annotations.map(({ message }) => message)).toEqual([
      ".github/lanes.yml  resolves outside the repository root",
    ]);
    expect(JSON.stringify({ problems, run })).not.toContain(SENTINEL);
  });

  it.each([
    ["../secret.yml", "../secret.yml  is not a path inside the repository"],
    ["..\\secret.yml", "..\\secret.yml  contains a backslash, which is not a path separator in a repository"],
  ])("fails the step for the config input %s without reading it", async (config, expected) => {
    const { root } = acmeBesideSecrets();
    writeFileSync(join(root, "../secret.yml"), `lanes: *${SENTINEL}\n`);

    const run = await runAction({ workspace: root, inputs: { config, files: "README.md" }, event: PULL_REQUEST });
    expect(run.exitCode).toBe(1);
    expect(run.outputs).toEqual({});
    expect(run.annotations.map(({ message }) => message)).toEqual([expected]);
    expect(JSON.stringify(run)).not.toContain(SENTINEL);
  });

  it("rejects a workspace glob that reaches outside the root", async () => {
    const { root, outside } = acmeBesideSecrets();
    mkdirSync(join(outside, "pkg"));
    writeFileSync(join(outside, "pkg/package.json"), JSON.stringify({ name: SENTINEL }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "../outside/*"\n');

    const problems = await loadProblems(root);
    expect(problems.map(({ file, at, where, message }) => ({ file, at, where, message }))).toEqual([
      {
        file: "pnpm-workspace.yaml",
        at: { line: 3, column: 5 },
        where: "packages[1]",
        message: "a glob cannot reach outside the repository root",
      },
    ]);

    const run = await runAction({ workspace: root, inputs: { files: "README.md" }, event: PULL_REQUEST });
    expect(run.exitCode).toBe(1);
    expect(run.annotations[0]?.message).toContain("a glob cannot reach outside the repository root");
    expect(JSON.stringify({ problems, run })).not.toContain(SENTINEL);
  });
});

describe("the git tree", () => {
  it.each([
    ["a symbolic link", "120000", "is a symbolic link"],
    ["a submodule", "160000", "is a git submodule"],
  ])("refuses a package manifest committed as %s", async (_, mode, reason) => {
    const repo = gitFixture(ACME, tempDir());
    const target = join(repo.dir, "link-target");
    writeFileSync(target, SENTINEL);
    const object = mode === "160000" ? repo.base : repo.git("hash-object", "-w", target);
    rmSync(target);
    repo.git("update-index", "--cacheinfo", `${mode},${object},packages/api/package.json`);
    repo.git("commit", "--quiet", "--message", `Commit the api manifest as ${mode}`);
    const head = repo.git("rev-parse", "HEAD");

    const explained = await cli(["explain", "--base", repo.base, "--head", head], repo.dir);
    expect(explained).toEqual({ code: 1, stdout: "", stderr: `packages/api/package.json  ${reason}` });
    expect(JSON.stringify(explained)).not.toContain(SENTINEL);
  });
});

describe("parse errors", () => {
  it.each([
    ["a bare token", `{\n  "name": ${SENTINEL}\n}\n`, null],
    ["a trailing comma", `{\n  "name": "${SENTINEL}",\n}\n`, { line: 3, column: 1 }],
  ])("locate a manifest with %s and never quote it", async (_, text, at) => {
    const problems = await problemsOf("acme", { "packages/ui/package.json": text });
    expect(problems).toEqual([{ file: "packages/ui/package.json", at, where: null, message: "is not valid JSON" }]);
  });

  it("report a YAML syntax error by its position and the parser's error code alone", async () => {
    const problems = await problemsOf("acme", { [CONFIG]: `lanes: |${SENTINEL}\n  x\nunmatched: all\n` });
    expect(problems[0]).toMatchObject({ file: CONFIG, at: { line: 1, column: 9 }, where: null });
    expect(problems[0]?.message).toBe("is not valid YAML: unexpected token");
    for (const problem of problems) {
      expect(problem.at).not.toBeNull();
      expect(problem.message).toMatch(/^is not valid YAML: [a-z ]+$/);
    }
    expect(JSON.stringify(problems)).not.toContain(SENTINEL);
  });

  it.each([
    [CONFIG, `lanes: *${SENTINEL}\nunmatched: all\n`],
    ["pnpm-workspace.yaml", `packages: *${SENTINEL}\n`],
  ])("report an alias with no anchor in %s without quoting it", async (file, text) => {
    const problems = await problemsOf("acme", { [file]: text });
    expect(problems).toEqual([
      { file, at: null, where: null, message: "is not valid YAML: an alias cannot be expanded" },
    ]);
  });

  it("never quote a GitHub response body that is not JSON", async () => {
    const github = await fakeGitHub();
    github.on(`/compare/${BASE}...${HEAD}`, { text: SENTINEL });
    const run = await runAction({ workspace: ACME, event: PULL_REQUEST, github });
    expect(run.exitCode).toBe(0);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations.map(({ message }) => message)).toEqual([
      `lane-router failed closed and selected every lane: GET /compare/${BASE}...${HEAD} returned a body that is not valid JSON`,
    ]);
    expect(JSON.stringify(run)).not.toContain(SENTINEL);
  });

  it("never quote an event payload that is not JSON", async () => {
    const run = await runAction({
      workspace: ACME,
      inputs: { files: "README.md" },
      event: { name: "pull_request", text: SENTINEL },
    });
    expect(run.exitCode).toBe(1);
    expect(run.annotations[0]?.message.split("\n")[0]).toMatch(
      /^cannot read the event payload at .+: it is not valid JSON$/,
    );
    expect(JSON.stringify(run)).not.toContain(SENTINEL);
  });
});
