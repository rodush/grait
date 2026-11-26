import { lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { packageResource, bundledRuntime, runtimeFile } from "./runtime-resources.mjs";
import { command } from "./setup-process.mjs";
import { isTestPath, validateEvidence } from "./tdd.mjs";

export function assertApplicationRunner(runner) {
  if (
    !Array.isArray(runner?.command) ||
    runner.command.some((arg) => typeof arg !== "string") ||
    !runner.command[0]?.trim()
  )
    throw new Error(
      "Configure tdd.runner.command in workflow.config.json with the application's test adapter command before verification",
    );
  const selections = runner.command.filter((arg) => arg.includes("{testFiles}"));
  if (
    selections.length > 1 ||
    selections.some((arg) => arg !== "{testFiles}") ||
    runner.command[0] === "{testFiles}"
  )
    throw new Error("Use {testFiles} once as a separate test adapter argument");
  if (
    runner.filePatterns !== undefined &&
    (!selections.length ||
      !Array.isArray(runner.filePatterns) ||
      !runner.filePatterns.length ||
      runner.filePatterns.some(
        (pattern) => typeof pattern !== "string" || !pattern.trim() || pattern.startsWith("/"),
      ))
  )
    throw new Error("Configure tdd.runner.filePatterns as repository-relative focused test globs");
  const install = runner.install ?? [];
  if (!Array.isArray(install) || install.some((arg) => typeof arg !== "string"))
    throw new Error(
      "Configure tdd.runner.install in workflow.config.json as an optional argument array",
    );
}

export async function selectTestFiles({ root, baseline, redHead, config }) {
  const { stdout } = await command(
    "git",
    ["diff", "--no-renames", "--diff-filter=ACMT", "--name-only", "-z", baseline, redHead],
    { cwd: root },
  );
  const patterns = config.tdd.runner.filePatterns;
  const files = stdout
    .split("\0")
    .filter(
      (file) =>
        isTestPath(file, config) &&
        (!patterns || patterns.some((pattern) => matchesGlob(file, pattern))),
    );
  if (!files.length)
    throw new Error("Focused verification requires changed acceptance test files at the Red head");
  return files;
}

async function snapshotTestFiles(cwd, testFiles, allowMissing) {
  const files = [];
  for (const path of testFiles) {
    const entry = await lstat(join(cwd, path)).catch((error) => {
      if (allowMissing && error.code === "ENOENT") return null;
      throw error;
    });
    if (!entry) continue;
    if (!entry.isFile()) throw new Error("Focused test paths must resolve to regular files");
    files.push(path);
  }
  return files;
}

// Runs committed snapshots, not the mutable agent checkout. This strips process
// credentials but is not an OS sandbox: use an isolated host for untrusted tests.
export async function verifyCommits({
  root,
  head,
  baseline,
  phase,
  expectedFailures,
  issue,
  acceptanceDigest,
  runner,
  testFiles,
}) {
  if (
    ![head, baseline].every((sha) => /^[a-f0-9]{40}$/.test(sha)) ||
    !["red", "green"].includes(phase)
  )
    throw new Error("Verification needs exact committed SHAs and red/green phase");
  assertApplicationRunner(runner);
  const focused = runner.command.includes("{testFiles}");
  if (focused && !testFiles?.length)
    throw new Error("Focused verification requires a nonempty committed test selection");
  const temporary = await mkdtemp(join(tmpdir(), "grait-verification-"));
  const binding = { issue, acceptanceDigest, head, baseline, phase, ...(focused && { testFiles }) };
  try {
    const run = async (sha, name) => {
      const cwd = join(temporary, name);
      await mkdir(cwd);
      const archive = join(temporary, `${name}.tar`);
      await command("git", ["archive", "--format=tar", `--output=${archive}`, sha], { cwd: root });
      await command("tar", ["-xf", archive, "-C", cwd]);
      const selected = focused
        ? await snapshotTestFiles(cwd, testFiles, phase === "red" && name === "baseline")
        : [];
      if (focused && !selected.length) return { passed: [], failed: [], infrastructureErrors: [] };
      const home = join(temporary, `${name}-home`);
      await mkdir(home);
      const env = {
        PATH: process.env.PATH,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        NPM_CONFIG_CACHE: join(home, "npm-cache"),
        NPM_CONFIG_USERCONFIG: join(home, "npmrc"),
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_MIN_RELEASE_AGE: "3",
        CI: "true",
      };
      if (runner.install?.length)
        await command(runner.install[0], runner.install.slice(1), { cwd, env });
      const args = runner.command.flatMap((arg) => {
        if (arg === "{testFiles}") return selected;
        if (focused && arg === "{nodeAdapter}")
          return bundledRuntime
            ? [runtimeFile, "--grait-internal-node-adapter", "--literal-files"]
            : [packageResource("scripts/adapters/node-suite.mjs"), "--literal-files"];
        if (bundledRuntime && arg.includes("{nodeAdapter}")) {
          if (arg !== "{nodeAdapter}")
            throw new Error("Use {nodeAdapter} as a separate command argument");
          return [runtimeFile, "--grait-internal-node-adapter"];
        }
        return [
          arg.replaceAll("{nodeAdapter}", packageResource("scripts/adapters/node-suite.mjs")),
        ];
      });
      const result = await command(args[0], args.slice(1), { cwd, env, allowFailure: true });
      let report;
      try {
        report = JSON.parse(result.stdout);
      } catch {
        throw new Error(
          "Test adapter must emit one bounded JSON report; raw test output is not handed to implementation",
        );
      }
      if (
        !Array.isArray(report.passed) ||
        !Array.isArray(report.failed) ||
        !Array.isArray(report.infrastructureErrors) ||
        Buffer.byteLength(result.stdout) > 100000
      )
        throw new Error("Test adapter returned an invalid report");
      if (
        ![0, 1].includes(result.code) ||
        (result.code === 0) !== (!report.failed.length && !report.infrastructureErrors.length)
      )
        throw new Error("Test adapter report disagrees with its exit status");
      // Publish only explicitly public adapter observations, never arbitrary report fields.
      const { sanitizeObservation } = await import("../adapters/test-observation.mjs");
      return {
        passed: report.passed,
        failed: report.failed.map((test) => ({
          id: test.id,
          kind: test.kind,
          ...(test.observation ? { observation: sanitizeObservation(test.observation) } : {}),
        })),
        infrastructureErrors: report.infrastructureErrors,
      };
    };
    const base = await run(baseline, "baseline");
    if (phase === "green")
      validateEvidence(
        { ...base, ...binding, phase: "red", baselinePassed: true },
        { ...binding, phase: "red", expectedFailures },
      );
    else if (base.passed.length || base.failed.length || base.infrastructureErrors.length)
      validateEvidence(
        { ...base, ...binding, phase: "green", baselinePassed: true },
        { ...binding, phase: "green" },
      );
    const report = { ...(await run(head, "candidate")), ...binding, baselinePassed: true };
    validateEvidence(report, { ...binding, expectedFailures });
    return report;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
