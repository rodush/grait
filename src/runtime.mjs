import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { packageResource, bundledRuntime, runtimeFile } from "../scripts/lib/runtime-resources.mjs";

const execute = promisify(execFile);

export async function targetRoot(cwd = process.cwd()) {
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

export async function runRuntime({ command, args = [], cwd = process.cwd() }) {
  if (!["orchestrator", "github", "activate"].includes(command))
    throw new Error("Unknown runtime command");
  const root = args.includes("--help") ? resolve(cwd) : await targetRoot(cwd);
  return new Promise((resolveResult, reject) => {
    const invocation = bundledRuntime
      ? [runtimeFile, "--grait-internal-runtime", command, ...args]
      : command === "activate"
        ? [packageResource("src/cli.mjs"), "--grait-internal-runtime", command, ...args]
        : [packageResource(`scripts/${command}.mjs`), ...args];
    const child = spawn(process.execPath, invocation, {
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
