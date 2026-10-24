#!/usr/bin/env node
// Bundle build.mts (and the page's landscape loader it imports) with the app's esbuild,
// then run it. Arguments are passed through: see build.mts --help.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const esbuild = path.join(repo, "app/node_modules/.bin/esbuild");
if (!existsSync(esbuild)) {
  console.error("app/node_modules/.bin/esbuild is missing; run `npm ci` in app/ first.");
  process.exit(1);
}
const bundle = path.join(repo, "data/landscapes/.cache/builder.mjs");
const built = spawnSync(
  esbuild,
  [
    path.join(here, "build.mts"),
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

const args = process.argv.slice(2);
if (!args.includes("--out")) args.push("--out", path.join(repo, "data/landscapes"));
const run = spawn(process.execPath, [bundle, ...args], { stdio: "inherit" });
// Ctrl-C reaches the builder directly (same process group); it aborts cleanly and exits.
process.on("SIGINT", () => {});
run.on("exit", (code, signal) => process.exit(code ?? (signal ? 130 : 1)));
