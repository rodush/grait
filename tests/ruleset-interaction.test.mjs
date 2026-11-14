import test from "node:test";
import assert from "node:assert/strict";
import { repositoryRules } from "../scripts/lib/bootstrap.mjs";
import { configureRepositoryRules } from "../scripts/lib/ruleset-setup.mjs";

const repo = "acme/service";
const rules = repositoryRules([{ id: 42, login: "operator" }], 100, null, 7);
const failure = Object.assign(new Error("synthetic-secret-body"), { status: 403 });

function scenario({
  phase = "activate",
  answers = ["completed"],
  mutate = () => {},
  failedWrite = false,
  verificationFailure = null,
} = {}) {
  const calls = [];
  const logs = [];
  const questions = [];
  const expected = structuredClone(rules).map((rule, index) => ({
    ...rule,
    id: index + 1,
    source: repo,
    enforcement: phase === "stage" && rule.target === "branch" ? "disabled" : "active",
  }));
  mutate(expected);
  let listCalls = 0;
  let writes = 0;
  const api = {
    async list(path) {
      calls.push({ path, method: "GET" });
      listCalls++;
      if (listCalls === 1 && !failedWrite) throw failure;
      if (listCalls > 1 && verificationFailure) throw verificationFailure;
      return expected.map(({ id, name, source, enforcement }) => ({
        id,
        name,
        source,
        enforcement,
      }));
    },
    async request(path, options = {}) {
      calls.push({ path, method: options.method || "GET" });
      if (options.method) {
        writes++;
        throw failure;
      }
      const actual = structuredClone(expected.find(({ id }) => path.endsWith(`/${id}`)));
      if (actual.rules) actual.rules.reverse();
      return { ...actual, node_id: "github-response-metadata", _links: { self: "metadata" } };
    },
  };
  const run = (overrides = {}) =>
    configureRepositoryRules({
      api,
      repo,
      rules,
      phase,
      prompt: async () => {
        questions.push("asked");
        return answers.shift() ?? null;
      },
      log: (message) => logs.push(message),
      ...overrides,
    });
  return { run, calls, logs, questions, writes: () => writes };
}

test("completed manually verifies complete canonical rules read-only in staging and activation", async () => {
  for (const phase of ["stage", "activate"]) {
    const f = scenario({ phase });
    assert.deepEqual(await f.run(), { enforcement: phase === "stage" ? "staged" : "active" });
    assert.equal(f.questions.length, 1);
    assert.ok(f.logs.some((line) => /manually|manual/i.test(line) && /verified/i.test(line)));
    assert.equal(f.calls.filter(({ method }) => method !== "GET").length, 0);
    for (let id = 1; id <= rules.length; id++)
      assert.ok(f.calls.some(({ path }) => path === `repos/${repo}/rulesets/${id}`));
  }
});

test("manual verification after a partial write never performs additional rule writes", async () => {
  const f = scenario({ failedWrite: true });
  assert.deepEqual(await f.run(), { enforcement: "active" });
  assert.equal(f.writes(), 1);
  const writeIndex = f.calls.findIndex(({ method }) => method !== "GET");
  assert.ok(f.calls.slice(writeIndex + 1).every(({ method }) => method === "GET"));
});

test("completed rejects incomplete or weakened rules and waits for another explicit decision", async () => {
  for (const mutate of [
    (actual) => actual.pop(),
    (actual) => {
      actual[0].enforcement = "disabled";
    },
    (actual) => {
      actual[0].conditions.ref_name.include = ["refs/heads/unrelated"];
    },
    (actual) => {
      actual[0].rules
        .find(({ type }) => type === "required_status_checks")
        .parameters.required_status_checks.pop();
    },
    (actual) => {
      actual[0].bypass_actors.push({
        actor_id: 999,
        actor_type: "Integration",
        bypass_mode: "always",
      });
    },
    (actual) => {
      actual[1].bypass_actors[0].actor_id = 999;
    },
  ]) {
    const f = scenario({ mutate, answers: ["completed", "pause"] });
    await assert.rejects(f.run(), (error) => error.code === "RULESET_SETUP_PENDING");
    assert.equal(f.questions.length, 2);
    assert.equal(f.writes(), 0);
    assert.ok(!f.logs.some((line) => /Manual ruleset configuration verified/.test(line)));
  }
});

test("verification errors are redacted and do not count as acknowledgement", async () => {
  for (const verificationFailure of [
    Object.assign(new Error("synthetic-sensitive-http-body"), { status: 503 }),
    new Error("synthetic-sensitive-network-message"),
  ]) {
    const f = scenario({ verificationFailure, answers: ["completed", null] });
    await assert.rejects(f.run(), (error) => error.code === "RULESET_SETUP_PENDING");
    const output = f.logs.join("\n");
    assert.doesNotMatch(output, /synthetic-sensitive|synthetic-secret/);
    if (verificationFailure.status) assert.match(output, /HTTP 503/);
    assert.equal(f.questions.length, 2);
    assert.equal(f.writes(), 0);
  }
});

test("only explicit continue or dedicated acknowledgement accepts unenforced rules", async () => {
  for (const answers of [["continue"], ["yes", "continue"]]) {
    const f = scenario({ answers });
    assert.deepEqual(await f.run(), { enforcement: "unenforced" });
    assert.ok(f.logs.some((line) => /Explicit acknowledgement received/.test(line)));
    assert.equal(f.writes(), 0);
  }
  const acknowledged = scenario({ answers: [] });
  assert.deepEqual(await acknowledged.run({ acknowledgeUnenforced: true }), {
    enforcement: "unenforced",
  });
  assert.equal(acknowledged.questions.length, 0);
  assert.ok(
    acknowledged.logs.some((line) => line.includes(`https://github.com/${repo}/settings/rules`)),
  );
});

test("pause empty input and EOF leave rules pending instead of acknowledging", async () => {
  for (const answer of ["pause", "", null]) {
    const f = scenario({ answers: [answer] });
    await assert.rejects(f.run(), (error) => error.code === "RULESET_SETUP_PENDING");
    assert.equal(f.questions.length, 1);
    assert.equal(f.writes(), 0);
    assert.ok(!f.logs.some((line) => /Explicit acknowledgement received/.test(line)));
  }
});
