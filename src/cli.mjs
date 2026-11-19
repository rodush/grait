#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { isEntrypoint } from "../scripts/lib/entrypoint.mjs";
import { orchestratorMain } from "../scripts/orchestrator.mjs";
import { githubMain } from "../scripts/github.mjs";
import { runNodeSuite } from "../scripts/adapters/node-suite.mjs";
import reporter from "../scripts/adapters/node-test-reporter.mjs";
import { runRuntime } from "./runtime.mjs";

export { verifyCommits } from "../scripts/lib/verification.mjs";
export { generateProjectArtifacts } from "./project-policy.mjs";
export default reporter;

const version =
  typeof GRAIT_VERSION === "string"
    ? GRAIT_VERSION
    : JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

async function main(args = process.argv.slice(2)) {
  if (args[0] === "--grait-internal-node-adapter") return runNodeSuite(args.slice(1));
  if (args[0] === "--grait-internal-runtime") {
    const [, command, ...options] = args;
    process.argv = [process.execPath, process.argv[1], ...options];
    if (command === "orchestrator") return orchestratorMain();
    if (command === "github") return githubMain();
    throw new Error("Unknown internal runtime command");
  }
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
}

if (isEntrypoint(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
