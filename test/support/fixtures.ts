import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

export function fixtureDir(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}/`, import.meta.url));
}

/** Paths mapped to new text, or to null to delete the file. */
export type Overrides = Readonly<Record<string, string | null>>;

export function applyOverrides(dir: string, overrides: Overrides): void {
  for (const [path, text] of Object.entries(overrides)) {
    const target = join(dir, path);
    if (text === null) rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
}

/** A directory under the system temp folder, removed when the current test finishes. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lane-router-"));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return dir;
}

export function fixtureCopy(name: string, overrides: Overrides = {}): string {
  const dir = tempDir();
  cpSync(fixtureDir(name), dir, { recursive: true });
  applyOverrides(dir, overrides);
  return dir;
}
