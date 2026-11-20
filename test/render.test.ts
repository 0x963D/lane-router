import { describe, expect, it } from "vitest";
import { changedFiles, incomplete } from "../src/core/change.ts";
import { explainText, reasonLine, summaryMarkdown } from "../src/render.ts";
import { CONFIG } from "./support/model.ts";
import { planFor, planWith } from "./support/plan.ts";

const MIXED = [
  "packages/api/src/user.ts",
  "fixtures/browser/login.json",
  "README.md",
  "tools/codegen/generate.mjs",
  ".vscode/settings.json",
];

describe("rendered wording", () => {
  it("aligns every placement column, whatever order the paths come in", async () => {
    const plan = await planFor("acme", [
      ".vscode/settings.json",
      "docs/api/users.md",
      "fixtures/browser/login.json",
      "packages/ui/src/button.tsx",
    ]);
    expect(explainText(plan).split("\n").slice(8)).toMatchInlineSnapshot(`
      [
        ".vscode/settings.json",
        "  paths[6]                      no lane        Editor settings affect no lane.",
        "docs/api/users.md",
        "  paths[3] @acme/api via name   api, web, e2e  The api serves these files by name.",
        "  docs                          no lane",
        "fixtures/browser/login.json",
        "  paths[2] @acme/web via tests  web            The browser tests load these fixtures.",
        "packages/ui/src/button.tsx",
        "  package @acme/ui              web, e2e",
      ]
    `);
  });

  it("explains a mixed change lane by lane and path by path", async () => {
    expect(explainText(await planFor("acme", MIXED))).toMatchInlineSnapshot(`
      "mode pr, base base, head head, 5 files, complete, not docs-only

      lane  decision  reason
      api   run       tools/codegen/generate.mjs matches paths[1] for @acme/api via code: The api build runs the code generator. (+1 more)
      web   run       fixtures/browser/login.json matches paths[2] for @acme/web via tests: The browser tests load these fixtures. (+2 more)
      e2e   run       tools/codegen/generate.mjs matches paths[1] for @acme/api via code, read through @acme/web-e2e > @acme/web: The api build runs the code generator. (+1 more)
      lint  run       floor lane, runs for every change that is not docs-only

      .vscode/settings.json
        paths[6]                      no lane        Editor settings affect no lane.
      README.md
        docs                          no lane
      fixtures/browser/login.json
        paths[2] @acme/web via tests  web            The browser tests load these fixtures.
      packages/api/src/user.ts
        package @acme/api             api, web, e2e
      tools/codegen/generate.mjs
        paths[1] @acme/api via code   api, web, e2e  The api build runs the code generator."
    `);
  });

  it("marks the placements a docs-only change does not count", async () => {
    expect(explainText(await planFor("acme", ["packages/api/README.md", "docs/guide.md"]))).toMatchInlineSnapshot(`
      "mode pr, base base, head head, 2 files, complete, docs-only

      lane  decision  reason
      api   skip      docs-only change, and no explicit path rule selects this lane
      web   run       docs/guide.md matches paths[4]: The web build inlines the guide.
      e2e   skip      docs-only change, and no explicit path rule selects this lane
      lint  skip      docs-only change, and no explicit path rule selects this lane

      docs/guide.md
        paths[4]           web                                                The web build inlines the guide.
        docs               no lane
      packages/api/README.md
        package @acme/api  api, web, e2e (not counted in a docs-only change)
        docs               no lane"
    `);
  });

  it("says why a plan failed closed", async () => {
    const truncated = incomplete({ kind: "truncated", listed: 300, limit: 300 });
    expect(explainText(await planWith("acme", () => Promise.resolve(truncated)))).toMatchInlineSnapshot(`
      "mode pr, base base, head head, 0 files listed, incomplete, not docs-only

      lane  decision  reason
      api   run       fail closed, the compare API lists at most 300 files and listed 300. Local Git could not verify the complete list. Use fetch-depth: 0 to make the revisions available
      web   run       fail closed, the compare API lists at most 300 files and listed 300. Local Git could not verify the complete list. Use fetch-depth: 0 to make the revisions available
      e2e   run       fail closed, the compare API lists at most 300 files and listed 300. Local Git could not verify the complete list. Use fetch-depth: 0 to make the revisions available
      lint  run       fail closed, the compare API lists at most 300 files and listed 300. Local Git could not verify the complete list. Use fetch-depth: 0 to make the revisions available

      fail closed, the compare API lists at most 300 files and listed 300. Local Git could not verify the complete list. Use fetch-depth: 0 to make the revisions available."
    `);
  });

  it("shows the listed paths of an incomplete list as deciding nothing", async () => {
    const listed = changedFiles([{ path: "README.md", previousPath: null }]).paths;
    const files = incomplete({ kind: "count-mismatch", listed: 1, expected: 2 }, listed);
    expect(explainText(await planWith("acme", () => Promise.resolve(files)))).toMatchInlineSnapshot(`
      "mode pr, base base, head head, 1 file listed, incomplete, not docs-only

      lane  decision  reason
      api   run       fail closed, the compare API listed 1 file but the pull request changes 2
      web   run       fail closed, the compare API listed 1 file but the pull request changes 2
      e2e   run       fail closed, the compare API listed 1 file but the pull request changes 2
      lint  run       fail closed, the compare API listed 1 file but the pull request changes 2

      fail closed, the compare API listed 1 file but the pull request changes 2. The listed paths below decide nothing.

      README.md
        docs  no lane"
    `);
  });

  it("words every skip reason", async () => {
    const skips = await Promise.all(
      [["packages/web/e2e/login.spec.ts"], ["README.md"], []].map(async (change) =>
        reasonLine((await planFor("acme", change)).lanes[0] ?? expect.unreachable()),
      ),
    );
    expect(skips).toMatchInlineSnapshot(`
      [
        "nothing it reads changed",
        "docs-only change, and no explicit path rule selects this lane",
        "no changed files",
      ]
    `);
  });

  it("writes the job summary as a Markdown table", async () => {
    expect(summaryMarkdown(await planFor("acme", ["packages/ui/src/button.tsx"]))).toMatchInlineSnapshot(`
      "### lane-router

      mode pr&#44; base base&#44; head head&#44; 1 file&#44; complete&#44; not docs&#45;only

      | Lane | Decision | Reason |
      | --- | --- | --- |
      | api | skip | nothing it reads changed |
      | web | run | packages&#47;ui&#47;src&#47;button&#46;tsx is in &#64;acme&#47;ui&#44; read through &#64;acme&#47;web |
      | e2e | run | packages&#47;ui&#47;src&#47;button&#46;tsx is in &#64;acme&#47;ui&#44; read through &#64;acme&#47;web&#45;e2e &#62; &#64;acme&#47;web |
      | lint | run | floor lane&#44; runs for every change that is not docs&#45;only |
      "
    `);
  });

  it("escapes a pipe in a table cell so that a why cannot break the table", async () => {
    const config = `lanes:\n  web:\n    packages: ["@acme/web"]\npaths:\n  - match: ["docs/guide.md"]\n    lanes: [web]\n    why: Inlines a | b.\nunmatched: all\n`;
    const plan = await planFor("acme", ["docs/guide.md"], { [CONFIG]: config });
    expect(summaryMarkdown(plan)).toContain("Inlines a &#124; b&#46;");
  });

  it("renders paths and why strings as literal text while preserving CLI text", async () => {
    const payload = "![x](https://example.invalid/x.png) [link](https://example.invalid/) <img src=x> `code` | &amp;";
    const path = `packages/ui/src/${payload}.tsx`;
    const config = `lanes:\n  web_test:\n    packages: ["@acme/web"]\npaths:\n  - match: ["packages/ui/src/**"]\n    lanes: [web_test]\n    why: ${JSON.stringify(payload)}\nunmatched: all\n`;
    const plan = await planFor("acme", [path], { [CONFIG]: config });
    const summary = summaryMarkdown(plan);
    expect(summary).toContain("| web&#95;test | run |");
    expect(summary).toContain("&#33;&#91;x&#93;&#40;https&#58;&#47;example&#46;invalid&#47;x&#46;png&#41;");
    expect(summary).toContain("&#91;link&#93;&#40;https&#58;&#47;&#47;example&#46;invalid&#47;&#41;");
    expect(summary).toContain("&#60;img src&#61;x&#62; &#96;code&#96; &#124; &#38;amp&#59;");
    expect(summary).not.toMatch(/!\[|\[link\]|<img|`code`|&amp;/);
    expect(
      summary
        .split("\n")
        .find((line) => line.startsWith("| web"))
        ?.match(/\|/g),
    ).toHaveLength(4);
    expect(explainText(plan)).toContain(payload);
    expect(explainText(plan)).toContain("packages/ui/src/![x](https:/example.invalid/x.png)");
  });

  it("renders package names and failure reasons as literal text", async () => {
    const name = "@acme/![pkg](url)<b>`x`|";
    const plan = await planFor("acme", ["packages/ui/src/button.tsx"], {
      [CONFIG]: `lanes:\n  web:\n    packages: [${JSON.stringify(name)}]\nunmatched: all\n`,
      "packages/ui/package.json": JSON.stringify({ name, version: "0.0.0" }),
      "packages/web/package.json": JSON.stringify({ name: "@acme/web", version: "0.0.0" }),
    });
    expect(summaryMarkdown(plan)).toContain(
      "&#64;acme&#47;&#33;&#91;pkg&#93;&#40;url&#41;&#60;b&#62;&#96;x&#96;&#124;",
    );
    expect(explainText(plan)).toContain(name);
    const failed = await planWith("acme", () =>
      Promise.resolve(incomplete({ kind: "error", message: "<b>![x](url)`x`|" })),
    );
    expect(summaryMarkdown(failed)).toContain("&#60;b&#62;&#33;&#91;x&#93;&#40;url&#41;&#96;x&#96;&#124;");
    expect(explainText(failed)).toContain("<b>![x](url)`x`|");
  });
});
