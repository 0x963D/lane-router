import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureDir } from "./support/fixtures.ts";

const reference = readFileSync(new URL("../docs/config.md", import.meta.url), "utf8");

describe("config reference", () => {
  it("shows the acme fixture's config as its first example, so the demo's row numbers match it", () => {
    const fixture = readFileSync(`${fixtureDir("acme")}.github/lanes.yml`, "utf8");
    expect(reference.match(/```yaml\n([\s\S]*?)```/)?.[1]).toBe(fixture);
  });
});
