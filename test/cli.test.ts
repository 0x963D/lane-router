import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

  it("diffs the merge base of --base and --head against --head", async () => {
    const repo = acmeRepo();
    repo.git("checkout", "--quiet", "-b", "feature");
    repo.write("packages/ui/src/button.tsx", 'export const Button = "large";\n');
    repo.commit("Make the button large");
    repo.git("checkout", "--quiet", "main");
    repo.write("packages/api/src/user.ts", 'export const user = "grace";\n');
    repo.commit("Rename the user");

    const { code, stdout } = await cli(["explain", "--base", "main", "--head", "feature", "--json"], repo.dir);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject(decisions({ api: "skip", web: "run", e2e: "run", lint: "run" }));
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
