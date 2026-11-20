import { defineConfig } from "vitest/config";
import config from "../vitest.config.ts";

export default defineConfig({
  ...config,
  test: {
    ...config.test,
    include: ["test/action-seam-mutation.test.js", "test/action-contract.test.ts"],
  },
});
