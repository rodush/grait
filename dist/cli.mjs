#!/usr/bin/env node

// src/cli.mjs
import { readFileSync } from "node:fs";

// src/runtime.mjs
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

// scripts/lib/runtime-resources.mjs
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var runtimeDirectory = true
  ? fileURLToPath(new URL("./", import.meta.url))
  : fileURLToPath(new URL("../../", import.meta.url));
function packageResource(path) {
  return join(runtimeDirectory, path);
}

// src/runtime.mjs
var execute = promisify(execFile);
async function targetRoot(cwd = process.cwd()) {
  try {
    const { stdout } = await execute("git", ["rev-parse", "--show-toplevel"], {
      cwd: resolve(cwd),
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    throw new Error("Choose a Git repository with --cwd PATH");
  }
}
async function runRuntime({ command, args: args2 = [], cwd = process.cwd() }) {
  if (!["orchestrator", "github"].includes(command)) throw new Error("Unknown runtime command");
  const root = args2.includes("--help") ? resolve(cwd) : await targetRoot(cwd);
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [packageResource(`scripts/${command}.mjs`), ...args2], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", () => reject(new Error(`Unable to start grait ${command}`)));
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`grait ${command} was interrupted`));
      else resolveResult(code ?? 1);
    });
  });
}

// src/cli.mjs
var { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
var args = process.argv.slice(2);
try {
  let cwd = process.cwd();
  if (args[0] === "--cwd") {
    if (!args[1] || args[1].startsWith("-")) throw new Error("Provide --cwd PATH");
    cwd = args.splice(0, 2)[1];
  } else if (args[0]?.startsWith("--cwd=")) {
    cwd = args.shift().slice("--cwd=".length);
    if (!cwd) throw new Error("Provide --cwd PATH");
  }
  if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
    console.log(
      `GRAIT ${version}

Usage: grait [--cwd PATH] COMMAND [OPTIONS]

Commands:
  orchestrator     Coordinate the local Project workflow
  github           Publish through the configured writer identity

Options:
  --cwd PATH       Select a target Git repository or subdirectory
  --help, -h       Show this help
  --version, -v    Show the installed package version`,
    );
  } else if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    console.log(version);
  } else if (["orchestrator", "github"].includes(args[0])) {
    process.exitCode = await runRuntime({ command: args.shift(), args, cwd });
  } else throw new Error("Unknown command or option. Run grait --help for available commands.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
