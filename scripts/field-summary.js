import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import process from "node:process";

const input = process.argv[2];
assert.ok(input, "pass the path to summary.json");
const rows = JSON.parse(readFileSync(input, "utf8"));
assert.ok(rows.length > 0 && rows.every((row) => !row.error), "the replay must finish every repository");

if (rows.length === 1 && rows[0].laneCounts !== undefined) {
  const row = rows[0];
  process.stdout.write(`${row.repo} @ ${row.head.slice(0, 12)}: ${row.decisions}/${row.attempted} plans\n\n`);
  process.stdout.write("| Lane | Run | Skip |\n| --- | ---: | ---: |\n");
  for (const [lane, { run, skip }] of Object.entries(row.laneCounts)) {
    process.stdout.write(`| ${lane} | ${run} | ${skip} |\n`);
  }
  if (row.rejections + row.crashes > 0) {
    process.stdout.write(`\nRejected: ${row.rejections}. Crashed: ${row.crashes}.\n`);
    process.exitCode = 1;
  }
} else {
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
    "| Repository at replay tip | Workspace | Head packages / test lanes | Discovery mismatches | Plans | Skipped / lane verdicts | Fallbacks and reasons | Rejected / crashed |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | ---: |",
    ...rows.map(
      (row) =>
        `| [${row.repo} @ ${row.head.slice(0, 12)}](https://github.com/${row.repo}/commit/${row.head}) | ${row.manager} | ${row.packages} / ${row.testLanes} | ${row.discoveryMismatches} | ${row.decisions} / ${row.attempted} | ${row.skipped} / ${row.laneVerdicts} | ${row.fallbacks} (${counts(row.reasons)}) | ${row.rejections} / ${row.crashes} |`,
    ),
    `| **Total (${rows.length} repositories)** | | | ${sum("discoveryMismatches")} | ${sum("decisions")} / ${sum("attempted")} | ${sum("skipped")} / ${sum("laneVerdicts")} | ${sum("fallbacks")} (${counts(totalReasons)}) | ${sum("rejections")} / ${sum("crashes")} |`,
  ];
  const floorOnly = rows.filter((row) => row.floorOnly && row.laneVerdicts === row.decisions);
  const floorPlans = floorOnly.reduce((total, row) => total + row.decisions, 0);
  process.stdout.write(table.join("\n") + "\n");
  process.stdout.write(`\nFloor-only repositories: ${floorOnly.length}. Plans: ${floorPlans}.\n`);
}
