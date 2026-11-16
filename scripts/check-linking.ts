import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { directoryTree } from "../src/adapters/directory.ts";
import { loadModel } from "../src/load/index.ts";
import { LINKING_CASES, type LinkingCase } from "./linking-cases.ts";

const VERSIONS = { pnpm: "11.18.0", npm: "11.11.0" } as const;
type Manager = keyof typeof VERSIONS;
const scratch = mkdtempSync(join(process.env.LANE_ROUTER_TMP ?? tmpdir(), "lane-router-linking-"));

async function run(manager: Manager, args: readonly string[], cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : manager;
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", `${manager} ${args.join(" ")}`] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      env: {
        ...process.env,
        CI: "true",
        npm_config_cache: join(cwd, ".cache"),
        npm_config_update_notifier: "false",
        npm_config_registry: "http://127.0.0.1:1",
        XDG_CACHE_HOME: join(cwd, ".cache"),
        XDG_CONFIG_HOME: join(cwd, ".config"),
        XDG_DATA_HOME: join(cwd, ".data"),
        XDG_STATE_HOME: join(cwd, ".state"),
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "protocol.allow",
        GIT_CONFIG_VALUE_0: "never",
        GIT_TERMINAL_PROMPT: "0",
      },
      timeout: 30_000,
    });
    let output = "";
    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      output += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, output });
    });
  });
}

function write(dir: string, path: string, text: string): void {
  const file = join(dir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function dependencyAt(dir: string, key: string, root: string): string | undefined {
  for (let parent = dir; ; parent = dirname(parent)) {
    const manifest = join(parent, "node_modules", key, "package.json");
    if (existsSync(manifest)) return manifest;
    if (parent === root || parent === parse(parent).root) return undefined;
  }
}

function moduleKeys(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) =>
    name.startsWith("@")
      ? readdirSync(join(dir, name)).map((child) => `${name}/${child}`)
      : name.startsWith(".")
        ? []
        : [name],
  );
}

interface Outcome {
  readonly row: number;
  readonly label: string;
  readonly manager: Manager;
  readonly result: string;
  readonly links: readonly string[];
}
async function check(row: LinkingCase, index: number, manager: Manager): Promise<Outcome> {
  const dir = join(scratch, `${index}-${manager}`);
  const names = [
    "@acme/api",
    row.specifier.includes(":ui@") ? "ui" : "@acme/ui",
    "plain",
    "3d",
    "v1-compat",
    "@acme/inner-ui",
  ];
  const dirs = ["api", "ui", "plain", "three", "v1", "api/packages/ui"];
  const field = row.field ?? "dependencies";
  const manifests = names.map((name, i) => ({
    name,
    version: "1.0.0",
    ...(i === 0 ? { [field]: { [row.key]: row.specifier } } : {}),
  }));
  const globs = ["packages/*", "packages/api/packages/*"];
  write(dir, "package.json", JSON.stringify({ name: "root", private: true, workspaces: globs, ...row.root }));
  write(
    dir,
    "pnpm-workspace.yaml",
    `packages: ${JSON.stringify(globs)}\nlinkWorkspacePackages: true\nstoreDir: .store\ncacheDir: .cache\n${row.yaml ?? ""}`,
  );
  manifests.forEach((manifest, i) => {
    write(dir, `packages/${dirs[i] ?? ""}/package.json`, JSON.stringify(manifest));
  });
  write(
    dir,
    ".github/lanes.yml",
    `workspace:\n  discovery: ${manager}\nlanes:\n${names.map((name, i) => `  lane${i}:\n    packages: [${JSON.stringify(name)}]`).join("\n")}\nunmatched: all\n`,
  );
  const installed = await run(
    manager,
    [
      "install",
      "--offline",
      "--ignore-scripts",
      ...(manager === "pnpm" ? ["--no-frozen-lockfile"] : ["--no-audit", "--no-fund"]),
    ],
    dir,
  );
  write(dir, "install.log", installed.output);
  assert.equal(
    installed.code === 0,
    row.installs.includes(manager),
    `row ${index + 1} ${manager} install status changed in ${dir}: ${installed.output}`,
  );
  if (installed.code !== 0) {
    assert.notEqual(installed.code, -1, `install did not finish in ${dir}`);
    assert(!/Unknown options|command not found|is not recognized/i.test(installed.output), installed.output);
    return { row: index + 1, label: row.label, manager, result: "rejected", links: [] };
  }
  const linked: { from: number; to: number; key: string }[] = [];
  for (let from = 0; from < dirs.length; from++) {
    const packageDir = join(dir, "packages", dirs[from] ?? "");
    const keys = new Set([...moduleKeys(join(packageDir, "node_modules")), ...(from === 0 ? [row.key] : [])]);
    for (const key of keys) {
      const path = dependencyAt(packageDir, key, dir);
      if (path === undefined) continue;
      const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
      assert(manifest !== null && typeof manifest === "object" && "name" in manifest);
      const to = names.findIndex((name) => name === manifest.name);
      if (to !== -1) linked.push({ from, to, key });
    }
  }
  const links = linked.map(({ from, to, key }) => `${names[from]} -> ${names[to]} via ${key}`);
  const model = await loadModel(directoryTree(dir), ".github/lanes.yml");
  if (!model.ok)
    return { row: index + 1, label: row.label, manager, result: `FAIL load ${JSON.stringify(model.error)}`, links };
  for (const { from, to } of linked) {
    const reach = model.value.packageDirs[0].get(`packages/${dirs[to] ?? ""}`)?.reach;
    const edge = [...(reach ?? [])].find(([lane]) => lane === `lane${from}`)?.[1];
    if (edge?.kind !== "reads" || (from !== to && edge.chain.length !== 2)) {
      return {
        row: index + 1,
        label: row.label,
        manager,
        result: `FAIL missing ${names[from]} -> ${names[to]}`,
        links,
      };
    }
  }
  return { row: index + 1, label: row.label, manager, result: "pass", links };
}

for (const manager of ["pnpm", "npm"] as const) {
  const version = await run(manager, ["--version"], scratch);
  assert.equal(version.code, 0, version.output);
  assert.equal(version.output.trim(), VERSIONS[manager], `${manager} version must be pinned`);
}
const outcomes: Outcome[] = [];
const jobs = LINKING_CASES.flatMap((row, index) =>
  (["pnpm", "npm"] as const).map((manager) => ({ row, index, manager })),
);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (job === undefined) break;
      const outcome = await check(job.row, job.index, job.manager);
      outcomes.push(outcome);
      process.stdout.write(
        `${job.index + 1}\t${outcome.label}\t${outcome.manager}\t${outcome.result}\t${outcome.links.join("; ")}\n`,
      );
    }
  }),
);
write(scratch, "results.json", JSON.stringify(outcomes, null, 2));
const failures = outcomes.filter(({ result }) => result.startsWith("FAIL"));
process.stdout.write(
  `${LINKING_CASES.length} rows, ${outcomes.filter(({ result }) => result === "pass").length} installed and checked, ${outcomes.filter(({ result }) => result === "rejected").length} rejected, ${failures.length} failures. Logs: ${scratch}\n`,
);
assert.equal(
  failures.length,
  0,
  failures.map(({ label, manager, result }) => `${label} [${manager}] ${result}`).join("\n"),
);
