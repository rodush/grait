// Reference adapter: explicit file patterns, including a valid empty baseline.
import { glob } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const files = [];
for (const pattern of process.argv.slice(2))
  for await (const file of glob(pattern)) files.push(file);
if (!files.length) {
  process.stdout.write(JSON.stringify({ passed: [], failed: [], infrastructureErrors: [] }));
} else {
  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--test-reporter",
      new URL("node-test-reporter.mjs", import.meta.url).pathname,
      ...new Set(files),
    ],
    { encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 240000, env: process.env },
  );
  if (result.error || result.signal) throw new Error("Node test runner did not finish normally");
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.status;
}
