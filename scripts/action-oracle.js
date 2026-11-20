import assert from "node:assert/strict";
import { fixture, git, mergeBases } from "./action-scenarios.js";

export const diagnostics = {
  ancestry: /does not extend its compare base/,
  cap: /at most 300 files.*Local Git could not verify/,
  checkout: /does not match the event.*head/,
  count: /pull request changes/,
  gitBase: /base routing model.*cannot be built/,
  head: /head input does not match|cannot resolve the head input/,
  mode: /mode input is required|routes in (push|pr) mode/,
  noBase: /no base commit/,
  outside: /not a path inside the routed root/,
  prCheckout: /matches neither/,
  rewind: /head does not extend base/,
  groupHead: /merge_group.head_sha/,
  wrongList: /at most 300 files/,
  unavailable: /returned 503/,
  invalidJson: /not valid JSON/,
  missingFiles: /cannot read/,
  compare: /returned 404/,
};

function cached(read) {
  const values = new Map();
  return (...key) => {
    const id = JSON.stringify(key);
    if (!values.has(id)) values.set(id, read(...key));
    return values.get(id);
  };
}

export function actionOracle(repo) {
  const tree = cached((revision) => {
    const entries = git(repo, ["ls-tree", "-r", "-z", "--full-tree", revision]).split("\0").filter(Boolean);
    return new Map(entries.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry.slice(0, entry.indexOf("\t"))]));
  });
  const json = cached((revision, path) => JSON.parse(git(repo, ["show", revision + ":" + path])));
  const resolveRevision = (cwd, ref) => {
    try {
      return git(cwd, ["rev-parse", "--verify", "--end-of-options", ref + "^{commit}"]).trim();
    } catch {
      return undefined;
    }
  };
  const resolve = cached(resolveRevision);
  const parents = cached((cwd, revision) =>
    git(cwd, ["cat-file", "-p", revision])
      .split("\n\n", 1)[0]
      .split("\n")
      .filter((line) => line.startsWith("parent "))
      .map((line) => line.slice(7)),
  );
  const changed = cached((base, head) => {
    const before = tree(base);
    const after = tree(head);
    const paths = [...new Set([...before.keys(), ...after.keys()])];
    return paths.filter((path) => before.get(path) !== after.get(path)).sort();
  });
  const ancestry = cached((base, head) => mergeBases(repo, base, head));
  const shallow = cached((cwd) => git(cwd, ["rev-parse", "--is-shallow-repository"]).trim() === "true");
  const renameCount = cached(
    (base, head) =>
      git(repo, ["diff", "--name-only", "--find-renames", "-z", base, head, "--"]).split("\0").filter(Boolean).length,
  );

  return (cwd, scenario) => {
    const checkout = resolveRevision(cwd, "HEAD");
    assert.ok(checkout === scenario.checkout, "fixture checkout differs from its requested revision");
    const prefix = scenario.root === "." ? "" : scenario.root + "/";
    const checkedConfig = json(checkout, prefix + fixture.config);
    const lanes = Object.keys(checkedConfig.lanes);
    const { event, payload, eventSha, inputs = {} } = scenario;
    const pr = payload.pull_request;
    const group = payload.merge_group;
    const defaults = pr ? "pr" : event === "push" || event === "merge_group" ? "push" : undefined;
    const mode = inputs.mode ?? defaults;
    const verdict = { lanes, run: lanes, mode, paths: [], supplied: "", shallow: shallow(cwd) };
    const close = (diagnostic, details) => ({ ...verdict, ...details, closed: diagnostic });
    const reject = (diagnostic) => ({ ...verdict, rejected: diagnostic, noRequest: true });
    if (event === "merge_group" && !group?.head_sha) return reject("groupHead");
    if (!mode || (defaults && mode !== defaults && event !== "merge_group")) return reject("mode");

    // Start with the event's declared revisions. Classify the checked-out tree before selecting a range.
    const eventHead = pr?.head.sha ?? group?.head_sha ?? (event === "push" ? payload.after : eventSha);
    const eventBase = pr?.base.sha ?? group?.base_sha ?? payload.before;
    const explicitBase = inputs.base !== undefined;
    const explicitHead = inputs.head !== undefined;
    const supplied = scenario.supplied
      ? changed(eventBase, eventHead)
          .map((path) => path.slice(prefix.length))
          .join("\n")
      : inputs.files;
    if (explicitHead && (inputs.head === "HEAD" ? checkout : resolve(cwd, inputs.head)) !== checkout)
      return close("head", { supplied, noRequest: true });

    if (supplied) {
      const paths = supplied.trim().split("\n");
      const base = explicitBase ? resolve(cwd, inputs.base) : null;
      const result = route(checkedConfig, prefix, checkout, base, paths);
      return {
        ...verdict,
        ...result,
        supplied,
        noRequest: true,
        head: explicitHead ? checkout : eventHead,
        matrixBase: inputs.base ?? eventBase ?? "",
        paths,
      };
    }
    if (!explicitBase && (!eventBase || /^0+$/.test(eventBase))) return close("noBase", { noRequest: true });
    if (!explicitHead && !pr && checkout !== eventHead) return close("checkout", { noRequest: true });
    if (!explicitHead && event === "pull_request" && ![eventHead, eventSha].includes(checkout))
      return close("prCheckout", { noRequest: true });

    const targetTip = event === "pull_request_target" && checkout === eventSha;
    const proposed = Boolean(pr && (checkout === eventHead || targetTip));
    const [first, second, ...otherParents] = proposed || !pr ? [] : parents(cwd, checkout);
    const verifiedMerge = second === eventHead && first !== undefined && otherParents.length === 0;
    const matrixBase = inputs.base ?? (verifiedMerge ? first : eventBase);
    const head = targetTip && !explicitHead ? eventHead : checkout;
    // A branch the remote cannot name can still be resolved by the checkout.
    const base =
      (fixture.remoteRef.test(matrixBase) ? resolve(repo, matrixBase) : undefined) ?? resolve(cwd, matrixBase);
    if (!base) return close("compare");
    const bases = ancestry(base, head);
    const remoteBase = scenario.remoteMergeBase ?? bases[0];
    assert.ok(bases.includes(remoteBase), "fixture endpoint must use a best common ancestor");
    const details = { matrixBase, head, diff: [remoteBase, head] };
    if (!proposed && Boolean(pr || group || mode === "push") && !bases.includes(base))
      return close(mode === "pr" ? "ancestry" : "rewind", details);

    // Transport and deliberately corrupted listings come from outside Git.
    if (scenario.manualExpectation) return close(scenario.manualExpectation, details);

    const full = changed(remoteBase, head);
    const count = renameCount(remoteBase, head);
    const requiredCount = proposed && !explicitBase && !explicitHead ? pr.changed_files : null;
    if (count >= fixture.listLimit) {
      // A large listing is usable only when this checkout can establish the same diff.
      const localBase = mergeBases(cwd, base, head, { local: true })[0];
      const localChoice = scenario.remoteMergeBase ? readLocalChoice(cwd, base, head) : localBase;
      if (localChoice === undefined) return close("cap", details);
      if (changed(localChoice, head).some((path) => !path.startsWith(prefix))) return close("outside", details);
      if (localChoice !== remoteBase || (requiredCount !== null && requiredCount !== full.length))
        return close("cap", { ...details, localBase: localChoice });
    } else if (requiredCount !== null && count !== requiredCount) {
      return close("count", details);
    }
    if (full.some((path) => !path.startsWith(prefix))) return close("outside", details);
    const paths = full.map((path) => path.slice(prefix.length));
    return {
      ...verdict,
      ...details,
      ...route(checkedConfig, prefix, checkout, resolve(cwd, remoteBase), paths),
      paths,
    };
  };

  function route(checkedConfig, prefix, checkout, base, paths) {
    const lanes = Object.keys(checkedConfig.lanes);
    const needsBase = paths.some((path) => path === fixture.config || path.endsWith("/package.json"));
    if (needsBase && !base) return { lanes, run: lanes, closed: "gitBase" };
    if (paths.includes(fixture.config)) {
      const union = [...new Set([...lanes, ...Object.keys(json(base, prefix + fixture.config).lanes)])];
      return { lanes: union, run: union };
    }
    const touched = new Set(paths.map((path) => /^packages\/([^/]+)\//.exec(path)?.[1]));
    if (touched.has(undefined)) return { lanes, run: lanes };
    const models = [checkout, ...(needsBase ? [base] : [])].map(
      (revision) =>
        new Map(
          [...tree(revision).keys()]
            .filter(
              (path) => path.startsWith(prefix) && /^packages\/[^/]+\/package\.json$/.test(path.slice(prefix.length)),
            )
            .map((path) => {
              const manifest = json(revision, path);
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
      run: lanes.filter((lane) => models.some((model) => reaches(checkedConfig.lanes[lane].packages, model))),
    };
  }
}

function readLocalChoice(cwd, base, head) {
  try {
    return git(cwd, ["merge-base", base, head]).trim();
  } catch {
    return undefined;
  }
}
