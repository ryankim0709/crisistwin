#!/usr/bin/env node
// Bundle prewarm.mts (and the app's landscape loader it imports) with the app's esbuild, then
// run it under Node 22. Arguments pass through: see prewarm.mts --help. Run from the repo root.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const esbuild = path.join(repo, "app/node_modules/.bin/esbuild");
if (!existsSync(esbuild)) {
  console.error("app/node_modules/.bin/esbuild is missing; run `npm ci` in app/ first.");
  process.exit(1);
}
const bundle = path.join(repo, "data/landscapes/.cache/prewarm.mjs");
mkdirSync(path.dirname(bundle), { recursive: true });
const built = spawnSync(
  esbuild,
  [
    path.join(here, "prewarm.mts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--log-level=warning",
    `--outfile=${bundle}`,
  ],
  { stdio: "inherit" },
);
if (built.status !== 0) process.exit(built.status ?? 1);
const run = spawn(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit", cwd: repo });
process.on("SIGINT", () => {});
run.on("exit", (code, signal) => process.exit(code ?? (signal ? 130 : 1)));
