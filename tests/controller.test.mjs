import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Controller } from "../scripts/lib/controller.mjs";
import { availableSlots, issueDigest } from "../scripts/lib/policy.mjs";

const baseConfig = JSON.parse(readFileSync(new URL("../workflow.config.json", import.meta.url)));
function fixture() {
  const config = { ...baseConfig, controllerRepository: "org/repo", humanOperators: ["operator"] };
  const records = new Map();
  const saves = [];
  const api = {
    request: async (path) => {
      const number = Number(path.match(/issues\/(\d+)$/)?.[1]);
      return number ? issueItem(number).content : {};
    },
    list: async () => [],
  };
  const controller = new Controller({
    api,
    projectApi: api,
    repo: "org/repo",
    projectId: "project",
    writer: "writer[bot]",
    reviewer: "reviewer[bot]",
    config,
  });
  controller.repository = { default_branch: "main", owner: { login: "org" } };
  controller.ledger = {
    load: async (number) => {
      if (!records.has(number))
        records.set(number, {
          state: {
            version: 1,
            number,
            tddPolicy: { required: false, reason: "Legacy policy fixture" },
          },
        });
      return records.get(number);
    },
    save: async (number) => saves.push(structuredClone(records.get(number).state)),
  };
  controller.project = {
    items: [],
    move: async (item, status) => {
      item.status = status;
    },
  };
  return { controller, config, api, records, saves };
}

function issueItem(number, status = "Ready") {
  return {
    status,
    content: {
      __typename: "Issue",
      user: { login: "operator" },
      number,
      title: `Story ${number}`,
      body: "Requirements",
      state: "OPEN",
      repository: { nameWithOwner: "org/repo" },
    },
  };
}

test("slot reservation precedes dispatch and a sixth story cannot be claimed", async () => {
  const { controller, config } = fixture();
  const items = Array.from({ length: 6 }, (_, i) => issueItem(i + 1));
  controller.project.items = items;
  controller.canClaim = async () => true;
  const observed = [];
  controller.dispatch = async (_number, _state, _kind, _inputs, onReserved) => {
    await onReserved();
    observed.push(availableSlots(items, config));
    return true;
  };
  for (const item of items) {
    const { state } = await controller.ledger.load(item.content.number);
    state.triagedDigest = issueDigest(item.content);
    await controller.claim(item, state);
  }
  assert.deepEqual(observed, [4, 3, 2, 1, 0]);
  assert.equal(items[5].status, "Ready");
});

test("blocked work cannot consume a slot or dispatch implementation", async () => {
  const { controller } = fixture();
  const item = issueItem(1);
  const state = { triagedDigest: issueDigest(item.content) };
  controller.canClaim = async () => false;
  controller.dispatch = async () => assert.fail("Blocked work dispatched");
  assert.equal(await controller.claim(item, state), false);
  assert.equal(item.status, "Ready");
});

async function reviewFixture({ rethink = false, managed = true } = {}) {
  const result = fixture();
  const { controller } = result;
  const item = issueItem(1, "Review");
  const issue = (await controller.ledger.load(1)).state;
  Object.assign(issue, { phase: "review", pr: 10, triagedDigest: issueDigest(item.content) });
  const state = (await controller.ledger.load(10)).state;
  state.history = [
    {
      head: "head",
      patch: "patch",
      verdict: "REQUEST_CHANGES",
      blockers: ["bug"],
      conflicts: false,
      rethink,
    },
  ];
  const pr = {
    number: 10,
    title: "fix: implement story",
    state: "open",
    draft: false,
    head: {
      sha: "head",
      ref: "agent/issue-1",
      repo: { full_name: managed ? "org/repo" : "contributor/fork" },
    },
    user: { login: managed ? "writer[bot]" : "contributor" },
    labels: [{ name: "agent:managed" }, { name: "agent:admitted" }],
  };
  controller.project.items = [item];
  controller.linkedItem = async () => item;
  controller.completed = async () => null;
  const checks = [];
  const dispatches = [];
  controller.check = async (target, ledger, conclusion, summary) =>
    checks.push({ conclusion, summary });
  controller.dispatch = async (...args) => dispatches.push(args);
  return { ...result, item, state, issue, pr, checks, dispatches };
}

test("follow-up fixes stay in Review", async () => {
  const { controller, pr, item, dispatches } = await reviewFixture();
  await controller.reconcilePR(pr);
  assert.equal(item.status, "Review");
  assert.equal(dispatches[0][2], "fix");
  assert.equal(dispatches[0][3].rethink, false);
});

test("a redesign waits in Review until it can reserve an In Progress slot", async () => {
  const { controller, pr, item, issue, dispatches } = await reviewFixture({ rethink: true });
  controller.project.items.push(
    ...Array.from({ length: 5 }, (_, i) => issueItem(20 + i, "In Progress")),
  );
  await controller.reconcilePR(pr);
  assert.equal(item.status, "Review");
  assert.equal(dispatches.length, 0);
  controller.project.items[1].status = "Done";
  await controller.reconcilePR(pr);
  assert.equal(item.status, "In Progress");
  assert.equal(issue.phase, "rethink");
  assert.equal(dispatches[0][3].rethink, true);
});

test("fork branches receive findings without automatic pushes", async () => {
  const { controller, pr, dispatches, checks } = await reviewFixture({ managed: false });
  await controller.reconcilePR(pr);
  assert.equal(dispatches.length, 0);
  assert.equal(checks.at(-1).conclusion, "failure");
});

test("ten rounds remain exhausted after a human resume boundary", async () => {
  const { controller, pr, state, dispatches } = await reviewFixture();
  state.history = Array.from({ length: 10 }, (_, i) => ({
    head: i === 9 ? "head" : `head${i}`,
    patch: `patch${i}`,
    blockers: [`bug${i}`],
    verdict: "REQUEST_CHANGES",
  }));
  state.resumeIndex = 9;
  controller.pause = async (number, ledger, reason) => {
    ledger.paused = true;
    ledger.reason = reason;
  };
  await controller.reconcilePR(pr);
  assert.equal(state.paused, true);
  assert.match(state.reason, /Ten/);
  assert.equal(dispatches.length, 0);
});

test("a stale review cannot approve or fix the current head", async () => {
  const { controller, pr, state, api, dispatches, checks } = await reviewFixture();
  const metadata = {
    version: 1,
    pr: 10,
    head: "old",
    round: 1,
    operation: "op",
    verdict: "APPROVE",
    blockers: [],
    rethink: false,
    conflicts: false,
  };
  state.history = [];
  state.pending = {
    kind: "review",
    operation: "op",
    head: "old",
    round: 1,
    at: "2026-01-01T00:00:00Z",
    patch: "oldpatch",
  };
  controller.completed = async () => state.pending;
  api.list = async () => [
    {
      id: 123,
      user: { login: "reviewer[bot]" },
      submitted_at: "2026-01-01T00:01:00Z",
      commit_id: "old",
      state: "APPROVED",
      body: `\`\`\`workflow-review\n${JSON.stringify(metadata)}\n\`\`\``,
    },
  ];
  await controller.reconcilePR(pr);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].head, "old");
  assert.equal(dispatches.length, 0);
  assert.equal(checks.filter((check) => check.conclusion === "success").length, 0);
});

test("an unmerged PR closure never completes its issue", async () => {
  const { controller, pr, issue, item } = await reviewFixture();
  controller.pause = async (number, state) => {
    state.paused = true;
  };
  await controller.reconcilePR({ ...pr, state: "closed" });
  assert.equal(issue.paused, true);
  assert.notEqual(item.status, "Done");
});

test("only a merged linked PR completes the story", async () => {
  const { controller, pr, issue, item } = await reviewFixture();
  await controller.reconcilePR({ ...pr, state: "closed", merged_at: "2026-01-01T00:00:00Z" });
  assert.equal(issue.phase, "done");
  assert.equal(item.status, "Done");
});

test("a service account cannot use operator tasks simply because it has write access", async () => {
  const { controller, api } = fixture();
  api.request = async (path) =>
    path.startsWith("users/") ? { type: "User" } : { permission: "write" };
  await assert.rejects(
    () => controller.operatorTask("resume", 1, "service-account"),
    /configured human/,
  );
});

test("resuming a failed run waits for cancellation and preserves the completed review budget", async () => {
  const { controller, api, state } = await reviewFixture();
  state.paused = true;
  state.lastStoppedOperation = { kind: "fix", operation: "failed-fix" };
  api.request = async (path) =>
    path.startsWith("users/") ? { type: "User" } : { permission: "write" };
  controller.findRun = async () => ({ status: "in_progress" });
  await assert.rejects(() => controller.operatorTask("resume", 10, "operator"), /finish or cancel/);
  controller.findRun = async () => ({ status: "completed" });
  await controller.operatorTask("resume", 10, "operator");
  assert.equal(state.paused, false);
  assert.equal(state.history.length, 1);
  assert.equal(state.resumedOperation.operation, "failed-fix");
});

test("resuming a policy stop requires a new revision before another review or fix", async () => {
  const { controller, api, state, pr, dispatches, checks } = await reviewFixture();
  state.paused = true;
  state.lastStoppedOperation = null;
  api.request = async (path) =>
    path.startsWith("users/") ? { type: "User" } : { permission: "write" };
  await controller.operatorTask("resume", 10, "operator");
  await controller.reconcilePR(pr);
  assert.equal(dispatches.length, 0);
  assert.match(checks.at(-1).summary, /new revision/);
});

test("implementation retry reuses the existing slot", async () => {
  const { controller, api } = fixture();
  const item = issueItem(1, "In Progress");
  controller.project.items = [item];
  const { state } = await controller.ledger.load(1);
  Object.assign(state, {
    phase: "implementing",
    retry: "implement",
    triagedDigest: issueDigest(item.content),
  });
  api.request = async () => ({ ...item.content, state: "open", labels: [] });
  controller.completed = async () => null;
  const dispatches = [];
  controller.dispatch = async (...args) => dispatches.push(args);
  await controller.reconcileIssue(item);
  assert.equal(item.status, "In Progress");
  assert.equal(dispatches[0][2], "implement");
  assert.equal(state.retry, null);
});

test("retry adopts a PR already created by a partially failed implementation", async () => {
  const { controller, api } = fixture();
  const item = issueItem(1, "In Progress");
  controller.project.items = [item];
  const { state } = await controller.ledger.load(1);
  Object.assign(state, {
    phase: "implementing",
    retry: "implement",
    triagedDigest: issueDigest(item.content),
  });
  api.request = async () => ({ ...item.content, state: "open", labels: [] });
  api.list = async () => [
    {
      number: 10,
      draft: false,
      user: { login: "writer[bot]" },
      head: { ref: "agent/issue-1", repo: { full_name: "org/repo" } },
    },
  ];
  controller.completed = async () => null;
  controller.dispatch = async () =>
    assert.fail("Existing PR must be adopted without dispatching another implementation");
  await controller.reconcileIssue(item);
  assert.equal(item.status, "Review");
  assert.equal(state.pr, 10);
});

test("a competing PR cannot release an active implementation's slot or replace its delivery", async () => {
  const { controller, item, issue, pr, state, dispatches } = await reviewFixture({
    managed: false,
  });
  item.status = "In Progress";
  issue.phase = "implementing";
  issue.pr = null;
  issue.pending = { kind: "implement", operation: "active-implementation" };
  await controller.reconcilePR(pr);
  assert.equal(item.status, "In Progress");
  assert.equal(issue.pr, null);
  assert.match(state.deliveryReason, /active implementation/);
  assert.equal(dispatches.length, 0);
});

test("an agent approval cannot bypass incomplete blocking dependencies", async () => {
  const { controller, pr, state, checks } = await reviewFixture();
  state.history[0] = { ...state.history[0], verdict: "APPROVE", blockers: [] };
  controller.canClaim = async () => false;
  await controller.reconcilePR(pr);
  assert.equal(checks.at(-1).conclusion, "failure");
  assert.match(checks.at(-1).summary, /Blocking dependencies/);
});
