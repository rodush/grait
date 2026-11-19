var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) =>
  function __init() {
    if (err) throw err[0];
    try {
      return (fn && (res = (0, fn[__getOwnPropNames(fn)[0]])((fn = 0))), res);
    } catch (e) {
      throw ((err = [e]), e);
    }
  };
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};

// scripts/adapters/test-observation.mjs
var test_observation_exports = {};
__export(test_observation_exports, {
  sanitizeObservation: () => sanitizeObservation,
});
function scalar(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite value]";
  if (typeof value !== "string") return "[non-scalar value withheld]";
  if (
    /\b(?:function|class|import|require|assert|const|let|return)\b|=>|\bat\s+\S+\s*\(|[\\/][\w.-]+[\\/]|:\d+:\d+/i.test(
      value,
    )
  )
    return "[source or path-like value withheld]";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}
function sanitizeObservation(value) {
  if (!value || typeof value !== "object") return void 0;
  return {
    operator:
      typeof value.operator === "string" && /^[\w=!<>-]{1,40}$/.test(value.operator)
        ? value.operator
        : "assertion",
    expected: scalar(value.expected),
    observed: scalar(value.observed),
  };
}
var init_test_observation = __esm({
  "scripts/adapters/test-observation.mjs"() {},
});

// scripts/lib/verification.mjs
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// scripts/lib/runtime-resources.mjs
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var runtimeDirectory = true
  ? fileURLToPath(new URL("../../", import.meta.url))
  : fileURLToPath(new URL("../../", import.meta.url));
function packageResource(path) {
  return join(runtimeDirectory, path);
}

// scripts/lib/setup-process.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
async function command(program, args = [], options = {}) {
  const {
    input,
    interactive = false,
    allowFailure = false,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = interactive ? 0 : 6e5,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const collect = (chunk, channel) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 8 * 1024 * 1024) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      if (channel === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout?.on("data", (chunk) => collect(chunk, "out"));
    child.stderr?.on("data", (chunk) => collect(chunk, "err"));
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error(`Unable to run ${program}; check that it is installed and accessible`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut || exceeded)
        reject(new Error(`${program} exceeded its execution or output limit`));
      else if (code !== 0 && !allowFailure)
        reject(
          new Error(
            `${program} command failed (exit ${code ?? "signal"}); resolve the reported setup step and rerun`,
          ),
        );
      else resolve({ stdout, stderr, code });
    });
    child.stdin?.on("error", () => {});
    if (!interactive) child.stdin?.end(input);
  });
}

// scripts/lib/policy.mjs
import { createHash } from "node:crypto";
var digest = (value) => createHash("sha256").update(value).digest("hex");

// scripts/lib/tdd.mjs
function validateEvidence(
  report,
  { issue, acceptanceDigest, head, baseline, expectedFailures, phase },
) {
  if (
    report.issue !== issue ||
    report.acceptanceDigest !== acceptanceDigest ||
    report.head !== head ||
    report.baseline !== baseline ||
    report.phase !== phase ||
    report.baselinePassed !== true ||
    report.infrastructureErrors?.length
  )
    throw new Error("TDD evidence is stale or the baseline/infrastructure failed");
  if (
    !Array.isArray(report.failed) ||
    !Array.isArray(report.passed) ||
    (!report.passed.length && !report.failed.length)
  )
    throw new Error("TDD runner must report executed test identities");
  const identities = [...report.passed, ...report.failed.map((test) => test?.id)];
  if (
    identities.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(identities).size !== identities.length
  )
    throw new Error(
      `${phase === "green" ? "Green" : "Red"} evidence contains invalid or duplicate test identities`,
    );
  if (phase === "red") {
    if (
      !Array.isArray(expectedFailures) ||
      !expectedFailures.length ||
      new Set(expectedFailures).size !== expectedFailures.length
    )
      throw new Error("Tester must name the expected failing acceptance tests");
    const failures = report.failed.map((test) => test.id).sort();
    if (
      report.failed.some((test) => test.kind !== "assertion") ||
      JSON.stringify(failures) !== JSON.stringify([...expectedFailures].sort())
    )
      throw new Error("Red requires exactly the expected assertion failures");
  } else if (phase !== "green" || report.failed.length)
    throw new Error("Green requires the complete suite to pass");
  if (phase === "green" && expectedFailures?.some((id) => !report.passed.includes(id)))
    throw new Error("Green must execute and pass every accepted test");
  return digest(JSON.stringify(report));
}

// scripts/lib/verification.mjs
async function verifyCommits({
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
  const temporary = await mkdtemp(join2(tmpdir(), "grait-verification-"));
  const binding = { issue, acceptanceDigest, head, baseline, phase };
  try {
    const run = async (sha, name) => {
      const cwd = join2(temporary, name);
      await mkdir(cwd);
      const archive = join2(temporary, `${name}.tar`);
      await command("git", ["archive", "--format=tar", `--output=${archive}`, sha], { cwd: root });
      await command("tar", ["-xf", archive, "-C", cwd]);
      const home = join2(temporary, `${name}-home`);
      await mkdir(home);
      const env = {
        PATH: process.env.PATH,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        NPM_CONFIG_CACHE: join2(home, "npm-cache"),
        NPM_CONFIG_USERCONFIG: join2(home, "npmrc"),
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_MIN_RELEASE_AGE: "3",
        CI: "true",
      };
      if (runner.install?.length)
        await command(runner.install[0], runner.install.slice(1), { cwd, env });
      const args = runner.command.map((arg) =>
        arg.replaceAll("{nodeAdapter}", packageResource("scripts/adapters/node-suite.mjs")),
      );
      const result = await command(args[0], args.slice(1), { cwd, env, allowFailure: true });
      let report2;
      try {
        report2 = JSON.parse(result.stdout);
      } catch {
        throw new Error(
          "Test adapter must emit one bounded JSON report; raw test output is not handed to implementation",
        );
      }
      if (
        !Array.isArray(report2.passed) ||
        !Array.isArray(report2.failed) ||
        !Array.isArray(report2.infrastructureErrors) ||
        Buffer.byteLength(result.stdout) > 1e5
      )
        throw new Error("Test adapter returned an invalid report");
      if (
        ![0, 1].includes(result.code) ||
        (result.code === 0) !== (!report2.failed.length && !report2.infrastructureErrors.length)
      )
        throw new Error("Test adapter report disagrees with its exit status");
      const { sanitizeObservation: sanitizeObservation2 } = await Promise.resolve().then(
        () => (init_test_observation(), test_observation_exports),
      );
      return {
        passed: report2.passed,
        failed: report2.failed.map((test) => ({
          id: test.id,
          kind: test.kind,
          ...(test.observation ? { observation: sanitizeObservation2(test.observation) } : {}),
        })),
        infrastructureErrors: report2.infrastructureErrors,
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
export { verifyCommits };
