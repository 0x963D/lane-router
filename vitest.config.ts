import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The CLI and Action tests spawn git and Node processes, which is slow on Windows under parallel load.
    testTimeout: 30_000,
  },
});
