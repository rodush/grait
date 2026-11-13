import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Controller } from "../scripts/lib/controller.mjs";
import { digest, issueDigest } from "../scripts/lib/policy.mjs";

const baseConfig = JSON.parse(await readFile(new URL("../workflow.config.json", import.meta.url)));
const baseline = "a".repeat(40),
  redHead = "b".repeat(40),
  greenHead = "c".repeat(40);
function fixture() {
  const config = {
    ...structuredClone(baseConfig),
    controllerRepository: "org/repo",
    humanOperators: ["operator"],
  };
  const item = {
    status: "Ready",
    content: {
      number: 12,
      __typename: "Issue",
      title: "Support a new behavior",
      body: "Acceptance requirements",
      state: "OPEN",
      user: { login: "operator" },
      labels: [],
      repository: { nameWithOwner: "org/repo" },
    },
  };
  const pr = {
    number: 50,
    node_id: "PR50",
    state: "open",
    draft: true,
    title: "feat: support behavior",
    head: { sha: redHead, ref: "agent/issue-12", repo: { full_name: "org/repo" } },
    user: { login: "writer[bot]" },
    labels: [{ name: "agent:managed" }],
  };
  const records = new Map([
    [
      12,
      {
        state: {
          version: 1,
          number: 12,
          triagedDigest: issueDigest(item.content),
          tddPolicy: { required: true, reason: null },
        },
      },
    ],
  ]);
  const calls = [],
    dispatches = [];
  const api = {
    request: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith("/permission")) return { permission: "write" };
      if (path.startsWith("users/")) return { type: "User" };
      if (path.endsWith("/issues/12")) return item.content;
      if (path.endsWith("/commits/main")) return { sha: baseline };
      if (path.endsWith("/pulls/50")) return pr;
      if (path.includes("/compare/"))
        return {
          status: "ahead",
          merge_base_commit: { sha: path.split("/compare/")[1].split("...")[0] },
          files: [
            {
              filename: pr.head.sha === greenHead ? "src/behavior.mjs" : "tests/behavior.test.mjs",
            },
          ],
        };
      return {};
    },
    list: async (path) => (path.includes("/pulls?") ? [pr] : []),
    graphql: async () => ({}),
  };
  const c = new Controller({
    api,
    projectApi: api,
    repo: "org/repo",
    projectId: "P",
    writer: "writer[bot]",
    reviewer: "reviewer[bot]",
    config,
  });
  c.repository = { default_branch: "main", owner: { login: "org" } };
  c.ledger = {
    load: async (number) => {
      if (!records.has(number)) records.set(number, { state: { version: 1, number } });
      return records.get(number);
    },
    save: async () => {},
  };
  c.project = {
    items: [item],
    find: () => item,
    move: async (target, status) => {
      target.status = status;
    },
  };
  c.canClaim = async () => true;
  c.completed = async () => null;
  c.dispatch = async (number, state, kind, inputs, onReserved = async () => {}) => {
    await onReserved();
    const pending = {
      kind,
      operation: `op-${dispatches.length + 1}`,
      at: new Date().toISOString(),
      ...inputs,
    };
    state.pending = pending;
    dispatches.push({ number, kind, inputs });
    return true;
  };
  const state = records.get(12).state;
  const info = { action: "tests-ready", expectedFailures: ["acceptance behavior"] };
  c.tdd.metadata = async () => info;
  const report = (phase) => ({
    issue: 12,
    acceptanceDigest: state.triagedDigest,
    head: pr.head.sha,
    baseline: phase === "red" ? baseline : redHead,
    phase,
    baselinePassed: true,
    passed: phase === "red" ? ["old behavior"] : ["old behavior", "acceptance behavior"],
    failed: phase === "red" ? [{ id: "acceptance behavior", kind: "assertion" }] : [],
    infrastructureErrors: [],
  });
  return { c, api, config, item, pr, state, records, calls, dispatches, info, report };
}

test("testable Ready claims start the tester and reserve a single slot", async () => {
  const f = fixture();
  assert.equal(await f.c.claim(f.item, f.state), true);
  assert.equal(f.item.status, "In Progress");
  assert.equal(f.state.tdd.owner, "tester");
  assert.equal(f.dispatches[0].kind, "test");
  assert.equal(f.dispatches[0].inputs.head, baseline);
  assert.equal(f.state.tdd.branch, "agent/issue-12");
});

test("budget denial leaves no TDD state or WIP reservation and retry can still claim", async () => {
  const f = fixture();
  f.c.dispatch = Controller.prototype.dispatch.bind(f.c);
  f.c.budget.reserve = async () => false;
  assert.equal(await f.c.claim(f.item, f.state), false);
  assert.equal(f.state.tdd, undefined);
  assert.equal(f.item.status, "Ready");
  assert.equal(f.state.pending, undefined);
});

test("an explicit triage exemption routes initial work to the implementer", async () => {
  const f = fixture();
  f.state.tddPolicy = { required: false, reason: "Only changes prose" };
  await f.c.claim(f.item, f.state);
  assert.equal(f.dispatches[0].kind, "implement");
  assert.equal(f.state.tdd, undefined);
});

test("initial tester handoff, verified Red, implementation and verified Green use one branch", async () => {
  const f = fixture();
  await f.c.claim(f.item, f.state);
  f.c.completed = async () => f.state.pending;
  await f.c.tdd.reconcile(f.item, f.state);
  assert.equal(f.state.pr, 50);
  assert.equal(f.state.tdd.stage, "verify-red");
  assert.equal(f.dispatches.at(-1).kind, "verify");
  assert.equal(f.item.status, "In Progress");
  f.c.tdd.proof = async () => f.report("red");
  await f.c.tdd.reconcile(f.item, f.state);
  assert.equal(f.state.tdd.owner, "implementer");
  assert.equal(f.dispatches.at(-1).kind, "develop");
  assert.equal(f.dispatches.at(-1).inputs.head, redHead);
  f.pr.head.sha = greenHead;
  f.info.action = "implemented";
  await f.c.tdd.reconcile(f.item, f.state);
  assert.equal(f.state.tdd.stage, "verify-green");
  assert.equal(f.dispatches.at(-1).inputs.baseline, redHead);
  f.c.tdd.proof = async () => f.report("green");
  await f.c.tdd.reconcile(f.item, f.state);
  assert.equal(f.state.tdd.stage, "done");
  assert.equal(f.state.tdd.owner, null);
  assert.equal(f.item.status, "Review");
  assert.equal(f.records.get(50).state.tddGreenHead, greenHead);
  assert.equal(f.state.tdd.pr, 50);
});

test("implementer test-handback invalidates Red and returns the same branch to tester", async () => {
  const f = fixture();
  await f.c.claim(f.item, f.state);
  f.c.completed = async () => f.state.pending;
  await f.c.tdd.reconcile(f.item, f.state);
  f.c.tdd.proof = async () => f.report("red");
  await f.c.tdd.reconcile(f.item, f.state);
  f.info.action = "tests-needed";
  f.info.reason = "Missing required edge case";
  await f.c.tdd.reconcile(f.item, f.state);
  assert.equal(f.state.tdd.stage, "test");
  assert.equal(f.state.tdd.owner, "tester");
  assert.equal(f.state.tdd.redHead, null);
  assert.equal(f.state.tdd.cycle, 2);
  assert.equal(f.dispatches.at(-1).kind, "test");
  assert.equal(f.dispatches.at(-1).inputs.pr, 50);
});

test("branch advancement during verification cannot authorize a stale handoff", async () => {
  const f = fixture();
  await f.c.claim(f.item, f.state);
  f.c.completed = async () => f.state.pending;
  await f.c.tdd.reconcile(f.item, f.state);
  f.pr.head.sha = greenHead;
  f.c.tdd.proof = async () => assert.fail("Stale SHA must stop before proof is consumed");
  await assert.rejects(() => f.c.tdd.reconcile(f.item, f.state), /advanced/);
  assert.equal(f.state.tdd.owner, "tester");
});

test("incomplete diffs, divergent ancestry and cross-role files cannot hand off", async () => {
  const f = fixture();
  for (const comparison of [
    {
      status: "diverged",
      merge_base_commit: { sha: baseline },
      files: [{ filename: "tests/new.py" }],
    },
    {
      status: "ahead",
      merge_base_commit: { sha: greenHead },
      files: [{ filename: "tests/new.py" }],
    },
    {
      status: "ahead",
      merge_base_commit: { sha: baseline },
      files: Array.from({ length: 300 }, () => ({ filename: "tests/new.py" })),
    },
  ]) {
    f.api.request = async () => comparison;
    await assert.rejects(() => f.c.tdd.changed(baseline, redHead, "tester"), /complete|forward/);
  }
  f.api.request = async () => ({
    status: "ahead",
    merge_base_commit: { sha: baseline },
    files: [{ filename: "src/behavior.mjs" }],
  });
  await assert.rejects(() => f.c.tdd.changed(baseline, redHead, "tester"), /cannot change/);
});

test("handoff metadata is accepted only once from the configured writer for the active operation", async () => {
  const f = fixture();
  const body = (operation) =>
    "```workflow-handoff\n" + JSON.stringify({ operation, action: "tests-ready" }) + "\n```";
  f.c.tdd.metadata = Object.getPrototypeOf(f.c.tdd).metadata.bind(f.c.tdd);
  f.api.list = async () => [
    { user: { login: "outsider" }, body: body("active") },
    { user: { login: "writer[bot]" }, body: body("old") },
    { user: { login: "writer[bot]" }, body: body("active") },
  ];
  assert.equal((await f.c.tdd.metadata(12, "active")).operation, "active");
  f.api.list = async () => [
    { user: { login: "writer[bot]" }, body: body("active") },
    { user: { login: "writer[bot]" }, body: body("active") },
  ];
  await assert.rejects(() => f.c.tdd.metadata(12, "active"), /one writer/);
});

async function proofFixture(t, modifyRun = {}, modifyArtifact = {}) {
  const f = fixture(),
    pending = { kind: "verify", operation: "proof-operation" };
  const run = {
    id: 123,
    path: ".github/workflows/tdd-verify.yml",
    event: "workflow_dispatch",
    run_attempt: 1,
    actor: { login: "writer[bot]" },
    head_branch: "main",
    conclusion: "success",
    ...modifyRun,
  };
  const bytes = Buffer.from(
    "UEsDBBQAAAAAAFm0bF1yn8o/ZAAAAGQAAAAKAAAAcHJvb2YuanNvbnsib3BlcmF0aW9uIjogInByb29mLW9wZXJhdGlvbiIsICJydW5JZCI6ICIxMjMiLCAiaGVhZCI6ICJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIn1QSwECFAMUAAAAAABZtGxdcp/KP2QAAABkAAAACgAAAAAAAAAAAAAAgAEAAAAAcHJvb2YuanNvblBLBQYAAAAAAQABADgAAACMAAAAAAA=",
    "base64",
  );
  f.c.findRun = async () => run;
  f.api.list = async () => [
    {
      id: 99,
      name: "tdd-proof",
      expired: false,
      workflow_run: { id: 123 },
      size_in_bytes: bytes.length,
      digest: `sha256:${digest(bytes)}`,
      ...modifyArtifact,
    },
  ];
  f.api.request = async () => bytes;
  return { ...f, pending };
}

test("proof provenance accepts only the exact trusted verifier run and artifact digest", async (t) => {
  const good = await proofFixture(t);
  assert.equal((await good.c.tdd.proof(good.pending)).head, redHead);
  for (const change of [
    { path: ".github/workflows/ci.yml" },
    { event: "pull_request" },
    { run_attempt: 2 },
    { actor: { login: "outsider" } },
    { head_branch: "feature" },
    { conclusion: "failure" },
  ]) {
    const f = await proofFixture(t, change);
    await assert.rejects(() => f.c.tdd.proof(f.pending), /Untrusted/);
  }
  for (const change of [
    { expired: true },
    { workflow_run: { id: 122 } },
    { size_in_bytes: 1000001 },
    { digest: `sha256:${"0".repeat(64)}` },
  ]) {
    const f = await proofFixture(t, {}, change);
    await assert.rejects(() => f.c.tdd.proof(f.pending), /artifact|integrity/i);
  }
});

test("local claims start tester ownership and require exact branch SHA for handoff", async () => {
  const f = fixture();
  await f.c.claim(f.item, f.state, true, "operator");
  assert.equal(f.state.tdd.localActor, "operator");
  assert.equal(f.dispatches.length, 0);
  await assert.rejects(
    () =>
      f.c.operatorTask("handoff-local", 12, "operator", {
        head: greenHead,
        action: "tests-ready",
        expected: '["acceptance behavior"]',
      }),
    /SHA/,
  );
  await f.c.operatorTask("handoff-local", 12, "operator", {
    head: redHead,
    action: "tests-ready",
    expected: '["acceptance behavior"]',
  });
  assert.equal(f.dispatches.at(-1).kind, "verify");
  assert.equal(f.state.tdd.stage, "verify-red");
});

test("PR review fixes restart tester-first while preserving Review and completed review history", async () => {
  const f = fixture();
  f.pr.draft = false;
  f.item.status = "Review";
  f.state.pr = 50;
  f.state.phase = "review";
  f.state.tdd = { stage: "done", head: redHead };
  f.c.linkedItem = async () => f.item;
  f.c.check = async () => {};
  const prState = (await f.c.ledger.load(50)).state;
  prState.history = [
    {
      head: redHead,
      patch: "patch",
      verdict: "REQUEST_CHANGES",
      blockers: ["bug"],
      conflicts: false,
      rethink: false,
    },
  ];
  await f.c.reconcilePR(f.pr);
  assert.equal(f.state.tdd.followup, true);
  assert.equal(f.dispatches.at(-1).kind, "test");
  assert.equal(f.item.status, "Review");
  assert.equal(prState.history.length, 1);
});

test("resuming a partially pushed tester run cannot blindly replay its old write operation", async () => {
  const f = fixture();
  await f.c.claim(f.item, f.state);
  f.state.lastStoppedOperation = f.state.pending;
  f.state.pending = null;
  f.state.paused = true;
  f.c.findRun = async () => ({ status: "completed", conclusion: "failure" });
  const before = f.dispatches.length;
  let rejected = false;
  try {
    await f.c.operatorTask("resume", 12, "operator");
    await f.c.tdd.reconcile(f.item, f.state);
  } catch {
    rejected = true;
  }
  assert.equal(
    f.dispatches.length,
    before,
    "A branch advanced by the stopped run requires adoption/validation or a fail-closed stop, never another tester dispatch against the old head",
  );
  assert.ok(
    rejected || f.state.paused || f.state.tdd.head === redHead,
    "Partial changes must be reconciled explicitly",
  );
});

test("an acceptance dispute pauses the issue and prevents the next role dispatch", async () => {
  const f = fixture();
  await f.c.claim(f.item, f.state);
  f.state.pending = null;
  f.state.tdd.stage = "test";
  f.state.tdd.owner = "tester";
  f.info.action = "needs-triage";
  f.info.reason =
    "Criterion C1 requires clarification: expected acceptance differs from observed contract";
  const stopped = { kind: "test", operation: "disputed-operation", head: baseline };
  f.c.completed = async () => stopped;
  f.c.pause = async (_number, state, reason) => {
    state.paused = true;
    state.reason = reason;
  };
  await assert.rejects(() => f.c.tdd.reconcile(f.item, f.state), /triage|operator resolution/i);
  // The public issue reconciliation boundary is responsible for pausing errors.
  await f.c.run();
  assert.equal(f.state.paused, true);
  assert.equal(f.dispatches.length, 1);
});

test("verified Red handoff retains bounded sanitized behavioral observations in the issue ledger", async () => {
  const f = fixture();
  await f.c.claim(f.item, f.state);
  f.c.completed = async () => f.state.pending;
  await f.c.tdd.reconcile(f.item, f.state);
  const report = f.report("red");
  report.failed[0].observation = {
    operator: "strictEqual",
    expected: "const privateFixture = true",
    observed: { secret: "fixture" },
  };
  f.c.tdd.proof = async () => report;
  await f.c.tdd.reconcile(f.item, f.state);
  assert.equal(f.state.tdd.failureCount, 1);
  assert.equal(f.state.tdd.failures[0].id, "acceptance behavior");
  assert.match(f.state.tdd.failures[0].observation.expected, /withheld/);
  assert.match(f.state.tdd.failures[0].observation.observed, /withheld/);
  assert.ok(!JSON.stringify(f.state.tdd.failures).includes("privateFixture"));
});
