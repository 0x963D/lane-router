import { defineConfig } from "vitest/config";
import config from "../vitest.config.ts";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ["test/routing.test.ts", "test/invariants.test.ts", "test/render.test.ts", "test/workspace.test.ts"],
  },
});
