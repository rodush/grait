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
async function runRuntime({ command, args = [], cwd = process.cwd() }) {
  if (!["orchestrator", "github"].includes(command)) throw new Error("Unknown runtime command");
  const root = args.includes("--help") ? resolve(cwd) : await targetRoot(cwd);
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [packageResource(`scripts/${command}.mjs`), ...args], {
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
export { runRuntime, targetRoot };
