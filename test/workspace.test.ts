import { describe, expect, it } from "vitest";
import { CONFIG, loadFixture, problemsOf } from "./support/model.ts";

describe("workspace discovery", () => {
  it("falls back to npm workspaces when there is no pnpm-workspace.yaml", async () => {
    expect((await loadFixture("npm-array")).ok).toBe(true);
  });

  it("reads the object form of npm workspaces, with ./ prefixes and trailing slashes", async () => {
    expect((await loadFixture("npm-object")).ok).toBe(true);
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
});
