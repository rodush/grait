import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import reporter from "../scripts/adapters/node-test-reporter.mjs";
import { validateEvidence } from "../scripts/lib/tdd.mjs";
import { parse } from "yaml";

const execute = promisify(execFile);
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT"),
);
const adapter = fileURLToPath(new URL("../scripts/adapters/node-suite.mjs", import.meta.url));
const reporterPath = fileURLToPath(
  new URL("../scripts/adapters/node-test-reporter.mjs", import.meta.url),
);

async function collect(events) {
  async function* source() {
    yield* events;
  }
  let output = "";
  for await (const chunk of reporter(source())) output += chunk;
  return JSON.parse(output);
}

test("runner reporter separates assertion Red from infrastructure and excludes skip/todo from Green", async () => {
  const report = await collect([
    {
      type: "test:start",
      data: { file: "/work/project/tests/acceptance.mjs", name: "behavior", nesting: 0 },
    },
    {
      type: "test:pass",
      data: {
        file: "/work/project/tests/acceptance.mjs",
        name: "behavior",
        nesting: 0,
        details: {},
      },
    },
    {
      type: "test:pass",
      data: {
        file: "/work/project/tests/acceptance.mjs",
        name: "skipped",
        skip: true,
        details: {},
      },
    },
    {
      type: "test:pass",
      data: {
        file: "/work/project/tests/acceptance.mjs",
        name: "planned",
        todo: true,
        details: {},
      },
    },
    {
      type: "test:fail",
      data: {
        file: "/work/project/tests/acceptance.mjs",
        name: "new behavior",
        details: { error: { cause: { code: "ERR_ASSERTION" } } },
      },
    },
    {
      type: "test:fail",
      data: {
        file: "/work/project/tests/acceptance.mjs",
        name: "broken import",
        details: { error: { cause: { code: "ERR_MODULE_NOT_FOUND" } } },
      },
    },
  ]);
  assert.deepEqual(report.passed, ["tests/acceptance.mjs::behavior"]);
  assert.equal(report.failed[0].id, "tests/acceptance.mjs::new behavior");
  assert.equal(report.failed[0].kind, "assertion");
  assert.equal(report.failed.length, 1);
  assert.match(report.infrastructureErrors[0], /ERR_MODULE_NOT_FOUND/);
});

test("reference adapter permits an empty baseline but candidate evidence cannot be empty", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "grait-empty-suite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputPath = join(directory, "result.json"),
    output = await open(outputPath, "w");
  const child = spawn(process.execPath, [adapter, "*.missing.mjs"], {
    cwd: directory,
    env: childEnv,
    stdio: ["ignore", output.fd, "ignore"],
  });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`Adapter failed: ${code}`)),
    );
  });
  await output.close();
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  assert.deepEqual(report, { passed: [], failed: [], infrastructureErrors: [] });
  assert.throws(
    () => validateEvidence({ ...report, phase: "green", baselinePassed: true }, { phase: "green" }),
    /executed/i,
  );
});

test("Node reporter classifies actual test runner pass, assertion failure and skip events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "grait-runner-suite-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "behavior.mjs"),
    'import test from "node:test";import assert from "node:assert/strict";test("existing",()=>{});test("acceptance",()=>assert.equal(1,2));test.skip("future",()=>{});',
  );
  const outputPath = join(directory, "result.json"),
    output = await open(outputPath, "w");
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-isolation=none",
      "--test-reporter",
      reporterPath,
      join(directory, "behavior.mjs"),
    ],
    { cwd: directory, env: childEnv, stdio: ["ignore", output.fd, "ignore"] },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await output.close();
  assert.equal(code, 1);
  const report = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(report.passed.length, 1);
  assert.equal(report.failed.length, 1);
  assert.match(report.failed[0].id, /acceptance$/);
  assert.equal(report.failed[0].kind, "assertion");
  assert.deepEqual(report.infrastructureErrors, []);
});

test("real Node assertion errors share explicit public observations and withhold ordinary assertion values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "grait-public-observation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "behavior.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
test("public contract", () => {
  try { assert.equal("private-actual", "private-expected"); }
  catch (error) {
    error.publicObservation = { operator: "strictEqual", expected: 200, observed: 404 };
    throw error;
  }
});
test("private contract", () => assert.equal("hidden-actual", "hidden-expected"));
`,
  );
  const outputPath = join(directory, "result.json");
  const output = await open(outputPath, "w");
  const child = spawn(
    process.execPath,
    [
      "--test",
      "--test-isolation=none",
      "--test-reporter",
      reporterPath,
      join(directory, "behavior.mjs"),
    ],
    { cwd: directory, env: childEnv, stdio: ["ignore", output.fd, "ignore"] },
  );
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  await output.close();
  assert.equal(code, 1);
  const result = await readFile(outputPath, "utf8");
  const report = JSON.parse(result);
  assert.equal(report.failed.length, 2);
  const exposed = report.failed.find((failure) => failure.id.endsWith("::public contract"));
  const withheld = report.failed.find((failure) => failure.id.endsWith("::private contract"));
  assert.deepEqual(exposed.observation, { operator: "strictEqual", expected: 200, observed: 404 });
  assert.equal(withheld.observation, undefined);
  assert.deepEqual(report.infrastructureErrors, []);
  for (const value of ["private-actual", "private-expected", "hidden-actual", "hidden-expected"])
    assert.ok(!result.includes(value));
});

test(
  "reference adapter preserves publicObservation through Node worker serialization",
  {
    skip:
      process.env.GITHUB_ACTIONS !== "true" &&
      "Default Node worker subprocesses are denied by the local sandbox; GitHub Actions verifies this path",
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "grait-worker-observation-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      join(directory, "behavior.mjs"),
      `import test from "node:test";
import assert from "node:assert/strict";
test("public contract", () => {
  try { assert.equal("private-actual", "private-expected"); }
  catch (error) { error.publicObservation = { operator: "strictEqual", expected: 200, observed: 404 }; throw error; }
});
test("private contract", () => assert.equal("hidden-actual", "hidden-expected"));
`,
    );
    const outputPath = join(directory, "result.json");
    const output = await open(outputPath, "w");
    const child = spawn(process.execPath, [adapter, "behavior.mjs"], {
      cwd: directory,
      env: childEnv,
      stdio: ["ignore", output.fd, "ignore"],
    });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    await output.close();
    assert.equal(code, 1);
    const result = await readFile(outputPath, "utf8");
    const report = JSON.parse(result);
    assert.equal(report.failed.length, 2);
    assert.deepEqual(
      report.failed.find((failure) => failure.id.endsWith("::public contract")).observation,
      {
        operator: "strictEqual",
        expected: 200,
        observed: 404,
      },
    );
    assert.equal(
      report.failed.find((failure) => failure.id.endsWith("::private contract")).observation,
      undefined,
    );
    assert.deepEqual(report.infrastructureErrors, []);
    for (const value of ["private-actual", "private-expected", "hidden-actual", "hidden-expected"])
      assert.ok(!result.includes(value));
  },
);

test("verifier jobs use immutable heads and publish proof only after isolated verification succeeds", async () => {
  const workflow = parse(
    await readFile(new URL("../.github/workflows/tdd-verify.yml", import.meta.url), "utf8"),
  );
  assert.equal(workflow.on.workflow_dispatch.inputs.head.required, true);
  assert.equal(workflow.on.workflow_dispatch.inputs.baseline.required, true);
  assert.ok(workflow.jobs.verify.if.includes("github.run_attempt == 1"));
  assert.ok([workflow.jobs.publish.needs].flat().includes("verify"));
  assert.ok(workflow.jobs.publish.if.includes("needs.verify.result == 'success'"));
  for (const step of workflow.jobs.verify.steps.filter((step) =>
    step.uses?.startsWith("actions/checkout@"),
  ))
    assert.equal(step.with["persist-credentials"], false);
  assert.deepEqual(workflow.jobs.publish.permissions, {});
});
