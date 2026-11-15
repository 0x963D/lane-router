import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitFixture } from "../test/support/git-fixture.ts";
import { DEMO_SCENARIOS } from "./demo-scenarios.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "lane-router-demo-"));

try {
  const repo = gitFixture(join(ROOT, "test/fixtures/acme"), dir);

  const short = (sha: string): string => sha.slice(0, 7);
  const explain = (head: string): number => {
    process.stdout.write(`$ git diff --name-only ${short(repo.base)}...${short(head)}\n`);
    process.stdout.write(`${repo.git("diff", "--name-only", `${repo.base}...${head}`)}\n\n`);
    process.stdout.write(`$ lane-router explain --base ${short(repo.base)} --head ${short(head)}\n`);
    const run = spawnSync(
      process.execPath,
      [join(ROOT, "dist/cli.js"), "explain", "--base", repo.base, "--head", head],
      { cwd: repo.dir, stdio: "inherit" },
    );
    return run.status ?? 1;
  };

  let code = 0;
  for (const scenario of DEMO_SCENARIOS) {
    for (const [path, text] of Object.entries(scenario.files)) repo.write(path, text);
    const result = explain(repo.commit(scenario.message));
    code ||= result;
    process.stdout.write("\n");
  }
  process.exitCode = code;
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
