import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { command } from "./setup-process.mjs";
import { validateEvidence } from "./tdd.mjs";

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
}) {
  if (
    ![head, baseline].every((sha) => /^[a-f0-9]{40}$/.test(sha)) ||
    !["red", "green"].includes(phase)
  )
    throw new Error("Verification needs exact committed SHAs and red/green phase");
  for (const args of [runner?.install || [], runner?.command]) {
    if (
      !Array.isArray(args) ||
      args.some((arg) => typeof arg !== "string") ||
      (args === runner?.command && !args.length)
    )
      throw new Error("Configure explicit local test install/command arrays");
  }
  const temporary = await mkdtemp(join(tmpdir(), "grait-verification-"));
  const binding = { issue, acceptanceDigest, head, baseline, phase };
  try {
    const run = async (sha, name) => {
      const cwd = join(temporary, name);
      await mkdir(cwd);
      const archive = join(temporary, `${name}.tar`);
      await command("git", ["archive", "--format=tar", `--output=${archive}`, sha], { cwd: root });
      await command("tar", ["-xf", archive, "-C", cwd]);
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
      const args = runner.command.map((arg) =>
        arg.replaceAll("{nodeAdapter}", resolve(root, "scripts/adapters/node-suite.mjs")),
      );
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
