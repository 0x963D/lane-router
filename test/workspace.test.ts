import { describe, expect, it } from "vitest";
import { CONFIG, problemsOf } from "./support/model.ts";
import { placementKinds, placementsOf, planFor, running } from "./support/plan.ts";

/* A package exists when a path inside it gets a package placement, and a dependency exists when a change to it selects the dependent's lane. */

function packageOf(plan: Awaited<ReturnType<typeof planFor>>, path: string): string | undefined {
  const placement = placementsOf(plan, path).find((found) => found.kind === "package");
  return placement?.kind === "package" ? placement.package : undefined;
}

describe("workspace discovery", () => {
  it("finds pnpm packages, including one listed by its own path", async () => {
    const plan = await planFor("acme", ["packages/api/src/user.ts", "packages/web/e2e/login.spec.ts"]);
    expect(packageOf(plan, "packages/api/src/user.ts")).toBe("@acme/api");
    expect(packageOf(plan, "packages/web/e2e/login.spec.ts")).toBe("@acme/web-e2e");
  });

  it("honours pnpm negations", async () => {
    const plan = await planFor("pnpm-negated", ["packages/legacy/old/index.js"]);
    expect(placementKinds(plan, "packages/legacy/old/index.js")).toEqual(["unmatched"]);
    expect(running(plan)).toEqual(["core", "lint"]);
  });

  it("reads the npm array form", async () => {
    const plan = await planFor("npm-array", ["packages/one/index.js", "packages/two/index.js"]);
    expect(packageOf(plan, "packages/one/index.js")).toBe("@npm/one");
    expect(packageOf(plan, "packages/two/index.js")).toBe("@npm/two");
  });

  it("reads the npm object form and its dependencies", async () => {
    const plan = await planFor("npm-object", ["libs/kit/index.js"]);
    expect(packageOf(plan, "libs/kit/index.js")).toBe("@obj/kit");
    expect(running(plan)).toEqual(["site"]);
  });

  it("prefers pnpm-workspace.yaml under auto discovery", async () => {
    const plan = await planFor("auto-both", ["packages/lib/index.js", "apps/web/index.js"]);
    expect(packageOf(plan, "packages/lib/index.js")).toBe("@both/lib");
    expect(placementKinds(plan, "apps/web/index.js")).toEqual(["unmatched"]);
  });

  it("ignores pnpm-workspace.yaml when discovery is npm", async () => {
    const config = "lanes:\n  lint:\n    floor: true\nworkspace:\n  discovery: npm\nunmatched: all\n";
    const plan = await planFor("auto-both", ["packages/lib/index.js", "apps/web/index.js"], { [CONFIG]: config });
    expect(packageOf(plan, "apps/web/index.js")).toBe("@both/web");
    expect(placementKinds(plan, "packages/lib/index.js")).toEqual(["unmatched"]);
  });

  it("does not treat a directory without a named package.json as a package", async () => {
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
      "packages/ui/package.json": JSON.stringify({ version: "1.0.0" }),
      "packages/web/package.json": JSON.stringify({ name: "@acme/web" }),
    });
    expect(placementKinds(plan, "packages/ui/src/button.tsx")).toEqual(["unmatched"]);
  });

  it("follows all four dependency fields, whatever the version specifier", async () => {
    const plan = await planFor("dependency-fields", ["packages/target/index.js"]);
    expect(running(plan)).toEqual(["prod", "dev", "peer", "optional"]);
  });

  it.each([
    ["ui", "workspace:@acme/ui@*"],
    ["ui", "workspace:@acme/ui"],
    ["@acme/api", "workspace:@acme/ui@*"],
    ["ui", "workspace:@acme/ui@^1.0.0"],
    ["ui", "workspace:../ui"],
    ["ui", "link:../ui"],
    ["ui", "file:../ui"],
    ["ui", "../ui"],
    ["ui", "./../ui"],
    ["ui", "npm:@acme/ui@*"],
    ["ui", "npm:@acme/ui"],
    ["ui", "jsr:@acme/ui@1"],
    ["ui", "gh:@acme/ui"],
    ["ui", "npmjs:@acme/ui@latest"],
    ["ui", "corp:@acme/ui@^1"],
    ["ui", "file:..\\ui"],
    ["ui", "../web/../ui"],
    ["ui", "file:../ui/"],
    ["@acme/ui", "workspace:"],
    ["@acme/ui", "workspace:^"],
    ["@acme/ui", "workspace:~"],
    ["@acme/ui", "workspace:1.0.0"],
    ["ui", "workspace:ui@*"],
    ["ui", "npm:ui@latest"],
  ])("follows %s: %s to its workspace target", async (key, specifier) => {
    const unscoped = specifier.includes(":ui@");
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { [key]: specifier } }),
      ...(unscoped ? { "packages/ui/package.json": JSON.stringify({ name: "ui" }) } : {}),
    });
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
  });

  it.each([
    "workspace:@missing/ui@*",
    "workspace:../missing",
    "workspace:*",
    "link:../missing",
    "file:../missing",
    "../missing",
    "npm:@missing/ui@*",
    "corp:@missing/ui@*",
    "git+file:../ui",
    "E:/packages/ui",
    "file:../ui.tgz",
    "~/ui",
    "/packages/ui",
    "link:../../../outside",
  ])("rejects an unresolved workspace reference %s with its manifest and key", async (specifier) => {
    const problems = await problemsOf("acme", {
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", devDependencies: { ui: specifier } }),
    });
    expect(problems).toMatchObject([
      {
        file: "packages/web/package.json",
        where: "devDependencies.ui",
        message: "does not resolve to a workspace package",
      },
    ]);
  });

  it("ignores dependencies that are not workspace packages", async () => {
    const plan = await planFor("acme", ["packages/web/src/app.tsx"]);
    expect(placementsOf(plan, "packages/web/src/app.tsx")).toMatchObject([{ kind: "package", package: "@acme/web" }]);
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
  });

  it("reports one problem naming both files when auto finds neither", async () => {
    const problems = await problemsOf("acme", { "pnpm-workspace.yaml": null, "package.json": null });
    expect(problems.map((problem) => problem.file)).toEqual(["package.json"]);
    expect(problems[0]?.message).toContain("pnpm-workspace.yaml");
  });

  it("requires pnpm-workspace.yaml when discovery is pnpm", async () => {
    const config = `lanes:\n  one:\n    packages: ["@npm/one"]\nworkspace:\n  discovery: pnpm\nunmatched: all\n`;
    const problems = await problemsOf("npm-array", { [CONFIG]: config });
    expect(problems.map((problem) => problem.file)).toEqual(["pnpm-workspace.yaml"]);
  });

  it("requires a workspaces field for npm discovery", async () => {
    const problems = await problemsOf("npm-array", { "package.json": JSON.stringify({ name: "npm-array" }) });
    expect(problems.map(({ file, where }) => ({ file, where }))).toEqual([
      { file: "package.json", where: "workspaces" },
    ]);
  });

  it("reports a duplicate package name with both directories", async () => {
    const problems = await problemsOf("acme", { "packages/ui/package.json": JSON.stringify({ name: "@acme/api" }) });
    expect(problems).toHaveLength(1);
    expect(problems[0]?.file).toBe("packages/ui/package.json");
    expect(problems[0]?.message).toContain("packages/api");
  });

  it("reports a manifest that is not valid JSON", async () => {
    const problems = await problemsOf("acme", { "packages/ui/package.json": "{ name" });
    expect(problems.map((problem) => problem.file)).toEqual(["packages/ui/package.json"]);
  });

  it.each([
    ["pnpm-workspace.yaml", { "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n  - "./"\n' }, "packages[1]"],
    [
      "package.json",
      { "pnpm-workspace.yaml": null, "package.json": '{ "workspaces": ["packages/*", ""] }' },
      "workspaces[1]",
    ],
  ])("reports a workspace glob in %s that cannot be used", async (file, overrides, where) => {
    const problems = await problemsOf("acme", overrides);
    expect(problems.map((problem) => ({ file: problem.file, where: problem.where }))).toEqual([{ file, where }]);
  });
});
