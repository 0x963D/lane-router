import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.ts";
import { cli } from "./support/cli.ts";
import { fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture, type GitFixture } from "./support/git-fixture.ts";
import { CONFIG } from "./support/model.ts";

function acmeRepo(options: { readonly at?: string } = {}): GitFixture {
  return gitFixture(fixtureDir("acme"), tempDir(), options);
}

function decisions(lanes: Readonly<Record<string, "run" | "skip">>) {
  return { lanes: Object.entries(lanes).map(([lane, decision]) => ({ lane, decision })) };
}

describe("lane-router explain", () => {
  it("writes the explanation in bounded chunks and waits for the output sink", async () => {
    const repo = acmeRepo();
    repo.write("tools/new-file.ts", "export const x = 1;\n");
    const head = repo.commit("Add an unclaimed path");
    const parts: string[] = [];
    const code = await runCli(["explain", "--base", repo.base, "--head", head, "--json"], {
      cwd: repo.dir,
      stdout: async (text) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        parts.push(text);
      },
      stderr: (message) => {
        throw new Error(message);
      },
    });
    expect(code).toBe(0);
    expect(parts.length).toBeGreaterThan(4);
    expect(JSON.parse(parts.join("\n"))).toMatchObject({
      ...decisions({ api: "run", web: "run", e2e: "run", lint: "run" }),
      paths: [{ path: "tools/new-file.ts", placements: [{ kind: "unmatched", lanes: ["api", "web", "e2e", "lint"] }] }],
    });
  });

  it("routes a divergent range in PR mode and runs all lanes in push mode", async () => {
    const repo = acmeRepo();
    repo.git("checkout", "--quiet", "-b", "feature");
    repo.write("packages/ui/src/button.tsx", 'export const Button = "large";\n');
    const feature = repo.commit("Make the button large");
    repo.git("checkout", "--quiet", "main");
    repo.write("packages/api/src/user.ts", 'export const user = "grace";\n');
    repo.commit("Rename the user");

    const { code, stdout } = await cli(["explain", "--base", "main", "--head", "feature", "--json"], repo.dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject(decisions({ api: "skip", web: "run", e2e: "run", lint: "run" }));
    for (const [base, head, status] of [
      ["main", "feature", "diverged"],
      [feature, repo.base, "behind"],
    ] as const) {
      const push = await cli(["explain", "--mode", "push", "--base", base, "--head", head, "--json"], repo.dir);
      expect(push.code).toBe(0);
      expect(JSON.parse(push.stdout)).toMatchObject({
        mode: "push",
        complete: false,
        incomplete: { kind: "not-fast-forward", status, mergeBase: repo.base },
        ...decisions({ api: "run", web: "run", e2e: "run", lint: "run" }),
      });
    }
  });

  it("routes a fast-forward push and an identical push using the selected mode", async () => {
    const repo = acmeRepo();
    repo.write("packages/ui/src/button.tsx", "export const Button = 42;\n");
    const head = repo.commit("Change the button");
    const args = ["explain", "--mode", "push", "--head", head, "--json"];

    const fastForward = await cli([...args, "--base", repo.base], repo.dir);
    expect(fastForward.code).toBe(0);
    expect(JSON.parse(fastForward.stdout)).toMatchObject({
      mode: "push",
      complete: true,
      ...decisions({ api: "skip", web: "run", e2e: "run", lint: "run" }),
    });

    const identical = await cli([...args, "--base", head], repo.dir);
    expect(identical.code).toBe(0);
    expect(JSON.parse(identical.stdout)).toMatchObject({
      mode: "push",
      complete: true,
      ...decisions({ api: "skip", web: "skip", e2e: "skip", lint: "skip" }),
    });
  });

  it("runs every lane in push mode if the base is absent or unavailable", async () => {
    const repo = acmeRepo();
    for (const [options, kind] of [
      [[], "no-base"],
      [["--base", "0".repeat(40)], "no-base"],
      [["--base=--unfetched"], "error"],
    ] as const) {
      const result = await cli(["explain", "--mode", "push", "--head", repo.base, "--json", ...options], repo.dir);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "push",
        complete: false,
        incomplete: { kind },
        ...decisions({ api: "run", web: "run", e2e: "run", lint: "run" }),
      });
    }
  });

  it.each(["blob:none", "tree:0"])("reads the base manifest on demand with %s", async (filter) => {
    const repo = acmeRepo();
    const baseBlob = repo.git("rev-parse", repo.base + ":packages/ui/package.json");
    repo.write("packages/ui/package.json", '{"name":"@acme/ui","description":"changed"}\n');
    const head = repo.commit("Change the UI manifest");
    repo.git("config", "uploadpack.allowFilter", "true");
    repo.git("config", "uploadpack.allowAnySHA1InWant", "true");
    const clone = tempDir();
    execFileSync("git", ["clone", "--quiet", "--filter=" + filter, pathToFileURL(repo.dir).href, clone]);
    const missing = () =>
      execFileSync("git", ["cat-file", "--batch-check"], {
        cwd: clone,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        input: baseBlob + "\n",
        encoding: "utf8",
      }).trim();
    expect(missing()).toBe(baseBlob + " missing");

    const result = await cli(["explain", "--base", repo.base, "--head", head, "--json"], clone);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      complete: true,
      ...decisions({ api: "skip", web: "run", e2e: "run", lint: "run" }),
    });
    expect(missing()).toMatch(new RegExp("^" + baseBlob + " blob "));
  });

  it("routes both paths of a rename", async () => {
    const repo = acmeRepo();
    repo.move("packages/api/src/user.ts", "packages/ui/src/user.ts");
    const head = repo.commit("Move the user model");

    const { stdout } = await cli(["explain", "--base", repo.base, "--head", head, "--json"], repo.dir);
    expect(JSON.parse(stdout)).toMatchObject({
      paths: [{ path: "packages/api/src/user.ts" }, { path: "packages/ui/src/user.ts" }],
      ...decisions({ api: "run", web: "run", e2e: "run", lint: "run" }),
    });
  });

  it("routes changed gitlinks even when local Git ignores submodule changes", async () => {
    const repo = acmeRepo();
    const path = "packages/ui/vendor";
    repo.git("update-index", "--add", "--cacheinfo", "160000," + repo.base + "," + path);
    repo.git("commit", "--quiet", "-m", "Pin the dependency");
    const before = repo.git("rev-parse", "HEAD");
    repo.git("update-index", "--cacheinfo", "160000," + before + "," + path);
    repo.git("commit", "--quiet", "-m", "Update the dependency");
    repo.git("config", "diff.ignoreSubmodules", "all");
    expect(repo.git("diff", "--name-only", before, "HEAD")).toBe("");

    const { code, stdout } = await cli(["explain", "--base", before, "--head", "HEAD", "--json"], repo.dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      complete: true,
      paths: [{ path }],
      ...decisions({ api: "skip", web: "run", e2e: "run", lint: "run" }),
    });
  });

  it("reads the original commit when a local replacement points to a different tree", async () => {
    const repo = acmeRepo();
    repo.write("packages/ui/src/button.tsx", "export const Button = 42;\n");
    const head = repo.commit("Change the button");
    repo.git("switch", "--quiet", "-c", "replacement", repo.base);
    repo.write("packages/api/src/user.ts", "export const user = 'other';\n");
    repo.git("replace", head, repo.commit("Change the API"));

    const { code, stdout } = await cli(["explain", "--base", repo.base, "--head", head, "--json"], repo.dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      complete: true,
      paths: [{ path: "packages/ui/src/button.tsx" }],
      ...decisions({ api: "skip", web: "run", e2e: "run", lint: "run" }),
    });
  });

  it("prints the header, the lane table and each path with its placements", async () => {
    const repo = acmeRepo();
    repo.write("fixtures/browser/login.json", '{ "user": "grace" }\n');
    const head = repo.commit("Change a browser fixture");

    const { code, stdout } = await cli(["explain", "--base", repo.base, "--head", head], repo.dir);
    expect(code).toBe(0);
    expect(stdout.split("\n")).toEqual([
      `mode pr, base ${repo.base.slice(0, 7)}, head ${head.slice(0, 7)}, 1 file, complete, not docs-only`,
      "",
      "lane  decision  reason",
      "api   skip      nothing it reads changed",
      "web   run       fixtures/browser/login.json matches paths[2] for @acme/web via tests: The browser tests load these fixtures.",
      "e2e   skip      nothing it reads changed",
      "lint  run       floor lane, runs for every change that is not docs-only",
      "",
      "fixtures/browser/login.json",
      "  paths[2] @acme/web via tests  web  The browser tests load these fixtures.",
    ]);
  });

  it("reads the config and the workspace at --head, not from the working tree", async () => {
    const repo = acmeRepo();
    repo.write("packages/site/package.json", '{ "name": "@acme/site" }\n');
    repo.write(CONFIG, `lanes:\n  site:\n    packages: ["@acme/site"]\nunmatched: all\n`);
    const head = repo.commit("Add the site package and its lane");
    repo.write(CONFIG, "lanes: [this is not valid\n");

    const { code, stdout } = await cli(["explain", "--base", repo.base, "--head", head, "--json"], repo.dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject(
      decisions({ site: "run", api: "run", web: "run", e2e: "run", lint: "run" }),
    );
  });

  it("runs against --cwd from any directory", async () => {
    const repo = acmeRepo();
    repo.write("packages/ui/src/button.tsx", 'export const Button = "large";\n');
    const head = repo.commit("Make the button large");
    const args = ["explain", "--base", repo.base, "--head", head];

    const inside = await cli(args, repo.dir);
    const elsewhere = await cli([...args, "--cwd", repo.dir], tempDir());
    expect(elsewhere).toEqual(inside);
  });

  it("routes paths relative to a nested --cwd and fails closed on a path outside it", async () => {
    const repo = acmeRepo({ at: "mono" });
    repo.write("packages/ui/src/button.tsx", 'export const Button = "large";\n');
    const inside = repo.commit("Make the button large");
    writeFileSync(join(repo.dir, "LICENSE"), "MIT\n");
    const outside = repo.commit("Add a license outside the routed root");

    const routed = await cli(
      ["explain", "--base", repo.base, "--head", inside, "--cwd", repo.root, "--json"],
      repo.dir,
    );
    expect(JSON.parse(routed.stdout)).toMatchObject({
      complete: true,
      ...decisions({ api: "skip", web: "run", e2e: "run", lint: "run" }),
    });
    const closed = await cli(["explain", "--base", inside, "--head", outside, "--cwd", repo.root, "--json"], repo.dir);
    expect(JSON.parse(closed.stdout)).toMatchObject({
      complete: false,
      incomplete: { kind: "invalid-path", raw: "LICENSE" },
      ...decisions({ api: "run", web: "run", e2e: "run", lint: "run" }),
    });
  });

  it("ignores packages under a committed node_modules directory", async () => {
    const repo = gitFixture(fixtureDir("pnpm-negated"), tempDir());
    repo.write("packages/core/node_modules/copy/package.json", '{ "name": "@neg/core" }\n');
    repo.write("packages/core/index.js", "export const core = 2;\n");
    const head = repo.commit("Vendor a copy of core");

    const { code, stdout } = await cli(["explain", "--base", repo.base, "--head", head, "--json"], repo.dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject(decisions({ core: "run", lint: "run" }));
  });

  it("reads batched manifests by UTF-8 byte length, including shared blob IDs", async () => {
    const repo = acmeRepo();
    repo.write("pnpm-workspace.yaml", 'packages: ["packages/*", "fixtures/*"]\n');
    repo.write(
      CONFIG,
      'lanes:\n  check:\n    packages: ["check"]\n  ui:\n    packages: ["@acme/ui"]\nunmatched: all\n',
    );
    const manifest = '{"name":"check","description":"été 🧪","devDependencies":{"@acme/ui":"*"}}\n';
    repo.write("fixtures/one/package.json", manifest);
    repo.write("fixtures/two/package.json", manifest);
    const base = repo.commit("Add test fixtures with the same manifest");
    repo.write("fixtures/two/check.js", "export const check = 1;\n");
    const head = repo.commit("Change the second fixture");
    const { code, stdout } = await cli(["explain", "--base", base, "--head", head, "--json"], repo.dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject(decisions({ check: "run", ui: "skip" }));
  });

  it("exits 0 with every lane running when the revisions share no history", async () => {
    const repo = acmeRepo();
    repo.git("checkout", "--quiet", "--orphan", "unrelated");
    repo.commit("Start an unrelated history");

    const { code, stdout } = await cli(["explain", "--base", "main", "--head", "unrelated", "--json"], repo.dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      complete: false,
      incomplete: { kind: "error" },
      ...decisions({ api: "run", web: "run", e2e: "run", lint: "run" }),
    });
  });

  it.each([
    ["--base is missing", ["explain", "--head", "main"]],
    ["--head is missing in push mode", ["explain", "--mode", "push"]],
    ["the mode is unknown", ["explain", "--base", "main", "--head", "main", "--mode", "merge"]],
    ["a flag is unknown", ["explain", "--base", "main", "--head", "main", "--bse", "x"]],
    ["there is no command", ["--base", "main", "--head", "main"]],
    ["a ref does not resolve", ["explain", "--base", "nope", "--head", "main"]],
  ])("exits 2 with usage on stderr when %s", async (_, args) => {
    const repo = acmeRepo();
    const { code, stdout, stderr } = await cli(args, repo.dir);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("usage: lane-router explain");
  });

  it("exits 1 and lists the problems when the config at --head is invalid", async () => {
    const repo = acmeRepo();
    repo.write(CONFIG, `lanes:\n  api:\n    pakages: ["@acme/api"]\nunmatched: all\n`);
    const head = repo.commit("Break the config");

    const { code, stdout, stderr } = await cli(["explain", "--base", repo.base, "--head", head], repo.dir);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(".github/lanes.yml:3:5  lanes.api.pakages");
  });
});
