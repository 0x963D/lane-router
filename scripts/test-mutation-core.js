import { Stryker } from "@stryker-mutator/core";

await new Stryker({
  mutate: ["src/core/**/*.ts"],
  testFiles: ["test/routing.test.ts", "test/invariants.test.ts", "test/render.test.ts", "test/workspace.test.ts"],
  vitest: { related: false, configFile: "vitest.config.ts" },
}).runMutationTest();
