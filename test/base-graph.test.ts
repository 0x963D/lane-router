import { describe, expect, it } from "vitest";
import type { PlanJson } from "../src/render.ts";
import { jsonObject, pullRequestCheckout, runAction, type ActionEvent } from "./support/action.ts";
import { explainJson, runningLanes } from "./support/cli.ts";
import { compare, fakeGitHub } from "./support/fake-github.ts";
import { fixtureCopy, fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture, type GitFixture } from "./support/git-fixture.ts";
import { CONFIG } from "./support/model.ts";

/*
 * A change is judged against the graph it starts from and the graph it ends in, so a change cannot
 * reshape the graph that judges it. In acme, @acme/web depends on @acme/ui, and lanes web and e2e
 * read @acme/ui through @acme/web.
 */

const ACME = fixtureDir("acme");
const ALL = ["api", "web", "e2e", "lint"];
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const WEB_MANIFEST = "packages/web/package.json";
const UI_MANIFEST = "packages/ui/package.json";
const BUTTON = "packages/ui/src/button.tsx";

function manifest(name: string, dependencies: Readonly<Record<string, string>> = {}): string {
  return `${JSON.stringify({ name, version: "0.0.0", private: true, dependencies }, null, 2)}\n`;
}

function acmeRepo(): GitFixture {
  const repo = gitFixture(ACME, tempDir());
  repo.write(WEB_MANIFEST, manifest("@acme/web", { "@acme/ui": "^1.0.0" }));
  const base = repo.commit("Use a registry range for ui");
  return { ...repo, base };
}

function pullRequest(changedFiles: number): ActionEvent {
  return {
    name: "pull_request",
    payload: { pull_request: { base: { sha: BASE }, head: { sha: HEAD }, changed_files: changedFiles } },
  };
}

function shallowPrCheckout() {
  const { repo, base, merge, runner } = pullRequestCheckout(acmeRepo());
  const workspace = tempDir();
  repo.git("clone", "--depth", "1", "--no-local", repo.dir, workspace);
  return { base, merge, runner: (count: number) => ({ ...runner(count), workspace }) };
}

/** How each placement of `path` reached `lane`: the package chain, and the graph it was found in. */
function evidence(plan: PlanJson, lane: string, path: string) {
  const planned = plan.lanes.find((entry) => entry.lane === lane);
  if (planned?.decision !== "run") return [];
  return planned.because.flatMap((reason) =>
    reason.kind === "placement" && reason.path === path ? [{ through: reason.through, graph: reason.graph }] : [],
  );
}

/** A head commit that renames @acme/ui, so @acme/web's dependency on it no longer resolves in head. */
function renameUi(repo: GitFixture): string {
  repo.write(UI_MANIFEST, manifest("@acme/design"));
  repo.write(BUTTON, 'export const Button = "large";\n');
  return repo.commit("Rename @acme/ui to @acme/design and change the button");
}

describe("a package manifest change", () => {
  it("still reaches the lanes that read a deleted dependency in the base graph", async () => {
    const repo = acmeRepo();
    repo.write(WEB_MANIFEST, manifest("@acme/web", { react: "^19.0.0" }));
    repo.write(BUTTON, 'export const Button = "large";\n');
    const head = repo.commit("Drop the ui dependency and change the button");

    const plan = await explainJson(repo.base, head, repo.dir);
    expect(runningLanes(plan)).toEqual(["web", "e2e", "lint"]);
    expect(evidence(plan, "web", BUTTON)).toEqual([{ through: ["@acme/web", "@acme/ui"], graph: "base" }]);
    expect(evidence(plan, "e2e", BUTTON)).toEqual([
      { through: ["@acme/web-e2e", "@acme/web", "@acme/ui"], graph: "base" },
    ]);
  });

  it("still reaches the lanes that read a renamed package by its old name", async () => {
    const repo = acmeRepo();
    const head = renameUi(repo);

    const plan = await explainJson(repo.base, head, repo.dir);
    expect(runningLanes(plan)).toEqual(["web", "e2e", "lint"]);
    expect(evidence(plan, "web", BUTTON)).toEqual([{ through: ["@acme/web", "@acme/ui"], graph: "base" }]);
    expect(plan.lanes.find(({ lane }) => lane === "web")?.reason).toBe(
      `${UI_MANIFEST} is in @acme/ui, read through @acme/web in the base graph (+1 more)`,
    );
  });

  it("is judged in the Action against the base graph at the compare API's merge base", async () => {
    const { repo, base, head, runner } = pullRequestCheckout(acmeRepo(), renameUi);
    repo.git("switch", "--detach", head);
    const github = await fakeGitHub();
    compare(github, base, head, [UI_MANIFEST, BUTTON], { status: "diverged", mergeBase: repo.base });

    const run = await runAction({ ...runner(2), github });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.outputs.lanes ?? "null")).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
  });

  it("runs every lane when the merge base was not fetched", async () => {
    const { base, merge, runner } = shallowPrCheckout();
    const github = await fakeGitHub();
    compare(github, base, merge, [WEB_MANIFEST]);

    const run = await runAction({ ...runner(1), github });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.outputs.lanes ?? "null")).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(jsonObject(run.outputs.reasons).api).toBe(
      `fail closed, the base routing model at ${base.slice(0, 7)} cannot be built: ` +
        "the commit is not in the local repository, so fetch more history, for example with fetch-depth: 0",
    );
    expect(run.annotations.map(({ level }) => level)).toEqual(["warning"]);
  });

  it("reads the base graph from the base input when the files input lists the change", async () => {
    const repo = acmeRepo();
    renameUi(repo);
    const files = `${UI_MANIFEST}\n${BUTTON}`;

    const judged = await runAction({ workspace: repo.dir, inputs: { files, base: repo.base }, event: pullRequest(2) });
    expect(JSON.parse(judged.outputs.lanes ?? "null")).toEqual(["web", "e2e", "lint"]);
    expect(judged.outputs.complete).toBe("true");

    const unjudged = await runAction({ workspace: repo.dir, inputs: { files }, event: pullRequest(2) });
    expect(JSON.parse(unjudged.outputs.lanes ?? "null")).toEqual(ALL);
    expect(jsonObject(unjudged.outputs.reasons).api).toBe(
      "fail closed, the base routing model cannot be built: the change names no base commit",
    );
  });
});

describe("a change with no package manifest", () => {
  it("never reads the base graph, so a shallow checkout routes it precisely", async () => {
    const { base, merge, runner } = shallowPrCheckout();
    const github = await fakeGitHub();
    compare(github, base, merge, [BUTTON]);

    const run = await runAction({ ...runner(1), github });
    expect(JSON.parse(run.outputs.lanes ?? "null")).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
  });
});

describe("the workspace file", () => {
  it("selects every lane, even when a row maps it to no lane", async () => {
    const config = `lanes:
  api:
    packages: ["@acme/api"]
  web:
    packages: ["@acme/web"]
  lint:
    floor: true
paths:
  - match: [pnpm-workspace.yaml]
    lanes: []
    why: Pretend the workspace file reaches no lane.
unmatched: all
`;
    const workspace = fixtureCopy("acme", { [CONFIG]: config });

    const run = await runAction({ workspace, inputs: { files: "pnpm-workspace.yaml" }, event: pullRequest(1) });
    expect(JSON.parse(run.outputs.lanes ?? "null")).toEqual(["api", "web", "lint"]);
    expect(jsonObject(run.outputs.reasons)).toMatchObject({
      api: "pnpm-workspace.yaml defines the workspace",
      web: "pnpm-workspace.yaml defines the workspace",
    });
  });
});
