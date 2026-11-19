// Reference adapter: explicit file patterns, including a valid empty baseline.
import { glob } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isEntrypoint } from "../lib/entrypoint.mjs";
import { bundledRuntime, runtimeFile } from "../lib/runtime-resources.mjs";

export async function runNodeSuite(patterns = process.argv.slice(2)) {
  const files = [];
  for (const pattern of patterns) for await (const file of glob(pattern)) files.push(file);
  if (!files.length) {
    process.stdout.write(JSON.stringify({ passed: [], failed: [], infrastructureErrors: [] }));
  } else {
    const result = spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter",
        bundledRuntime
          ? runtimeFile
          : fileURLToPath(new URL("node-test-reporter.mjs", import.meta.url)),
        ...new Set(files),
      ],
      { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 240000, env: process.env },
    );
    if (result.error || result.signal) throw new Error("Node test runner did not finish normally");
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
  }
}

if (!bundledRuntime && isEntrypoint(import.meta.url)) await runNodeSuite();
