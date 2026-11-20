import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT = "workspace";
const CONFIG = ".github/lanes.yml";
const LANES = ["alpha", "bravo", "charlie", "delta"];
const EMPTY_SHA = "0".repeat(40);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));

export function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=.git/no-hooks", ...args], {
    cwd,
    env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: ".git/no-global", ...extraEnv },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
}

export function history(dir, seed) {
  const repo = join(dir, "full");
  mkdirSync(repo);
  const run = (...args) => git(repo, args).trim();
  function write(path, text) {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
  const json = (path, value) => write(ROOT + "/" + path, JSON.stringify(value) + "\n");
  let tick = 0;
  function commit(...args) {
    const stamp = new Date(Date.UTC(2020, 0, 1, 0, 0, tick++)).toISOString();
    git(repo, args, {
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    });
    return run("rev-parse", "HEAD");
  }
  function save(message) {
    run("add", "--all");
    return commit("commit", "--quiet", "--allow-empty", "-m", message);
  }
  function branch(name, start) {
    run("switch", "--quiet", "-c", name, start);
  }
  const pkg = (lane, file) => "packages/" + lane + "/" + file;
  const manifest = (lane, reads) =>
    json(pkg(lane, "package.json"), { name: lane, ...(reads ? { dependencies: { [reads]: "*" } } : {}) });
  const config = (names) =>
    json(CONFIG, {
      lanes: Object.fromEntries(names.map((lane, index) => [lane, { packages: [LANES[index]] }])),
      unmatched: "all",
    });
  const [from, to, reader, other] = [...LANES].sort((a, b) => Buffer.compare(rank(seed, a), rank(seed, b)));
  const move = pkg(from, "move " + seed + ".js");
  const moved = pkg(to, "move " + seed + ".js");
  const rename = pkg(from, "rename.js");
  const renamed = pkg(to, "renamed.js");
  const deleted = pkg(reader, "delete.js");
  const customPath = pkg(other, "custom.js");

  run("init", "--quiet", "--initial-branch=main", "--object-format=sha1");
  json("package.json", { private: true, workspaces: ["packages/*"] });
  config(LANES);
  for (const lane of LANES) manifest(lane, lane === reader ? from : undefined);
  write(ROOT + "/" + move, "const moved = 1;\n");
  write(ROOT + "/" + rename, "const renamed = 1;\n");
  write(ROOT + "/" + deleted, "const deleted = 1;\n");
  const fork = save("Initial workspace");

  branch("patch", fork);
  write(ROOT + "/" + move, "const moved = 2;\n");
  const patch = save("Edit the file on the PR branch");

  run("switch", "--quiet", "main");
  renameSync(join(repo, ROOT, move), join(repo, ROOT, moved));
  manifest(reader);
  const first = save("Move the file and remove a dependency on base");
  const merge = commit("merge", "--quiet", "--no-ff", "--no-edit", "patch");

  branch("newer-base", first);
  write(ROOT + "/" + pkg(other, "advance.js"), "advance\n");
  config([...LANES.slice(0, -1), "foxtrot"]);
  const newer = save("Advance base past the tested merge");

  branch("custom", first);
  write(ROOT + "/" + customPath, "custom\n");
  const custom = save("Create a different tested tree");
  write("outside.txt", "outside the routed root\n");
  const outside = save("Change a path outside the routed root");

  branch("rename", fork);
  renameSync(join(repo, ROOT, rename), join(repo, ROOT, renamed));
  rmSync(join(repo, ROOT, deleted));
  const renames = save("Rename across packages and delete a file");

  branch("manifest", fork);
  manifest(reader);
  write(ROOT + "/" + move, "const moved = 3;\n");
  const manifests = save("Remove a reader and change its former dependency");

  branch("config", fork);
  config([...LANES.slice(0, -1), "echo"]);
  const configs = save("Rename a lane");

  branch("large", fork);
  for (let index = 0; index < 300 + (seed % 7); index++) {
    write(ROOT + "/" + pkg("alpha", "bulk-" + index + ".js"), String(index));
  }
  write(ROOT + "/" + pkg("delta", "omitted.js"), "beyond the compare cap\n");
  const large = save("Exceed the compare cap");

  const checkouts = new Map();
  let current = large;
  function checkout(head, shallow) {
    if (!shallow) {
      if (current !== head) run("switch", "--quiet", "--detach", head);
      current = head;
      return repo;
    }
    const existing = checkouts.get(head);
    if (existing !== undefined) return existing;
    const path = join(dir, "shallow-" + checkouts.size);
    run("clone", "--quiet", "--depth=1", "--revision=" + head, pathToFileURL(repo).href, path);
    checkouts.set(head, path);
    return path;
  }

  return { repo, checkout, fork, first, patch, merge, newer, custom, outside, renames, manifests, configs, large };
}

function rank(seed, name) {
  // Derive the same permutation for a seed even when only one case is selected.
  const value = Buffer.from(name);
  let hash = seed | 0;
  for (const byte of value) hash = Math.imul(hash ^ byte, 16777619);
  const rank = Buffer.alloc(4);
  rank.writeInt32BE(Math.imul(hash ^ (hash >>> 16), 0x85ebca6b));
  return rank;
}

export function cases(h) {
  const pr = (name, checkout, base, options = {}) => ({
    name,
    checkout,
    event: "pull_request",
    payload: { pull_request: { base: { sha: base }, head: { sha: h.patch }, changed_files: 1 } },
    eventSha: h.merge,
    ...options,
  });
  const push = (name, checkout, before, after, options = {}) => ({
    name,
    checkout,
    event: "push",
    payload: { before, after },
    eventSha: after,
    ...options,
  });
  const manual = (checkout, name, options) => ({
    name,
    checkout,
    event: "workflow_dispatch",
    payload: {},
    eventSha: h.custom,
    ...options,
  });
  return [
    pr("merge-stale-base", h.merge, h.fork, { diff: [h.first, h.merge], shallow: true }),
    pr("merge-newer-base", h.merge, h.newer, { diff: [h.first, h.merge] }),
    pr("merge-explicit-head", h.merge, h.newer, { diff: [h.first, h.merge], inputs: { head: "HEAD" } }),
    pr("merge-explicit-base", h.merge, h.fork, { diff: [h.fork, h.merge], inputs: { base: h.fork } }),
    pr("pr-head", h.patch, h.newer, { diff: [h.fork, h.patch], matrixBase: h.newer, shallow: true }),
    pr("pr-target-head", h.patch, h.newer, {
      event: "pull_request_target",
      eventSha: h.newer,
      diff: [h.fork, h.patch],
      matrixBase: h.newer,
    }),
    pr("target-merge", h.merge, h.newer, {
      event: "pull_request_target",
      eventSha: h.newer,
      diff: [h.first, h.merge],
    }),
    pr("target-base-tip", h.newer, h.newer, {
      event: "pull_request_target",
      eventSha: h.newer,
      diff: [h.fork, h.patch],
      matrixBase: h.newer,
    }),
    pr("pr-wrong-checkout", h.custom, h.first, { closed: /matches neither/ }),
    pr("pr-custom-head", h.custom, h.first, { diff: [h.first, h.custom], inputs: { head: "HEAD" } }),
    pr("pr-custom-nonancestor", h.custom, h.newer, {
      inputs: { head: "HEAD" },
      closed: /does not extend its compare base/,
    }),
    pr("pr-count-mismatch", h.patch, h.newer, { closed: /pull request changes 1/, fault: "short-list" }),
    pr("pr-explicit-bypasses-count", h.patch, h.newer, {
      inputs: { base: h.patch },
      diff: [h.patch, h.patch],
    }),
    pr("pr-base-graph-from-diff", h.configs, h.newer, {
      payload: { pull_request: { base: { sha: h.newer }, head: { sha: h.configs }, changed_files: 1 } },
      diff: [h.fork, h.configs],
      matrixBase: h.newer,
    }),
    push("push-forward", h.custom, h.first, h.custom, { diff: [h.first, h.custom] }),
    push("push-short-base", h.custom, h.first, h.custom, {
      diff: [h.first, h.custom],
      matrixBase: h.first.slice(0, 10),
      inputs: { base: h.first.slice(0, 10) },
    }),
    push("push-local-base", h.custom, h.first, h.custom, {
      diff: [h.first, h.custom],
      matrixBase: "custom^^",
      inputs: { base: "custom^^" },
    }),
    push("push-wrong-checkout", h.custom, h.first, h.merge, { closed: /does not match the event.*head/ }),
    push("push-explicit-checkout", h.custom, h.first, h.merge, {
      diff: [h.first, h.custom],
      inputs: { head: "HEAD" },
    }),
    push("push-explicit-wrong-head", h.custom, h.first, h.custom, {
      inputs: { head: h.merge },
      closed: /head input does not match/,
    }),
    push("push-force", h.custom, h.newer, h.custom, { closed: /head does not extend base/ }),
    push("push-rewind", h.first, h.custom, h.first, { closed: /head does not extend base/ }),
    push("push-new-branch", h.custom, EMPTY_SHA, h.custom, { closed: /no base commit/ }),
    push("push-new-branch-base", h.custom, EMPTY_SHA, h.custom, {
      inputs: { base: h.first, head: "HEAD" },
      diff: [h.first, h.custom],
    }),
    push("push-wrong-mode", h.custom, h.first, h.custom, { inputs: { mode: "pr" }, failed: /routes in push mode/ }),
    push("push-renames-and-deletes", h.renames, h.fork, h.renames, { diff: [h.fork, h.renames] }),
    push("push-manifest-shallow", h.manifests, h.fork, h.manifests, {
      closed: /base routing model|base workspace|base commit/,
      shallow: true,
    }),
    push("push-config", h.configs, h.fork, h.configs, { diff: [h.fork, h.configs] }),
    push("push-outside-root", h.outside, h.first, h.outside, { closed: /not a path inside the routed root/ }),
    push("push-capped", h.large, h.fork, h.large, { closed: /at most 300 files/ }),
    push("push-capped-shallow", h.large, h.fork, h.large, { closed: /at most 300 files/, shallow: true }),
    push("push-compare-error", h.custom, h.first, h.custom, { closed: /returned 503/, fault: "unavailable" }),
    push("push-invalid-json", h.custom, h.first, h.custom, { closed: /not valid JSON/, fault: "invalid-json" }),
    push("push-invalid-list", h.custom, h.first, h.custom, { closed: /cannot read/, fault: "missing-files" }),
    manual(h.custom, "manual-default-head", { inputs: { mode: "pr", base: h.first }, diff: [h.first, h.custom] }),
    manual(h.custom, "manual-missing-mode", { inputs: { base: h.first }, failed: /mode input is required/ }),
    manual(h.custom, "manual-push", {
      inputs: { mode: "push", base: h.newer, head: "HEAD" },
      closed: /head does not extend base/,
    }),
    ...[{}, { base: h.fork }, { head: "HEAD" }, { base: h.fork, head: "HEAD" }].map((inputs, index) =>
      push("supplied-files-" + index, h.renames, h.fork, h.renames, {
        inputs,
        diff: [h.fork, h.renames],
        supplied: true,
      }),
    ),
    push("supplied-files-wrong-head", h.renames, h.fork, h.renames, {
      inputs: { files: "outside-the-test.js", head: h.fork },
      closed: /head input does not match/,
      noRequest: true,
    }),
  ];
}

export const fixture = { root: ROOT, config: CONFIG, listLimit: 300 };
