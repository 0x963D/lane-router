#!/usr/bin/env node
import { once } from "node:events";
import { runCli } from "../cli.ts";

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: async (text) => {
    if (!process.stdout.write(`${text}\n`)) await once(process.stdout, "drain");
  },
  stderr: (text) => process.stderr.write(`${text}\n`),
});
