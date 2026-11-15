import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitFixture } from "../test/support/git-fixture.ts";

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

  repo.write("packages/ui/src/button.tsx", 'export const Button = "button";\nexport const size = "large";\n');
  const oneFile = explain(repo.commit("Enlarge the button"));
  process.stdout.write("\n");

  repo.write("fixtures/browser/login.json", '{\n  "user": "grace"\n}\n');
  repo.write("docs/api/users.md", "# Users\n\nThe api serves this file by name. It now lists roles.\n");
  repo.write("README.md", "# acme\n\nA small monorepo that lane-router routes in its tests.\n\nRun pnpm test.\n");
  repo.write(".vscode/settings.json", '{\n  "editor.formatOnSave": true,\n  "editor.tabSize": 2\n}\n');
  const fiveFiles = explain(repo.commit("Refresh the fixtures and the docs"));

  process.exitCode = oneFile || fiveFiles;
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
