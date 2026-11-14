import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const imports = {
  picomatch: { regex: "^picomatch(/|$)", message: "Glob semantics live in src/core/glob.ts." },
  yaml: { regex: "^yaml$", message: "YAML is parsed in src/load/yaml.ts." },
  actionsCore: { regex: "^@actions/", message: "Only src/action.ts talks to the Actions runner." },
  childProcess: { regex: "^(node:)?child_process$", message: "Only src/adapters/git.ts spawns processes." },
  loadInternals: {
    regex: "(^|/)load/(?!index\\.ts$)",
    message: "Import the loader through src/load/index.ts.",
  },
  planEntry: {
    regex: "(^|/)route\\.ts$",
    importNames: ["route", "decide"],
    message: "Every plan goes through planLanes in src/core/plan.ts.",
  },
  compileEntry: {
    regex: "(^|/)core/model\\.ts$",
    importNames: ["compile"],
    message: "Models come from loadModel.",
  },
  decoders: { regex: "(^|/)decode\\.ts$", message: "Tests drive loadModel, not the decoders." },
  adapters: { regex: "(^|/)adapters/", message: "Sources are chosen in src/action.ts and src/cli.ts." },
  siblingAdapters: { regex: "^\\./", message: "Adapters do not import each other." },
  corePurity: {
    regex: "^(?!\\./|\\.\\./result\\.ts$)",
    message: "The core imports only src/core and src/result.ts.",
  },
  corePurityGlob: {
    regex: "^(?!\\./|\\.\\./result\\.ts$|picomatch/posix$)",
    message: "The core imports only src/core and src/result.ts.",
  },
};

const restrict = (...names) => ({
  "no-restricted-imports": ["error", { patterns: names.map((name) => imports[name]) }],
});

const outsideCore = ["picomatch", "yaml", "actionsCore", "childProcess", "loadInternals", "planEntry"];

export default defineConfig(
  { ignores: ["dist/", "node_modules/", "coverage/", "test/fixtures/"] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "never" }],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-console": "error",
    },
  },
  { files: ["**/*.js"], extends: [tseslint.configs.disableTypeChecked] },

  { files: ["src/**/*.ts"], rules: restrict(...outsideCore, "adapters") },
  { files: ["src/core/**/*.ts"], rules: restrict("corePurity", "picomatch", "planEntry") },
  { files: ["src/core/plan.ts"], rules: restrict("corePurity", "picomatch") },
  { files: ["src/core/glob.ts"], rules: restrict("corePurityGlob", "planEntry") },
  {
    files: ["src/load/**/*.ts"],
    rules: restrict("picomatch", "yaml", "actionsCore", "childProcess", "planEntry", "adapters"),
  },
  { files: ["src/load/yaml.ts"], rules: restrict("picomatch", "actionsCore", "childProcess", "planEntry", "adapters") },
  { files: ["src/adapters/**/*.ts"], rules: restrict(...outsideCore, "siblingAdapters") },
  {
    files: ["src/adapters/git.ts"],
    rules: restrict("picomatch", "yaml", "actionsCore", "loadInternals", "planEntry", "siblingAdapters"),
  },
  { files: ["src/action.ts"], rules: restrict("picomatch", "yaml", "childProcess", "loadInternals", "planEntry") },
  { files: ["src/cli.ts"], rules: restrict(...outsideCore) },
  {
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    rules: restrict("loadInternals", "planEntry", "compileEntry", "decoders"),
  },
);
