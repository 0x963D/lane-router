import { describe, expect, it } from "vitest";
import { directoryTree } from "../src/adapters/directory.ts";
import { changedFiles, incomplete, type IncompleteCause } from "../src/core/change.ts";
import { compileGlobs, globProblem } from "../src/core/glob.ts";
import { parseLaneName } from "../src/core/ids.ts";
import { planLanes } from "../src/core/plan.ts";
import { baseGraphOf, loadModel } from "../src/load/index.ts";
import { explainJson, reasonLine } from "../src/render.ts";
import { err } from "../src/result.ts";
import { fixtureCopy } from "./support/fixtures.ts";
import { CONFIG, modelOf } from "./support/model.ts";
import { decisionOf, evidenceOf, placementKinds, placementsOf, planFor, planWith, running } from "./support/plan.ts";

/*
 * Every test routes the acme fixture. Its closures, worked out by hand from the manifests and the one
 * configured edge (@acme/web reads @acme/api):
 *   api  = {api}
 *   web  = {web, ui, api}
 *   e2e  = {web-e2e, web, ui, api}
 *   lint is a floor lane with no packages.
 */

const ALL = ["api", "web", "e2e", "lint"];

const acmeConfig = (extra: { paths?: string; docsOnly?: string }) => `lanes:
  api:
    packages: ["@acme/api"]
  web:
    packages: ["@acme/web"]
  e2e:
    packages: ["@acme/web-e2e"]
  lint:
    floor: true
workspace:
  edges:
    - { from: "@acme/web", to: "@acme/api" }
paths:
  - match: ["docs/guide.md"]
    lanes: [web]
    why: The web build inlines the guide.
${extra.paths ?? ""}docs-only:
  match: ${extra.docsOnly ?? '["**/*.md"]'}
unmatched: all
`;

describe("built-in inputs", () => {
  it.each([
    [CONFIG, "is the routing config"],
    ["pnpm-workspace.yaml", "defines the workspace"],
    ["package.json", "is the root manifest"],
    ["pnpm-lock.yaml", "is a lockfile"],
    ["package-lock.json", "is a lockfile"],
    ["npm-shrinkwrap.json", "is a lockfile"],
    ["yarn.lock", "is a lockfile"],
    ["bun.lock", "is a lockfile"],
  ])("select every lane when %s changes, and no row can turn that off", async (path, says) => {
    const config = acmeConfig({ paths: `  - match: ["${path}"]\n    lanes: []\n    why: Try to hide it.\n` });
    const plan = await planFor("acme", [path], { [CONFIG]: config });
    expect(running(plan)).toEqual(ALL);
    expect(placementKinds(plan, path)).toEqual(["built-in", "row"]);
    expect(plan.lanes.map(reasonLine)).toEqual(
      ALL.map((lane) =>
        path === CONFIG
          ? "fail closed, the base routing model cannot be built: the change names no base commit"
          : `${path} ${says}${lane === "lint" ? " (+1 more)" : ""}`,
      ),
    );
  });

  it("read only at the root", async () => {
    const plan = await planFor("acme", ["tools/scripts/package-lock.json"]);
    expect(placementKinds(plan, "tools/scripts/package-lock.json")).toEqual(["package"]);
  });

  it("still count when docs-only globs cover them", async () => {
    const plan = await planFor("acme", ["pnpm-workspace.yaml"], {
      [CONFIG]: acmeConfig({ docsOnly: '["**/*.md", "*.yaml"]' }),
    });
    expect(plan.event.kind).toBe("docs-only");
    expect(running(plan)).toEqual(ALL);
  });
});

describe("paths rows", () => {
  it.each([
    ["  ", "a glob cannot be empty"],
    ["path\\file", "use / as the path separator"],
    ["/outside", "globs are relative to the repository root"],
    ["./inside", "globs are relative to the repository root"],
    ["!pattern", "a glob cannot start with !"],
    ["dir/../outside", "a glob cannot reach outside the repository root"],
  ])("rejects %j with the corresponding glob problem", (pattern, message) => {
    expect(globProblem(pattern)).toBe(message);
  });

  it("reports a glob longer than the matcher can compile", () => {
    expect(globProblem("a".repeat(70_000))).toMatch(/length/i);
  });

  it("accepts a literal trailing exclamation point and handles an empty pattern list", () => {
    expect(globProblem("file!")).toBeUndefined();
    expect(compileGlobs({ match: ["file!"] })("file!")).toBe(true);
    expect(compileGlobs({ match: [] })("file!")).toBe(false);
  });

  it("distinguishes malformed lane names from reserved output names", () => {
    expect(parseLaneName("-web")).toEqual(err("malformed"));
    expect(parseLaneName("web!")).toEqual(err("malformed"));
    expect(parseLaneName("matrix")).toEqual(err("reserved"));
    expect(parseLaneName("web-2")).toEqual({ ok: true, value: "web-2" });
  });

  it("matches a dotfile through a wildcard", async () => {
    const config = acmeConfig({
      paths: '  - match: ["shared/*"]\n    lanes: [web]\n    why: Only the web build reads the shared input.\n',
    });
    const plan = await planFor("acme", ["shared/.generated"], { [CONFIG]: config });
    expect(running(plan)).toEqual(["web", "lint"]);
    expect(evidenceOf(plan, "web")).toEqual(["row"]);
  });

  it("selects every lane for lanes: all, with the row's why as evidence", async () => {
    const plan = await planFor("acme", [".github/workflows/ci.yml"]);
    expect(running(plan)).toEqual(ALL);
    const decision = decisionOf(plan, "api");
    expect(decision.kind === "run" && decision.because[0]).toMatchObject({
      kind: "placement",
      placement: { kind: "row", row: { index: 0, why: "CI changes can affect every lane." } },
    });
  });

  it("selects the listed lanes for lanes: [a], adding up with other paths", async () => {
    const plan = await planFor("acme", ["docs/guide.md", "packages/ui/src/button.tsx"]);
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
    expect(evidenceOf(plan, "web")).toEqual(["row", "package"]);
  });

  it("treats lanes: [] as a known path that selects nothing", async () => {
    const plan = await planFor("acme", [".vscode/settings.json"]);
    expect(running(plan)).toEqual(["lint"]);
    expect(placementKinds(plan, ".vscode/settings.json")).toEqual(["row"]);
  });

  it("selects every lane whose closure holds the package for via: code", async () => {
    const plan = await planFor("acme", ["tools/codegen/generate.mjs"]);
    expect(running(plan)).toEqual(ALL);
  });

  it("selects only the lanes rooted at the package for via: tests", async () => {
    const plan = await planFor("acme", ["fixtures/browser/login.json"]);
    expect(running(plan)).toEqual(["web", "lint"]);
    expect(decisionOf(plan, "e2e")).toMatchObject({ kind: "skip", because: "untouched" });
  });

  it("selects every lane whose closure holds the package for via: name", async () => {
    const plan = await planFor("acme", ["docs/api/users.md", ".vscode/settings.json"]);
    expect(running(plan)).toEqual(ALL);
  });

  it("applies inside a package, adding up with the package placement", async () => {
    const plan = await planFor("acme", ["packages/ui/tokens.json"]);
    expect(placementKinds(plan, "packages/ui/tokens.json")).toEqual(["row", "package"]);
    expect(running(plan)).toEqual(ALL);
    expect(evidenceOf(plan, "api")).toEqual(["row"]);
  });
});

describe("package placement", () => {
  it("follows a cycle and reaches a root-level package through its shortest chain", async () => {
    const files = {
      [CONFIG]: `lanes:
  multi:
    packages: [app, helper]
  isolated:
    packages: [isolated]
unmatched: all
`,
      "pnpm-workspace.yaml": 'packages: ["app", "helper", "kit", "isolated"]\n',
      "app/package.json": '{"name":"app","dependencies":{"helper":"*"}}',
      "helper/package.json": '{"name":"helper","devDependencies":{"app":"*","kit":"*"}}',
      "kit/package.json": '{"name":"kit"}',
      "isolated/package.json": '{"name":"isolated"}',
    };
    const plan = await planFor("acme", ["kit/index.ts"], files);
    expect(running(plan)).toEqual(["multi"]);
    expect(decisionOf(plan, "multi")).toMatchObject({
      because: [{ through: { kind: "reads", chain: ["helper", "kit"], graph: "head" } }],
    });
    expect(plan.lanes.map(reasonLine)).toEqual([
      "kit/index.ts is in kit, read through helper",
      "nothing it reads changed",
    ]);
  });

  it("selects the lanes whose closure holds the package through manifest dependencies", async () => {
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"]);
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
    expect(decisionOf(plan, "api")).toMatchObject({ kind: "skip", because: "untouched" });
  });

  it("follows configured edges transitively and records the shortest chain", async () => {
    const plan = await planFor("acme", ["packages/api/src/user.ts"]);
    expect(running(plan)).toEqual(ALL);
    const chains = ["api", "web", "e2e"].map((lane) => {
      const decision = decisionOf(plan, lane);
      const reason = decision.kind === "run" ? decision.because[0] : undefined;
      return reason?.kind === "placement" && reason.through.kind === "reads" ? reason.through.chain : undefined;
    });
    expect(chains).toEqual([["@acme/api"], ["@acme/web", "@acme/api"], ["@acme/web-e2e", "@acme/web", "@acme/api"]]);
  });

  it("places a path in the deepest package that holds it", async () => {
    const plan = await planFor("acme", ["packages/web/e2e/login.spec.ts"]);
    expect(running(plan)).toEqual(["e2e", "lint"]);
    expect(placementsOf(plan, "packages/web/e2e/login.spec.ts")).toMatchObject([
      { kind: "package", package: "@acme/web-e2e" },
    ]);
  });

  it("keeps a file at a workspace directory's path unmatched", async () => {
    const path = "packages/ui";
    const plan = await planFor("acme", [path]);
    expect(placementKinds(plan, path)).toEqual(["unmatched"]);
    expect(running(plan)).toEqual(ALL);
  });

  it("knows a package that no lane reaches, so the path is not unmatched", async () => {
    const plan = await planFor("acme", ["tools/scripts/run.mjs"]);
    expect(placementKinds(plan, "tools/scripts/run.mjs")).toEqual(["package"]);
    expect(running(plan)).toEqual(["lint"]);
  });
});

describe("docs placement", () => {
  it("places a docs path as known, so it is not unmatched", async () => {
    const plan = await planFor("acme", ["README.md", "packages/ui/src/button.tsx"]);
    expect(placementKinds(plan, "README.md")).toEqual(["docs"]);
    expect(plan.event.kind).toBe("ordinary");
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
  });

  it("leaves a path matched by docs-only.except unmatched", async () => {
    const plan = await planFor("acme", [".changeset/quiet-frogs.md"]);
    expect(placementKinds(plan, ".changeset/quiet-frogs.md")).toEqual(["unmatched"]);
    expect(plan.event.kind).toBe("ordinary");
    expect(running(plan)).toEqual(ALL);
  });
});

describe("unmatched paths", () => {
  it("select every lane, and the root is never a package", async () => {
    const plan = await planFor("acme", ["tsconfig.json"]);
    expect(placementKinds(plan, "tsconfig.json")).toEqual(["unmatched"]);
    expect(running(plan)).toEqual(ALL);
  });
});

describe("docs-only changes", () => {
  it("count matching explicit rows", async () => {
    const plan = await planFor("acme", ["README.md", "docs/guide.md"]);
    expect(plan.event.kind).toBe("docs-only");
    expect(running(plan)).toEqual(["web"]);
    expect(decisionOf(plan, "lint")).toMatchObject({ kind: "skip", because: "docs-only" });
  });

  it("count via: name rows", async () => {
    const plan = await planFor("acme", ["docs/api/users.md"]);
    expect(running(plan)).toEqual(["api", "web", "e2e"]);
  });

  it("do not count package placements without an explicit row", async () => {
    const plan = await planFor("acme", ["packages/api/README.md"]);
    expect(placementKinds(plan, "packages/api/README.md")).toEqual(["package", "docs"]);
    expect(running(plan)).toEqual([]);
  });

  it("count via: code and via: tests rows", async () => {
    const rows = [
      '  - match: ["docs/gen/*.md"]\n    packages: ["@acme/api"]\n    via: code\n    why: Generated.\n',
      '  - match: ["docs/qa/*.md"]\n    packages: ["@acme/web"]\n    via: tests\n    why: Test notes.\n',
    ].join("");
    const plan = await planFor("acme", ["docs/gen/a.md", "docs/qa/b.md"], { [CONFIG]: acmeConfig({ paths: rows }) });
    expect(placementKinds(plan, "docs/gen/a.md")).toEqual(["row", "docs"]);
    expect(running(plan)).toEqual(["api", "web", "e2e"]);
  });

  it.each([
    ["fixtures/browser/welcome.md", ["web"]],
    ["tools/codegen/template.md", ["api", "web", "e2e"]],
  ])("counts the fixture row for %s in a docs-only change", async (path, lanes) => {
    const plan = await planFor("acme", [path]);
    expect(plan.event.kind).toBe("docs-only");
    expect(running(plan)).toEqual(lanes);
  });

  it("require no lane when nothing counts, floor lanes included", async () => {
    const plan = await planFor("acme", ["README.md"]);
    expect(running(plan)).toEqual([]);
    expect(plan.lanes.map(({ decision }) => decision.kind === "skip" && decision.because)).toEqual(
      ALL.map(() => "docs-only"),
    );
  });
});

describe("floor lanes", () => {
  it("run for every change that has paths and is not docs-only", async () => {
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"]);
    expect(evidenceOf(plan, "lint")).toEqual(["floor"]);
  });
});

describe("an empty change", () => {
  it("requires nothing, floor lanes included", async () => {
    const plan = await planFor("acme", []);
    expect(plan.event.kind).toBe("empty");
    expect(plan.lanes.map(({ lane }) => evidenceOf(plan, lane.name))).toEqual(ALL.map(() => ["no-changes"]));
  });
});

describe("failing closed", () => {
  it("keeps the manifest path and the rejected base graph's cause", async () => {
    const path = "packages/ui/package.json";
    const plan = await planLanes(await modelOf("acme"), {
      mode: "push",
      range: { base: "before", head: "after" },
      changes: () => Promise.resolve(changedFiles([{ path, previousPath: null }], { mergeBase: "merged" })),
      baseGraph: (commit, { allowNewConfig }) => {
        expect(commit).toBe("merged");
        expect(allowNewConfig).toBe(false);
        return Promise.reject(new Error("manifest cannot be read"));
      },
    });
    expect(plan.mode).toBe("push");
    expect(running(plan)).toEqual(ALL);
    expect(plan.event).toMatchObject({
      kind: "incomplete",
      cause: { kind: "no-base-graph", commit: "merged", reason: "manifest cannot be read" },
      paths: [{ path, placements: [{ kind: "package" }] }],
    });
  });

  it("treats a missing base config as new only when the config changed", async () => {
    const plan = await planLanes(await modelOf("acme"), {
      mode: "pr",
      range: { base: "before", head: "after" },
      changes: () => Promise.resolve(changedFiles([{ path: CONFIG, previousPath: null }], { mergeBase: "merged" })),
      baseGraph: (commit, { allowNewConfig }) => {
        expect(commit).toBe("merged");
        expect(allowNewConfig).toBe(true);
        return Promise.resolve(err("base is unavailable"));
      },
    });
    expect(running(plan)).toEqual(ALL);
    expect(evidenceOf(plan, "api")).toEqual(["incomplete"]);
    expect(plan.event).toMatchObject({
      cause: { kind: "no-base-graph", commit: "merged", reason: "base is unavailable" },
    });
  });

  it.each<IncompleteCause>([
    { kind: "truncated", listed: 300, limit: 300 },
    { kind: "count-mismatch", listed: 2, expected: 3 },
    { kind: "no-base" },
    { kind: "invalid-path", raw: "../outside.ts" },
    { kind: "error", message: "compare returned 500" },
  ])("runs every lane when the file list is incomplete: $kind", async (cause) => {
    const plan = await planWith("acme", () => Promise.resolve(incomplete(cause)));
    expect(running(plan)).toEqual(ALL);
    expect(plan.lanes.map(({ decision }) => decision.kind === "run" && decision.because)).toEqual(
      ALL.map(() => [{ kind: "incomplete", cause }]),
    );
  });

  it("preserves the incomplete cause even when the list includes a manifest", async () => {
    const listed = changedFiles(
      ["README.md", "packages/web/package.json"].map((path) => ({ path, previousPath: null })),
    ).paths;
    const cause = { kind: "truncated", listed: 300, limit: 300 } as const;
    const plan = await planWith("acme", () => Promise.resolve(incomplete(cause, listed)));
    expect(plan.event).toMatchObject({ kind: "incomplete", cause });
    expect(placementKinds(plan, "README.md")).toEqual(["docs"]);
    expect(running(plan)).toEqual(ALL);
  });

  it("runs every lane with the error as the cause when the source rejects", async () => {
    const plan = await planWith("acme", () => Promise.reject(new Error("git failed")));
    expect(running(plan)).toEqual(ALL);
    expect(decisionOf(plan, "api")).toEqual({
      kind: "run",
      because: [{ kind: "incomplete", cause: { kind: "error", message: "git failed" } }],
    });
  });

  it("makes a path outside the root an incomplete list", async () => {
    const plan = await planFor("acme", ["packages/ui/src/button.tsx", "../outside.ts"]);
    expect(plan.event).toMatchObject({ kind: "incomplete", cause: { kind: "invalid-path", raw: "../outside.ts" } });
    expect(running(plan)).toEqual(ALL);
  });
});

describe("base and head coverage", () => {
  it("keeps a removed lane and the base floor without applying it to other lanes", async () => {
    const base = directoryTree(
      fixtureCopy("acme", {
        [CONFIG]: 'lanes:\n  build:\n    floor: true\n  old:\n    packages: ["@acme/api"]\nunmatched: all\n',
      }),
    );
    const head = directoryTree(
      fixtureCopy("acme", {
        [CONFIG]:
          'lanes:\n  build:\n    packages: ["@acme/api"]\n  other:\n    packages: ["@acme/api"]\nunmatched: all\n',
      }),
    );
    const model = await loadModel(head, CONFIG, base);
    if (!model.ok) throw new Error(JSON.stringify(model.error));
    const plan = await planLanes(model.value, {
      mode: "pr",
      range: { base: "before", head: "after" },
      changes: () => Promise.resolve(changedFiles([{ path: "packages/ui/src/button.tsx", previousPath: null }])),
      baseGraph: () => Promise.resolve(err("base was already read")),
    });
    expect(running(plan)).toEqual(["build", "old"]);
    expect(evidenceOf(plan, "build")).toEqual(["floor"]);
    expect(evidenceOf(plan, "old")).toEqual(["removed"]);
    const json: unknown = JSON.parse([...explainJson(plan)].join("\n"));
    expect(json).toMatchObject({
      lanes: [
        { lane: "build", base: "before", decision: "run" },
        { lane: "other", base: "before", decision: "skip" },
        { lane: "old", base: "before", decision: "run" },
      ],
    });
  });

  it("uses the graph at the merge base for package placements and explicit rows", async () => {
    const path = "packages/ui/src/button.tsx";
    const claim = "shared/claimed.txt";
    const config = acmeConfig({
      paths: '  - match: ["shared/claimed.txt"]\n    packages: ["@acme/ui"]\n    via: name\n    why: Shared input.\n',
    });
    const base = directoryTree(fixtureCopy("acme", { [CONFIG]: config }));
    const head = directoryTree(
      fixtureCopy("acme", {
        [CONFIG]: config,
        "packages/web/package.json": '{"name":"@acme/web"}',
      }),
    );
    const model = await loadModel(head, CONFIG);
    if (!model.ok) throw new Error(JSON.stringify(model.error));
    const plan = await planLanes(model.value, {
      mode: "pr",
      range: { base: "before", head: "after" },
      changes: () =>
        Promise.resolve(
          changedFiles(
            [path, claim, "packages/web/package.json"].map((path) => ({ path, previousPath: null })),
            { mergeBase: "merged" },
          ),
        ),
      baseGraph: baseGraphOf(head, CONFIG, {
        resolve: (ref) => Promise.resolve(ref === "merged" ? ref : undefined),
        treeAt: () => base,
      }),
    });
    expect(plan.event.kind).toBe("ordinary");
    const web = decisionOf(plan, "web");
    if (web.kind !== "run") throw new Error("web reads the changed package");
    const reads = web.because.flatMap((reason) =>
      reason.kind === "placement" && [path, claim].includes(reason.path)
        ? [{ path: reason.path, through: reason.through }]
        : [],
    );
    const through = { kind: "reads", chain: ["@acme/web", "@acme/ui"], graph: "base" };
    expect(reads).toEqual([
      { path, through },
      { path: claim, through },
    ]);
  });
});

describe("renames", () => {
  it("normalizes and deduplicates both names relative to the routed root", () => {
    const files = changedFiles(
      [
        { previousPath: "project/mono/././packages//ui/src/new.ts", path: "project/mono/packages/ui/src/new.ts" },
        { previousPath: "project/mono/packages/api/src/old.ts", path: "project/mono/packages/ui/src/new.ts" },
      ],
      { under: "project/mono///", mergeBase: "merged" },
    );
    expect(files).toMatchObject({
      kind: "complete",
      mergeBase: "merged",
      paths: ["packages/api/src/old.ts", "packages/ui/src/new.ts"],
    });
  });

  it("keeps the first invalid path and the valid part of an incomplete rename listing", () => {
    const files = changedFiles([
      { previousPath: "/absolute.ts", path: "packages/ui/src/new.ts" },
      { previousPath: null, path: "packages/./bad.ts" },
      { previousPath: null, path: "packages/file\0.ts" },
    ]);
    expect(files).toMatchObject({
      kind: "incomplete",
      cause: { kind: "invalid-path", raw: "/absolute.ts" },
      paths: ["packages/ui/src/new.ts"],
    });
  });

  it("route both the old and the new path", async () => {
    const plan = await planFor("acme", [{ path: "packages/ui/src/a.ts", previousPath: "packages/api/src/a.ts" }]);
    expect(placementKinds(plan, "packages/api/src/a.ts")).toEqual(["package"]);
    expect(placementKinds(plan, "packages/ui/src/a.ts")).toEqual(["package"]);
    expect(running(plan)).toEqual(ALL);
  });
});

describe("explanations", () => {
  it("keep every reason a lane runs, not just the first", async () => {
    const plan = await planFor("acme", ["packages/api/src/user.ts", "tools/codegen/generate.mjs"]);
    expect(evidenceOf(plan, "api")).toEqual(["package", "row"]);
  });
});
