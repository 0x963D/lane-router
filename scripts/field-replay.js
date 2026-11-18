import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { parseArgs } from "node:util";
import { readFieldPlan } from "./field-plan.ts";
import { loadModel, formatProblems } from "../src/load/index.ts";
import { fieldConfig, workspaceAt } from "./field-workspaces.js";

const CONFIG = ".lane-router-field.json";
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const DATASET = new URL("./field-repositories.json", import.meta.url);
const REVISIONS = 200;
const MAX_BUFFER = 256 * 1024 * 1024;

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    repo: { type: "string", multiple: true },
    limit: { type: "string", default: String(REVISIONS) },
  },
});
assert.ok(values.root, "pass --root <directory for shallow clones and replay results>");
const root = resolve(values.root);
const output = resolve(values.output ?? root);
const limit = Number(values.limit);
assert.ok(Number.isInteger(limit) && limit > 0 && limit <= REVISIONS, "invalid --limit");
const dataset = JSON.parse(await readFile(DATASET, "utf8"));
const selected = dataset.filter(({ repo }) => !values.repo || values.repo.includes(repo));
assert.ok(selected.length > 0 && (!values.repo || selected.length === new Set(values.repo).size), "unknown repository");
await mkdir(root, { recursive: true });
await mkdir(output, { recursive: true });
const fingerprint = createHash("sha256");
for (const file of [
  CLI,
  import.meta.filename,
  new URL("./field-plan.ts", import.meta.url),
  new URL("./field-workspaces.js", import.meta.url),
]) {
  fingerprint.update(await readFile(file));
}
const version = fingerprint.digest("hex");

async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return "";
  }
}

async function saveJson(path, value) {
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n");
  await rename(temporary, path);
}

function run(command, args, { cwd, input, env, encoding = "utf8", timeout = 120_000 } = {}) {
  return new Promise((fulfill, reject) => {
    const child = execFile(
      command,
      args,
      { cwd, env, encoding, windowsHide: true, maxBuffer: MAX_BUFFER, timeout },
      (error, stdout, stderr) => {
        if (!error) return fulfill(stdout);
        reject(Object.assign(error, { output: String(stderr).trim() }));
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const gitEnvironment = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_COUNT: "0" };
function git(cwd, args, options) {
  return run("git", ["-c", "gc.auto=0", ...args], { cwd, env: gitEnvironment, ...options });
}

const project = fileURLToPath(new URL("../", import.meta.url));
const [authorName, authorEmail] = await Promise.all(
  ["user.name", "user.email"].map(async (key) => (await git(project, ["config", key])).trim()),
);
const identity = ["-c", `user.name=${authorName}`, "-c", `user.email=${authorEmail}`, "-c", "commit.gpgsign=false"];

async function isClone(dir) {
  try {
    return (await stat(join(dir, ".git"))).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function clone({ repo, head }) {
  const dir = join(root, repo.replace("/", "--"));
  const url = `https://github.com/${repo}.git`;
  if (!(await isClone(dir))) {
    await git(
      root,
      ["clone", `--revision=${head}`, `--depth=${REVISIONS + 1}`, "--no-tags", "--no-checkout", url, dir],
      {
        timeout: 600_000,
      },
    );
  }
  assert.equal((await git(dir, ["remote", "get-url", "origin"])).trim(), url);
  return dir;
}

function objects(dir) {
  const blobs = new Map();
  return async function prime(ids) {
    const missing = [...new Set(ids)].filter((id) => !blobs.has(id));
    if (missing.length === 0) return blobs;
    const batch = await git(dir, ["cat-file", "--batch"], { input: missing.join("\n") + "\n", encoding: "buffer" });
    let offset = 0;
    for (const id of missing) {
      const lineEnd = batch.indexOf(10, offset);
      const [found, type, rawSize] = batch.toString("ascii", offset, lineEnd).split(" ");
      const size = Number(rawSize);
      assert.ok(found === id && type === "blob" && Number.isSafeInteger(size) && size >= 0, `cannot read blob ${id}`);
      const end = lineEnd + 1 + size;
      assert.equal(batch[end], 10, `truncated blob ${id}`);
      blobs.set(id, batch.toString("utf8", lineEnd + 1, end));
      offset = end + 1;
    }
    assert.equal(offset, batch.length, "unexpected bytes after blob batch");
    return blobs;
  };
}

async function treeAt(dir, commit, readBlobs) {
  const listing = await git(dir, ["ls-tree", "-rtz", commit]);
  const rootEntries = [];
  const entries = new Map();
  for (const line of listing.split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const path = line.slice(tab + 1);
    const [mode, type, id] = line.slice(0, tab).split(" ");
    if (!path.includes("/")) rootEntries.push(line);
    if (type !== "tree") entries.set(path, { mode, id });
  }
  assert.ok(!rootEntries.some((entry) => entry.endsWith(`\t${CONFIG}`)), `upstream already contains ${CONFIG}`);
  const modeRefusals = new Map([
    ["120000", "symbolic-link"],
    ["160000", "submodule"],
  ]);
  const blob = (path) => {
    const entry = entries.get(path);
    return entry && !modeRefusals.has(entry.mode) ? entry.id : undefined;
  };
  const files = [...entries.keys()];
  return {
    rootEntries,
    has: (path) => entries.has(path),
    files: () => files,
    prime: (paths) => readBlobs(paths.map(blob).filter(Boolean)),
    text: async (path) => {
      const id = blob(path);
      return id === undefined ? undefined : (await readBlobs([id])).get(id);
    },
    read: async (path) => {
      const refusal = modeRefusals.get(entries.get(path)?.mode);
      if (refusal) return { kind: "refused", refusal };
      const id = blob(path);
      if (!id) return { kind: "missing" };
      return { kind: "file", text: (await readBlobs([id])).get(id) };
    },
  };
}

async function audit(tree, config, expected) {
  const result = await loadModel(
    {
      files: () => Promise.resolve(tree.files()),
      read: (path) => (path === CONFIG ? Promise.resolve({ kind: "file", text: config }) : tree.read(path)),
    },
    CONFIG,
  );
  if (!result.ok) return formatProblems(result.error);
  const sort = (packages) => packages.map(({ name, dir }) => `${dir}: ${name}`).sort();
  const actual = sort([...result.value.packageDirs[0].values()]);
  const wanted = sort(expected);
  if (JSON.stringify(actual) === JSON.stringify(wanted)) return null;
  return JSON.stringify({
    missing: wanted.filter((entry) => !actual.includes(entry)),
    extra: actual.filter((entry) => !wanted.includes(entry)),
  });
}

async function overlay(dir, rootEntries, configId, parent) {
  const input = [...rootEntries, `100644 blob ${configId}\t${CONFIG}`].join("\0") + "\0";
  const tree = (await git(dir, ["mktree", "-z"], { input })).trim();
  const args = [...identity, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Add replay config"];
  return (await git(dir, args)).trim();
}

async function decide(dir, base, head) {
  const start = performance.now();
  const child = spawn(
    process.execPath,
    [CLI, "explain", "--base", base, "--head", head, "--config", CONFIG, "--json"],
    {
      cwd: dir,
      windowsHide: true,
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const [closed, parsed] = await Promise.allSettled([once(child, "close"), readFieldPlan(child.stdout)]);
  const ms = performance.now() - start;
  if (closed.status === "rejected") return { error: closed.reason.message, exit: null, signal: null, ms };
  const [exit, signal] = closed.value;
  if (exit !== 0) return { error: stderr.trim() || "CLI did not exit successfully", exit, signal, ms };
  try {
    if (parsed.status === "rejected") throw parsed.reason;
    const { base: actualBase, head: actualHead, ...result } = parsed.value;
    assert.equal(actualBase, base);
    assert.equal(actualHead, head);
    return { ms, ...result };
  } catch (error) {
    return { error: error.message, exit, signal, ms };
  }
}

async function replay(repo) {
  const stem = join(output, repo.repo.replace("/", "--"));
  const out = stem + ".jsonl";
  const resultFile = stem + ".result.json";
  const key = JSON.stringify({
    ...repo,
    limit,
    version,
    node: process.version,
    nodeOptions: process.env.NODE_OPTIONS ?? "",
  });
  const priorResult = await readIfPresent(resultFile);
  if (priorResult) {
    const { key: priorKey, result } = JSON.parse(priorResult);
    if (priorKey === key && isClean(result)) return result;
  }
  const dir = await clone(repo);
  const revs = (await git(dir, ["rev-list", "--first-parent", `--max-count=${limit + 1}`, repo.head]))
    .trim()
    .split("\n")
    .reverse();
  assert.equal(revs.length, limit + 1, `${repo.repo} needs at least ${limit + 1} first-parent commits`);
  const recorded = await readIfPresent(out);
  const completeLines = recorded.slice(0, recorded.lastIndexOf("\n") + 1);
  const [recordedKey, ...lines] = completeLines.trimEnd().split("\n");
  const rows = recordedKey === key ? lines.map((line) => JSON.parse(line)) : [];
  const restart = rows.findIndex((row, index) => row.commit !== revs[index + 1] || row.error || row.layoutError);
  if (restart >= 0) rows.length = restart;
  const resumed = rows.at(-1)?.overlay;
  if (resumed !== undefined) await git(dir, ["cat-file", "-e", `${resumed}^{commit}`]);
  await writeFile(out, [key, ...rows.map((row) => JSON.stringify(row)), ""].join("\n"));
  const readBlobs = objects(dir);
  const configs = new Map();
  let base = resumed;
  for (const commit of revs.slice(rows.length === 0 ? 0 : rows.length + 1)) {
    const tree = await treeAt(dir, commit, readBlobs);
    const workspace = await workspaceAt(tree);
    const config = fieldConfig(workspace.packages);
    const layoutError = await audit(tree, config, workspace.packages);
    let configId = configs.get(config);
    if (configId === undefined) {
      configId = (await git(dir, ["hash-object", "-w", "--stdin"], { input: config })).trim();
      configs.set(config, configId);
    }
    const head = await overlay(dir, tree.rootEntries, configId, base);
    if (base !== undefined) {
      const decision = await decide(dir, base, head);
      const row = {
        commit,
        overlay: head,
        manager: workspace.manager,
        packages: workspace.packages.length,
        testLanes: workspace.packages.filter(({ test }) => test).length,
        layoutError,
        ...decision,
      };
      rows.push(row);
      await appendFile(out, JSON.stringify(row) + "\n");
    }
    base = head;
  }
  const result = summarize(repo, rows);
  await saveJson(resultFile, { key, result });
  return result;
}

function summarize({ repo, branch, head }, rows) {
  const failures = rows.filter((row) => "error" in row);
  const completed = rows.filter((row) => "lanes" in row);
  const occurrences = completed.flatMap(({ fallbacks }) => fallbacks);
  const reasons = Object.fromEntries(
    [...new Set(occurrences)].sort().map((reason) => [reason, occurrences.filter((item) => item === reason).length]),
  );
  const times = completed.map(({ ms }) => ms).sort((a, b) => a - b);
  const percentile = (p) => (times.length === 0 ? null : Math.round(times[Math.ceil(times.length * p) - 1]));
  const tip = rows.at(-1);
  return {
    repo,
    branch,
    head,
    manager: tip.manager,
    packages: tip.packages,
    testLanes: tip.testLanes,
    attempted: rows.length,
    readErrors: rows.filter(({ layoutError }) => layoutError !== null).length,
    decisions: completed.length,
    laneVerdicts: completed.reduce((sum, row) => sum + row.lanes, 0),
    skipped: completed.reduce((sum, row) => sum + row.skipped, 0),
    fallbacks: completed.filter(({ fallbacks }) => fallbacks.length > 0).length,
    reasons,
    rejections: failures.filter(({ exit, layoutError }) => exit === 1 && layoutError !== null).length,
    crashes: failures.filter(({ exit, layoutError }) => exit !== 1 || layoutError === null).length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
  };
}

const summary = [];
for (const repo of selected) {
  let result;
  try {
    result = await replay(repo);
  } catch (error) {
    result = { ...repo, error: error.output || error.message };
  }
  summary.push(result);
  process.stdout.write(JSON.stringify(result) + "\n");
}
await saveJson(join(output, "summary.json"), summary);
if (summary.some((row) => !isClean(row))) process.exitCode = 1;

function isClean(row) {
  return !row.error && row.readErrors === 0 && row.crashes === 0 && row.rejections === 0;
}
