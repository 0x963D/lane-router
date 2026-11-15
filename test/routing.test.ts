import { describe, expect, it } from "vitest";
import { changedFiles, incomplete, type IncompleteCause } from "../src/core/change.ts";
import { reasonLine } from "../src/render.ts";
import { CONFIG } from "./support/model.ts";
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
      ALL.map((lane) => `${path} ${says}${lane === "lint" ? " (+1 more)" : ""}`),
    );
  });

  it("read only at the root", async () => {
    const plan = await planFor("acme", ["tools/scripts/package-lock.json"]);
    expect(placementKinds(plan, "tools/scripts/package-lock.json")).toEqual(["package"]);
  });

  it("still count when docs-only globs cover them", async () => {
    const plan = await planFor("acme", [CONFIG], { [CONFIG]: acmeConfig({ docsOnly: '["**/*.md", ".github/**"]' }) });
    expect(plan.event.kind).toBe("docs-only");
    expect(running(plan)).toEqual(ALL);
  });
});

describe("paths rows", () => {
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

  it("never lets the listed paths of an incomplete list decide anything", async () => {
    const listed = changedFiles([{ path: "README.md", previousPath: null }]).paths;
    const plan = await planWith("acme", () =>
      Promise.resolve(incomplete({ kind: "truncated", listed: 300, limit: 300 }, listed)),
    );
    expect(plan.event.kind).toBe("incomplete");
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

describe("renames", () => {
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
