import fc from "fast-check";

type Edge = [from: number, to: number];
const fields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

export type File =
  | { kind: "package"; owner: number; note: boolean }
  | { kind: "claim"; claim: number }
  | { kind: "manifest"; owner: number }
  | { kind: "docs" | "unmatched" | "lockfile" };

export const scenario = fc.integer({ min: 2, max: 8 }).chain((size) => {
  const index = fc.integer({ min: 0, max: size - 1 });
  const roots = fc.uniqueArray(index, { maxLength: 3 });
  const claim = fc.integer({ min: 0, max: size + 3 });
  const edge = fc.tuple(index, index);
  const deps = fc.array(edge, { maxLength: size * 2 });
  const file = fc.oneof(
    { weight: 6, arbitrary: fc.record({ kind: fc.constant("package"), owner: index, note: fc.boolean() }) },
    { weight: 3, arbitrary: fc.record({ kind: fc.constant("claim"), claim: fc.integer({ min: 0, max: 3 }) }) },
    { weight: 2, arbitrary: fc.constant({ kind: "docs" }) },
    { weight: 1, arbitrary: fc.constant({ kind: "unmatched" }) },
    { weight: 1, arbitrary: fc.constant({ kind: "lockfile" }) },
  ) satisfies fc.Arbitrary<File>;
  return fc
    .record({
      nested: fc.array(fc.boolean(), { minLength: size, maxLength: size }),
      dependencies: fc.record({
        dependencies: deps,
        devDependencies: deps,
        peerDependencies: deps,
        optionalDependencies: deps,
      }),
      extra: fc.array(edge, { maxLength: size }),
      lanes: fc.array(fc.record({ roots, floor: fc.boolean() }), { minLength: 1, maxLength: 6 }),
      packageRules: fc.array(fc.record({ claim, packages: roots, via: fc.constantFrom("code", "tests", "name") }), {
        maxLength: 6,
      }),
      laneRules: fc.array(fc.record({ claim, all: fc.boolean() }), { maxLength: 4 }),
      change: fc.oneof(
        {
          weight: 14,
          arbitrary: fc.record({
            kind: fc.constant("graph"),
            reader: index,
            offset: fc.integer({ min: 1, max: size - 1 }),
            field: fc.constantFrom(...fields, "extra"),
          }),
        },
        {
          weight: 6,
          arbitrary: fc.record({ kind: fc.constant("mixed"), files: fc.array(file, { maxLength: 6 }) }),
        },
        {
          weight: 2,
          arbitrary: fc.record({ kind: fc.constant("rename"), before: file, after: file }),
        },
        {
          weight: 2,
          arbitrary: fc.record({
            kind: fc.constant("base"),
            reader: index,
            offset: fc.integer({ min: 1, max: size - 1 }),
          }),
        },
      ),
    })
    .map(({ change, ...generated }) => {
      const input = { ...generated, previous: undefined, renamedPackage: undefined };
      const { dependencies, extra, packageRules, laneRules } = input;
      const lanes = input.lanes.map((lane) => ({ ...lane, floor: lane.floor || lane.roots.length === 0 }));
      switch (change.kind) {
        case "graph": {
          const { reader, offset, field } = change;
          const target = (reader + offset) % size;
          const claim = target + 4;
          const added: Edge = [reader, target];
          return {
            ...input,
            dependencies:
              field === "extra" ? dependencies : { ...dependencies, [field]: [...dependencies[field], added] },
            extra: field === "extra" ? [...extra, added] : extra,
            lanes: [...lanes, { roots: [reader], floor: false }],
            packageRules: packageRules.filter((rule) => rule.claim !== claim),
            laneRules: laneRules.filter((rule) => rule.claim !== claim),
            files: [{ kind: "package", owner: target, note: false }] satisfies File[],
          };
        }
        case "mixed":
          return { ...input, lanes, files: change.files };
        case "rename":
          return { ...input, lanes, files: [change.after], previous: change.before };
        case "base": {
          const target = (change.reader + change.offset) % size;
          const withoutTarget = (packages: readonly number[]) => packages.filter((pkg) => pkg !== target);
          const added: Edge = [change.reader, target];
          return {
            ...input,
            dependencies: { ...dependencies, dependencies: [...dependencies.dependencies, added] },
            extra: extra.filter((edge) => !edge.includes(target)),
            lanes: [
              ...lanes.map(({ roots, floor }) => {
                const remaining = withoutTarget(roots);
                return { roots: remaining, floor: floor || remaining.length === 0 };
              }),
              { roots: [change.reader], floor: false },
            ],
            packageRules: packageRules.map((rule) => ({ ...rule, packages: withoutTarget(rule.packages) })),
            files: [{ kind: "manifest", owner: target }] satisfies File[],
            renamedPackage: target,
          };
        }
      }
    });
});

export type Scenario = ReturnType<typeof scenario.generate>["value"];

function closure(roots: readonly number[], edges: readonly Edge[], size: number) {
  const reachable = new Set(roots);
  for (let pass = 0; pass < size; pass++) {
    for (const [from, to] of edges) if (reachable.has(from)) reachable.add(to);
  }
  return reachable;
}

export function expectedRuns(input: Scenario) {
  const files = [...input.files, ...(input.previous === undefined ? [] : [input.previous])];
  const docsOnly =
    files.length > 0 &&
    files.every(
      (file) =>
        file.kind === "lockfile" ||
        file.kind === "docs" ||
        (file.kind === "claim" && file.claim === 0) ||
        (file.kind === "package" && file.note),
    );
  const claims = files.flatMap((file) =>
    file.kind === "claim" ? [file.claim] : file.kind === "package" ? [file.owner + 4] : [],
  );
  const owners = files.flatMap((file) => (file.kind === "package" || file.kind === "manifest" ? [file.owner] : []));
  const fallback = files.some(
    (file) =>
      file.kind === "lockfile" ||
      file.kind === "unmatched" ||
      (file.kind === "claim" &&
        file.claim !== 0 &&
        !input.packageRules.some((rule) => rule.claim === file.claim && rule.packages.length > 0) &&
        !input.laneRules.some((rule) => rule.claim === file.claim)),
  );
  const base = [...Object.values(input.dependencies).flat(), ...input.extra];
  const head = base.filter(([, to]) => to !== input.renamedPackage);
  return input.lanes.map(({ roots, floor }, lane) => {
    const reachable = closure(roots, head, input.nested.length);
    const baseReach = input.renamedPackage === undefined ? undefined : closure(roots, base, input.nested.length);
    const readsPackage = (pkg: number) => reachable.has(pkg) || baseReach?.has(pkg) === true;
    const rowRuns =
      input.packageRules.some(
        (rule) =>
          claims.includes(rule.claim) &&
          rule.packages.some((pkg) => (rule.via === "tests" ? roots.includes(pkg) : readsPackage(pkg))),
      ) ||
      input.laneRules.some(
        (rule) => claims.includes(rule.claim) && (rule.all || lane === rule.claim % input.lanes.length),
      );
    const packageRuns = !docsOnly && owners.some(readsPackage);
    const graphSensitive =
      packageRuns && !floor && !fallback && !rowRuns && !owners.some((owner) => roots.includes(owner));
    return {
      required: fallback || rowRuns || packageRuns || (floor && files.length > 0 && !docsOnly),
      graphSensitive,
    };
  });
}
