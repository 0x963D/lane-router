import { describe, expect, it } from "vitest";
import { runAction } from "./support/action.ts";
import { compare, fakeGitHub, type CompareFile, type FakeGitHub } from "./support/fake-github.ts";
import { fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture, type GitFixture } from "./support/git-fixture.ts";
import { CONFIG } from "./support/model.ts";

const ACME = fixtureDir("acme");
const UI_FILE = "packages/ui/feature/item.ts";
const API_MANIFEST = "packages/api/package.json";
const API_PATH_RULE = "UI files also affect the API lane.";
const LANES = ["ui", "api"];

const scenarios = [
  "file move",
  "directory rename",
  "dependency edge",
  "routing config",
  "older payload base",
  "newer payload base",
] as const;

type Scenario = (typeof scenarios)[number];

function history(scenario: Scenario) {
  const repo = gitFixture(ACME, tempDir());
  repo.write(
    CONFIG,
    'lanes:\n  ui:\n    packages: ["@acme/ui"]\n  api:\n    packages: ["@acme/api"]\nunmatched: all\n',
  );
  repo.write(UI_FILE, "export const item = 1;\n");
  const fork = repo.commit("Seed lane inputs");
  repo.git("switch", "-c", "patch");
  if (scenario === "directory rename") {
    repo.write("packages/ui/feature/new.ts", "export const added = 1;\n");
  } else {
    repo.write(UI_FILE, "export const item = 2;\n");
  }
  const head = repo.commit("Edit the UI package");

  repo.git("switch", "main");
  switch (scenario) {
    case "file move":
      repo.move(UI_FILE, "packages/api/feature/item.ts");
      break;
    case "directory rename":
      repo.move("packages/ui/feature", "packages/api/feature");
      break;
    case "dependency edge":
      repo.write(API_MANIFEST, '{"name":"@acme/api","dependencies":{"@acme/ui":"workspace:*"}}\n');
      break;
    case "routing config":
      repo.write(
        CONFIG,
        repo.git("show", `HEAD:${CONFIG}`) +
          `\npaths:\n  - match: ["packages/ui/feature/**"]\n    lanes: [api]\n    why: ${API_PATH_RULE}\n`,
      );
      break;
    case "older payload base":
    case "newer payload base":
      repo.write("packages/api/before-merge.ts", "export const beforeMerge = 1;\n");
      break;
  }
  const firstParent = repo.commit("Advance the base");
  repo.git("-c", "merge.directoryRenames=true", "merge", "--no-ff", "--no-edit", "patch");
  const merge = repo.git("rev-parse", "HEAD");
  const testedPath = scenario === "file move" ? "packages/api/feature/item.ts" : "packages/api/feature/new.ts";
  if (scenario === "file move" || scenario === "directory rename") {
    expect(diffPaths(repo, firstParent, merge)).toEqual([testedPath]);
  }

  repo.git("switch", "main");
  repo.git("switch", "-c", "newer-base", firstParent);
  repo.write("packages/api/after-merge.ts", "export const afterMerge = 1;\n");
  const newerBase = repo.commit("Advance the base beyond the test merge");
  const base = scenario === "older payload base" ? fork : scenario === "newer payload base" ? newerBase : firstParent;
  repo.git("switch", "-c", "custom", firstParent);
  repo.write("packages/api/custom.ts", "export const custom = 1;\n");
  const custom = repo.commit("Create a different checkout");
  return { repo, base, firstParent, head, merge, custom };
}

function diffPaths(repo: GitFixture, base: string, head: string) {
  return repo.git("diff", "--name-only", "--no-renames", base, head).split("\n").filter(Boolean);
}

function compareFromGit(github: FakeGitHub, repo: GitFixture, base: string, head: string) {
  const mergeBase = repo.git("merge-base", base, head);
  const status =
    base === head ? "identical" : mergeBase === base ? "ahead" : mergeBase === head ? "behind" : "diverged";
  const files = repo
    .git("diff", "--name-status", "--find-renames", mergeBase, head)
    .split("\n")
    .filter(Boolean)
    .map((line): CompareFile => {
      const [status, from, to] = line.split("\t");
      if (status === undefined || from === undefined) throw new Error(`Invalid fixture diff row ${line}`);
      return to === undefined
        ? { filename: from, status }
        : { filename: to, previous_filename: from, status: "renamed" };
    });
  compare(github, base, head, files, { status, mergeBase });
  return files.length;
}

function affectedLanes(repo: GitFixture, base: string, head: string, paths: readonly string[]) {
  if (paths.includes(CONFIG)) return LANES;
  const uiChanged = paths.some((path) => path.startsWith("packages/ui/"));
  const apiChanged = paths.some((path) => path.startsWith("packages/api/"));
  const apiReadsUi = [base, head].some(
    (ref) =>
      repo.git("show", `${ref}:${API_MANIFEST}`).includes('"@acme/ui"') ||
      repo.git("show", `${ref}:${CONFIG}`).includes(API_PATH_RULE),
  );
  return [uiChanged ? "ui" : "", apiChanged || (uiChanged && apiReadsUi) ? "api" : ""].filter(Boolean);
}

describe("a pull request plans the tested tree", () => {
  it.each(scenarios)("%s", async (scenario) => {
    const { repo, base, firstParent, head, merge, custom } = history(scenario);
    const github = await fakeGitHub();
    const changedFiles = compareFromGit(github, repo, base, head);
    for (const compareBase of new Set([base, firstParent])) {
      for (const tree of [merge, head, custom]) compareFromGit(github, repo, compareBase, tree);
    }
    const event = {
      name: "pull_request",
      payload: { pull_request: { base: { sha: base }, head: { sha: head }, changed_files: changedFiles } },
    };

    for (const [checkout, tree] of Object.entries({ merge, head, custom })) {
      repo.git("switch", "--detach", tree);
      for (const [baseInput, headInput, filesInput] of [
        [false, false, false],
        [true, false, false],
        [false, true, false],
        [true, true, false],
        [false, false, true],
        [true, false, true],
        [false, true, true],
        [true, true, true],
      ]) {
        const compareBase = baseInput ? firstParent : base;
        const diffBase = checkout === "head" && compareBase === base ? repo.git("merge-base", base, tree) : compareBase;
        const paths = diffPaths(repo, diffBase, tree);
        const label = `${checkout}, base=${String(baseInput)} head=${String(headInput)} files=${String(filesInput)}`;
        const run = await runAction({
          workspace: repo.dir,
          event,
          github,
          sha: merge,
          process: "in-process",
          inputs: {
            ...(baseInput ? { base: compareBase } : {}),
            ...(headInput ? { head: tree } : {}),
            ...(filesInput ? { files: paths.join("\n") } : {}),
          },
        });
        for (const lane of affectedLanes(repo, diffBase, tree, paths)) {
          expect.soft(run.outputs[lane], `${label}, ${lane}`).toBe("run");
        }
      }
    }
  });
});
