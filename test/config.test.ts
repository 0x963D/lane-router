import { describe, expect, it } from "vitest";
import { FIXED_OUTPUTS } from "../src/core/ids.ts";
import { CONFIG, configProblems, located, loadFixture, problemsOf } from "./support/model.ts";

const lanes = `lanes:
  api:
    packages: ["@acme/api"]
`;

function at(line: number, column: number) {
  return { line, column };
}

describe("config validation", () => {
  it("reports every problem in one error, each at its own YAML position", async () => {
    const problems = await configProblems(`lanes:
  unit:
    pakages: ["@acme/api"]
  web:
    packages: ["@acme/nope"]
  -bad:
    floor: true
unmatched: all
`);
    expect(located(problems)).toEqual([
      { where: "lanes.unit.pakages", at: at(3, 5) },
      { where: "lanes.web.packages[0]", at: at(5, 16) },
      { where: "lanes.-bad", at: at(6, 3) },
    ]);
    expect(problems.every((problem) => problem.file === CONFIG)).toBe(true);
  });

  it("reports workspace and config problems together", async () => {
    const problems = await problemsOf("acme", {
      "packages/ui/package.json": JSON.stringify({ name: "@acme/ui", devDependencies: { broken: 1 } }),
      [CONFIG]: `${lanes}workspace:\n  edgs: []\nunmatched: all\n`,
    });
    expect(problems.map(({ file, where }) => ({ file, where }))).toEqual([
      { file: "packages/ui/package.json", where: "devDependencies.broken" },
      { file: CONFIG, where: "workspace.edgs" },
    ]);
  });

  it.each([
    [
      "a lane",
      `lanes:\n  api:\n    pakages: ["@acme/api"]\nunmatched: all\n`,
      "lanes.api.pakages",
      at(3, 5),
      "packages",
    ],
    ["the workspace", `${lanes}workspace:\n  edgs: []\nunmatched: all\n`, "workspace.edgs", at(5, 3), "edges"],
    ["the top level", `${lanes}path: []\nunmatched: all\n`, "path", at(4, 1), "paths"],
  ])("rejects an unknown key in %s and suggests the closest key", async (_, yaml, where, position, suggestion) => {
    const problems = await configProblems(yaml);
    expect(located(problems)).toEqual([{ where, at: position }]);
    expect(problems[0]?.message).toContain(`did you mean ${suggestion}`);
  });

  it("reports a misspelled required key in a row as unknown and as missing", async () => {
    const problems = await configProblems(
      `${lanes}paths:\n  - match: [a]\n    lanes: all\n    wy: x\nunmatched: all\n`,
    );
    expect(located(problems)).toEqual([
      { where: "paths[0].why", at: at(5, 5) },
      { where: "paths[0].wy", at: at(7, 5) },
    ]);
    expect(problems[1]?.message).toContain("did you mean why");
  });

  it.each(["-unit", "a b", "unit!"])("rejects the malformed lane name %j", async (name) => {
    const problems = await configProblems(`lanes:\n  "${name}":\n    floor: true\nunmatched: all\n`);
    expect(located(problems)).toEqual([{ where: `lanes.${name}`, at: at(2, 3) }]);
  });

  it.each(FIXED_OUTPUTS)("rejects the lane name %s because it is a fixed output", async (name) => {
    const problems = await configProblems(`lanes:\n  ${name}:\n    floor: true\nunmatched: all\n`);
    expect(located(problems)).toEqual([{ where: `lanes.${name}`, at: at(2, 3) }]);
  });

  it("checks that every package a lane names exists, and suggests a close one", async () => {
    const problems = await configProblems(`lanes:\n  web:\n    packages: ["@acme/wbe"]\nunmatched: all\n`);
    expect(located(problems)).toEqual([{ where: "lanes.web.packages[0]", at: at(3, 16) }]);
    expect(problems[0]?.message).toContain("did you mean @acme/web");
  });

  it("checks both ends of every workspace edge", async () => {
    const problems = await configProblems(
      `${lanes}workspace:\n  edges:\n    - from: "@acme/nope"\n      to: "@acme/gone"\nunmatched: all\n`,
    );
    expect(located(problems)).toEqual([
      { where: "workspace.edges[0].from", at: at(6, 13) },
      { where: "workspace.edges[0].to", at: at(7, 11) },
    ]);
  });

  it("checks the packages and lanes that rows name", async () => {
    const problems = await configProblems(
      `${lanes}paths:\n  - match: [a]\n    packages: ["@acme/nope"]\n    via: code\n    why: x\n  - match: [b]\n    lanes: [nope]\n    why: x\nunmatched: all\n`,
    );
    expect(located(problems)).toEqual([
      { where: "paths[0].packages[0]", at: at(6, 16) },
      { where: "paths[1].lanes[0]", at: at(10, 13) },
    ]);
  });

  it.each([
    ["a missing match", "    lanes: all\n    why: x\n", "paths[0].match"],
    ["an empty match", "    match: []\n    lanes: all\n    why: x\n", "paths[0].match"],
    [
      "both lanes and packages",
      '    match: [a]\n    lanes: all\n    packages: ["@acme/api"]\n    via: code\n    why: x\n',
      "paths[0]",
    ],
    ["neither lanes nor packages", "    match: [a]\n    why: x\n", "paths[0]"],
    ["via on a lanes row", "    match: [a]\n    lanes: all\n    via: code\n    why: x\n", "paths[0].via"],
    ["packages without via", '    match: [a]\n    packages: ["@acme/api"]\n    why: x\n', "paths[0]"],
    ["an unknown via", '    match: [a]\n    packages: ["@acme/api"]\n    via: build\n    why: x\n', "paths[0].via"],
    ["a missing why", "    match: [a]\n    lanes: all\n", "paths[0].why"],
    ["an empty why", '    match: [a]\n    lanes: all\n    why: ""\n', "paths[0].why"],
    ["lanes that are neither all nor a list", "    match: [a]\n    lanes: some\n    why: x\n", "paths[0].lanes"],
    ["a glob with a backslash", "    match: ['docs\\\\a.md']\n    lanes: all\n    why: x\n", "paths[0].match[0]"],
    ["a glob with a leading slash", "    match: [/docs/a.md]\n    lanes: all\n    why: x\n", "paths[0].match[0]"],
  ])("reports a row with %s", async (_, row, where) => {
    const problems = await configProblems(`${lanes}paths:\n  -${row.slice(3)}unmatched: all\n`);
    expect(problems.map((problem) => problem.where)).toEqual([where]);
  });

  it("accepts lanes: [] as a known path that selects nothing", async () => {
    const loaded = await loadFixture("acme", {
      [CONFIG]: `${lanes}paths:\n  - match: [".vscode/**"]\n    lanes: []\n    why: Editor settings.\nunmatched: all\n`,
    });
    expect(loaded.ok).toBe(true);
  });

  it.each([
    ["missing", lanes, "unmatched"],
    ["anything but all", `${lanes}unmatched: none\n`, "unmatched"],
  ])("requires unmatched: all and rejects it when %s", async (_, yaml, where) => {
    const problems = await configProblems(yaml);
    expect(problems.map((problem) => problem.where)).toEqual([where]);
  });

  it("requires packages on a lane that is not a floor lane", async () => {
    const problems = await configProblems(`lanes:\n  web: {}\n  lint:\n    floor: true\nunmatched: all\n`);
    expect(located(problems)).toEqual([{ where: "lanes.web", at: at(2, 8) }]);
  });

  it("requires at least one lane", async () => {
    const problems = await configProblems(`lanes: {}\nunmatched: all\n`);
    expect(problems.map((problem) => problem.where)).toEqual(["lanes"]);
  });

  it("reports invalid YAML at its position and nothing else", async () => {
    const problems = await configProblems(`lanes:\n  api:\n    packages: ["@acme/api"\nunmatched: all\n`);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.every((problem) => problem.at !== null && problem.where === null)).toBe(true);
  });

  it("names the config file when it is missing", async () => {
    const problems = await problemsOf("acme", { [CONFIG]: null });
    expect(problems.map(({ file, at, where }) => ({ file, at, where }))).toEqual([
      { file: CONFIG, at: null, where: null },
    ]);
  });

  it("accepts the example config", async () => {
    expect((await loadFixture("acme")).ok).toBe(true);
  });
});
