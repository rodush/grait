import { sanitizeObservation } from "./adapters/test-observation.mjs";
import { readFile, writeFile, mkdtemp, cp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { validateEvidence } from "./lib/tdd.mjs";
const execute = promisify(execFile);
const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
const inputs = event.inputs;
const config = JSON.parse(
  await readFile(new URL("../workflow.config.json", import.meta.url), "utf8"),
);
const runner = config.tdd?.runner;
if (!runner?.command?.length || !/^\S+@sha256:[a-f0-9]{64}$/.test(runner.image || ""))
  throw new Error("Configure a digest-pinned TDD container and a JSON test adapter command");
const trusted = await mkdtemp(join(tmpdir(), "tdd-verifier-"));
try {
  await writeFile(join(trusted, "config.json"), JSON.stringify(runner));
  for (const name of [
    "tdd-container.mjs",
    "adapters/node-test-reporter.mjs",
    "adapters/node-suite.mjs",
    "adapters/test-observation.mjs",
  ])
    await cp(new URL(name, import.meta.url), join(trusted, name.split("/").at(-1)));
  const run = async (source) => {
    const result = await execute(
      "docker",
      [
        "run",
        "--rm",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--memory=2g",
        "--cpus=2",
        "--tmpfs",
        "/work:rw,exec,size=1g",
        "--tmpfs",
        "/tmp:rw,exec,size=256m",
        "--mount",
        `type=bind,src=${resolve(source)},dst=/source,readonly`,
        "--mount",
        `type=bind,src=${trusted},dst=/trusted,readonly`,
        "--entrypoint",
        "node",
        runner.image,
        "/trusted/tdd-container.mjs",
      ],
      { timeout: 600000, maxBuffer: 2 * 1024 * 1024 },
    ).catch((error) => {
      throw new Error(`Isolated test execution failed (${error.code || "unknown"})`);
    });
    return JSON.parse(result.stdout);
  };
  const base = await run(process.env.TDD_BASELINE_PATH);
  const target = await run(process.env.TDD_HEAD_PATH);
  const expected = JSON.parse(inputs.expected);
  const binding = {
    issue: Number(inputs.number),
    acceptanceDigest: inputs.digest,
    head: inputs.head,
    baseline: inputs.baseline,
    phase: inputs.phase,
  };
  if (inputs.phase === "red") {
    const empty =
      Array.isArray(base.passed) &&
      base.passed.length === 0 &&
      Array.isArray(base.failed) &&
      base.failed.length === 0 &&
      Array.isArray(base.infrastructureErrors) &&
      base.infrastructureErrors.length === 0;
    if (!empty)
      validateEvidence(
        { ...base, ...binding, phase: "green", baselinePassed: true },
        { ...binding, phase: "green" },
      );
  } else
    validateEvidence(
      { ...base, ...binding, phase: "red", baselinePassed: true },
      { ...binding, phase: "red", expectedFailures: expected },
    );
  target.failed = target.failed.map((test) => ({
    id: test.id,
    kind: test.kind,
    ...(test.observation ? { observation: sanitizeObservation(test.observation) } : {}),
  }));
  const report = {
    ...target,
    ...binding,
    baselinePassed: true,
    operation: inputs.operation_id,
    runId: process.env.GITHUB_RUN_ID,
  };
  validateEvidence(report, { ...binding, expectedFailures: expected });
  const output = JSON.stringify(report);
  if (Buffer.byteLength(output) > 50000)
    throw new Error("TDD evidence exceeds the bounded report size");
  await writeFile(process.env.GITHUB_OUTPUT, `proof=${output}\n`, { flag: "a" });
} finally {
  await rm(trusted, { recursive: true, force: true });
}
