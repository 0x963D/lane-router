import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse } from "yaml";

export async function workspaceAt(tree) {
  const root = JSON.parse(((await tree.text("package.json")) ?? "{}").replace(/^\uFEFF/, ""));
  const pnpm = await tree.text("pnpm-workspace.yaml");
  const isPnpm = pnpm !== undefined;
  const declared = Array.isArray(root.workspaces) ? root.workspaces : root.workspaces?.packages;
  const manager = isPnpm ? "pnpm" : root.packageManager?.startsWith("yarn@") || tree.has("yarn.lock") ? "yarn" : "npm";
  const patterns = isPnpm ? (parse(pnpm)?.packages ?? []) : (declared ?? []);
  if (!isPnpm && declared === undefined) return { manager: null, packages: [] };
  assert.ok(
    Array.isArray(patterns) && patterns.every((pattern) => typeof pattern === "string"),
    "invalid workspace patterns",
  );

  const include = patterns.filter((pattern) => !pattern.startsWith("!"));
  const exclude = patterns.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const matches = (file, pattern) =>
    posix.matchesGlob(file, `${posix.normalize(pattern).replace(/\/$/, "")}/package.json`);
  const files = tree.files().filter((file) => {
    if (!file.endsWith("/package.json") || file.split("/").some((part) => part === "node_modules" || part === ".git")) {
      return false;
    }
    return include.some((pattern) => matches(file, pattern)) && !exclude.some((pattern) => matches(file, pattern));
  });
  await tree.prime(files);
  const packages = [];
  for (const file of files) {
    const text = await tree.text(file);
    if (text === undefined) continue;
    const json = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (typeof json.name === "string" && json.name !== "") {
      packages.push({ name: json.name, dir: posix.dirname(file), test: typeof json.scripts?.test === "string" });
    }
  }
  return { manager, packages };
}

export function fieldConfig(packages) {
  const tests = packages.filter(({ test }) => test);
  const lanes = Object.fromEntries(
    tests
      .map(({ dir, name }) => [
        `test-${createHash("sha256").update(dir).digest("hex").slice(0, 12)}`,
        { packages: [name] },
      ])
      .sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1)),
  );
  assert.equal(Object.keys(lanes).length, tests.length, "test lane names must be unique");
  return JSON.stringify({ lanes: { ...lanes, floor: { floor: true } }, unmatched: "all" });
}
