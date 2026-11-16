import { describe, expect, it } from "vitest";
import { loadModel } from "../src/load/index.ts";
import { CONFIG, loadFixture, problemsOf } from "./support/model.ts";
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
    ["ui", "r:@acme/ui@^1"],
    ["ui", "file:..\\ui"],
    ["ui", "../web/../ui"],
    ["ui", "file:../ui/"],
    ["@acme/ui", "workspace:"],
    ["@acme/ui", "workspace:^"],
    ["@acme/ui", "workspace:~"],
    ["@acme/ui", "workspace:1.0.0"],
    ["ui", "workspace:ui@*"],
    ["ui", "npm:ui@latest"],
    ["@acme/ui", "jsr:^1.0.0"],
    ["@acme/ui", "jsr:1.0.0"],
    ["@acme/ui", "jsr:latest"],
    ["@acme/ui", "gh:latest"],
    ["@acme/ui", "catalog:"],
    ["@acme/ui", "catalog:default"],
    ["@acme/ui", "catalog:ui2"],
    ["@acme/ui", "1.2.3"],
    ["@acme/ui", "^1.0.0"],
    ["@acme/ui", "latest"],
  ])("follows %s: %s to its workspace target", async (key, specifier) => {
    const unscoped = specifier.includes(":ui@");
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { [key]: specifier } }),
      ...(unscoped ? { "packages/ui/package.json": JSON.stringify({ name: "ui" }) } : {}),
    });
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
  });

  it.each(["workspace:@missing/ui@*", "workspace:*"])(
    "rejects an unresolved workspace reference %s with its manifest and key",
    async (specifier) => {
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
    },
  );

  it.each(["3d", "v1-compat", "@acme/ui"])("includes workspace alias %s alongside its dependency key", async (name) => {
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
      "packages/ui/package.json": JSON.stringify({ name }),
      "packages/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: { "@acme/api": `workspace:${name}@*` },
      }),
    });
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
  });

  it.each(["workspace:*", "workspace:^", "workspace:~1.2.0", "workspace:@other/name"])(
    "uses the key for workspace range %s",
    async (specifier) => {
      const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
        "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { "@acme/ui": specifier } }),
      });
      expect(running(plan)).toEqual(["web", "e2e", "lint"]);
    },
  );

  it.each([
    ["react", "catalog:"],
    ["react", "catalog:default"],
    ["react", "catalog:react19"],
    ["string-width-cjs", "npm:string-width@^4.2.0"],
    ["string-width-cjs", "npm:string-width"],
    ["@std/path", "jsr:^1.0.0"],
    ["@luca/cases", "jsr:@luca/cases@^1"],
    ["@luca/cases", "jsr:@luca/cases"],
    ["ui", "npm:@missing/ui@*"],
    ["ui", "corp:@missing/ui@*"],
    ["lib", "work:@corp/lib@^2.0.0"],
    ["lib", "r:@corp/lib@^2.0.0"],
    ["lib", "gh:@my-org/private-pkg"],
    ["left-pad", "npmjs:left-pad"],
    ["express", "nightly"],
    ["express", "1.0.0"],
    ["express", ">=0.1.0 <0.2.0"],
    ["node", "tool:24"],
    ["node", "runtime:24"],
    ["serde", "crate:serde"],
    ["httpx", "pypi:httpx"],
  ])("ignores external registry dependency %s: %s", async (key, specifier) => {
    const loaded = await loadFixture("acme", {
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { [key]: specifier } }),
    });
    expect(loaded.ok).toBe(true);
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { [key]: specifier } }),
    });
    expect(running(plan)).toEqual(["lint"]);
  });

  it.each([
    "https://example.com/ui.tgz",
    "http://example.com/ui.tar.gz",
    "https://github.com/acme/ui.git",
    "git://example.com/ui.git",
    "git+https://example.com/ui.git",
    "git+http://example.com/ui.git",
    "git+ssh://git@example.com/ui.git#v1.0.0",
    "git@github.com:acme/ui.git",
    "ssh://git@example.com/ui.git",
    "github:acme/ui",
    "gitlab:acme/ui",
    "bitbucket:acme/ui",
    "gist:106cfef49f8476b753a9cbbf9c65aff1",
    "acme/ui",
    "acme/ui#97edff6f525f192a3f83cea1944765f769ae2678",
    "acme/ui#master",
    "acme/ui#heads/canary",
    "acme/ui#2.0.1",
    "acme/ui#v0.0.7",
    "acme/ui#semver:1.0.0",
    "acme/ui#semver:v0.0.7",
    "acme/ui#semver:^2.0.0",
    "acme/ui#semver:<=v0.0.7",
    "acme/ui#path:/packages/ui",
    "acme/ui.git#beta&path:/packages/ui",
    "acme/ui.git#beta::path:packages/ui",
    "git+file:../ui",
    "tool:24",
    "runtime:24",
  ])("keeps the conservative key lookup for %s", async (specifier) => {
    const manifest = (key: string) => ({
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { [key]: specifier } }),
    });
    expect(running(await planFor("acme", ["packages/ui/src/button.tsx"], manifest("@acme/ui")))).toEqual([
      "web",
      "e2e",
      "lint",
    ]);
    expect(running(await planFor("acme", ["packages/ui/src/button.tsx"], manifest("external")))).toEqual(["lint"]);
  });

  it.each(["catalog:", "catalog:default", "catalog:ui2"])(
    "dereferences %s before finding its target",
    async (catalog) => {
      for (const specifier of [
        "npm:@acme/ui@^1",
        "workspace:@acme/ui@*",
        "link:./packages/ui",
        "file:./packages/ui",
        "./packages/ui",
        "workspace:./packages/ui",
      ]) {
        const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
          "pnpm-workspace.yaml": `packages: ["packages/*", "packages/web/e2e", "tools/*"]\ncatalog:\n  ui: ${JSON.stringify(specifier)}\ncatalogs:\n  ui2:\n    ui: ${JSON.stringify(specifier)}\n`,
          "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { ui: catalog } }),
        });
        expect(running(plan)).toEqual(["web", "e2e", "lint"]);
      }
    },
  );

  it.each([
    "workspace:../missing",
    "link:../missing",
    "file:../missing",
    "../missing",
    "E:/packages/ui",
    "file:../ui.tgz",
    "~/ui",
    "/packages/ui",
    "link:../../../outside",
    "./ui.tar",
    "./ui.tar.gz",
    "./ui.tgz",
  ])("loads a local path outside the discovered packages %s", async (specifier) => {
    const loaded = await loadFixture("acme", {
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { ui: specifier } }),
    });
    expect(loaded.ok).toBe(true);
  });

  it.each(
    [
      "link:../ui/dist",
      "file:../ui/dist",
      "../ui/dist",
      "workspace:../ui/dist",
      "file:../ui/artifact.tgz",
      "../ui/artifact.tgz",
    ].flatMap((specifier) => [false, true].map((manifest) => ({ specifier, manifest }))),
  )("follows $specifier to its owner with manifest=$manifest", async ({ specifier, manifest }) => {
    const path = specifier.endsWith(".tgz") ? "packages/ui/artifact.tgz" : "packages/ui/dist/index.js";
    const plan = await planFor("acme", [path], {
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { kit: specifier } }),
      [path]: "content",
      ...(manifest ? { "packages/ui/dist/package.json": JSON.stringify({ name: "dist-ui" }) } : {}),
    });
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
  });

  it("uses the deepest workspace owner of a path", async () => {
    const files = {
      "pnpm-workspace.yaml": 'packages: ["packages/*", "packages/web/e2e", "tools/*", "packages/ui/inner"]\n',
      "packages/ui/inner/package.json": JSON.stringify({ name: "@acme/inner" }),
      "packages/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: { kit: "link:../ui/inner/dist" },
      }),
    };
    expect(running(await planFor("acme", ["packages/ui/inner/dist/index.js"], files))).toEqual(["web", "e2e", "lint"]);
    expect(running(await planFor("acme", ["packages/ui/src/button.tsx"], files))).toEqual(["lint"]);
  });

  it("does not match a sibling directory with the same prefix", async () => {
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
      "packages/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: { kit: "link:../ui-other/dist" },
      }),
    });
    expect(running(plan)).toEqual(["lint"]);
  });

  it.each(["link:../UI", "file:../UI", "../UI", "link:../UI/DIST", "workspace:../UI"])(
    "includes the case-insensitive path target of %s",
    async (specifier) => {
      const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
        "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { kit: specifier } }),
      });
      expect(running(plan)).toEqual(["web", "e2e", "lint"]);
    },
  );

  it("keeps every case-insensitive match and the original case-sensitive ancestor", async () => {
    const files: Record<string, string> = {
      [CONFIG]: 'workspace:\n  discovery: npm\nlanes:\n  app:\n    packages: ["app"]\nunmatched: all\n',
      "package.json": JSON.stringify({ workspaces: ["packages/**"] }),
      "packages/app/package.json": JSON.stringify({ name: "app", dependencies: { kit: "link:../UI/inner/dist" } }),
      "packages/UI/package.json": JSON.stringify({ name: "upper" }),
      "packages/ui/inner/package.json": JSON.stringify({ name: "lower-inner" }),
      "packages/Ui/INNER/package.json": JSON.stringify({ name: "mixed-inner" }),
    };
    const model = await loadModel(
      {
        files: () => Promise.resolve(Object.keys(files)),
        read: (path) =>
          Promise.resolve(files[path] === undefined ? { kind: "missing" } : { kind: "file", text: files[path] }),
      },
      CONFIG,
    );
    expect(model.ok).toBe(true);
    if (!model.ok) return;
    for (const name of ["upper", "lower-inner", "mixed-inner"]) {
      const target = [...model.value.packageDirs[0].values()].find((pkg) => pkg.name === name);
      const through = [...(target?.reach ?? [])].find(([lane]) => lane === "app")?.[1];
      expect(through).toMatchObject({ kind: "reads", chain: ["app", name] });
    }
  });

  it.each([".local/x", ".local", "..local/x"])("follows dot-prefixed local path %s", async (specifier) => {
    const dir = `packages/web/${specifier}`;
    const plan = await planFor("acme", [`${dir}/index.js`], {
      "pnpm-workspace.yaml": `packages: ["packages/*", "packages/web/e2e", "tools/*", "${dir}"]\n`,
      [`${dir}/package.json`]: JSON.stringify({ name: "@acme/local" }),
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", dependencies: { x: specifier } }),
    });
    expect(running(plan)).toEqual(["web", "e2e", "lint"]);
  });

  it("keeps both the dependency key and the alias target", async () => {
    const overrides = {
      "packages/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: { "@acme/api": "npm:@acme/ui@*" },
      }),
    };
    expect(running(await planFor("acme", ["packages/api/src/user.ts"], overrides))).toEqual([
      "api",
      "web",
      "e2e",
      "lint",
    ]);
    expect(running(await planFor("acme", ["packages/ui/src/button.tsx"], overrides))).toEqual(["web", "e2e", "lint"]);
  });

  it("routes a vendored file dependency by path rules and runs every lane when none claims it", async () => {
    const config = 'lanes:\n  api:\n    packages: ["@acme/api"]\n  web:\n    packages: ["@acme/web"]\nunmatched: all\n';
    const files = {
      "packages/web/package.json": JSON.stringify({
        name: "@acme/web",
        dependencies: { vendor: "file:../../vendor/lib" },
      }),
      "vendor/lib/package.json": JSON.stringify({ name: "vendor", version: "1.0.0" }),
      "vendor/lib/index.js": "export const value = 1;",
      [CONFIG]: config,
    };
    const path = "vendor/lib/index.js";
    const unclaimed = await planFor("acme", [path], files);
    expect(placementKinds(unclaimed, path)).toEqual(["unmatched"]);
    expect(running(unclaimed)).toEqual(["api", "web"]);
    const claimed = await planFor("acme", [path], {
      ...files,
      [CONFIG]:
        config +
        'paths:\n  - match: ["vendor/lib/**"]\n    packages: ["@acme/web"]\n    via: code\n    why: The web package reads the vendored library.\n',
    });
    expect(placementKinds(claimed, path)).toEqual(["row"]);
    expect(running(claimed)).toEqual(["web"]);
  });

  it.each([
    {
      "pnpm-workspace.yaml":
        'packages: ["packages/*", "packages/web/e2e", "tools/*"]\noverrides:\n  legacy: link:./packages/ui\n',
    },
    { "package.json": JSON.stringify({ pnpm: { overrides: { "parent@1>legacy": "workspace:@acme/ui@*" } } }) },
    { "package.json": JSON.stringify({ overrides: { parent: { child: { ".": "npm:@acme/ui@^1" } } } }) },
    { "package.json": JSON.stringify({ overrides: { parent: { legacy: "file:../ui" } } }) },
    { "package.json": JSON.stringify({ overrides: { legacy: "$@acme/ui" }, dependencies: { "@acme/ui": "^1" } }) },
    { "package.json": JSON.stringify({ overrides: { legacy: "$kit" }, dependencies: { kit: "npm:@acme/ui@^1" } }) },
    {
      "pnpm-workspace.yaml":
        'packages: ["packages/*", "packages/web/e2e", "tools/*"]\ncatalog:\n  legacy: npm:@acme/ui@^1\noverrides:\n  legacy: "catalog:"\n',
    },
  ])("adds override targets to packages that do not declare the overridden dependency", async (files) => {
    expect(running(await planFor("acme", ["packages/ui/src/button.tsx"], files))).toEqual([
      "api",
      "web",
      "e2e",
      "lint",
    ]);
  });

  it.each(
    ["yaml", "pnpm", "npm"].flatMap((source) =>
      ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].map((field) => ({
        source,
        field,
      })),
    ),
  )("expands $ references from $source using root $field", async ({ source, field }) => {
    const overrides = { legacy: "$kit" };
    const root = {
      [field]: { kit: "link:./packages/ui" },
      ...(source === "npm" ? { overrides } : source === "pnpm" ? { pnpm: { overrides } } : {}),
    };
    const files = {
      "package.json": JSON.stringify(root),
      ...(source === "yaml"
        ? {
            "pnpm-workspace.yaml":
              'packages: ["packages/*", "packages/web/e2e", "tools/*"]\noverrides:\n  legacy: $kit\n',
          }
        : {}),
    };
    expect(running(await planFor("acme", ["packages/ui/src/button.tsx"], files))).toEqual([
      "api",
      "web",
      "e2e",
      "lint",
    ]);
  });

  it.each([1, true, null, [], { "left-pad": 1 }, { parent: { child: [] } }])(
    "loads override values that cannot name a package %j",
    async (overrides) => {
      const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
        "package.json": JSON.stringify({ overrides }),
      });
      expect(running(plan)).toEqual(["web", "e2e", "lint"]);
    },
  );

  it("keeps valid override targets beside ignored values", async () => {
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
      "package.json": JSON.stringify({
        overrides: { parent: { ignored: 1, legacy: "link:./packages/ui" }, other: [] },
      }),
    });
    expect(running(plan)).toEqual(["api", "web", "e2e", "lint"]);
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
