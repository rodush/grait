#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runRuntime } from "./runtime.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);

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
      `GRAIT ${version}\n\nUsage: grait [--cwd PATH] COMMAND [OPTIONS]\n\nCommands:\n  orchestrator     Coordinate the local Project workflow\n  github           Publish through the configured writer identity\n\nOptions:\n  --cwd PATH       Select a target Git repository or subdirectory\n  --help, -h       Show this help\n  --version, -v    Show the installed package version`,
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
