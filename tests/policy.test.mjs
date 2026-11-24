import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertAcyclic,
  availableSlots,
  conventionalTitle,
  dependencyComplete,
  issueDigest,
  loopDecision,
  parseBlock,
  validateReview,
  validateTriage,
  validateConfig,
} from "../scripts/lib/policy.mjs";
import { repositoryRules } from "../scripts/lib/bootstrap.mjs";

const config = JSON.parse(readFileSync(new URL("../workflow.config.json", import.meta.url)));
const entry = (number, extra = {}) => ({
  fixAttempts: number,
  head: `head${number}`,
  patch: `patch${number}`,
  blockers: [`finding${number}`],
  verdict: "REQUEST_CHANGES",
  rethink: false,
  conflicts: false,
  ...extra,
});

test("only In Progress consumes the five-story limit, including other repositories and opaque items", () => {
  const progress = Array.from({ length: 4 }, () => ({
    status: config.statuses.inProgress,
    content: { __typename: "Issue" },
  }));
  const review = Array.from({ length: 20 }, () => ({
    status: config.statuses.review,
    content: { __typename: "Issue" },
  }));
  assert.equal(availableSlots([...progress, ...review], config), 1);
  assert.equal(
    availableSlots(
      [...progress, ...review, { status: config.statuses.inProgress, content: null }],
      config,
    ),
    0,
  );
  assert.equal(
    availableSlots([...progress, { status: config.statuses.inProgress, isArchived: true }], config),
    1,
  );
});

test("the tenth blocking review stops; a clean tenth review can proceed to human merge", () => {
  const history = Array.from({ length: 10 }, (_, i) => entry(i));
  assert.equal(loopDecision(history.slice(0, 9), config).action, "fix");
  assert.equal(loopDecision(history, config).action, "pause");
  history[9] = entry(9, { verdict: "APPROVE", blockers: [] });
  assert.equal(loopDecision(history, config).action, "human-merge");
});

test("the same blocker after two fix attempts interrupts the loop", () => {
  const history = [1, 2, 3].map((i) => entry(i, { blockers: ["parser:empty-input"] }));
  assert.equal(loopDecision(history.slice(0, 2), config).action, "fix");
  assert.match(loopDecision(history, config).reason, /two fix attempts/);
});

test("a recurring code state and conflicting instructions interrupt early", () => {
  assert.match(
    loopDecision([entry(1), entry(2), entry(3, { patch: "patch1" })], config).reason,
    /oscillate/,
  );
  assert.match(loopDecision([entry(1, { conflicts: true })], config).reason, /Conflicting/);
  assert.equal(loopDecision([entry(1, { rethink: true })], config).action, "rethink");
});

test("an incomplete comment review cannot authorize a merge", () => {
  assert.equal(
    loopDecision([entry(1, { verdict: "COMMENT", blockers: [] })], config).action,
    "pause",
  );
});

test("unchanged patches and unrelated pushes do not count as code reversals or completed fixes", () => {
  assert.equal(loopDecision([entry(1), entry(2, { patch: "patch1" })], config).action, "fix");
  const pushes = [1, 2, 3].map((i) => entry(i, { blockers: ["same"], fixAttempts: 0 }));
  assert.equal(loopDecision(pushes, config).action, "fix");
});

test("Ready capacity accepts positive safe integers and remains optional", () => {
  assert.doesNotThrow(() => validateConfig({ ...config, maxReady: undefined }));
  assert.doesNotThrow(() => validateConfig({ ...config, maxReady: 7 }));
  for (const maxReady of [0, -1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateConfig({ ...config, maxReady }), /maxReady/);
  }
});

test("automated write scopes cannot include shared policy or automation", () => {
  assert.doesNotThrow(() => validateConfig(config));
  const protectedConfig = {
    ...config,
    allowedWritePaths: ["src/**", "tests/**"],
    protectedPaths: ["docs/", "scripts/", "AGENTS.md", ".github/"],
    tdd: { ...config.tdd, implementationPaths: ["src/**"] },
  };
  assert.doesNotThrow(() => validateConfig(protectedConfig));
  for (const path of ["docs/**", "scripts/**", "AGENTS.md", ".github/workflows/**"])
    assert.throws(
      () => validateConfig({ ...protectedConfig, allowedWritePaths: [path] }),
      /protected/,
    );
});

test("canceled or unreadable dependencies do not count as implemented", () => {
  assert.equal(dependencyComplete({ state: "closed", state_reason: "completed" }), true);
  assert.equal(dependencyComplete({ state: "CLOSED", stateReason: "COMPLETED" }), true);
  for (const value of [
    { state: "open" },
    { state: "closed", state_reason: "not_planned" },
    { state: "closed" },
  ])
    assert.equal(dependencyComplete(value), false);
});

test("dependency cycles across repositories are rejected", () => {
  assert.throws(
    () =>
      assertAcyclic(
        new Map([
          ["org/a#1", ["org/b#2"]],
          ["org/b#2", ["org/a#1"]],
        ]),
      ),
    /cycle/,
  );
  assert.doesNotThrow(() =>
    assertAcyclic(
      new Map([
        ["a", ["b", "c"]],
        ["b", ["c"]],
        ["c", []],
      ]),
    ),
  );
});

test("triage is invalidated by changed requirements or unanswered questions", () => {
  const issue = { number: 1, title: "Outcome", body: "Acceptance criteria" };
  const metadata = {
    version: 1,
    issue: 1,
    digest: issueDigest(issue),
    ready: true,
    blockers: [],
    questions: [],
    checklist: Object.fromEntries(
      ["scope", "acceptance", "validation", "dependencies", "alignment"].map((key) => [key, true]),
    ),
  };
  assert.equal(validateTriage(metadata, issue), metadata);
  assert.throws(() => validateTriage(metadata, { ...issue, body: "New scope" }), /Stale/);
  assert.throws(
    () => validateTriage({ ...metadata, questions: ["Which approach?"] }, issue),
    /no open questions/,
  );
  assert.throws(
    () => validateTriage({ ...metadata, blockers: ["unqualified#1"] }, issue),
    /reference/,
  );
});

test("review metadata must match GitHub's formal decision, head, PR, and round", () => {
  const data = {
    version: 1,
    pr: 5,
    head: "abc",
    round: 2,
    verdict: "APPROVE",
    blockers: [],
    rethink: false,
    conflicts: false,
  };
  const review = { state: "APPROVED", commit_id: "abc" };
  const expected = { number: 5, head: "abc", round: 2 };
  assert.equal(validateReview(data, review, expected), data);
  assert.throws(() => validateReview(data, { ...review, commit_id: "old" }, expected), /revision/);
  assert.throws(
    () => validateReview(data, { ...review, state: "CHANGES_REQUESTED" }, expected),
    /decision/,
  );
  assert.throws(
    () => validateReview({ ...data, blockers: ["bug"] }, review, expected),
    /Approval cannot/,
  );
  assert.throws(() => validateReview({ ...data, round: 1 }, review, expected), /round/);
});

test("duplicate metadata blocks cannot hide contradictory decisions", () => {
  assert.deepEqual(parseBlock('```workflow-review\n{"ok":true}\n```', "workflow-review"), {
    ok: true,
  });
  assert.throws(() => parseBlock("```x\n{}\n```\n```x\n{}\n```", "x"), /exactly one/);
});

test("repository rules let humans squash-merge when the delivery gates pass", () => {
  const rules = repositoryRules([{ id: 42 }], 1234, 456, 98765);
  const branchRules = rules.filter(({ target }) => target === "branch");
  assert.deepEqual(
    branchRules.map(({ name }) => name),
    ["Required delivery gates"],
  );
  const [gates] = branchRules;
  assert.deepEqual(gates.bypass_actors, []);
  assert.deepEqual(gates.conditions.ref_name, {
    include: ["~DEFAULT_BRANCH"],
    exclude: [],
  });
  assert.deepEqual(gates.rules.find(({ type }) => type === "pull_request").parameters, {
    required_approving_review_count: 1,
    dismiss_stale_reviews_on_push: true,
    require_code_owner_review: true,
    require_last_push_approval: true,
    required_review_thread_resolution: true,
    allowed_merge_methods: ["squash"],
  });
  assert.deepEqual(gates.rules.find(({ type }) => type === "required_status_checks").parameters, {
    strict_required_status_checks_policy: true,
    required_status_checks: [
      { context: "Template validation", integration_id: 98765 },
      { context: "Agent review", integration_id: 1234 },
    ],
  });

  const releaseRules = rules.filter(({ target }) => target === "tag");
  for (const rule of releaseRules) {
    assert.deepEqual(rule.conditions.ref_name, {
      include: ["refs/tags/v*"],
      exclude: [],
    });
    assert.equal(rule.enforcement, "active");
  }
  assert.deepEqual(
    releaseRules.map(({ name, rules }) => [name, rules.map(({ type }) => type)]),
    [
      ["Release tag creation", ["creation"]],
      ["Immutable release tags", ["update", "deletion"]],
    ],
  );
});

test("Conventional Commit titles allow scopes and breaking changes", () => {
  for (const title of ["feat: add API", "fix(parser): reject null", "feat(api)!: change response"])
    assert.equal(conventionalTitle(title), true);
  for (const title of ["Update stuff", "feat add API", "fix: "])
    assert.equal(conventionalTitle(title), false);
});

test("local configuration supports Codex Claude and Copilot without hosted execution", () => {
  assert.deepEqual(config.supportedEngines, ["codex", "claude", "copilot"]);
  for (const engine of ["codex", "claude", "copilot"]) {
    const selected = { ...config, supportedEngines: ["codex", "claude", "copilot"], engine };
    assert.doesNotThrow(() => validateConfig(selected));
    assert.equal(selected.execution, "local");
    assert.equal(selected.ghAwVersion, undefined);
    assert.equal(selected.ghAwActionsSha, undefined);
  }
});
