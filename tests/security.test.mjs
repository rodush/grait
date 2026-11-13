import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { admitted, DispatchBudget } from "../scripts/lib/admission.mjs";
import { Controller } from "../scripts/lib/controller.mjs";
import { createRelease } from "../scripts/lib/release.mjs";
import { repositoryRules } from "../scripts/lib/bootstrap.mjs";

const config = {
  ...JSON.parse(readFileSync(new URL("../workflow.config.json", import.meta.url))),
  controllerRepository: "org/repo",
  humanOperators: ["operator"],
};

test("outsiders require explicit admission; author association alone does not grant access", async () => {
  const api = { request: async () => ({ permission: "read" }) };
  const item = { user: { login: "outsider" }, author_association: "COLLABORATOR", labels: [] };
  assert.equal(await admitted(api, "org/repo", item, config, "writer[bot]"), false);
  assert.equal(
    await admitted(
      api,
      "org/repo",
      { ...item, labels: [{ name: config.labels.admitted }] },
      config,
      "writer[bot]",
    ),
    true,
  );
  api.request = async () => ({ permission: "write" });
  assert.equal(await admitted(api, "org/repo", item, config, "writer[bot]"), true);
  api.request = async () => {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  };
  await assert.rejects(() => admitted(api, "org/repo", item, config, "writer[bot]"), /forbidden/);
});

test("outsider issue floods, repeated edits and unlinked fork PRs cause no agent dispatch", async () => {
  let dispatched = 0;
  const api = {
    request: async (path) =>
      path.endsWith("/permission")
        ? { permission: "read" }
        : {
            number: 1,
            title: "External",
            body: "request",
            labels: [],
            user: { login: "outsider" },
          },
    list: async () => [],
  };
  const controller = new Controller({
    api,
    projectApi: api,
    repo: "org/repo",
    projectId: "p",
    writer: "writer[bot]",
    reviewer: "reviewer[bot]",
    config,
  });
  controller.dispatch = async () => {
    dispatched++;
  };
  controller.ledger.load = async () => assert.fail("Unadmitted content must not enter the ledger");
  for (let i = 0; i < 30; i++) {
    await controller.reconcileIssue({ content: { number: i + 1 }, status: "Backlog" });
    await controller.reconcilePR({
      number: i + 50,
      user: { login: "outsider" },
      labels: [],
      head: { repo: { full_name: "outsider/fork" } },
    });
  }
  assert.equal(dispatched, 0);
});

function budgetFixture(
  limits = { maxConcurrent: 2, dailyCredits: 4200, agentCredits: 1000, detectionCredits: 400 },
) {
  const entry = { comment: { id: 10 }, state: { reservations: [] } };
  let clock = new Date("2026-11-12T12:00:00Z");
  const runs = new Map();
  let saves = 0;
  const budget = new DispatchBudget(
    {
      load: async () => entry,
      save: async () => {
        saves++;
      },
    },
    999,
    limits,
    async (pending) => runs.get(pending.operation),
    () => clock,
  );
  const pending = (operation) => ({ operation, kind: "triage", at: clock.toISOString() });
  return {
    budget,
    entry,
    runs,
    pending,
    advance: () => {
      clock = new Date(clock.getTime() + 86400001);
    },
    saved: () => saves,
  };
}

test("global reservations bound concurrency and rolling daily credits across workflow kinds", async () => {
  const { budget, entry, runs, pending, advance } = budgetFixture();
  assert.equal(await budget.reserve(pending("a")), true);
  assert.equal(await budget.reserve({ ...pending("b"), kind: "review" }), true);
  assert.equal(await budget.reserve(pending("c")), false);
  runs.set("a", { status: "completed" });
  assert.equal(await budget.reserve(pending("c")), true);
  runs.set("b", { status: "completed" });
  runs.set("c", { status: "completed" });
  assert.equal(await budget.reserve(pending("d")), false);
  advance();
  assert.equal(await budget.reserve(pending("d")), true);
  assert.equal(entry.state.reservations.length, 1);
});

test("unknown runs retain their reservation even after a day, and missing ledgers fail closed", async () => {
  const { budget, entry, pending, advance } = budgetFixture({
    maxConcurrent: 1,
    dailyCredits: 28000,
    agentCredits: 1000,
    detectionCredits: 400,
  });
  await budget.reserve(pending("uncertain"));
  advance();
  assert.equal(await budget.reserve(pending("new")), false);
  entry.comment = null;
  await assert.rejects(() => budget.reserve(pending("reset")), /Missing automation budget/);
});

test("budget denial never calls the dispatcher or reserves an implementation slot", async () => {
  const api = { request: async () => assert.fail("No API dispatch allowed"), list: async () => [] };
  const c = new Controller({
    api,
    projectApi: api,
    repo: "org/repo",
    projectId: "p",
    writer: "writer[bot]",
    reviewer: "reviewer[bot]",
    config,
  });
  c.budget.reserve = async () => false;
  c.ledger.save = async () => {};
  const state = {};
  assert.equal(
    await c.dispatch(1, state, "implement", {}, async () => assert.fail("Slot consumed")),
    false,
  );
  assert.equal(state.pending, undefined);
});

function releaseFixture({
  exists = false,
  tagType = "commit",
  tagSha = "verified",
  protectedTags = true,
} = {}) {
  const calls = [];
  const rule = repositoryRules([{ id: 42 }], 123, 456, 98765).find(
    (item) => item.name === "Immutable release tags",
  );
  const api = {
    list: async () => (protectedTags ? [{ id: 1, name: rule.name, source: "org/repo" }] : []),
    request: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith("/rulesets/1")) return rule;
      if (path.endsWith("/git/refs")) {
        if (exists) throw Object.assign(new Error("Reference already exists"), { status: 422 });
        return {};
      }
      if (path.includes("/git/ref/tags/")) return { object: { type: tagType, sha: tagSha } };
      return {};
    },
  };
  return { api, calls };
}

for (const tagType of ["commit", "tag"])
  test(`existing ${tagType} tags cannot bypass release CI`, async () => {
    const { api, calls } = releaseFixture({ exists: true, tagType, tagSha: "unreviewed" });
    await assert.rejects(
      () => createRelease(api, "org/repo", "v1.2.3", "verified"),
      /already exists/,
    );
    assert.equal(
      calls.some((call) => call.path.endsWith("/releases")),
      false,
    );
  });

test("release creates a fresh validated tag and rejects races or missing protection", async () => {
  const good = releaseFixture();
  await createRelease(good.api, "org/repo", "v1.2.3", "verified");
  assert.deepEqual(good.calls.find((call) => call.path.endsWith("/git/refs")).options.body, {
    ref: "refs/tags/v1.2.3",
    sha: "verified",
  });
  assert.equal(good.calls.at(-1).options.body.target_commitish, "verified");
  const race = releaseFixture({ tagSha: "changed" });
  await assert.rejects(
    () => createRelease(race.api, "org/repo", "v1.2.3", "verified"),
    /validated commit/,
  );
  assert.equal(
    race.calls.some((call) => call.path.endsWith("/releases")),
    false,
  );
  const missing = releaseFixture({ protectedTags: false });
  await assert.rejects(
    () => createRelease(missing.api, "org/repo", "v1.2.3", "verified"),
    /protection/,
  );
});

test("release identity may create tags but no identity can bypass tag immutability", () => {
  const rules = repositoryRules([{ id: 42 }], 123, 456, 98765);
  const creation = rules.find((rule) => rule.name === "Release tag creation");
  assert.deepEqual(creation.bypass_actors, [
    { actor_id: 456, actor_type: "Integration", bypass_mode: "always" },
  ]);
  assert.deepEqual(rules.find((rule) => rule.name === "Immutable release tags").bypass_actors, []);
});
