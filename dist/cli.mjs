#!/usr/bin/env node
import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);

if (!args.length || (args.length === 1 && ["--help", "-h"].includes(args[0]))) {
  console.log(
    `GRAIT ${version}\n\nUsage: grait [--help] [--version]\n\nOptions:\n  --help, -h       Show this help\n  --version, -v    Show the installed package version`,
  );
} else if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
  console.log(version);
} else {
  console.error("Unknown command or option. Run grait --help for available commands.");
  process.exitCode = 1;
}
