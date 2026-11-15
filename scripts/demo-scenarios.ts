export const DEMO_SCENARIOS = [
  {
    message: "Enlarge the button",
    files: {
      "packages/ui/src/button.tsx": 'export const Button = "button";\nexport const size = "large";\n',
    },
  },
  {
    message: "Refresh the fixtures and the docs",
    files: {
      "fixtures/browser/login.json": '{\n  "user": "grace"\n}\n',
      "docs/api/users.md": "# Users\n\nThe api serves this file by name. It now lists roles.\n",
      "README.md": "# acme\n\nA small monorepo that lane-router routes in its tests.\n\nRun pnpm test.\n",
      ".vscode/settings.json": '{\n  "editor.formatOnSave": true,\n  "editor.tabSize": 2\n}\n',
    },
  },
] as const;
