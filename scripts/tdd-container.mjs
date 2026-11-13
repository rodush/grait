// This file is mounted read-only into a disposable credential-free container.
import { cp, mkdir, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
const config = JSON.parse(await readFile("/trusted/config.json", "utf8"));
await mkdir("/work/project", { recursive: true });
await cp("/source", "/work/project", {
  recursive: true,
  filter: (path) => !path.split("/").includes(".git"),
});
const environment = {
  PATH: process.env.PATH,
  HOME: "/work",
  TMPDIR: "/tmp",
  NPM_CONFIG_CACHE: "/work/npm-cache",
  NPM_CONFIG_MIN_RELEASE_AGE: "3",
  NPM_CONFIG_IGNORE_SCRIPTS: "true",
};
function run(command) {
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.some((part) => typeof part !== "string")
  )
    throw new Error("Configure explicit TDD command arrays");
  return spawnSync(
    command[0],
    command
      .slice(1)
      .map((part) =>
        part
          .replaceAll("{reporter}", "/trusted/node-test-reporter.mjs")
          .replaceAll("{nodeAdapter}", "/trusted/node-suite.mjs"),
      ),
    {
      cwd: "/work/project",
      env: environment,
      encoding: "utf8",
      timeout: 240000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}
try {
  if (config.install?.length) {
    const install = run(config.install);
    if (install.status !== 0 || install.error) throw new Error("Dependency installation failed");
  }
  const result = run(config.command);
  if (result.error || result.signal || ![0, 1].includes(result.status))
    throw new Error("Test command did not finish normally");
  const report = JSON.parse(result.stdout);
  if (
    !Array.isArray(report.passed) ||
    !Array.isArray(report.failed) ||
    !Array.isArray(report.infrastructureErrors)
  )
    throw new Error("Adapter must emit one JSON test report");
  if (
    (result.status === 0) !==
    (report.failed.length === 0 && report.infrastructureErrors.length === 0)
  )
    throw new Error("Adapter result disagrees with test exit status");
  process.stdout.write(JSON.stringify(report));
} catch (error) {
  process.stdout.write(
    JSON.stringify({ passed: [], failed: [], infrastructureErrors: [error.message] }),
  );
  process.exitCode = 1;
}
