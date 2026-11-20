import { Buffer } from "node:buffer";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli.ts";
import { runAction } from "./support/action.ts";
import { fixtureDir } from "./support/fixtures.ts";

const { git } = vi.hoisted(() => ({ git: vi.fn() }));
vi.mock("node:child_process", async (original) => {
  const execFile = () => {
    throw new Error("unexpected subprocess");
  };
  execFile[promisify.custom] = (command, args) => {
    let resolve;
    let reject;
    const execution = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    execution.child = {
      stdin: {
        on() {},
        end(input) {
          try {
            expect(command).toBe("git");
            const result = git(input, ...args);
            if (result === undefined)
              throw Object.assign(new Error("unavailable Git object"), { stderr: Buffer.from("missing object") });
            resolve({ stdout: Buffer.from(result) });
          } catch (error) {
            reject(error);
          }
        },
      },
    };
    return execution;
  };
  return { ...(await original()), execFile };
});

const workspace = fixtureDir("acme");
const config = ".github/lanes.yml";
const all = ["api", "web", "e2e", "lint"];
const selected = ["web", "e2e", "lint"];
const [base, head, incoming, stale] = ["a", "b", "c", "d"].map((char) => char.repeat(40));
const ui = "packages/ui/src/button.tsx";
const { Response } = globalThis;
const request = vi.fn();
const push = { name: "push", payload: { before: base, after: head } };
const pr = {
  name: "pull_request",
  payload: { pull_request: { base: { sha: stale }, head: { sha: incoming }, changed_files: 1 } },
};
const blobs = readdirSync(workspace, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .map((path) => [relative(workspace, path).replaceAll("\\", "/"), readFileSync(path)]);
const tree = blobs.map(([path], index) => "100644 blob " + index + "\t" + path + "\0").join("");

function fixtureGitOutput(input, ...args) {
  if (args[0] === "rev-parse") {
    if (args[1] === "--show-prefix") return "";
    return {
      "HEAD^{commit}": head,
      [head + "^{commit}"]: head,
      [base + "^{commit}"]: base,
      "local~2^{commit}": base,
    }[args.at(-1)];
  }
  if (args[0] === "--no-replace-objects") return "tree f\nparent " + base + "\nparent " + incoming + "\n\nmessage\n";
  if (args[0] === "merge-base") return base + "\n";
  if (args[0] === "diff") return ui + "\0";
  if (args[0] === "ls-tree") return tree;
  if (args[0] === "cat-file") {
    return Buffer.concat(
      input
        .trim()
        .split("\n")
        .map((id) => {
          const text = blobs[Number(id)][1];
          return Buffer.concat([Buffer.from(id + " blob " + text.length + "\n"), text, Buffer.from("\n")]);
        }),
    );
  }
  throw new Error("unexpected Git command: " + args.join(" "));
}

const listed = {
  status: "ahead",
  base_commit: { sha: base },
  merge_base_commit: { sha: base },
  files: [{ filename: ui }],
};

beforeEach(() => {
  request.mockReset().mockImplementation(() => Promise.resolve(Response.json(listed)));
  vi.stubGlobal("fetch", request);
  git.mockReset().mockImplementation(fixtureGitOutput);
});
afterEach(() => vi.unstubAllGlobals());

async function action(options = {}) {
  return runAction({ workspace, event: push, sha: head, process: "in-process", ...options });
}

function expectLanes(result, lanes, complete) {
  expect(result.exitCode).toBe(0);
  expect(result.outputs.lanes).toBe(JSON.stringify(lanes));
  expect(result.outputs.complete).toBe(String(complete));
}

describe("Action inputs and compare responses", () => {
  it("routes the checked-out merge from its recorded first parent", async () => {
    expectLanes(await action({ event: pr }), selected, true);
    expect(request.mock.calls[0][0]).toMatch(new RegExp(base + "\\.\\.\\." + head + "$"));
  });

  it("falls back to the payload base for a one-parent checkout", async () => {
    git.mockImplementation((input, ...args) =>
      args[0] === "--no-replace-objects" ? "tree f\nparent " + stale + "\n\n" : fixtureGitOutput(input, ...args),
    );
    request.mockResolvedValue(Response.json({ ...listed, merge_base_commit: { sha: stale } }));
    expectLanes(await action({ event: pr }), selected, true);
    expect(request.mock.calls[0][0]).toContain(stale + "..." + head);
  });

  it("routes a PR head and rejects disagreement with its payload count", async () => {
    const event = {
      ...pr,
      payload: { pull_request: { ...pr.payload.pull_request, head: { sha: head }, changed_files: 2 } },
    };
    const result = await action({ event });
    expectLanes(result, all, false);
    expect(result.annotations[0].message).toContain("pull request changes 2");
    expectLanes(await action({ event, inputs: { head: "HEAD" } }), selected, true);
  });

  it("keeps the proposed change when the target workflow checks out the base tip", async () => {
    expectLanes(await action({ event: { ...pr, name: "pull_request_target" } }), selected, true);
    expect(request.mock.calls[0][0]).toContain(stale + "..." + incoming);
  });

  it("retries a ref the compare endpoint cannot resolve", async () => {
    request.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expectLanes(await action({ inputs: { base: "local~2", token: "fixture" } }), selected, true);
    expect(request.mock.calls.map(([url]) => url.split("/compare/")[1])).toEqual([
      "local~2..." + head,
      base + "..." + head,
    ]);
    expect(request.mock.calls[0][1].headers.Authorization).toBe("Bearer fixture");
  });

  it("routes supplied paths without requiring a compare", async () => {
    expectLanes(await action({ inputs: { files: " \n\r\n " + ui + "\r\n" } }), selected, true);
    expect(request).not.toHaveBeenCalled();
  });

  it("trusts supplied file paths even when Git has no checkout", async () => {
    git.mockReset();
    const result = await action({ inputs: { files: ui + "\npackages/api/src/user.ts\r\n" } });
    expectLanes(result, all, true);
    expect(git).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("uses a supplied base to read the graph for listed manifest changes", async () => {
    const files = "packages/ui/package.json";
    expectLanes(await action({ inputs: { files } }), all, false);
    expectLanes(await action({ inputs: { files, base } }), selected, true);
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the nested Git prefix and still rejects paths outside it", async () => {
    const prefix = "test/fixtures/acme/";
    git.mockImplementation((input, ...args) =>
      args[1] === "--show-prefix" ? prefix + "\n" : fixtureGitOutput(input, ...args),
    );
    const options = { workspace: join(workspace, "../../.."), inputs: { "working-directory": prefix } };
    const inside = { filename: prefix + ui };
    request.mockResolvedValueOnce(Response.json({ ...listed, files: [inside] }));
    expectLanes(await action(options), selected, true);
    request.mockResolvedValueOnce(Response.json({ ...listed, files: [inside, { filename: "outside" }] }));
    const result = await action(options);
    expectLanes(result, all, false);
    expect(result.annotations[0].message).toContain("outside");
  });

  it("honors explicit manual ranges and leaves their mode visible", async () => {
    const result = await action({ event: { name: "workflow_dispatch", payload: {} }, inputs: { mode: "pr", base } });
    expectLanes(result, selected, true);
    expect(result.summary).toContain("mode pr");
  });

  it.each([
    [
      "event/checkout mismatch",
      { event: { ...push, payload: { before: base, after: incoming } } },
      "does not match the event",
    ],
    ["head input/checkout mismatch", { inputs: { head: base } }, "does not match the checkout"],
    ["missing head ref", { inputs: { head: "missing" } }, "cannot resolve the head input"],
    ["new branch", { event: { ...push, payload: { before: "0".repeat(40), after: head } } }, "no base commit"],
  ])("runs all lanes on %s", async (_label, options, reason) => {
    const result = await action(options);
    expectLanes(result, all, false);
    expect(result.annotations[0].message).toContain(reason);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["force push", { ...listed, status: "diverged" }, "head does not extend base"],
    ["wrong merge base", { ...listed, merge_base_commit: { sha: stale } }, "head does not extend base"],
    ["capped response", { ...listed, files: Array.from({ length: 300 }, () => ({ filename: ui })) }, "at most 300"],
    ["invalid status", { ...listed, status: "invalid" }, "cannot read"],
    ["no listing", { ...listed, files: null }, "cannot read"],
    ["invalid path", { ...listed, files: [{ filename: "../outside" }] }, "not a path inside"],
  ])("runs all lanes on %s", async (_label, body, reason) => {
    request.mockResolvedValue(Response.json(body));
    const result = await action();
    expectLanes(result, all, false);
    expect(result.annotations[0].message).toContain(reason);
  });

  it.each([
    [{ event: { name: "push", text: "[broken" } }, "it is not valid JSON"],
    [{ event: { name: "push", payload: {} } }, "the push event payload after"],
    [{ event: { name: "workflow_dispatch", payload: {} } }, "the base input is required"],
    [{ inputs: { mode: "unknown" } }, "the mode input"],
    [{ inputs: { config: "missing.yml" } }, "missing.yml  not found"],
  ])("publishes usage or model errors for %j", async (options, reason) => {
    const result = await action(options);
    expect(result.exitCode).toBe(1);
    expect(result.annotations[0].message).toContain(reason);
    expect(result.outputs).toEqual({});
    expect(request).not.toHaveBeenCalled();
  });

  it("checks both paths when the compare API reports a rename", async () => {
    request.mockResolvedValue(
      Response.json({
        ...listed,
        files: [{ filename: ui, previous_filename: "packages/api/src/user.ts" }],
      }),
    );
    const result = await action();
    expectLanes(result, all, true);
    expect(result.outputs.api).toBe("run");
  });

  it("recovers an omitted full base SHA through the checkout", async () => {
    request.mockResolvedValueOnce(Response.json({ ...listed, base_commit: undefined }));
    expectLanes(await action({ inputs: { base: "local~2" } }), selected, true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails a conflicting mode before making a request", async () => {
    const result = await action({ inputs: { mode: "pr" } });
    expect(result.exitCode).toBe(1);
    expect(result.annotations[0].message).toContain("routes in push mode");
    expect(result.outputs).toEqual({});
    expect(request).not.toHaveBeenCalled();
  });
});

describe("CLI Git protocol", () => {
  it("reads the tree and raw diff through Git without opening the working files", async () => {
    let json = "";
    const result = await runCli(["explain", "--base", base, "--head", head, "--config", config, "--json"], {
      cwd: workspace,
      stdout: (text) => {
        json += text;
      },
      stderr: (text) => {
        throw new Error(text);
      },
    });
    expect(result).toBe(0);
    const plan = JSON.parse(json);
    expect(plan.complete).toBe(true);
    expect(plan.lanes.filter(({ decision }) => decision === "run").map(({ lane }) => lane)).toEqual(selected);
    expect(plan.paths.map(({ path }) => path)).toEqual([ui]);
  });
});
