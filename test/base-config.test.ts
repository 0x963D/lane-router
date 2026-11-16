import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { directoryTree } from "../src/adapters/directory.ts";
import { changedFiles } from "../src/core/change.ts";
import { planLanes } from "../src/core/plan.ts";
import { baseGraphOf, loadModel } from "../src/load/index.ts";
import { jsonObject, runAction } from "./support/action.ts";
import { explainJson } from "./support/cli.ts";
import { compare, fakeGitHub } from "./support/fake-github.ts";
import { fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture } from "./support/git-fixture.ts";
import { CONFIG } from "./support/model.ts";

const ACME = fixtureDir("acme");
const ORIGINAL = readFileSync(`${ACME}/${CONFIG}`, "utf8");
const BUTTON = "packages/ui/src/button.tsx";
const ALL = ["api", "web", "e2e", "lint"];
const REMOVED = "removed from the routing config in this change";

function decisions(plan: Awaited<ReturnType<typeof explainJson>>) {
  return plan.lanes.map(({ lane, decision }) => [lane, decision]);
}

describe("base and head routing configs", () => {
  it.each([
    {
      name: "deleted lanes",
      config: ORIGINAL.replace(/ {2}web:\r?\n {4}packages:.*\r?\n {2}e2e:\r?\n {4}packages:.*\r?\n/, "").replace(
        "lanes: [web]",
        "lanes: []",
      ),
      lanes: ["api", "lint", "web", "e2e"],
      removed: ["web", "e2e"],
    },
    {
      name: "a renamed lane",
      config: ORIGINAL.replace("  web:", "  browser:").replace("lanes: [web]", "lanes: [browser]"),
      lanes: ["api", "browser", "e2e", "lint", "web"],
      removed: ["web"],
    },
    {
      name: "a lane with different packages",
      config: ORIGINAL.replace('packages: ["@acme/web"]', 'packages: ["@acme/api"]'),
      lanes: ALL,
      removed: [],
    },
    {
      name: "a lane without its floor flag",
      config: ORIGINAL.replace("floor: true", 'packages: ["@acme/api"]'),
      lanes: ALL,
      removed: [],
    },
  ])("keeps every base lane for $name", async ({ config, lanes, removed }) => {
    const repo = gitFixture(ACME, tempDir());
    repo.write(CONFIG, config);
    repo.write(BUTTON, "export const Button = 'broken';\n");
    const head = repo.commit("Change routing and the button");
    const plan = await explainJson(repo.base, head, repo.root);
    expect(plan.complete).toBe(true);
    expect(decisions(plan)).toEqual(lanes.map((lane) => [lane, "run"]));
    for (const lane of removed) expect(plan.lanes.find((entry) => entry.lane === lane)?.reason).toBe(REMOVED);
  });

  it("publishes removed lanes in every Action output and the summary", async () => {
    const repo = gitFixture(ACME, tempDir());
    repo.write(
      CONFIG,
      ORIGINAL.replace(/ {2}web:\r?\n {4}packages:.*\r?\n {2}e2e:\r?\n {4}packages:.*\r?\n/, "").replace(
        "lanes: [web]",
        "lanes: []",
      ),
    );
    repo.write(BUTTON, "export const Button = 'broken';\n");
    const head = repo.commit("Remove lanes and change the button");
    const github = await fakeGitHub();
    compare(github, repo.base, head, [CONFIG, BUTTON], { mergeBase: repo.base });
    const run = await runAction({
      workspace: repo.root,
      event: {
        name: "pull_request",
        payload: { pull_request: { base: { sha: repo.base }, head: { sha: head }, changed_files: 2 } },
      },
      github,
    });
    expect(run.exitCode).toBe(0);
    expect(run.outputs.complete).toBe("true");
    expect(JSON.parse(run.outputs.lanes ?? "null")).toEqual(["api", "lint", "web", "e2e"]);
    expect(jsonObject(run.outputs.matrix).include).toEqual([
      expect.objectContaining({ lane: "api" }),
      expect.objectContaining({ lane: "lint" }),
      expect.objectContaining({ lane: "web" }),
      expect.objectContaining({ lane: "e2e" }),
    ]);
    for (const lane of ["web", "e2e"]) {
      expect(run.outputs[lane]).toBe("run");
      expect(jsonObject(run.outputs.reasons)[lane]).toBe(REMOVED);
      expect(run.summary).toContain(`| ${lane} | run | ${REMOVED} |`);
    }
  });

  it("uses each config's packages and preserves a base floor", async () => {
    const base = directoryTree(ACME);
    const config = ORIGINAL.replace('packages: ["@acme/web"]', 'packages: ["@acme/api"]').replace(
      "floor: true",
      'packages: ["@acme/api"]',
    );
    const headTree = {
      ...base,
      read: (path: string) =>
        path === CONFIG ? Promise.resolve({ kind: "file" as const, text: config }) : base.read(path),
    };
    const loaded = await loadModel(headTree, CONFIG, base);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const plan = await planLanes(loaded.value, {
      mode: "pr",
      range: { base: "base", head: "head" },
      changes: () => Promise.resolve(changedFiles([{ path: BUTTON, previousPath: null }])),
      baseGraph: baseGraphOf(headTree, CONFIG, { resolve: () => Promise.resolve(undefined), treeAt: () => base }),
    });
    expect(plan.lanes.map(({ lane, decision }) => [lane.name, decision.kind])).toEqual([
      ["api", "skip"],
      ["web", "run"],
      ["e2e", "run"],
      ["lint", "run"],
    ]);
  });

  it("uses just the head lanes when the config is new", async () => {
    const repo = gitFixture(ACME, tempDir());
    repo.remove(CONFIG);
    const base = repo.commit("Remove the config");
    repo.write(CONFIG, ORIGINAL);
    const head = repo.commit("Add the config");
    const plan = await explainJson(base, head, repo.root);
    expect(plan.complete).toBe(true);
    expect(decisions(plan)).toEqual(ALL.map((lane) => [lane, "run"]));
  });

  it("fails closed when the base config is missing but the config path is not changed", async () => {
    const tree = directoryTree(ACME);
    const missing = {
      ...tree,
      read: (path: string) => (path === CONFIG ? Promise.resolve({ kind: "missing" as const }) : tree.read(path)),
    };
    const loaded = await loadModel(tree, CONFIG, missing);
    expect(loaded.ok).toBe(false);
  });

  it.each(["invalid", "unresolved"])("fails closed on an %s base config", async (kind) => {
    const repo = gitFixture(ACME, tempDir());
    repo.write(CONFIG, kind === "invalid" ? "lanes: [" : ORIGINAL.replace('"@acme/web"', '"@acme/missing"'));
    const base = repo.commit("Change the base config");
    repo.write(CONFIG, ORIGINAL);
    const head = repo.commit("Restore the config");
    const plan = await explainJson(base, head, repo.root);
    expect(plan.complete).toBe(false);
    expect(decisions(plan)).toEqual(ALL.map((lane) => [lane, "run"]));
    expect(plan.incomplete?.kind).toBe("no-base-graph");
  });

  it("fails closed when reading the base config throws", async () => {
    const tree = directoryTree(ACME);
    const unreadable = {
      ...tree,
      read: (path: string) => {
        if (path === CONFIG) throw new Error("cannot read the base config");
        return tree.read(path);
      },
    };
    const loaded = await loadModel(tree, CONFIG);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const plan = await planLanes(loaded.value, {
      mode: "pr",
      range: { base: "base", head: "head" },
      changes: () => Promise.resolve(changedFiles([{ path: CONFIG, previousPath: null }], { mergeBase: "base" })),
      baseGraph: baseGraphOf(tree, CONFIG, { resolve: () => Promise.resolve("base"), treeAt: () => unreadable }),
    });
    expect(plan.event.kind).toBe("incomplete");
    expect(plan.lanes.map(({ lane, decision }) => [lane.name, decision.kind])).toEqual(
      ALL.map((lane) => [lane, "run"]),
    );
  });

  it("fails closed when a config change has no fetched base", async () => {
    const run = await runAction({
      workspace: ACME,
      inputs: { files: CONFIG, base: "c".repeat(40) },
      event: {
        name: "pull_request",
        payload: { pull_request: { base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) }, changed_files: 1 } },
      },
    });
    expect(run.exitCode).toBe(0);
    expect(run.outputs.complete).toBe("false");
    expect(JSON.parse(run.outputs.lanes ?? "null")).toEqual(ALL);
  });
});
