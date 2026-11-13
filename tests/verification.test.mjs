import test from "node:test";
import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const { verifyCommits } = await import(
  pathToFileURL(resolve(sourceRoot, "scripts/lib/verification.mjs"))
);
const digest = "a".repeat(64);
const expected = ["accepted behavior"];

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, "Synthetic committed repository command must succeed");
  return result.stdout.trim();
}

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), "grait-verification-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, ["init", "--quiet"]);
  await writeFile(join(root, "adapter.mjs"), adapter);
  const logPath = join(root, "execution-log.jsonl");
  await writeFile(join(root, ".gitignore"), "execution-log.jsonl\n");
  async function commit(report, { exit, output } = {}) {
    await writeFile(join(root, "report.json"), JSON.stringify({ report, exit, output }));
    git(root, ["add", "--all"]);
    git(root, [
      "-c",
      "user.name=GRAIT Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: commit verification state",
    ]);
    return git(root, ["rev-parse", "HEAD"]);
  }
  return {
    root,
    logPath,
    commit,
    args(head, baseline, phase = "red", expectedFailures = expected) {
      return {
        root,
        head,
        baseline,
        phase,
        expectedFailures,
        issue: 12,
        acceptanceDigest: digest,
        runner: { install: [], command: [process.execPath, "adapter.mjs", logPath] },
      };
    },
    async logs() {
      return (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    },
  };
}

const passing = { passed: ["existing behavior"], failed: [], infrastructureErrors: [] };
const failing = {
  passed: ["existing behavior"],
  failed: [
    {
      id: "accepted behavior",
      kind: "assertion",
      message: "private-test-value",
      observation: { expected: "const secret=private", observed: { private: "hidden" } },
    },
  ],
  infrastructureErrors: [],
  arbitraryPrivateField: "private-report-field",
  issue: 999,
  head: "stale-untrusted-head",
};
const green = {
  passed: ["existing behavior", "accepted behavior"],
  failed: [],
  infrastructureErrors: [],
};

const adapter = `
import { appendFileSync, readFileSync } from "node:fs";
const value = JSON.parse(readFileSync("report.json", "utf8"));
appendFileSync(process.argv[2], JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, userprofile: process.env.USERPROFILE, gitCredential: !!process.env.GH_TOKEN, modelCredential: !!process.env.OPENAI_API_KEY, projectCredential: !!process.env.PROJECT_TOKEN, codexHome: !!process.env.CODEX_HOME }) + "\\n");
process.stdout.write(value.output === undefined ? JSON.stringify(value.report) : value.output);
process.exitCode = value.exit === undefined ? (value.report.failed.length || value.report.infrastructureErrors.length ? 1 : 0) : value.exit;
`;

test("local verification runs exact committed Red and Green snapshots with bound sanitized evidence", async (t) => {
  const f = await repository(t);
  const baseline = await f.commit(passing);
  const red = await f.commit(failing);
  const implementation = await f.commit(green);
  await writeFile(join(f.root, "report.json"), "uncommitted checkout must not run");
  const report = await verifyCommits(f.args(red, baseline));
  assert.equal(report.head, red);
  assert.equal(report.baseline, baseline);
  assert.equal(report.issue, 12);
  assert.equal(report.acceptanceDigest, digest);
  assert.equal(report.phase, "red");
  assert.equal(report.baselinePassed, true);
  assert.deepEqual(
    report.failed.map(({ id, kind }) => ({ id, kind })),
    [{ id: "accepted behavior", kind: "assertion" }],
  );
  assert.match(report.failed[0].observation.expected, /withheld/);
  assert.match(report.failed[0].observation.observed, /withheld/);
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-test-value|private-report-field|stale-untrusted-head/,
  );
  const verified = await verifyCommits(f.args(implementation, red, "green"));
  assert.equal(verified.head, implementation);
  assert.equal(verified.baseline, red);
  assert.equal(verified.phase, "green");
  assert.deepEqual(verified.failed, []);
  assert.ok(verified.passed.includes(expected[0]));
  assert.equal(
    await readFile(join(f.root, "report.json"), "utf8"),
    "uncommitted checkout must not run",
  );
  for (const { cwd, home } of await f.logs()) {
    await assert.rejects(() => lstat(cwd), { code: "ENOENT" });
    await assert.rejects(() => lstat(home), { code: "ENOENT" });
  }
});

test("local verification strips credentials and native session homes from both snapshots", async (t) => {
  const f = await repository(t);
  const baseline = await f.commit(passing);
  const red = await f.commit(failing);
  const names = ["GH_TOKEN", "PROJECT_TOKEN", "OPENAI_API_KEY", "CODEX_HOME", "HOME"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = `synthetic-private-${name}`;
  try {
    await verifyCommits(f.args(red, baseline));
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
  const logs = await f.logs();
  assert.equal(logs.length, 2);
  for (const row of logs) {
    assert.equal(row.gitCredential, false);
    assert.equal(row.modelCredential, false);
    assert.equal(row.projectCredential, false);
    assert.equal(row.codexHome, false);
    assert.notEqual(row.home, previous.HOME);
    assert.equal(row.home, row.userprofile);
    assert.ok(row.home.includes("grait-verification-"));
  }
});

test("local verification rejects infrastructure errors, wrong Red failures and inconsistent exit status", async (t) => {
  for (const scenario of [
    { report: { passed: [], failed: [], infrastructureErrors: ["adapter setup failed"] } },
    {
      report: {
        passed: [],
        failed: [{ id: "accepted behavior", kind: "import-error" }],
        infrastructureErrors: [],
      },
    },
    {
      report: {
        passed: ["existing behavior"],
        failed: [{ id: "unexpected regression", kind: "assertion" }],
        infrastructureErrors: [],
      },
    },
    { report: failing, exit: 0 },
    { report: failing, exit: 2 },
    { report: failing, output: "private-multiline-test-output\nnot-json" },
  ]) {
    const f = await repository(t);
    const baseline = await f.commit(passing);
    const red = await f.commit(scenario.report, scenario);
    await assert.rejects(
      () => verifyCommits(f.args(red, baseline)),
      (error) => !error.message.includes("private-multiline-test-output"),
    );
    for (const { cwd } of await f.logs())
      await assert.rejects(() => lstat(cwd), { code: "ENOENT" });
  }
});

test("Green verification reproduces accepted Red and cannot omit accepted test identities", async (t) => {
  const f = await repository(t);
  const baseline = await f.commit(passing);
  const red = await f.commit(failing);
  const missingAccepted = await f.commit(passing);
  const implementation = await f.commit(green);
  await assert.rejects(
    () => verifyCommits(f.args(implementation, baseline, "green")),
    /Red|assertion|expected/i,
  );
  await assert.rejects(
    () => verifyCommits(f.args(missingAccepted, red, "green")),
    /Green|accepted|execute/i,
  );
  await assert.rejects(() => verifyCommits(f.args(red, red, "green")), /Green|pass/i);
  await assert.rejects(() => verifyCommits(f.args(red, "main")), /SHA|commit/i);
});

test("a valid empty baseline can precede the first acceptance test", async (t) => {
  const f = await repository(t);
  const empty = await f.commit({ passed: [], failed: [], infrastructureErrors: [] });
  const red = await f.commit({
    passed: [],
    failed: [{ id: "accepted behavior", kind: "assertion" }],
    infrastructureErrors: [],
  });
  const report = await verifyCommits(f.args(red, empty));
  assert.equal(report.baselinePassed, true);
  assert.equal(report.failed[0].id, "accepted behavior");
});

test("the Node adapter keeps acceptance identities stable across temporary committed paths", async (t) => {
  const f = await repository(t);
  await mkdir(join(f.root, "scripts/adapters"), { recursive: true });
  for (const filename of ["node-suite.mjs", "node-test-reporter.mjs", "test-observation.mjs"])
    await cp(
      resolve(sourceRoot, "scripts/adapters", filename),
      join(f.root, "scripts/adapters", filename),
    );
  await writeFile(join(f.root, "package.json"), JSON.stringify({ type: "module" }));
  await mkdir(join(f.root, "tests"));
  const original =
    'import test from "node:test";import assert from "node:assert/strict";import {readFileSync} from "node:fs";test("existing behavior",()=>assert.ok(true));';
  await writeFile(join(f.root, "tests/behavior.test.mjs"), original);
  await writeFile(join(f.root, "behavior.txt"), "red");
  const baseline = await f.commit(passing);
  await writeFile(
    join(f.root, "tests/behavior.test.mjs"),
    original +
      'test("accepted behavior",()=>assert.equal(readFileSync("behavior.txt","utf8"),"green"));',
  );
  const red = await f.commit(failing);
  await writeFile(join(f.root, "behavior.txt"), "green");
  const implementation = await f.commit(green);
  const expectedFailures = ["tests/behavior.test.mjs::accepted behavior"];
  const runner = { install: [], command: [process.execPath, "{nodeAdapter}", "tests/*.test.mjs"] };
  const redReport = await verifyCommits({
    ...f.args(red, baseline, "red", expectedFailures),
    runner,
  });
  assert.equal(redReport.failed[0].id, expectedFailures[0]);
  const greenReport = await verifyCommits({
    ...f.args(implementation, red, "green", expectedFailures),
    runner,
  });
  assert.ok(greenReport.passed.includes(expectedFailures[0]));
});
