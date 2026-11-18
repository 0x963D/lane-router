import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";

const input = process.argv[2];
assert.ok(input, "pass the path to summary.json");
const rows = JSON.parse(readFileSync(input, "utf8"));
assert.ok(rows.length > 0 && rows.every((row) => !row.error), "the replay must finish every repository");

const reasonNames = {
  "built-in/config": "config",
  "built-in/lockfile": "lockfile",
  "built-in/root-manifest": "root",
  "built-in/workspace": "workspace",
};
const counts = (reasons) =>
  Object.entries(reasons)
    .map(([reason, count]) => `${reasonNames[reason] ?? reason} ${count}`)
    .join(", ") || "none";
const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
const totalReasons = {};
for (const { reasons } of rows) {
  for (const [reason, count] of Object.entries(reasons)) totalReasons[reason] = (totalReasons[reason] ?? 0) + count;
}
const table = [
  "| Repository at replay tip | Workspace | Head packages / test lanes | Read errors | Plans | Skipped / lane verdicts | Fallbacks and reasons | Rejected / crashed | p50 / p95 ms |",
  "| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
  ...rows.map(
    (row) =>
      `| [${row.repo} @ ${row.head.slice(0, 12)}](https://github.com/${row.repo}/commit/${row.head}) | ${row.manager} | ${row.packages} / ${row.testLanes} | ${row.readErrors} | ${row.decisions} / ${row.attempted} | ${row.skipped} / ${row.laneVerdicts} | ${row.fallbacks} (${counts(row.reasons)}) | ${row.rejections} / ${row.crashes} | ${row.p50Ms ?? "n/a"} / ${row.p95Ms ?? "n/a"} |`,
  ),
  `| **Total (${rows.length} repositories)** | | | ${sum("readErrors")} | ${sum("decisions")} / ${sum("attempted")} | ${sum("skipped")} / ${sum("laneVerdicts")} | ${sum("fallbacks")} (${counts(totalReasons)}) | ${sum("rejections")} / ${sum("crashes")} | |`,
];
process.stdout.write(table.join("\n") + "\n");
