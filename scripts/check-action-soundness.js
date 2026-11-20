import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { parseArgs, promisify } from "node:util";
import { cases, fixture, git, history } from "./action-scenarios.js";

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
for (const file of [import.meta.filename, new URL("./action-scenarios.js", import.meta.url)]) {
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
const totals = { histories: 0, cases: 0, precise: 0, closed: 0, rejected: 0, skipped: 0 };
for (const row of resumed) record(row);
for (let seed = start + resumed.length; seed < start + count; seed++) {
  const dir = mkdtempSync(join(scratchRoot, "history-"));
  try {
    const row = await checkHistory(dir, seed);
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
  for (const key of ["cases", "precise", "closed", "rejected", "skipped"]) totals[key] += row[key];
}

async function checkHistory(dir, seed) {
  const action = join(dir, "index.mjs");
  writeFileSync(action, actionBundle);
  const h = history(dir, seed);
  const selected = cases(h).filter((scenario) => values.case === undefined || values.case === scenario.name);
  assert.ok(selected.length > 0, "unknown Action case");
  const server = createServer();
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const api = "http://127.0.0.1:" + server.address().port;
  const totals = { seed, cases: 0, precise: 0, closed: 0, rejected: 0, skipped: 0 };
  try {
    const trees = new Map();
    const jsonFiles = new Map();
    for (const scenario of selected) {
      const cwd = h.checkout(scenario.checkout, scenario.shallow);
      const expected = oracle(h.repo, trees, jsonFiles, scenario);
      const requests = [];
      const handler = compareHandler(h.repo, scenario.fault, requests);
      server.on("request", handler);
      let actual;
      try {
        actual = await runAction(action, dir, cwd, api, scenario, expected.paths);
        const skipped = checkResult(scenario, actual, expected, requests);
        totals.cases++;
        totals.skipped += skipped;
        totals[scenario.closed ? "closed" : scenario.failed ? "rejected" : "precise"]++;
      } catch (error) {
        process.stderr.write(
          "Counterexample: " +
            JSON.stringify({ seed, scenario, expected, actual, requests, reason: error.message }) +
            "\n",
        );
        throw error;
      } finally {
        server.off("request", handler);
      }
    }
    return totals;
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
}

function compareHandler(repo, fault, requests) {
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
      if (!/^[\w/.-]+$/.test(base) || !/^[\w/.-]+$/.test(head)) throw new Error("unknown remote revision");
      const rev = (ref) => git(repo, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]).trim();
      const first = rev(base);
      const last = rev(head);
      const mergeBase = git(repo, ["merge-base", first, last]).trim();
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
        body.files = Number(page) > 1 || fault === "short-list" ? [] : files.slice(0, fixture.listLimit);
        if (fault === "wrong-file") body.files[0] = { filename: fixture.root + "/packages/bravo/missing.js" };
      }
      response.end(JSON.stringify(body));
    } catch {
      response.writeHead(404).end();
    }
  };
}

function oracle(repo, trees, jsonFiles, scenario) {
  const prefix = fixture.root + "/";
  function tree(revision) {
    if (!trees.has(revision)) {
      const entries = git(repo, ["ls-tree", "-r", "-z", "--full-tree", revision]).split("\0").filter(Boolean);
      trees.set(
        revision,
        new Map(entries.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf("\t"))])),
      );
    }
    return trees.get(revision);
  }
  function json(revision, path) {
    const entry = revision + ":" + prefix + path;
    if (!jsonFiles.has(entry)) jsonFiles.set(entry, JSON.parse(git(repo, ["show", entry])));
    return jsonFiles.get(entry);
  }
  const checkout = json(scenario.checkout, fixture.config);
  const lanes = Object.keys(checkout.lanes);
  if (scenario.closed || scenario.failed) return { lanes, run: lanes, paths: [] };

  const [base, head] = scenario.diff;
  const old = tree(base);
  const next = tree(head);
  const changed = [...new Set([...old.keys(), ...next.keys()])].filter((path) => old.get(path) !== next.get(path));
  const paths = changed.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
  if (changed.length !== paths.length) return { lanes, run: lanes, paths };
  if (paths.includes(fixture.config)) {
    const union = [...new Set([...lanes, ...Object.keys(json(base, fixture.config).lanes)])];
    return { lanes: union, run: union, paths };
  }
  const touched = new Set(paths.map((path) => /^packages\/([^/]+)\//.exec(path)?.[1]));
  assert.ok(!touched.has(undefined), "a fixture edit has no package owner");
  const models = [scenario.checkout, ...(paths.some((path) => path.endsWith("/package.json")) ? [base] : [])].map(
    (revision) =>
      new Map(
        [...tree(revision).keys()]
          .filter((path) => /^workspace\/packages\/[^/]+\/package\.json$/.test(path))
          .map((path) => {
            const manifest = json(revision, path.slice(prefix.length));
            return [manifest.name, Object.keys(manifest.dependencies ?? {})];
          }),
      ),
  );
  function reaches(packages, model) {
    const seen = new Set(packages);
    for (const name of seen) {
      if (touched.has(name)) return true;
      for (const dependency of model.get(name) ?? []) seen.add(dependency);
    }
    return false;
  }
  return {
    lanes,
    run: lanes.filter((lane) => models.some((model) => reaches(checkout.lanes[lane].packages, model))),
    paths,
  };
}

async function runAction(action, dir, cwd, api, scenario, paths) {
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
    "working-directory": fixture.root,
    ...scenario.inputs,
    ...(scenario.supplied ? { files: paths.join("\n") } : {}),
  };
  for (const [name, value] of Object.entries(inputs)) env["INPUT_" + name.toUpperCase()] = value;
  Object.assign(env, {
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

function checkResult(scenario, actual, expected, requests) {
  if (scenario.failed) {
    assert.equal(actual.code, 1, "invalid inputs must fail the step");
    assert.match(actual.stdout, scenario.failed);
    assert.deepEqual(actual.outputs, {});
    assert.deepEqual(requests, []);
    return 0;
  }
  assert.equal(actual.code, 0, "valid inputs must publish a plan");
  const { outputs } = actual;
  if (scenario.expectedMode) assert.ok(actual.summary.includes("mode " + scenario.expectedMode));
  for (const lane of expected.run) assert.equal(outputs[lane], "run", lane + " skipped a required lane");
  for (const lane of expected.lanes) assert.equal(outputs[lane], expected.run.includes(lane) ? "run" : "skip", lane);
  assert.deepEqual(JSON.parse(outputs.lanes), expected.run);
  assert.equal(outputs["none-required"], String(expected.run.length === 0));
  assert.equal(outputs.complete, String(!scenario.closed));
  const { include } = JSON.parse(outputs.matrix);
  assert.deepEqual(
    include.map(({ lane }) => lane),
    expected.run,
  );
  if (scenario.closed) {
    assert.match(actual.stdout, scenario.closed);
    assert.match(actual.summary, /incomplete/);
  } else {
    const base =
      scenario.matrixBase ?? (scenario.supplied ? (scenario.inputs.base ?? scenario.payload.before) : scenario.diff[0]);
    for (const entry of include) assert.equal(entry.base, base, "matrix exposes the planned base");
    assert.match(actual.summary, new RegExp("head " + scenario.diff[1].slice(0, 7)));
  }
  if (scenario.supplied || scenario.noRequest) assert.deepEqual(requests, []);
  return expected.lanes.length - expected.run.length;
}
