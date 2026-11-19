import { describe, expect, it } from "vitest";
import { jsonObject, pullRequestCheckout, runAction, type ActionEvent } from "./support/action.ts";
import { compare, fakeGitHub } from "./support/fake-github.ts";
import { fixtureCopy, fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture } from "./support/git-fixture.ts";
import { CONFIG } from "./support/model.ts";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const MERGE_BASE = "c".repeat(40);
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
  it.each(["in-process", "child"] as const)("is trusted as complete and never calls the API (%s)", async (driver) => {
    const github = await fakeGitHub();
    const run = await runAction({
      workspace: ACME,
      inputs: { files: "packages/ui/src/button.tsx\n\n" },
      event: pullRequest(1),
      github,
      process: driver,
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
    expect(run.summary).toContain(
      `mode pr&#44; base ${BASE.slice(0, 7)}&#44; head ${HEAD.slice(0, 7)}&#44; 1 file&#44; complete`,
    );
    expect(run.summary.split("\n").filter((line) => /^\| (api|web|e2e|lint) \|/.test(line))).toHaveLength(4);
  });

  it("writes hostile paths as summary text and keeps their output reasons intact", async () => {
    const path = "packages/ui/src/![x](https://example.invalid/x.png)[link](url)<b>`x`|.tsx";
    const run = await runAction({ workspace: ACME, inputs: { files: path }, event: pullRequest(1) });
    expect(run.exitCode).toBe(0);
    expect(run.summary).not.toMatch(/!\[|\[link\]|<b>|`x`/);
    expect(run.summary).toContain("&#33;&#91;x&#93;");
    expect(jsonObject(run.outputs.reasons).web).toBe(
      "packages/ui/src/![x](https:/example.invalid/x.png)[link](url)<b>`x`|.tsx is in @acme/ui, read through @acme/web",
    );
  });
});

function prCheckout(options: { at?: string } = {}) {
  return pullRequestCheckout(gitFixture(ACME, tempDir(), options));
}

describe("the compare API", () => {
  it("compares the default merge checkout and ignores the branch file count", async () => {
    const { base, merge, runner } = prCheckout();
    const github = await fakeGitHub();
    compare(github, base, merge, ["packages/ui/src/button.tsx"]);
    const run = await runAction({ ...runner(2), github });
    expect(github.requests).toEqual([`/repos/acme/mono/compare/${base}...${merge}`]);
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
    expect(run.annotations).toEqual([]);
  });

  it("fails closed when a PR head checkout's listing differs from changed_files", async () => {
    const { repo, base, head, runner } = prCheckout();
    repo.git("switch", "--detach", head);
    const github = await fakeGitHub();
    compare(github, base, head, ["README.md", "docs/guide.md"], { status: "diverged", mergeBase: repo.base });
    const run = await runAction({ ...runner(3), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations).toMatchObject([{ level: "warning" }]);
  });

  it("fails closed when the listing reaches the 300-file cap", async () => {
    const { base, merge, runner } = prCheckout();
    const github = await fakeGitHub();
    compare(
      github,
      base,
      merge,
      Array.from({ length: 300 }, (_, index) => `docs/page-${String(index)}.md`),
    );
    const run = await runAction({ ...runner(300), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations.map(({ level }) => level)).toEqual(["warning"]);
    expect(run.annotations[0]?.message).toContain("at most 300 files");
  });

  it("skips the count check for an explicit PR head input and accepts a matching ref", async () => {
    const { repo, base, head, runner } = prCheckout();
    repo.git("switch", "patch");
    const github = await fakeGitHub();
    compare(github, base, head, ["packages/ui/src/button.tsx"], { status: "diverged", mergeBase: repo.base });
    const run = await runAction({ ...runner(9), inputs: { head: "patch" }, github });
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
    expect(run.annotations).toEqual([]);
  });

  it("routes both paths of a rename", async () => {
    const { base, merge, runner } = prCheckout();
    const github = await fakeGitHub();
    compare(github, base, merge, [
      { filename: "packages/ui/src/user.ts", previous_filename: "packages/api/src/user.ts", status: "renamed" },
    ]);
    const run = await runAction({ ...runner(1), github });
    expect(run.outputs.complete).toBe("true");
    expect(run.outputs.api).toBe("run");
  });

  it("accepts file statuses it does not model, such as copied", async () => {
    const { base, merge, runner } = prCheckout();
    const github = await fakeGitHub();
    compare(github, base, merge, [{ filename: "packages/ui/src/copy.tsx", status: "copied" }]);
    const run = await runAction({ ...runner(1), github });
    expect(run.outputs.complete).toBe("true");
  });

  it("routes the default range for a PR head checkout even when the base has diverged", async () => {
    const { repo, base, head, runner } = prCheckout();
    repo.git("switch", "--detach", head);
    const github = await fakeGitHub();
    compare(github, base, head, ["packages/ui/src/button.tsx"], { status: "diverged", mergeBase: repo.base });
    const run = await runAction({ ...runner(1), github });
    expect(github.requests).toEqual([`/repos/acme/mono/compare/${base}...${head}`]);
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
    expect(run.annotations).toEqual([]);
  });

  it("re-roots paths under a nested working-directory and fails closed on a path outside it", async () => {
    const { base, merge, runner } = prCheckout({ at: "mono" });
    const github = await fakeGitHub();
    compare(github, base, merge, ["mono/packages/ui/src/button.tsx"]);
    const inputs = { "working-directory": "mono" };
    const inside = await runAction({ ...runner(1), inputs, github });
    expect(parsed(inside.outputs.lanes)).toEqual(["web", "e2e", "lint"]);

    compare(github, base, merge, ["mono/packages/ui/src/button.tsx", "LICENSE"]);
    const outside = await runAction({ ...runner(2), inputs, github });
    expect(parsed(outside.outputs.lanes)).toEqual(ALL);
    expect(outside.outputs.complete).toBe("false");
  });

  it("requires an explicit head for a checkout outside the PR", async () => {
    const { repo, base, runner } = prCheckout();
    repo.git("switch", "--detach", base);
    const github = await fakeGitHub();
    const run = await runAction({ ...runner(1), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations[0]?.message).toContain("matches neither");
    expect(github.requests).toEqual([]);
  });

  it.each(["", "README.md"])("rejects a mismatched head with files %j", async (files) => {
    const { head, runner } = prCheckout();
    const github = await fakeGitHub();
    const run = await runAction({ ...runner(1), inputs: { head, files }, github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations[0]?.message).toContain("head input does not match");
    expect(github.requests).toEqual([]);
  });

  it("keeps the event range on pull_request_target", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["packages/ui/src/button.tsx"], { status: "diverged", mergeBase: MERGE_BASE });
    const run = await runAction({
      workspace: ACME,
      event: { ...pullRequest(1), name: "pull_request_target" },
      github,
    });
    expect(github.requests).toEqual([`/repos/acme/mono/compare/${BASE}...${HEAD}`]);
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
  });
});

describe("a push", () => {
  const BUTTON = "packages/ui/src/button.tsx";

  it("routes before...after precisely when head extends before", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [BUTTON], { status: "ahead", mergeBase: BASE });
    const run = await runAction({ workspace: ACME, event: push(BASE), github });
    expect(github.requests).toEqual([`/repos/acme/mono/compare/${BASE}...${HEAD}`]);
    expect(run.summary).toContain("mode push");
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.api).toBe("skip");
    expect(run.outputs.complete).toBe("true");
  });

  it("runs every lane after a force push, which the compare API reports as diverged", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [BUTTON], { status: "diverged", mergeBase: MERGE_BASE });
    const run = await runAction({ workspace: ACME, event: push(BASE), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(jsonObject(run.outputs.reasons).api).toBe(
      "fail closed, head does not extend base, so the compare API omits what the push dropped: status diverged, merge base ccccccc",
    );
    expect(run.annotations.map(({ level }) => level)).toEqual(["warning"]);
  });

  it("runs every lane when the push moved the branch back, which the compare API reports as behind", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [BUTTON], { status: "behind", mergeBase: HEAD });
    const run = await runAction({ workspace: ACME, event: push(BASE), github });
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(jsonObject(run.outputs.reasons).api).toContain("status behind");
  });

  it("runs every lane when the merge base is not before, whatever the status says", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [BUTTON], { status: "ahead", mergeBase: MERGE_BASE });
    const run = await runAction({ workspace: ACME, event: push(BASE), github });
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(jsonObject(run.outputs.reasons).api).toContain("merge base ccccccc");
  });

  it("runs every lane without a request when the push names no before commit", async () => {
    const github = await fakeGitHub();
    const run = await runAction({ workspace: ACME, event: { name: "push", payload: { after: HEAD } }, github });
    expect(run.exitCode).toBe(0);
    expect(github.requests).toEqual([]);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(jsonObject(run.outputs.reasons).api).toBe("fail closed, there is no base commit to compare against");
  });

  it("runs every lane without a request when a push has an all-zero before", async () => {
    const github = await fakeGitHub();
    const run = await runAction({ workspace: ACME, event: push("0".repeat(40)), github });
    expect(run.exitCode).toBe(0);
    expect(github.requests).toEqual([]);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
  });

  it("applies the same rule to a base and head given as inputs", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [BUTTON], { status: "diverged", mergeBase: MERGE_BASE });
    const run = await runAction({
      workspace: ACME,
      inputs: { mode: "push", base: BASE, head: HEAD },
      event: { name: "workflow_dispatch", payload: {} },
      github,
    });
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
  });

  it("routes the same with a mode input that agrees with the event", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [BUTTON], { status: "ahead", mergeBase: BASE });
    const run = await runAction({ workspace: ACME, inputs: { mode: "push" }, event: push(BASE), github });
    expect(run.exitCode).toBe(0);
    expect(run.summary).toContain("mode push");
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
  });

  it("runs every lane on a compare status it does not know", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, [BUTTON], { status: "sideways", mergeBase: BASE });
    const run = await runAction({ workspace: ACME, event: push(BASE), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations.map(({ level }) => level)).toEqual(["error"]);
    expect(run.annotations[0]?.message).toContain("status");
  });
});

describe("errors after the config is valid", () => {
  it("select every lane, annotate the error and let the step succeed when the API fails", async () => {
    const github = await fakeGitHub();
    const { base, merge, runner } = prCheckout();
    github.on(`/compare/${base}...${merge}`, { status: 500, body: { message: "Server Error" } });
    const run = await runAction({ ...runner(1), github });
    expect(run.exitCode).toBe(0);
    expect(parsed(run.outputs.lanes)).toEqual(ALL);
    expect(run.outputs.complete).toBe("false");
    expect(run.annotations.map(({ level }) => level)).toEqual(["error"]);
    expect(run.annotations[0]?.message).toContain("returned 500");
  });

  it("do the same when the API cannot be reached", async () => {
    const { runner } = prCheckout();
    const run = await runAction(runner(1));
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
    const dir = fixtureCopy("acme", { "packages/ui/package.json": "{" });
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

  it("accept mode pr with base and head for an event that implies no mode", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["packages/ui/src/button.tsx"], { status: "diverged", mergeBase: MERGE_BASE });
    const run = await runAction({
      workspace: ACME,
      inputs: { mode: "pr", base: BASE, head: HEAD },
      event: { name: "workflow_dispatch", payload: {} },
      github,
    });
    expect(run.exitCode).toBe(0);
    expect(run.summary).toContain("mode pr");
    expect(parsed(run.outputs.lanes)).toEqual(["web", "e2e", "lint"]);
    expect(run.outputs.complete).toBe("true");
  });

  it("fail the step when mode pr contradicts a push event", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["packages/ui/src/button.tsx"], { status: "diverged", mergeBase: MERGE_BASE });
    const run = await runAction({ workspace: ACME, inputs: { mode: "pr" }, event: push(BASE), github });
    expect(run.exitCode).toBe(1);
    expect(run.outputs).toEqual({});
    expect(run.annotations[0]?.message).toContain("the mode input is pr, but a push event routes in push mode");
  });

  it("fail the step when mode push contradicts a pull request event", async () => {
    const github = await fakeGitHub();
    compare(github, BASE, HEAD, ["packages/ui/src/button.tsx"], { status: "ahead", mergeBase: BASE });
    const run = await runAction({ workspace: ACME, inputs: { mode: "push" }, event: pullRequest(1), github });
    expect(run.exitCode).toBe(1);
    expect(run.outputs).toEqual({});
    expect(run.annotations[0]?.message).toContain("the mode input is push, but a pull_request event routes in pr mode");
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
