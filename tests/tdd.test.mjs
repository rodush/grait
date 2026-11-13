import test from "node:test";
import assert from "node:assert/strict";
import * as tdd from "../scripts/lib/tdd.mjs";

const head = "a".repeat(40);
const baseline = "b".repeat(40);
const acceptanceDigest = "c".repeat(64);
function config() {
  return {
    allowedWritePaths: ["tests/**", "src/**", "assets/**"],
    protectedPaths: [".github/", "src/security-policy.json"],
    tdd: {
      testPatterns: ["tests/**", "**/test_*.py", "**/*.spec.py"],
      implementationPaths: ["src/application/**", "assets/**"],
      profiles: {
        tester: { model: "test-model", reasoning: "high" },
        implementer: { model: "code-model", reasoning: "medium" },
      },
    },
  };
}
function handoff(overrides = {}) {
  return tdd.createHandoff({
    issue: 12,
    branch: "agent/issue-12",
    head,
    baseline,
    acceptanceDigest,
    ...overrides,
  });
}
function evidence(overrides = {}) {
  return {
    issue: 12,
    acceptanceDigest,
    head,
    baseline,
    phase: "red",
    baselinePassed: true,
    infrastructureErrors: [],
    passed: ["existing behavior"],
    failed: [{ id: "acceptance behavior", kind: "assertion" }],
    ...overrides,
  };
}
const expected = {
  issue: 12,
  acceptanceDigest,
  head,
  baseline,
  phase: "red",
  expectedFailures: ["acceptance behavior"],
};

test("tester and implementer may use independent model/reasoning settings", () => {
  const value = config();
  assert.equal(tdd.validateTddConfig(value), value.tdd);
  assert.notEqual(value.tdd.profiles.tester.model, value.tdd.profiles.implementer.model);
  value.tdd.profiles.tester.permissions = "write-all";
  assert.throws(() => tdd.validateTddConfig(value), /profile|override/i);
});

test("write scopes reject intersections, including a protected descendant inside a broad scope", () => {
  const overlap = config();
  overlap.tdd.implementationPaths = ["tests/**", "src/application/**"];
  assert.doesNotThrow(() => tdd.validateTddConfig(overlap));
  assert.throws(
    () => tdd.assertRoleChanges([{ filename: "tests/case.py" }], "implementer", overlap),
    /cannot change/,
  );
  const ancestor = config();
  ancestor.tdd.implementationPaths = ["src/**"];
  assert.throws(() => tdd.validateTddConfig(ancestor), /protected/i);
  const outside = config();
  outside.tdd.testPatterns = ["other-tests/**"];
  assert.throws(() => tdd.validateTddConfig(outside), /allowlist|scope/i);
});

test("renames, deletions and traversal cannot cross a role's write boundary", () => {
  const value = config();
  assert.doesNotThrow(() =>
    tdd.assertRoleChanges([{ filename: "tests/case.mjs" }], "tester", value),
  );
  assert.doesNotThrow(() =>
    tdd.assertRoleChanges([{ filename: "src/application/module.mjs" }], "implementer", value),
  );
  for (const [role, files] of [
    [
      "tester",
      [
        {
          filename: "tests/new.mjs",
          previous_filename: "src/application/old.mjs",
          status: "renamed",
        },
      ],
    ],
    ["implementer", [{ filename: "tests/case.mjs", status: "removed" }]],
    ["tester", [{ filename: "tests/../src/application/module.mjs" }]],
    ["tester", [{ filename: "tests//case.mjs" }]],
    ["tester", [{}]],
  ])
    assert.throws(() => tdd.assertRoleChanges(files, role, value), /cannot change|path|filename/i);
});

test("a handoff is bound to one issue branch, acceptance digest and baseline commit", () => {
  const state = handoff();
  assert.equal(state.owner, "tester");
  assert.equal(state.phase, "tests");
  assert.equal(state.baseline, baseline);
  assert.equal(state.head, head);
  assert.equal(state.acceptanceDigest, acceptanceDigest);
  for (const invalid of [
    { branch: "agent/issue-13" },
    { head: "main" },
    { acceptanceDigest: "unknown" },
    { baseline: undefined },
    { baseline: "main" },
    { cycle: 0 },
    { cycle: 11 },
  ])
    assert.throws(() => handoff(invalid), /handoff|baseline|cycle/i);
});

test("Red requires exactly the named new assertion failures", () => {
  assert.match(tdd.validateEvidence(evidence(), expected), /^[a-f0-9]{64}$/);
  for (const change of [
    { baselinePassed: false },
    { infrastructureErrors: ["dependency install failed"] },
    { head: "d".repeat(40) },
    { baseline: "e".repeat(40) },
    { issue: 13 },
    { acceptanceDigest: "f".repeat(64) },
    { failed: [{ id: "acceptance behavior", kind: "import-error" }] },
    { failed: [{ id: "unrelated regression", kind: "assertion" }] },
    { failed: [] },
    {
      failed: [
        { id: "acceptance behavior", kind: "assertion" },
        { id: "unexpected", kind: "assertion" },
      ],
    },
    {
      failed: [
        { id: "acceptance behavior", kind: "assertion" },
        { id: "acceptance behavior", kind: "assertion" },
      ],
    },
    { passed: ["acceptance behavior"] },
    { passed: ["existing behavior", "existing behavior"] },
    { passed: [""] },
  ])
    assert.throws(
      () => tdd.validateEvidence(evidence(change), expected),
      /evidence|Red|identity|identities|baseline|assertion|duplicate|stale/i,
    );
  assert.throws(
    () => tdd.validateEvidence(evidence(), { ...expected, expectedFailures: [] }),
    /expected/i,
  );
  assert.throws(
    () => tdd.validateEvidence(evidence({ passed: [], failed: [] }), expected),
    /executed/i,
  );
});

test("ownership moves exclusively tester to implementer and test revisions return to tester", () => {
  const initial = handoff();
  const implementing = tdd.handoffToImplementer(initial, evidence(), ["acceptance behavior"]);
  assert.equal(initial.owner, "tester");
  assert.equal(implementing.owner, "implementer");
  assert.equal(implementing.redHead, head);
  assert.equal(implementing.evidence.length, 1);
  assert.throws(
    () => tdd.handoffToImplementer(implementing, evidence(), ["acceptance behavior"]),
    /own/i,
  );
  const revision = tdd.returnToTester(implementing, "Acceptance criterion needs another edge case");
  assert.equal(revision.owner, "tester");
  assert.equal(revision.cycle, 2);
  assert.equal(revision.redHead, null);
  assert.throws(() => tdd.returnToTester(initial, "change"), /handback|implementer/i);
  assert.throws(() => tdd.returnToTester(implementing, "  "), /reason/i);
  assert.throws(() => tdd.returnToTester({ ...implementing, cycle: 10 }, "change"), /limit|human/i);
});

test("Green requires a nonempty fully passing suite at the implementation head", () => {
  const implementing = tdd.handoffToImplementer(handoff(), evidence(), ["acceptance behavior"]);
  const newHead = "d".repeat(40);
  const state = { ...implementing, head: newHead };
  const green = evidence({
    head: newHead,
    baseline: head,
    phase: "green",
    passed: ["existing behavior", "acceptance behavior"],
    failed: [],
  });
  const completed = tdd.completeImplementation(state, green);
  assert.equal(completed.phase, "review");
  assert.equal(completed.owner, null);
  assert.equal(completed.evidence.length, 2);
  assert.throws(
    () =>
      tdd.completeImplementation(state, {
        ...green,
        failed: [{ id: "acceptance behavior", kind: "assertion" }],
      }),
    /Green/i,
  );
  assert.throws(() => tdd.completeImplementation(state, { ...green, passed: [] }), /executed/i);
  assert.throws(() => tdd.completeImplementation(state, { ...green, head }), /stale/i);
  assert.throws(() => tdd.completeImplementation(handoff(), green), /own/i);
});

test("triage exemptions must explicitly declare inapplicability and a concrete reason", () => {
  assert.equal(
    typeof tdd.validateTddExemption,
    "function",
    "Export the triage exemption validator",
  );
  assert.deepEqual(
    tdd.validateTddExemption({
      required: false,
      reason: "Only adjusts prose in the operator guide",
    }),
    { required: false, reason: "Only adjusts prose in the operator guide" },
  );
  assert.deepEqual(tdd.validateTddExemption({ required: true, reason: null }), {
    required: true,
    reason: null,
  });
  for (const invalid of [
    undefined,
    {},
    { required: false },
    { required: false, reason: " " },
    { required: "false", reason: "prose" },
  ])
    assert.throws(() => tdd.validateTddExemption(invalid), /exemption|reason|required/i);
});

test("glob classification gives collocated tests precedence over overlapping production scopes", () => {
  const value = config();
  value.tdd.implementationPaths = ["src/application/**", "tests/**", "assets/**"];
  for (const path of [
    "tests/direct.py",
    "src/application/test_behavior.py",
    "src/application/behavior.spec.py",
  ]) {
    assert.equal(tdd.isTestPath(path, value), true);
    assert.doesNotThrow(() => tdd.assertRoleChanges([{ filename: path }], "tester", value));
    assert.throws(
      () => tdd.assertRoleChanges([{ filename: path }], "implementer", value),
      /cannot change/,
    );
  }
  assert.equal(tdd.isTestPath("src/application/behavior.py", value), false);
  assert.throws(
    () => tdd.assertRoleChanges([{ filename: "src/application/behavior.py" }], "tester", value),
    /cannot change/,
  );
  for (const role of ["tester", "implementer"])
    assert.throws(
      () =>
        tdd.assertRoleChanges(
          [
            {
              filename: "src/application/behavior.spec.py",
              previous_filename: "src/application/behavior.py",
            },
          ],
          role,
          value,
        ),
      /cannot change/,
    );
  assert.throws(
    () => tdd.assertRoleChanges([{ filename: "elsewhere/behavior.spec.py" }], "tester", value),
    /cannot change/,
  );
});

test("test globs cannot escape the repository or grant writes to protected tests", () => {
  for (const pattern of ["../*.py", "/tests/**", "tests\\*.py", "tests/../../*.py"]) {
    const value = config();
    value.tdd.testPatterns = [pattern];
    assert.throws(() => tdd.validateTddConfig(value), /glob|pattern/i);
  }
  const value = config();
  value.tdd.implementationPaths = ["assets/**"];
  value.protectedPaths = ["src/application/security.spec.py"];
  assert.throws(
    () =>
      tdd.assertRoleChanges([{ filename: "src/application/security.spec.py" }], "tester", value),
    /protected|cannot change/i,
  );
});
