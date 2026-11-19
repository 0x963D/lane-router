import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runAction, type ActionRun } from "./support/action.ts";
import { compare, fakeGitHub, type CompareFile, type FakeGitHub } from "./support/fake-github.ts";
import { fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture, type GitFixture } from "./support/git-fixture.ts";
import { CONFIG } from "./support/model.ts";

const ACME = fixtureDir("acme");
const UI_FILE = "packages/ui/feature/item.ts";
const UI_MANIFEST = "packages/ui/package.json";
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

function shallowMerge(repo: GitFixture, merge: string, firstParent: string) {
  const checkout = tempDir();
  repo.git("branch", "test-merge", merge);
  repo.git("clone", "--quiet", "--depth=1", "--branch=test-merge", pathToFileURL(repo.dir).href, checkout);
  repo.git("-C", checkout, "switch", "--detach", merge);
  expect(repo.git("-C", checkout, "rev-parse", "--is-shallow-repository")).toBe("true");
  expect(repo.git("-C", checkout, "rev-list", "--count", "HEAD")).toBe("1");
  expect(() => repo.git("-C", checkout, "cat-file", "-t", firstParent)).toThrow();
  return checkout;
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
    const shallow = shallowMerge(repo, merge, firstParent);

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
        const compareBase = baseInput || (checkout === "merge" && !filesInput) ? firstParent : base;
        const diffBase = checkout === "head" ? fork : compareBase;
        const paths = diffPaths(repo, diffBase, tree);
        const kind =
          scenario === "directory rename"
            ? "b"
            : !filesInput &&
                ((checkout === "head" && baseInput && compareBase !== base) ||
                  (checkout === "merge" && headInput && !baseInput && firstParent !== base))
              ? "c"
              : "a";
        const inputs = `${baseInput ? "B" : ""}${headInput ? "H" : ""}${filesInput ? "F" : ""}` || "default";
        const label = `(${kind}) ${scenario}, pull_request, ${checkout}, ${inputs}`;
        const run = await runAction({
          workspace: checkout === "merge" && inputs === "default" ? shallow : repo.dir,
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
        if (!filesInput && (checkout === "head" || checkout === "merge")) {
          expectPrecise(run, affected, label);
          expect.soft(run.annotations, `${label}, annotations`).toEqual([]);
        }
      }
    }

    for (const [checkout, tree] of Object.entries({ base, head, merge })) {
      repo.git("switch", "--detach", tree);
      const run = await runAction({
        workspace: checkout === "merge" ? shallow : repo.dir,
        event: { ...event, name: "pull_request_target" },
        github,
        sha: base,
        process: "in-process",
      });
      const kind = scenario === "directory rename" ? "b" : "a";
      const label = `(${kind}) ${scenario}, pull_request_target, ${checkout}, default`;
      const diffBase = checkout === "merge" ? firstParent : fork;
      const diffHead = checkout === "base" ? head : tree;
      const affected = affectedLanes(repo, diffBase, tree, diffPaths(repo, diffBase, diffHead));
      for (const lane of affected) {
        expect.soft(run.outputs[lane], `${label}, ${lane}`).toBe("run");
      }
      expectPrecise(run, affected, label);
      expect.soft(run.annotations, `${label}, annotations`).toEqual([]);
    }

    if (scenario === "older payload base") {
      const affected = affectedLanes(repo, base, merge, diffPaths(repo, base, merge));
      for (const name of ["pull_request", "pull_request_target"]) {
        const label = `(c) older payload base, ${name}, merge, explicit older base`;
        const run = await runAction({
          workspace: shallow,
          event: { ...event, name },
          github,
          sha: name === "pull_request" ? merge : base,
          process: "in-process",
          inputs: { base },
        });
        expectPrecise(run, affected, label);
        expect.soft(run.annotations, `${label}, annotations`).toEqual([]);
      }
    }
  });

  it.each(["different second parent", "octopus merge", "single parent"] as const)(
    "(c) falls back to the payload base for a checkout with %s",
    async (shape) => {
      const { repo, base, firstParent, head } = history("older payload base");
      repo.git("switch", "--detach", firstParent);
      repo.write("packages/ui/other.ts", "export const other = 1;\n");
      const side = repo.commit("Edit a different UI path");
      if (shape !== "single parent") {
        repo.git("switch", "--detach", firstParent);
        if (shape === "octopus merge") repo.git("merge", "--no-ff", "--no-edit", head, side);
        else repo.git("merge", "--no-ff", "--no-edit", side);
      }
      const checkout = repo.git("rev-parse", "HEAD");
      const parents = repo.git("show", "-s", "--format=%P", checkout).split(" ");
      expect(parents).toEqual(
        shape === "octopus merge"
          ? [firstParent, head, side]
          : shape === "single parent"
            ? [firstParent]
            : [firstParent, side],
      );
      const github = await fakeGitHub();
      compareFromGit(github, repo, firstParent, checkout);
      compareFromGit(github, repo, base, checkout);
      const changedFiles = compareFromGit(github, repo, base, head);
      const nonAncestor = repo.git("rev-parse", "newer-base");
      compareFromGit(github, repo, nonAncestor, checkout);
      compareFromGit(github, repo, nonAncestor, head);
      const affected = affectedLanes(repo, base, checkout, diffPaths(repo, base, checkout));
      expect(affected).toEqual(LANES);
      for (const name of ["pull_request", "pull_request_target"]) {
        for (const payloadBase of [base, nonAncestor]) {
          const ancestry = payloadBase === base ? "ancestor" : "non-ancestor";
          const label = `(c) ${shape}, ${name}, ${ancestry} fallback`;
          const run = await runAction({
            workspace: repo.dir,
            event: {
              name,
              payload: {
                pull_request: { base: { sha: payloadBase }, head: { sha: head }, changed_files: changedFiles },
              },
            },
            github,
            sha: name === "pull_request" ? checkout : payloadBase,
            process: "in-process",
          });
          if (payloadBase === base) {
            expectPrecise(run, affected, label);
            expect.soft(run.annotations, `${label}, annotations`).toEqual([]);
            expect.soft(github.requests.at(-1), `${label}, compare`).toContain(`/compare/${base}...${checkout}`);
          } else {
            expectAncestryFailure(run, label);
          }
        }
      }
    },
  );

  it("(c) loads the first parent's model when the merge changes a workspace manifest", async () => {
    const { repo, fork } = history("older payload base");
    repo.git("switch", "--detach", fork);
    const manifest = repo.git("show", `HEAD:${API_MANIFEST}`);
    repo.write(API_MANIFEST, '{"name":"@acme/api","dependencies":{"@acme/ui":"workspace:*"}}\n');
    const base = repo.commit("Make API read UI");
    repo.git("switch", "-c", "patch-model");
    repo.write(UI_MANIFEST, '{"name":"@acme/ui","scripts":{"test":"node --test"}}\n');
    const head = repo.commit("Edit the UI manifest");
    repo.git("switch", "--detach", base);
    repo.write(API_MANIFEST, manifest + "\n");
    const firstParent = repo.commit("Remove the API dependency on UI");
    repo.git("merge", "--no-ff", "--no-edit", head);
    const merge = repo.git("rev-parse", "HEAD");
    const github = await fakeGitHub();
    const changedFiles = compareFromGit(github, repo, base, head);
    compareFromGit(github, repo, base, merge);
    compareFromGit(github, repo, firstParent, merge);
    const event = {
      name: "pull_request",
      payload: { pull_request: { base: { sha: base }, head: { sha: head }, changed_files: changedFiles } },
    };
    const full = await runAction({ workspace: repo.dir, event, github, sha: merge, process: "in-process" });
    const label = "(c) manifest change with first-parent model";
    const paths = diffPaths(repo, firstParent, merge);
    expect(paths).toEqual([UI_MANIFEST]);
    expectPrecise(full, affectedLanes(repo, firstParent, merge, paths), label);
    expect.soft(full.annotations, `${label}, annotations`).toEqual([]);

    const workspace = shallowMerge(repo, merge, firstParent);
    const shallow = await runAction({ workspace, event, github, sha: merge, process: "in-process" });
    expect.soft(JSON.parse(shallow.outputs.lanes ?? "null"), "(c) shallow manifest, selected lanes").toEqual(LANES);
    expect.soft(shallow.outputs.complete, "(c) shallow manifest, complete").toBe("false");
    expect
      .soft(shallow.annotations[0]?.message ?? "", "(c) shallow manifest, missing base")
      .toContain(firstParent.slice(0, 7));
    expect.soft(shallow.annotations[0]?.message ?? "", "(c) shallow manifest, fetch advice").toContain("fetch-depth");
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
