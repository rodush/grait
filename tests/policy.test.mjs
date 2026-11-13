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
    status: "In Progress",
    content: { __typename: "Issue" },
  }));
  const review = Array.from({ length: 20 }, () => ({
    status: "Review",
    content: { __typename: "Issue" },
  }));
  assert.equal(availableSlots([...progress, ...review], config), 1);
  assert.equal(
    availableSlots([...progress, ...review, { status: "In Progress", content: null }], config),
    0,
  );
  assert.equal(
    availableSlots([...progress, { status: "In Progress", isArchived: true }], config),
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

test("automated write scopes cannot include shared policy or automation", () => {
  assert.doesNotThrow(() => validateConfig(config));
  for (const path of ["docs/**", "scripts/**", "AGENTS.md", ".github/workflows/**"])
    assert.throws(() => validateConfig({ ...config, allowedWritePaths: [path] }), /protected/);
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

test("human merge authority does not bypass delivery requirements", () => {
  const [gates, authority] = repositoryRules([{ id: 42 }], 1234, null, 98765);
  assert.deepEqual(gates.bypass_actors, []);
  assert.deepEqual(authority.bypass_actors, [
    { actor_id: 42, actor_type: "User", bypass_mode: "pull_request" },
  ]);
  assert.deepEqual(authority.rules, [{ type: "update" }]);
  assert.equal(
    gates.rules.find((rule) => rule.type === "pull_request").parameters.require_code_owner_review,
    true,
  );
  assert.equal(
    gates.rules.find((rule) => rule.type === "required_status_checks").parameters
      .required_status_checks[1].integration_id,
    1234,
  );
});

test("Conventional Commit titles allow scopes and breaking changes", () => {
  for (const title of ["feat: add API", "fix(parser): reject null", "feat(api)!: change response"])
    assert.equal(conventionalTitle(title), true);
  for (const title of ["Update stuff", "feat add API", "fix: "])
    assert.equal(conventionalTitle(title), false);
});
