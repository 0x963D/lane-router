import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";

const input = process.argv[2] ?? "coverage/mutation.json";
const report = JSON.parse(readFileSync(input, "utf8"));
const totals = new Map();
const pending = [];
for (const [file, { source, mutants }] of Object.entries(report.files).sort()) {
  const lines = source.split("\n");
  for (const { id, status, location, replacement } of mutants) {
    totals.set(status, (totals.get(status) ?? 0) + 1);
    if (status === "Killed") continue;
    const { line, column } = location.start;
    pending.push({
      id,
      file: `${file}:${line}:${column}`,
      status,
      source: lines[line - 1]?.trim(),
      replacement,
    });
  }
}
const killed = totals.get("Killed") ?? 0;
const timedOut = totals.get("Timeout") ?? 0;
const eligible = killed + timedOut + (totals.get("Survived") ?? 0) + (totals.get("NoCoverage") ?? 0);
assert.ok(eligible > 0, "no eligible mutants in the report");
const percent = (count) => Number(((100 * count) / eligible).toFixed(2));
process.stdout.write(
  JSON.stringify(
    {
      totals: Object.fromEntries([...totals].sort()),
      eligible,
      score: percent(killed + timedOut),
      killedByTests: percent(killed),
      ...(process.argv.includes("--details") ? { pending } : {}),
    },
    null,
    2,
  ) + "\n",
);
