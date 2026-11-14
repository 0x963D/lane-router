import { describe, expect, it } from "vitest";
import { jsonObject, runAction, type ActionEvent } from "./support/action.ts";
import {
  checkRuns,
  compare,
  fakeGitHub,
  history,
  type FakeCheckRun,
  type FakeCommit,
  type FakeGitHub,
} from "./support/fake-github.ts";
import { fixtureDir } from "./support/fixtures.ts";

/* Lanes and checks come from the acme fixture: api, web, e2e ("e2e / chromium"), lint. */

const ACME = fixtureDir("acme");
const commit = (digit: string): string => digit.repeat(40);
const H = commit("f");
const M = commit("e");
const P1 = commit("1");
const P2 = commit("2");
const P3 = commit("3");
const P4 = commit("4");
const P5 = commit("5");
const P6 = commit("6");
const LINE: readonly FakeCommit[] = [
  { sha: H, parents: [P1] },
  { sha: P1, parents: [P2] },
  { sha: P2, parents: [P3] },
  { sha: P3, parents: [P4] },
  { sha: P4, parents: [P5] },
  { sha: P5, parents: [P6] },
  { sha: P6, parents: [] },
];

const PUSH: ActionEvent = { name: "push", payload: { before: P1, after: H } };

function short(sha: string): string {
  return sha.slice(0, 7);
}

async function pushWithHistory(commits: readonly FakeCommit[] = LINE): Promise<FakeGitHub> {
  const github = await fakeGitHub();
  history(github, H, commits);
  return github;
}

function green(github: FakeGitHub, sha: string, ...names: string[]): void {
  const runs = names.map((name) => ({ name }));
  checkRuns(github, sha, runs);
}

function lastGreen(github: FakeGitHub, inputs: Readonly<Record<string, string>> = {}, event = PUSH) {
  return runAction({ workspace: ACME, inputs: { "last-green": "auto", ...inputs }, event, github });
}

function compareRequests(github: FakeGitHub): string[] {
  return github.requests.filter((path) => path.includes("/compare/"));
}

describe("finding a lane's last green commit", () => {
  it("uses the newest earlier first-parent ancestor where the lane's check passed", async () => {
    const github = await pushWithHistory();
    green(github, P2, "api");
    green(github, P4, "api");
    compare(github, P1, H, ["packages/ui/src/button.tsx"]);
    compare(github, P2, H, ["packages/ui/src/button.tsx"]);
    const run = await lastGreen(github);
    expect(run.outputs.api).toBe("skip");
    expect(jsonObject(run.outputs.reasons).api).toBe(`nothing it reads changed since ${short(P2)}`);
  });

  it("never counts head itself", async () => {
    const github = await pushWithHistory();
    green(github, H, "api");
    compare(github, P1, H, ["README.md"]);
    const run = await lastGreen(github);
    expect(run.outputs.api).toBe("run");
    expect(jsonObject(run.outputs.reasons).api).toBe("no green api check in the last 100 commits");
  });

  it("follows first parents only", async () => {
    const github = await pushWithHistory([{ sha: H, parents: [P1, M] }, { sha: M, parents: [P2] }, ...LINE.slice(1)]);
    green(github, M, "api");
    compare(github, P1, H, ["README.md"]);
    const run = await lastGreen(github);
    expect(run.outputs.api).toBe("run");
  });

  it("walks past a page of merged commits to reach the first parent", async () => {
    const merged = Array.from({ length: 99 }, (_, index) => commit("d").slice(0, 38) + String(index).padStart(2, "0"));
    const github = await pushWithHistory([
      { sha: H, parents: [P1, merged[0] ?? ""] },
      ...merged.map((sha, index) => ({ sha, parents: [merged[index + 1] ?? P2] })),
      ...LINE.slice(1),
    ]);
    green(github, P1, "api");
    compare(github, P1, H, ["README.md"]);
    const run = await lastGreen(github);
    expect(github.requests).toContain(`/repos/acme/mono/commits?sha=${H}&per_page=100&page=2`);
    expect(jsonObject(run.outputs.reasons).api).toContain(`since ${short(P1)}`);
  });

  it.each<[string, FakeCheckRun[]]>([
    ["a skipped check", [{ name: "api", conclusion: "skipped" }]],
    ["a neutral check", [{ name: "api", conclusion: "neutral" }]],
    ["a cancelled check", [{ name: "api", conclusion: "cancelled" }]],
    ["a check in progress", [{ name: "api", status: "in_progress", conclusion: null }]],
    ["a missing check", [{ name: "lint" }]],
    ["two runs that disagree", [{ name: "api" }, { name: "api", conclusion: "failure" }]],
  ])("does not count %s as a pass", async (_, runs) => {
    const github = await pushWithHistory();
    checkRuns(github, P1, runs);
    green(github, P2, "api");
    compare(github, P1, H, ["README.md"]);
    compare(github, P2, H, ["README.md"]);
    const run = await lastGreen(github);
    expect(jsonObject(run.outputs.reasons).api).toContain(`since ${short(P2)}`);
  });

  it("looks for the lane's configured check name", async () => {
    const github = await pushWithHistory();
    checkRuns(github, P1, [{ name: "e2e / chromium" }, { name: "e2e", conclusion: "failure" }]);
    compare(github, P1, H, ["README.md"]);
    const run = await lastGreen(github);
    expect(jsonObject(run.outputs.reasons).e2e).toContain(`since ${short(P1)}`);
  });

  it("stops after last-green-depth ancestors and runs the lane", async () => {
    const github = await pushWithHistory();
    green(github, P3, "api");
    compare(github, P1, H, ["README.md"]);
    const run = await lastGreen(github, { "last-green-depth": "2" });
    expect(run.outputs.api).toBe("run");
    expect(jsonObject(run.outputs.reasons).api).toBe("no green api check in the last 2 commits");
    expect(github.requests.filter((path) => path.includes("/check-runs"))).toEqual(
      [P1, P2].map((sha) => `/repos/acme/mono/commits/${sha}/check-runs?filter=latest&per_page=100&page=1`),
    );
  });
});

describe("deciding a lane from its proof", () => {
  it("runs the lane when the change since its proof selects it", async () => {
    const github = await pushWithHistory();
    green(github, P1, "web");
    compare(github, P1, H, ["packages/ui/src/button.tsx"]);
    const run = await lastGreen(github);
    expect(run.outputs.web).toBe("run");
    expect(jsonObject(run.outputs.reasons).web).toContain(`since ${short(P1)}`);
  });

  it("runs the lane when the change since its proof is incomplete, and only that lane", async () => {
    const github = await pushWithHistory();
    green(github, P1, "web");
    green(github, P2, "api");
    compare(github, P1, H, ["README.md"]);
    compare(
      github,
      P2,
      H,
      Array.from({ length: 300 }, (_, index) => `docs/page-${String(index)}.md`),
    );
    const run = await lastGreen(github);
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toMatchObject({ api: "run", web: "skip", complete: "false" });
  });

  it("shares one diff between lanes with the same proof", async () => {
    const github = await pushWithHistory();
    green(github, P2, "api", "web", "lint");
    green(github, P3, "e2e / chromium");
    for (const base of [P1, P2, P3]) compare(github, base, H, ["packages/api/src/user.ts"]);
    await lastGreen(github);
    expect(compareRequests(github).sort()).toEqual(
      [P1, P2, P3].map((base) => `/repos/acme/mono/compare/${base}...${H}`).sort(),
    );
  });

  it("gives each running lane its proof as the matrix base, or the event base without one", async () => {
    const github = await pushWithHistory();
    green(github, P2, "api");
    for (const base of [P1, P2]) compare(github, base, H, ["packages/api/src/user.ts"]);
    const run = await lastGreen(github);
    const include = jsonObject(run.outputs.matrix).include;
    expect(include).toMatchObject([
      { lane: "api", base: P2 },
      { lane: "web", base: P1 },
      { lane: "e2e", base: P1 },
      { lane: "lint", base: P1 },
    ]);
  });

  it("skips a floor lane whose change since its proof is docs-only", async () => {
    const github = await pushWithHistory();
    green(github, P1, "lint");
    compare(github, P1, H, ["README.md"]);
    const run = await lastGreen(github);
    expect(run.outputs.lint).toBe("skip");
  });

  it("decides lanes with a proof on a new branch, whose own range cannot be compared", async () => {
    const github = await pushWithHistory();
    green(github, P1, "api");
    compare(github, P1, H, ["README.md"]);
    const run = await lastGreen(github, {}, { name: "push", payload: { before: commit("0"), after: H } });
    expect(run.outputs).toMatchObject({ api: "skip", web: "run", complete: "false" });
  });

  it("selects every lane and lets the step succeed when the proof lookup fails", async () => {
    const github = await pushWithHistory();
    github.on(`/commits/${P1}/check-runs?filter=latest&per_page=100&page=1`, { status: 500, body: {} });
    compare(github, P1, H, ["README.md"]);
    const run = await lastGreen(github);
    expect(run.exitCode).toBe(0);
    expect(run.outputs).toMatchObject({ api: "run", web: "run", e2e: "run", lint: "run", complete: "false" });
    expect(run.annotations.map(({ level }) => level)).toEqual(["error"]);
  });
});

describe("when last-green applies", () => {
  it("is off by default and routes only the event's range", async () => {
    const github = await pushWithHistory();
    compare(github, P1, H, ["README.md"]);
    await runAction({ workspace: ACME, event: PUSH, github });
    expect(github.requests).toEqual([`/repos/acme/mono/compare/${P1}...${H}`]);
  });

  it("is ignored on a pull request", async () => {
    const github = await pushWithHistory();
    compare(github, P1, H, ["README.md"]);
    const event: ActionEvent = {
      name: "pull_request",
      payload: { pull_request: { base: { sha: P1 }, head: { sha: H }, changed_files: 1 } },
    };
    const run = await lastGreen(github, {}, event);
    expect(run.exitCode).toBe(0);
    expect(github.requests).toEqual([`/repos/acme/mono/compare/${P1}...${H}`]);
  });

  it("cannot be combined with the files input on a push", async () => {
    const github = await pushWithHistory();
    const run = await lastGreen(github, { files: "README.md" });
    expect(run.exitCode).toBe(1);
    expect(run.annotations[0]?.message).toContain("the files input cannot be combined with last-green: auto");
  });
});
