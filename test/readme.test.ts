import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fixtureDir } from "./support/fixtures.ts";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

function firstYamlBlockAfter(heading: string): string | undefined {
  const section = readme.split(`\n${heading}\n`)[1];
  return section?.match(/```yaml\n([\s\S]*?)```/)?.[1];
}

describe("README", () => {
  it("shows the acme fixture's config as its config example, so the demo's row numbers match it", () => {
    const fixture = readFileSync(`${fixtureDir("acme")}.github/lanes.yml`, "utf8");
    expect(firstYamlBlockAfter("## Config reference")).toBe(fixture);
  });
});
