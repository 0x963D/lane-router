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
export function isolatedGit(cwd) {
  return { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(cwd, ".git", "no-global") };
}
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));

export function git(cwd, args, extraEnv = {}) {
  return execFileSync("git", ["-c", "core.autocrlf=false", "-c", "core.hooksPath=.git/no-hooks", ...args], {
    cwd,
    env: { ...gitEnv, ...isolatedGit(cwd), ...extraEnv },
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
    const output = git(repo, args, {
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
    });
    return args[0] === "commit-tree" ? output.trim() : run("rev-parse", "HEAD");
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
  const spare = ["bravo", "charlie"].filter((lane) => lane !== reader);
  const capSource = spare[seed % spare.length];
  const capRename = pkg(capSource, "capped-rename.js");
  const capRenamed = pkg("delta", "capped-renamed.js");
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
  write(ROOT + "/" + capRename, "const cappedRename = 37;\n");
  const fork = save("Initial workspace");

  branch("patch", fork);
  write(ROOT + "/" + move, "const moved = 2;\n");
  let patch = save("Edit the file on the PR branch");
  if (seed % 3 === 0) {
    write(ROOT + "/" + pkg(to, "pr-follow-up.js"), "follow-up\n");
    patch = save("Add another PR change");
  }

  run("switch", "--quiet", "main");
  renameSync(join(repo, ROOT, move), join(repo, ROOT, moved));
  manifest(reader);
  let first = save("Move the file and remove a dependency on base");
  if (seed % 4 > 1) {
    write(ROOT + "/" + pkg(reader, "pre-merge.js"), "before merge\n");
    first = save("Advance the base before testing the merge");
  }
  const merge = commit("merge", "--quiet", "--no-ff", "--no-edit", "patch");

  branch("newer-base", first);
  write(ROOT + "/" + pkg(other, "advance.js"), "advance\n");
  config([...LANES.slice(0, -1), "foxtrot"]);
  let newer = save("Advance base past the tested merge");
  if (seed % 5 > 1) newer = save("Advance the payload base again");

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
  for (let index = 0; index < 299; index++) {
    write(ROOT + "/" + pkg("alpha", "bulk-" + index + ".js"), String(index));
  }
  write(ROOT + "/" + pkg("delta", "last.js"), "beyond a capped listing\n");
  const exactCap = save("Reach the compare cap");
  const largeCount = 301 + (seed % 7);
  for (let index = 299; index < largeCount - 1; index++) {
    write(ROOT + "/" + pkg("alpha", "bulk-" + index + ".js"), String(index));
  }
  const large = save("Exceed the compare cap");
  write("zz-outside.txt", "outside the workspace and beyond the compare cap\n");
  const largeOutside = save("Edit a path outside the workspace after the cap");

  branch("large-rename", large);
  renameSync(join(repo, ROOT, capRename), join(repo, ROOT, capRenamed));
  const largeRename = save("Rename across packages after the compare cap");

  branch("large-merge", first);
  const largeMerge = commit("merge", "--quiet", "--no-ff", "--no-edit", large);

  branch("queue", seed % 2 ? custom : first);
  const queueBase = run("rev-parse", "HEAD");
  const queueHead = commit("merge", "--quiet", "--no-ff", "--no-edit", patch);

  branch("other-pr-parent", fork);
  write(ROOT + "/" + pkg(other, "other-parent.js"), "another PR\n");
  const otherParent = save("Give the test merge a different second parent");
  branch("different-merge", first);
  const differentMerge = commit("merge", "--quiet", "--no-ff", "--no-edit", otherParent);
  const octopus = commit(
    "commit-tree",
    differentMerge + "^{tree}",
    "-p",
    first,
    "-p",
    patch,
    "-p",
    otherParent,
    "-m",
    "Record three parents",
  );
  // commit-tree reports its new object without moving the branch.
  branch("octopus", octopus);

  const [leftLane, rightLane] = ["bravo", "charlie", "delta"].filter((lane) => lane !== reader);
  branch("cross-left", fork);
  write(ROOT + "/" + pkg(leftLane, "cross-left.js"), "left\n");
  const left = save("Change the left merge base");
  branch("cross-right", fork);
  write(ROOT + "/" + pkg(rightLane, "cross-right.js"), "right\n");
  const right = save("Change the right merge base");
  const crossBase = commit("merge", "--quiet", "--no-ff", "--no-edit", left);
  branch("cross-head", left);
  commit("merge", "--quiet", "--no-ff", "--no-edit", right);
  for (let index = 0; index < largeCount; index++) {
    write(ROOT + "/" + pkg("alpha", "cross-bulk-" + index + ".js"), String(index));
  }
  const crossHead = save("Exceed the cap after the reversed merge");
  const localCross = run("merge-base", crossBase, crossHead);
  const remoteCross = mergeBases(repo, crossBase, crossHead).find((base) => base !== localCross);

  branch("at-root", fork);
  for (const entry of ["packages", ".github", "package.json"]) renameSync(join(repo, ROOT, entry), join(repo, entry));
  const rootBase = save("Route from the default working directory");
  write(pkg(other, "root-edit.js"), "root edit\n");
  const rootHead = save("Change a package at the repository root");

  const checkouts = new Map();
  let current;
  function checkout(head, depth) {
    if (depth === undefined) {
      if (current !== head) run("switch", "--quiet", "--detach", head);
      current = head;
      return repo;
    }
    const key = head + ":" + depth;
    if (checkouts.has(key)) return checkouts.get(key);
    const path = join(dir, "shallow-" + checkouts.size);
    run("clone", "--quiet", "--depth=" + depth, "--revision=" + head, pathToFileURL(repo).href, path);
    checkouts.set(key, path);
    return path;
  }

  const counts = new Map();
  function prCount(base, head) {
    const key = base + ":" + head;
    if (!counts.has(key)) {
      const [common] = mergeBases(repo, base, head);
      counts.set(
        key,
        git(repo, ["diff", "--name-only", "--find-renames", "-z", common, head, "--"]).split("\0").filter(Boolean)
          .length,
      );
    }
    return counts.get(key);
  }

  return {
    repo,
    checkout,
    prCount,
    seed,
    fork,
    first,
    patch,
    merge,
    newer,
    custom,
    outside,
    renames,
    manifests,
    configs,
    exactCap,
    large,
    largeCount,
    largeOutside,
    largeRename,
    largeMerge,
    queueBase,
    queueHead,
    differentMerge,
    octopus,
    crossBase,
    crossHead,
    remoteCross,
    rootBase,
    rootHead,
  };
}

export function mergeBases(repo, base, head, { local = false } = {}) {
  try {
    return git(repo, ["merge-base", "--all", base, head]).trim().split("\n").filter(Boolean).sort();
  } catch (error) {
    if (error.status === 1 || local) return [];
    throw error;
  }
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
  const pr = (name, checkout, base, { head = h.patch, changedFiles = h.prCount(base, head), ...rest } = {}) => ({
    name,
    checkout,
    event: "pull_request",
    payload: { pull_request: { base: { sha: base }, head: { sha: head }, changed_files: changedFiles } },
    eventSha: h.merge,
    ...rest,
  });
  const push = (name, checkout, before, after, options = {}) => ({
    name,
    checkout,
    event: "push",
    payload: { before, after },
    eventSha: after,
    ...options,
  });
  const group = (name, checkout, base, head, options = {}) => ({
    name,
    checkout,
    event: "merge_group",
    payload: { action: "checks_requested", merge_group: { base_sha: base, head_sha: head } },
    eventSha: h.patch,
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

  const depth = (h.seed % 2) + 1;
  const alternateBase = h.seed % 2 ? h.fork : h.newer;
  const atRoot = h.seed % 3 !== 1;
  const generated = [
    pr("seeded-merge-shape", h.seed % 2 ? h.octopus : h.differentMerge, alternateBase, {
      depth,
      inputs: { head: "HEAD" },
    }),
    (h.seed % 3 === 0 ? group : push)("seeded-event-and-inputs", h.custom, alternateBase, h.custom, {
      depth,
      inputs: h.seed % 3 === 1 ? {} : { base: h.first, head: "HEAD" },
    }),
    (h.seed % 2 ? group : push)(
      "seeded-root-and-depth",
      atRoot ? h.rootHead : h.custom,
      atRoot ? h.rootBase : h.first,
      atRoot ? h.rootHead : h.custom,
      { depth, root: atRoot ? "." : ROOT },
    ),
  ];

  return [
    pr("merge-stale-base", h.merge, h.fork, { depth: 1 }),
    pr("merge-newer-base", h.merge, h.newer),
    pr("merge-explicit-head", h.merge, h.newer, { depth, inputs: { head: "HEAD" } }),
    pr("merge-explicit-base", h.merge, h.fork, { inputs: { base: h.fork } }),
    pr("pr-head", h.patch, h.newer, { depth: 1 }),
    pr("pr-target-head", h.patch, h.newer, { event: "pull_request_target", eventSha: h.newer, depth }),
    pr("target-merge", h.merge, h.newer, { event: "pull_request_target", eventSha: h.newer }),
    pr("target-base-tip", h.newer, h.newer, { event: "pull_request_target", eventSha: h.newer, depth: 1 }),
    pr("target-tip-explicit-head", h.newer, h.newer, {
      event: "pull_request_target",
      eventSha: h.newer,
      inputs: { head: "HEAD" },
    }),
    pr("pr-wrong-checkout", h.custom, h.first),
    pr("pr-custom-head", h.custom, h.first, { depth, inputs: { head: "HEAD" } }),
    pr("pr-custom-nonancestor", h.custom, h.newer, { inputs: { head: "HEAD" } }),
    pr("pr-count-mismatch", h.patch, h.newer, { changedFiles: h.prCount(h.newer, h.patch) + 1 }),
    pr("pr-explicit-bypasses-count", h.patch, h.newer, { inputs: { base: h.patch }, changedFiles: 99 }),
    pr("pr-base-graph-from-diff", h.configs, h.newer, { head: h.configs }),
    push("push-forward", h.custom, h.first, h.custom, { depth: 1 }),
    push("push-short-base", h.custom, h.first, h.custom, { inputs: { base: h.first.slice(0, 10) } }),
    push("push-local-base", h.custom, h.first, h.custom, { inputs: { base: "custom^^" } }),
    push("push-wrong-checkout", h.custom, h.first, h.merge),
    push("push-explicit-checkout", h.custom, h.first, h.merge, { inputs: { head: "HEAD" } }),
    push("push-explicit-wrong-head", h.custom, h.first, h.custom, { inputs: { head: h.merge } }),
    push("push-force", h.custom, h.newer, h.custom, { depth: 1 }),
    push("push-rewind", h.first, h.custom, h.first),
    push("push-new-branch", h.custom, EMPTY_SHA, h.custom),
    push("push-new-branch-base", h.custom, EMPTY_SHA, h.custom, { inputs: { base: h.first, head: "HEAD" } }),
    push("push-wrong-mode", h.custom, h.first, h.custom, { inputs: { mode: "pr" } }),
    push("push-renames-and-deletes", h.renames, h.fork, h.renames),
    push("push-manifest-shallow", h.manifests, h.fork, h.manifests, { depth: 1 }),
    push("push-manifest-depth-two", h.manifests, h.fork, h.manifests, { depth: 2 }),
    push("push-config", h.configs, h.fork, h.configs),
    push("push-outside-root", h.outside, h.first, h.outside),
    push("push-root-default", h.rootHead, h.rootBase, h.rootHead, { root: "." }),
    push("push-exact-cap", h.exactCap, h.fork, h.exactCap),
    push("push-capped", h.large, h.fork, h.large),
    push("push-capped-rename", h.largeRename, h.fork, h.largeRename),
    push("push-capped-outside", h.largeOutside, h.fork, h.largeOutside),
    push("push-capped-disagreement", h.large, h.fork, h.large, { fault: "wrong-file", manualExpectation: "wrongList" }),
    pr("pr-capped", h.large, h.newer, { head: h.large }),
    pr("pr-capped-count-disagreement", h.large, h.newer, { head: h.large, changedFiles: h.largeCount - 1 }),
    pr("pr-default-merge-capped", h.largeMerge, h.fork, { head: h.large, eventSha: h.largeMerge }),
    pr("pr-default-merge-capped-shallow", h.largeMerge, h.fork, { head: h.large, eventSha: h.largeMerge, depth: 1 }),
    pr("pr-default-merge-capped-depth-two", h.largeMerge, h.fork, { head: h.large, eventSha: h.largeMerge, depth: 2 }),
    pr("pr-capped-criss-cross", h.crossHead, h.crossBase, { head: h.crossHead, remoteMergeBase: h.remoteCross }),
    push("push-capped-shallow", h.large, h.fork, h.large, { depth }),
    push("push-compare-error", h.custom, h.first, h.custom, { fault: "unavailable", manualExpectation: "unavailable" }),
    push("push-invalid-json", h.custom, h.first, h.custom, { fault: "invalid-json", manualExpectation: "invalidJson" }),
    push("push-invalid-list", h.custom, h.first, h.custom, {
      fault: "missing-files",
      manualExpectation: "missingFiles",
    }),
    group("merge-group-default", h.queueHead, h.queueBase, h.queueHead, { depth: 1 }),
    group("merge-group-wrong-checkout", h.outside, h.queueBase, h.queueHead),
    group("merge-group-custom-head", h.custom, h.first, h.queueHead, { inputs: { head: "HEAD" }, depth }),
    group("merge-group-nonancestor", h.queueHead, h.newer, h.queueHead, { depth: 1 }),
    group("merge-group-explicit-pr", h.queueHead, h.queueBase, h.queueHead, {
      inputs: { mode: "pr", base: h.queueBase, head: "HEAD" },
      depth,
    }),
    group("merge-group-explicit-pr-nonancestor", h.queueHead, h.newer, h.queueHead, { inputs: { mode: "pr" } }),
    group("merge-group-missing-head", h.queueHead, h.queueBase, h.queueHead, {
      payload: { merge_group: { base_sha: h.queueBase } },
    }),
    manual(h.custom, "manual-default-head", { inputs: { mode: "pr", base: h.first } }),
    manual(h.custom, "manual-missing-mode", { inputs: { base: h.first } }),
    manual(h.custom, "manual-push", { inputs: { mode: "push", base: h.newer, head: "HEAD" } }),
    ...[{}, { base: h.fork }, { head: "HEAD" }, { base: h.fork, head: "HEAD" }].map((inputs, index) =>
      push("supplied-files-" + index, h.renames, h.fork, h.renames, { inputs, supplied: true }),
    ),
    push("supplied-files-wrong-head", h.renames, h.fork, h.renames, {
      inputs: { files: "outside-the-test.js", head: h.fork },
    }),
    ...generated,
  ].map((scenario) => ({ root: ROOT, ...scenario }));
}

export const fixture = { config: CONFIG, listLimit: 300, remoteRef: /^[\w/.-]+$/ };
