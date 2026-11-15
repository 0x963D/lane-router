import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DEMO_SCENARIOS } from "../scripts/demo-scenarios.ts";
import { cli } from "./support/cli.ts";
import { fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture } from "./support/git-fixture.ts";

it("keeps both README excerpts equal to the demo's decision tables", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const excerpts = [...readme.matchAll(/```text\n([\s\S]*?)\n```/g)].map((match) => match[1]);
  expect(excerpts).toHaveLength(DEMO_SCENARIOS.length);
  const repo = gitFixture(fixtureDir("acme"), tempDir());
  for (const [index, scenario] of DEMO_SCENARIOS.entries()) {
    for (const [path, text] of Object.entries(scenario.files)) repo.write(path, text);
    const head = repo.commit(scenario.message);
    const run = await cli(["explain", "--base", repo.base, "--head", head], repo.dir);
    expect(run.code).toBe(0);
    const table = run.stdout.split("\n\n")[1];
    expect(table).toBeDefined();
    const excerpt = index === 0 ? table : table?.split("\n").find((row) => row.startsWith("api "));
    expect(excerpts[index]).toBe(excerpt);
  }
});
