import { describe, expect, it } from "vitest";
import { runAction, type ActionRun } from "./support/action.ts";
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
  const mergeOptions = scenario === "directory rename" ? ["-c", "merge.directoryRenames=true"] : [];
  repo.git(...mergeOptions, "merge", "--no-ff", "--no-edit", "patch");
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
  return { repo, base, firstParent, head, merge, custom, fork };
}

function diffPaths(repo: GitFixture, base: string, head: string) {
  return repo.git("diff", "--name-only", "--no-renames", base, head).split("\n").filter(Boolean);
}

function compareFromGit(github: FakeGitHub, repo: GitFixture, base: string, head: string, baseRef = base) {
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
  compare(github, baseRef, head, files, { status, mergeBase, baseCommit: base });
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

function expectPrecise(run: ActionRun, lanes: readonly string[], label: string) {
  expect.soft(JSON.parse(run.outputs.lanes ?? "null"), `${label}, selected lanes`).toEqual(lanes);
  expect.soft(run.outputs.complete, `${label}, complete`).toBe("true");
}

function expectAncestryFailure(run: ActionRun, label: string) {
  expect.soft(JSON.parse(run.outputs.lanes ?? "null"), `${label}, selected lanes`).toEqual(LANES);
  expect.soft(run.outputs.complete, `${label}, complete`).toBe("false");
  expect.soft(run.annotations[0]?.message ?? "", `${label}, ancestry error`).toContain("does not extend");
}

// (a) checks the tested tree, (b) needs a resolved directory rename, and (c) checks the new range rules.
describe("a pull request plans the tested tree", () => {
  it.each(scenarios)("%s", async (scenario) => {
    const { repo, base, firstParent, head, merge, custom, fork } = history(scenario);
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
        const diffBase = checkout === "head" ? fork : compareBase;
        const paths = diffPaths(repo, diffBase, tree);
        const kind =
          scenario === "directory rename"
            ? "b"
            : !filesInput &&
                ((checkout === "head" && baseInput && compareBase !== base) ||
                  (scenario === "newer payload base" && checkout === "merge" && headInput && !baseInput))
              ? "c"
              : "a";
        const inputs = `${baseInput ? "B" : ""}${headInput ? "H" : ""}${filesInput ? "F" : ""}` || "default";
        const label = `(${kind}) ${scenario}, pull_request, ${checkout}, ${inputs}`;
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
        const affected = affectedLanes(repo, diffBase, tree, paths);
        for (const lane of affected) {
          expect.soft(run.outputs[lane], `${label}, ${lane}`).toBe("run");
        }
        if (!filesInput && checkout === "head") {
          expectPrecise(run, affected, label);
          expect.soft(run.annotations, `${label}, annotations`).toEqual([]);
        }
        if (checkout === "merge" && inputs === "default") {
          if (scenario === "newer payload base") expectAncestryFailure(run, label);
          else expectPrecise(run, affected, label);
        }
      }
    }

    for (const [checkout, tree] of Object.entries({ base, head, merge })) {
      repo.git("switch", "--detach", tree);
      const run = await runAction({
        workspace: repo.dir,
        event: { ...event, name: "pull_request_target" },
        github,
        sha: base,
        process: "in-process",
      });
      const kind = scenario === "directory rename" ? "b" : "a";
      const label = `(${kind}) ${scenario}, pull_request_target, ${checkout}, default`;
      const diffBase = checkout === "merge" ? base : fork;
      const diffHead = checkout === "base" ? head : tree;
      const affected = affectedLanes(repo, diffBase, tree, diffPaths(repo, diffBase, diffHead));
      for (const lane of affected) {
        expect.soft(run.outputs[lane], `${label}, ${lane}`).toBe("run");
      }
      if (checkout === "merge" && scenario === "newer payload base") {
        expectAncestryFailure(run, label);
      } else {
        expectPrecise(run, affected, label);
      }
      if (checkout === "head") expect.soft(run.annotations, `${label}, annotations`).toEqual([]);
    }
  });

  it.each(["main", "origin/main", "short SHA", "unfetched-base"])(
    "(c) accepts a compare base given as %s",
    async (ref) => {
      const { repo, firstParent, head, merge } = history("file move");
      repo.git("update-ref", "refs/remotes/origin/main", firstParent);
      repo.git("switch", "--detach", merge);
      const base = ref === "short SHA" ? firstParent.slice(0, 8) : ref;
      const github = await fakeGitHub();
      compareFromGit(github, repo, firstParent, merge);
      if (ref !== "origin/main") compareFromGit(github, repo, firstParent, merge, base);
      const run = await runAction({
        workspace: repo.dir,
        event: {
          name: "pull_request",
          payload: { pull_request: { base: { sha: firstParent }, head: { sha: head }, changed_files: 1 } },
        },
        github,
        sha: merge,
        inputs: { base, head: merge },
      });
      expectPrecise(run, ["api"], `(c) ${ref}, pull_request, merge, BH`);
      expect(run.annotations).toEqual([]);
      const requests = ref === "origin/main" ? [base, firstParent] : [base];
      expect(github.requests).toEqual(
        requests.map((revision) => `/repos/acme/mono/compare/${encodeURIComponent(revision)}...${merge}`),
      );
    },
  );
});
