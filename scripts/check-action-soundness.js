import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { parseArgs, promisify } from "node:util";
import { actionOracle, diagnostics } from "./action-oracle.js";
import { cases, fixture, git, history, isolatedGit, mergeBases } from "./action-scenarios.js";

const counts = () => ({
  cases: 0,
  derived: 0,
  handWritten: 0,
  shallow: 0,
  precise: 0,
  closed: 0,
  rejected: 0,
  skipped: 0,
});

if (import.meta.main) await main();

async function main() {
  const { values } = parseArgs({
    options: {
      seed: { type: "string", default: "20261120" },
      histories: { type: "string", default: "1" },
      output: { type: "string" },
      action: { type: "string", default: fileURLToPath(new URL("../dist/index.js", import.meta.url)) },
      case: { type: "string" },
    },
  });
  const actionBundle = readFileSync(resolve(values.action));
  const start = Number(values.seed);
  const count = Number(values.histories);
  assert.ok(Number.isSafeInteger(start) && start >= 0, "pass a non-negative integer seed");
  assert.ok(Number.isSafeInteger(count) && count > 0 && Number.isSafeInteger(start + count), "invalid histories");
  const project = fileURLToPath(new URL("../", import.meta.url));
  const scratchRoot = resolve(values.output ?? join(project, "coverage", "action-soundness"));
  mkdirSync(scratchRoot, { recursive: true });
  const gitVersion = git(project, ["--version"]).trim();
  const fingerprint = createHash("sha256");
  fingerprint.update(actionBundle);
  for (const file of [
    import.meta.filename,
    new URL("./action-scenarios.js", import.meta.url),
    new URL("./action-oracle.js", import.meta.url),
  ]) {
    fingerprint.update(readFileSync(file));
  }
  const key = JSON.stringify({
    fingerprint: fingerprint.digest("hex"),
    git: gitVersion,
    node: process.version,
    platform: process.platform,
    start,
    case: values.case ?? null,
  });
  const checkpoint = join(
    scratchRoot,
    "action-" + createHash("sha256").update(key).digest("hex").slice(0, 16) + ".jsonl",
  );
  const resumed = values.output === undefined ? [] : readCheckpoint();
  const totals = { histories: 0, ...counts() };
  for (const row of resumed) record(row);
  for (let seed = start + resumed.length; seed < start + count; seed++) {
    const dir = mkdtempSync(join(scratchRoot, "history-"));
    try {
      const path = join(dir, "index.mjs");
      writeFileSync(path, actionBundle);
      const row = await checkHistory(dir, seed, [{ path, control: true }], { onlyCase: values.case });
      if (values.output !== undefined) appendFileSync(checkpoint, JSON.stringify(row) + "\n");
      record(row);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  }
  process.stdout.write(JSON.stringify({ seed: start, ...totals }) + "\n");

  function readCheckpoint() {
    let text;
    try {
      text = readFileSync(checkpoint, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      text = "";
    }
    const lines = text
      .slice(0, text.lastIndexOf("\n") + 1)
      .split("\n")
      .slice(0, -1);
    if (lines.length > 0) assert.equal(lines[0], key, "checkpoint belongs to a different run");
    const rows = lines.slice(1).map((line, index) => {
      const row = JSON.parse(line);
      assert.equal(row.seed, start + index, "checkpoint has a gap in its seed sequence");
      return row;
    });
    assert.ok(rows.length <= count, "this checkpoint already has more histories than requested");
    writeFileSync(checkpoint, [key, ...lines.slice(1), ""].join("\n"));
    return rows;
  }

  function record(row) {
    totals.histories++;
    for (const key of Object.keys(counts())) totals[key] += row[key];
  }
}

export async function checkHistory(dir, seed, actions, { onlyCase, completed = new Set(), onCase, jobs = 1 } = {}) {
  const h = history(dir, seed);
  const selected = cases(h).filter((scenario) => onlyCase === undefined || onlyCase === scenario.name);
  assert.ok(selected.length > 0, "unknown Action case");
  const handlers = new Map();
  const server = createServer((request, response) => {
    const id = request.url.split("/", 2)[1];
    const handle = handlers.get(id);
    if (handle === undefined) {
      response.writeHead(404).end();
      return;
    }
    request.url = request.url.slice(id.length + 1);
    handle(request, response);
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const api = "http://127.0.0.1:" + server.address().port;
  const totals = { seed, ...counts() };
  try {
    const oracle = actionOracle(h.repo);
    const replies = new Map();
    const invocations = actions.map((action, index) => {
      const id = String(index);
      const invocationDir = join(dir, "invocation-" + id);
      mkdirSync(invocationDir);
      return { ...action, id, invocationDir };
    });
    for (const scenario of selected) {
      if (completed.has(scenario.name)) continue;
      const cwd = h.checkout(scenario.checkout, scenario.depth);
      const expected = oracle(cwd, scenario);
      totals.cases++;
      totals[scenario.manualExpectation === undefined ? "derived" : "handWritten"]++;
      totals.shallow += Number(expected.shallow);
      async function check({ label, path, control, id, invocationDir }) {
        const requests = [];
        handlers.set(id, compareHandler(h.repo, scenario, requests, replies));
        try {
          const actual = await runAction(path, invocationDir, cwd, api + "/" + id, scenario, expected.supplied);
          try {
            const skipped = checkResult(actual, expected, requests);
            if (control) {
              totals.skipped += skipped;
              totals[expected.closed ? "closed" : expected.rejected ? "rejected" : "precise"]++;
            }
          } catch (error) {
            const evidence = { seed, scenario, expected, actual, requests, reason: error.message };
            if (control) {
              process.stderr.write("Counterexample: " + JSON.stringify(evidence) + "\n");
              throw error;
            }
            return { label, ...evidence };
          }
        } finally {
          handlers.delete(id);
        }
        return undefined;
      }
      await check(invocations[0]);
      const failures = [];
      for (let index = 1; index < invocations.length; index += jobs) {
        const results = await Promise.allSettled(invocations.slice(index, index + jobs).map(check));
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
          if (result.value !== undefined) failures.push(result.value);
        }
      }
      onCase?.({ name: scenario.name, failures });
    }
    return totals;
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

function compareHandler(repo, { root, fault, remoteMergeBase }, requests, replies) {
  return (request, response) => {
    const [pathname, query] = request.url.split("?");
    requests.push(request.url);
    const prefix = "/repos/fixture/workspace/compare/";
    if (!pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    if (fault === "unavailable") {
      response.writeHead(503).end();
      return;
    }
    if (fault === "invalid-json") {
      response.end("{");
      return;
    }
    try {
      const [base, head] = pathname.slice(prefix.length).split("...").map(decodeURIComponent);
      if (!fixture.remoteRef.test(base) || !fixture.remoteRef.test(head)) throw new Error("unknown remote revision");
      const key = JSON.stringify([request.url, root, fault, remoteMergeBase]);
      if (replies.has(key)) {
        response.end(replies.get(key));
        return;
      }
      const rev = (ref) => git(repo, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]).trim();
      const first = rev(base);
      const last = rev(head);
      const mergeBase = remoteMergeBase ?? mergeBases(repo, first, last)[0];
      if (!mergeBase) throw new Error("unrelated revisions");
      const status =
        first === last ? "identical" : first === mergeBase ? "ahead" : last === mergeBase ? "behind" : "diverged";
      const tokens = git(repo, ["diff", "--name-status", "-z", "--find-renames", mergeBase, last, "--"])
        .split("\0")
        .slice(0, -1);
      const files = [];
      for (let index = 0; index < tokens.length;) {
        const code = tokens[index++];
        const path = tokens[index++];
        files.push(
          code.startsWith("R")
            ? { status: "renamed", previous_filename: path, filename: tokens[index++] }
            : { status: { A: "added", D: "removed", M: "modified", T: "changed" }[code], filename: path },
        );
      }
      const body = { status, base_commit: { sha: first }, merge_base_commit: { sha: mergeBase } };
      if (fault !== "missing-files") {
        const page = new URLSearchParams(query).get("page");
        body.files = Number(page) > 1 ? [] : files.slice(0, fixture.listLimit);
        if (fault === "wrong-file")
          body.files[0] = { filename: (root === "." ? "" : root + "/") + "packages/bravo/missing.js" };
      }
      const reply = JSON.stringify(body);
      replies.set(key, reply);
      response.end(reply);
    } catch {
      response.writeHead(404).end();
    }
  };
}

async function runAction(action, dir, cwd, api, scenario, supplied) {
  const event = join(dir, "event.json");
  const output = join(dir, "output");
  const summary = join(dir, "summary");
  writeFileSync(event, JSON.stringify(scenario.payload));
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(GIT_|GITHUB_|INPUT_|RUNNER_|ACTIONS_)/i.test(name)),
  );
  const inputs = {
    config: fixture.config,
    "working-directory": scenario.root,
    ...scenario.inputs,
    ...(scenario.supplied ? { files: supplied } : {}),
  };
  for (const [name, value] of Object.entries(inputs)) env["INPUT_" + name.toUpperCase()] = value;
  Object.assign(env, isolatedGit(cwd), {
    GITHUB_API_URL: api,
    GITHUB_EVENT_NAME: scenario.event,
    GITHUB_EVENT_PATH: event,
    GITHUB_OUTPUT: output,
    GITHUB_REPOSITORY: "fixture/workspace",
    GITHUB_SHA: scenario.eventSha,
    GITHUB_STEP_SUMMARY: summary,
    GITHUB_WORKSPACE: cwd,
  });
  let code = 0;
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(process.execPath, [action], {
      cwd,
      env,
      timeout: 30_000,
      windowsHide: true,
    }));
  } catch (error) {
    assert.equal(typeof error.code, "number", "Action process did not exit normally");
    code = error.code;
    stdout = error.stdout + error.stderr;
  }
  const outputs = Object.fromEntries(
    [...readFileSync(output, "utf8").matchAll(/^(.+?)<<([\w-]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm)].map(
      ([, name, , value]) => [name, value],
    ),
  );
  return { code, outputs, stdout, summary: readFileSync(summary, "utf8") };
}

function checkResult(actual, expected, requests) {
  if (expected.rejected) {
    assert.equal(actual.code, 1, "invalid inputs must fail the step");
    assert.match(actual.stdout, diagnostics[expected.rejected]);
    assert.deepEqual(actual.outputs, {});
    assert.deepEqual(requests, []);
    return 0;
  }
  assert.equal(actual.code, 0, "valid inputs must publish a plan");
  const { outputs } = actual;
  const summary = actual.summary.replaceAll("&#44;", ",");
  for (const lane of expected.run) assert.equal(outputs[lane], "run", lane + " skipped a required lane");
  assert.match(summary, new RegExp("mode " + expected.mode + ","));
  for (const lane of expected.lanes) assert.equal(outputs[lane], expected.run.includes(lane) ? "run" : "skip", lane);
  assert.deepEqual(JSON.parse(outputs.lanes), expected.run);
  assert.equal(outputs["none-required"], String(expected.run.length === 0));
  assert.equal(outputs.complete, String(!expected.closed));
  const { include } = JSON.parse(outputs.matrix);
  assert.deepEqual(
    include.map(({ lane }) => lane),
    expected.run,
  );
  if (expected.closed) {
    assert.match(actual.stdout, diagnostics[expected.closed]);
    assert.match(actual.summary, /incomplete/);
  } else {
    for (const entry of include) assert.equal(entry.base, expected.matrixBase, "matrix exposes the planned base");
    assert.match(summary, new RegExp("head " + expected.head.slice(0, 7) + ","));
    assert.match(summary, new RegExp(", " + expected.paths.length + " files?, complete,"));
  }
  if (expected.noRequest) assert.deepEqual(requests, []);
  return expected.lanes.length - expected.run.length;
}
