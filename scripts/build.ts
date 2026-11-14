import { build, type BuildOptions } from "esbuild";

const shared: BuildOptions = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  // `yaml` and a dependency of `@actions/core` are CommonJS and call `require` for Node built-ins.
  // An ESM bundle has no `require`, so without this banner both bundles throw on start.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/bin/action.ts"], outfile: "dist/index.js" }),
  build({ ...shared, entryPoints: ["src/bin/cli.ts"], outfile: "dist/cli.js" }),
]);
