import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { Stryker } from "@stryker-mutator/core";

const { values } = parseArgs({
  options: {
    scope: { type: "string", default: "src" },
    workers: { type: "string", default: "1" },
    output: { type: "string", default: "coverage/mutation" },
    file: { type: "string" },
  },
});
const core = values.scope === "core";
const seam = values.scope === "seam";
const testConfig = core ? "scripts/routing-test.config.ts" : seam ? "scripts/seam-test.config.ts" : undefined;
assert.ok(core || seam || values.scope === "src", "pass --scope src, core or seam");
const concurrency = Number(values.workers);
assert.ok(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 4, "pass one to four workers");
if (values.file !== undefined) {
  assert.match(values.file, /^src(?:\/[\w-]+)+\.ts$/);
  assert.ok(existsSync(values.file), "mutation file must exist");
}

const hash = createHash("sha256");
hash.update(JSON.stringify({ ...values, node: process.version, nodeOptions: process.env.NODE_OPTIONS ?? "" }));
for (const path of [
  "package-lock.json",
  "stryker.config.json",
  "vitest.config.ts",
  "tsconfig.json",
  import.meta.filename,
]) {
  hash.update(readFileSync(path));
}
if (testConfig !== undefined) hash.update(readFileSync(testConfig));
for (const dir of ["src", "test"]) {
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map(({ parentPath, name }) => join(parentPath, name))
    .sort()) {
    hash.update(entry).update(readFileSync(entry));
  }
}
const output = resolve(values.output, hash.digest("hex").slice(0, 16));
mkdirSync(output, { recursive: true });
const jsonReport = join(output, "report.json");
process.stdout.write(`Report path ${jsonReport}\n`);
if (!existsSync(jsonReport)) {
  const incrementalFile = join(output, "incremental.json");
  const checkpoint = readCheckpoint(output);
  if (Object.keys(checkpoint.files).length > 0) writeFileSync(incrementalFile, JSON.stringify(checkpoint));
  const attempt = mkdtempSync(join(output, `attempt-${Date.now()}-`));
  const attemptReport = join(attempt, "report.json");
  process.env.LANE_ROUTER_ACTION_TEST_PROCESS = "in-process";
  const scopes = {
    core: ["src/core/**/*.ts"],
    seam: ["src/action.ts", "src/adapters/{github,git,directory}.ts", "src/core/change.ts"],
    src: ["src/**/*.ts"],
  };
  await new Stryker({
    concurrency,
    mutate: values.file === undefined ? scopes[values.scope] : [values.file],
    ...(testConfig === undefined ? {} : { vitest: { related: false, configFile: testConfig } }),
    incremental: true,
    incrementalFile,
    symlinkNodeModules: false,
    eventReporter: { baseDir: join(attempt, "events") },
    reporters: ["clear-text", "progress", "json", "event-recorder"],
    jsonReporter: { fileName: attemptReport },
  }).runMutationTest();
  renameSync(attemptReport, jsonReport);
}

function readCheckpoint(output) {
  const entries = new Map();
  const tests = new Map();
  for (const attempt of readdirSync(output)
    .filter((name) => name.startsWith("attempt-"))
    .sort()) {
    const dir = join(output, attempt, "events");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!/-on(DryRunCompleted|MutantTested)\.json$/.test(name)) continue;
      let event;
      try {
        event = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch (error) {
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (name.endsWith("-onDryRunCompleted.json")) {
        for (const test of event.result.tests) tests.set(test.id, test);
      } else {
        entries.set(event.id, event);
      }
    }
  }
  const files = Object.create(null);
  const testFiles = Object.create(null);
  const repoPath = (file) => relative(process.cwd(), file).replaceAll("\\", "/");
  for (const { fileName, ...mutant } of entries.values()) {
    const path = repoPath(fileName);
    const file = (files[path] ??= { source: readFileSync(path, "utf8"), language: "typescript", mutants: [] });
    file.mutants.push(mutant);
  }
  for (const { fileName, id, name, startPosition } of tests.values()) {
    const path = repoPath(fileName);
    const file = (testFiles[path] ??= { source: readFileSync(path, "utf8"), tests: [] });
    const location = startPosition
      ? { start: { line: startPosition.line + 1, column: startPosition.column + 1 } }
      : undefined;
    file.tests.push({ id, name, location });
  }
  return { schemaVersion: "1.0", thresholds: { high: 80, low: 60 }, projectRoot: process.cwd(), files, testFiles };
}
