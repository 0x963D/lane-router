import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { fixtureDir, tempDir } from "./support/fixtures.ts";
import { gitFixture } from "./support/git-fixture.ts";

const replay = fileURLToPath(new URL("../scripts/field-replay.js", import.meta.url));

it("replays first-parent changes with the checkout's routing config", async () => {
  const source = gitFixture(fixtureDir("acme"), tempDir());
  source.write("packages/ui/src/button.tsx", "export const Button = 42;\n");
  source.commit("Change the button");
  source.write("README.md", "Update the overview.\n");
  const head = source.commit("Change the readme");
  const scratch = tempDir();
  const args = [replay, "--checkout", source.dir, "--root", scratch, "--limit", "4"];
  const run = () => promisify(execFile)(process.execPath, args, { windowsHide: true, timeout: 30_000 });
  const first = await run();

  expect(JSON.parse(first.stdout)).toMatchObject({
    head,
    attempted: 2,
    decisions: 2,
    laneVerdicts: 8,
    skipped: 5,
    laneCounts: {
      api: { run: 0, skip: 2 },
      web: { run: 1, skip: 1 },
      e2e: { run: 1, skip: 1 },
      lint: { run: 1, skip: 1 },
    },
    rejections: 0,
    crashes: 0,
  });
  expect(JSON.parse(readFileSync(join(scratch, "summary.json"), "utf8"))).toEqual([JSON.parse(first.stdout)]);
  expect((await run()).stdout).toBe(first.stdout);
  expect(source.git("rev-parse", "HEAD")).toBe(head);
  expect(source.git("status", "--porcelain")).toBe("");
});

it.each([{ config: [] }, { config: ["--config", "missing.yml"] }])(
  "explains a missing config with one line ($config)",
  async ({ config }) => {
    const source = gitFixture(fixtureDir("acme"), tempDir());
    source.remove(".github/lanes.yml");
    source.commit("Remove the routing config");
    const result = promisify(execFile)(process.execPath, [
      replay,
      "--checkout",
      source.dir,
      "--root",
      tempDir(),
      ...config,
    ]);
    await expect(result).rejects.toHaveProperty("code", 1);
    const expected =
      config.length === 0
        ? /^Missing routing config \.github\/lanes\.yml at [a-f0-9]{12}\. Supply --config <path>\.\r?\n$/
        : /^Missing routing config "missing\.yml"\. Set --config to an existing file\.\r?\n$/;
    await expect(result.catch((error: unknown) => error)).resolves.toHaveProperty(
      "stderr",
      expect.stringMatching(expected),
    );
  },
);
