import { describe, expect, it } from "vitest";
import { jsonObject, runAction, type ActionEvent } from "./support/action.ts";
import { compare, fakeGitHub } from "./support/fake-github.ts";
import { fixtureCopy, fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture } from "./support/git-fixture.ts";
import { CONFIG } from "./support/model.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const ACME = fixtureDir("acme");
const ALL = ["api", "web", "e2e", "lint"];

function pullRequest(changedFiles: number): ActionEvent {
  return {
    name: "pull_request",
    payload: { pull_request: { base: { sha: BASE }, head: { sha: HEAD }, changed_files: changedFiles } },
  };
}

function push(before: string, after = HEAD): ActionEvent {
  return { name: "push", payload: { before, after } };
}

function parsed(text: string | undefined): unknown {
  return JSON.parse(text ?? "null");
}

describe("the files input", () => {
  it("is trusted as complete and never calls the API", async () => {
    const github = await fakeGitHub();
    const run = await runAction({
      workspace: ACME,
      inputs: { files: "packages/ui/src/button.tsx\n\n" },
      event: pullRequest(1),
      github,
    });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
    expect(github.requests).toEqual([]);
  });

  it("produces every output of the contract", async () => {
    const run = await runAction({
      workspace: ACME,
      inputs: { files: "packages/ui/src/button.tsx" },
      event: pullRequest(1),
    });
    expect(run.outputs).toMatchObject({ api: "skip", web: "run", e2e: "run", lint: "run" });
    expect(run.outputs["docs-only"]).toBe("false");
    expect(run.outputs["none-required"]).toBe("false");
    const reasons = jsonObject(run.outputs.reasons);
    expect(Object.keys(reasons)).toEqual(ALL);
    expect(parsed(run.outputs.matrix)).toEqual({
      include: ["web", "e2e", "lint"].map((lane) => ({ lane, base: BASE, reason: reasons[lane] })),
    });
  });

  it("sets none-required and an empty matrix when no lane runs", async () => {
    const run = await runAction({ workspace: ACME, inputs: { files: "README.md" }, event: pullRequest(1) });
    expect(parsed(run.outputs.lanes)).toEqual([]);
    expect(parsed(run.outputs.matrix)).toEqual({ include: [] });
    expect(run.outputs["none-required"]).toBe("true");
    expect(run.outputs["docs-only"]).toBe("true");
  });

  it("writes a job summary with one row per lane", async () => {
    const run = await runAction({
      workspace: ACME,
      inputs: { files: "packages/ui/src/button.tsx" },
      event: pullRequest(1),
    });
    expect(run.summary).toContain(`mode pr, base ${BASE.slice(0, 7)}, head ${HEAD.slice(0, 7)}, 1 file, complete`);
    expect(run.summary.split("\n").filter((line) => /^\| (api|web|e2e|lint) \|/.test(line))).toHaveLength(4);
  });
});

describe("the compare API", () => {
  it("compares the pull request's base and head", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["packages/ui/src/button.tsx"]);
    const run = await runAction({ workspace: ACME, event: pullRequest(1), github });
    expect(github.requests).toEqual([`/repos/acme/mono/compare/${BASE}...${HEAD}`]);
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
  });

  it("fails closed when the listing differs from the pull request's changed_files", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["README.md", "docs/guide.md"]);
    const run = await runAction({ workspace: ACME, event: pullRequest(3), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations).toMatchObject([{ level: "warning" }]);
  });

  it("fails closed when the listing reaches the 300-file cap", async () => {
    const github = await fakeGitHub();
    compare(
      github,
      BASE,
      HEAD,
      Array.from({ length: 300 }, (_, index) => `docs/page-${String(index)}.md`),
    );
    const run = await runAction({ workspace: ACME, event: pullRequest(300), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations.map(({ level }) => level)).toEqual(["warning"]);
    expect(run.annotations[0]?.message).toContain("at most 300 files");
  });

  it("skips the count check for a caller-supplied range", async () => {
    const github = await fakeGitHub();
    compare(github, "c".repeat(40), HEAD, ["packages/ui/src/button.tsx"]);
    const run = await runAction({
      workspace: ACME,
      inputs: { base: "c".repeat(40) },
      event: pullRequest(9),
      github,
    });
    expect(run.outputs.complete).toBe("true");
  });

  it("routes both paths of a rename", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [
      { filename: "packages/ui/src/user.ts", previous_filename: "packages/api/src/user.ts", status: "renamed" },
    ]);
    const run = await runAction({ workspace: ACME, event: pullRequest(1), github });
    expect(run.outputs.complete).toBe("true");
    expect(run.outputs.api).toBe("run");
  });

  it("accepts file statuses it does not model, such as copied", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [{ filename: "packages/ui/src/copy.tsx", status: "copied" }]);
    const run = await runAction({ workspace: ACME, event: pullRequest(1), github });
    expect(run.outputs.complete).toBe("true");
  });

  it("compares before...after on a push", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["packages/api/src/user.ts"]);
    const run = await runAction({ workspace: ACME, event: push(BASE), github });
    expect(github.requests).toEqual([`/repos/acme/mono/compare/${BASE}...${HEAD}`]);
    expect(run.summary).toContain("mode push");
    expect(run.outputs.complete).toBe("true");
  });

  it("fails closed without a request when a push has an all-zero before", async () => {
    const github = await fakeGitHub();
    const run = await runAction({ workspace: ACME, event: push("0".repeat(40)), github });
    expect(run.exitCode).toBe(0);
    expect(github.requests).toEqual([]);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
  });

  it("re-roots paths under a nested working-directory and fails closed on a path outside it", async () => {
    const repo = gitFixture(ACME, tempDir(), { at: "mono" });
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["mono/packages/ui/src/button.tsx"]);
    const inputs = { "working-directory": "mono" };
    const inside = await runAction({ workspace: repo.dir, inputs, event: pullRequest(1), github });
    expect(parsed(inside.outputs.lanes)).toEqual(["web", "e2e", "lint"]);

    compare(github, BASE, HEAD, ["mono/packages/ui/src/button.tsx", "LICENSE"]);
    const outside = await runAction({ workspace: repo.dir, inputs, event: pullRequest(2), github });
    expect(parsed(outside.outputs.lanes)).toEqual(ALL);
    expect(outside.outputs.complete).toBe("false");
  });
});

describe("errors after the config is valid", () => {
  it("select every lane, annotate the error and let the step succeed when the API fails", async () => {
    const github = await fakeGitHub();
    github.on(`/compare/${BASE}...${HEAD}`, { status: 500, body: { message: "Server Error" } });
    const run = await runAction({ workspace: ACME, event: pullRequest(1), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations.map(({ level }) => level)).toEqual(["error"]);
    expect(run.annotations[0]?.message).toContain("returned 500");
  });

  it("do the same when the API cannot be reached", async () => {
    const run = await runAction({ workspace: ACME, event: pullRequest(1) });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.annotations).toMatchObject([{ level: "error" }]);
  });
});

describe("errors before a model exists", () => {
  it("fail the step with every config problem and set no output", async () => {
    const dir = fixtureCopy("acme", {
      [CONFIG]: `lanes:\n  api:\n    pakages: ["@acme/api"]\n  web:\n    packages: ["@acme/nope"]\nunmatched: all\n`,
    });
    const run = await runAction({ workspace: dir, inputs: { files: "README.md" }, event: pullRequest(1) });
    expect(run.exitCode).toBe(1);
    expect(run.outputs).toEqual({});
    expect(run.annotations).toHaveLength(1);
    expect(run.annotations[0]?.message).toContain(".github/lanes.yml:3:5  lanes.api.pakages");
    expect(run.annotations[0]?.message).toContain(".github/lanes.yml:5:16  lanes.web.packages[0]");
  });

  it("fail the step on a workspace problem", async () => {
    const dir = fixtureCopy("acme", { "packages/ui/package.json": JSON.stringify({ name: "@acme/api" }) });
    const run = await runAction({ workspace: dir, inputs: { files: "README.md" }, event: pullRequest(1) });
    expect(run.exitCode).toBe(1);
    expect(run.outputs).toEqual({});
  });

  it("fail the step when mode cannot be taken from the event", async () => {
    const run = await runAction({
      workspace: ACME,
      inputs: { files: "README.md" },
      event: { name: "workflow_dispatch", payload: {} },
    });
    expect(run.exitCode).toBe(1);
    expect(run.annotations[0]?.message).toContain("the mode input is required");
  });

  it("accept an explicit mode with base and head for any other event", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["packages/api/src/user.ts"]);
    const run = await runAction({
      workspace: ACME,
      inputs: { mode: "push", base: BASE, head: HEAD },
      event: { name: "workflow_dispatch", payload: {} },
      github,
    });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
  });

  it("fail the step on an event payload that is missing a field the Action needs", async () => {
    const run = await runAction({
      workspace: ACME,
      event: { name: "pull_request", payload: { pull_request: {} } },
    });
    expect(run.exitCode).toBe(1);
    expect(run.annotations[0]?.message).toContain("pull_request.base");
  });
});
