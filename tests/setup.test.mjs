import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { setupFixture, bootstrapArguments } from "./helpers/setup-fixture.mjs";

const setupAvailable = existsSync(new URL("../scripts/setup.mjs", import.meta.url));

const mutation = (call) => call.method !== "GET" && call.path !== "graphql";
const graphMutation = (call) => call.path === "graphql" && /^\s*mutation\b/.test(call.body.query);

async function fixture(t, overrides) {
  const value = await setupFixture(overrides);
  t.after(() => value.close());
  return value;
}

test("setup is available as the opinionated npm entry point", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(manifest.scripts.setup, "node scripts/setup.mjs");
});

test(
  "setup help describes planning, resuming, browser fallback, and separate activation without contacting GitHub",
  { skip: !setupAvailable },
  async (t) => {
    const f = await fixture(t);
    const result = await f.run("setup.mjs", ["--help"]);
    assert.equal(result.status, 0, "The setup command must provide successful local help");
    for (const option of ["--plan", "--repo", "--harness", "--no-browser", "--activate", "--yes"])
      assert.ok(result.output.includes(option), `Help must describe ${option}`);
    const state = await f.state();
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.commands, []);
  },
);

test(
  "setup planning discovers the target and human defaults without writes or browser launches",
  { skip: !setupAvailable },
  async (t) => {
    const f = await fixture(t);
    const beforeConfig = await f.read("workflow.config.json");
    const beforeOwners = await f.read(".github/CODEOWNERS");
    const result = await f.run("setup.mjs", ["--plan", "--no-browser", "--yes"]);
    assert.equal(result.status, 0, "A read-only setup plan must succeed");
    assert.match(result.output, /acme\/service/);
    assert.match(result.output, /operator/);
    const plan = JSON.parse(result.output);
    assert.equal(plan.execution, "local");
    assert.match(plan.authentication, /native.*subscription/i);
    assert.deepEqual(plan.identities, ["writer", "reviewer"]);
    assert.equal(plan.providerApiKeys, false);
    assert.match(result.output, /disabled|false|activat/i);
    const state = await f.state();
    assert.deepEqual(
      state.calls.filter((call) => mutation(call) || graphMutation(call)),
      [],
    );
    assert.ok(
      state.commands.every(
        ({ args }) => !["browse", "secret", "variable", "extension", "workflow"].includes(args[0]),
      ),
    );
    assert.equal(await f.read("workflow.config.json"), beforeConfig);
    assert.equal(await f.read(".github/CODEOWNERS"), beforeOwners);
    assert.ok(!result.output.includes("synthetic-setup-token"));
  },
);

test(
  "setup planning respects an explicit repository and local harness",
  { skip: !setupAvailable },
  async (t) => {
    const f = await fixture(t);
    const result = await f.run("setup.mjs", [
      "--plan",
      "--repo",
      "acme/service",
      "--harness",
      "claude",
    ]);
    assert.equal(result.status, 0, "Explicit setup options must produce a plan");
    for (const expected of ["acme/service", "claude"]) assert.ok(result.output.includes(expected));
    const state = await f.state();
    assert.deepEqual(
      state.calls.filter((call) => mutation(call) || graphMutation(call)),
      [],
    );
  },
);

test(
  "setup gives a non-admin contributor a target-admin handoff before any mutation",
  { skip: !setupAvailable },
  async (t) => {
    const f = await fixture(t, {
      repository: {
        id: 72,
        node_id: "repo-node",
        name: "service",
        full_name: "acme/service",
        owner: { login: "acme", type: "Organization", id: 73 },
        permissions: { admin: false, push: true },
        default_branch: "main",
      },
    });
    const result = await f.run("setup.mjs", ["--repo", "acme/service", "--yes", "--no-browser"]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /admin|administrator|owner/i);
    assert.match(result.output, /acme\/service/);
    const state = await f.state();
    assert.ok(
      state.calls.some(({ path, method }) => path === "repos/acme/service" && method === "GET"),
      "Check target administrator access before rejecting the request",
    );
    assert.ok(
      !state.commands.some(({ command }) => command === "npm"),
      "Non-admin preflight must not install dependencies or start project tooling",
    );
    assert.deepEqual(
      state.calls.filter((call) => mutation(call) || graphMutation(call)),
      [],
    );
    assert.ok(
      state.commands.every(
        ({ args }) => !["browse", "secret", "variable", "extension", "workflow"].includes(args[0]),
      ),
    );
  },
);

test("bootstrap preserves application ownership rules and project configuration", async (t) => {
  const f = await fixture(t);
  const result = await f.run("bootstrap.mjs", [...bootstrapArguments, "--project-number", "12"]);
  assert.equal(result.status, 0, "Existing-project bootstrap must complete in the local fixture");
  const owners = await f.read(".github/CODEOWNERS");
  assert.ok(
    owners.includes("* @application-owner"),
    "Existing application ownership must survive setup",
  );
  assert.ok(
    owners.includes("/src/payments/ @acme/payments-team"),
    "Specific ownership must survive setup",
  );
  assert.ok(owners.includes("@operator"));
  const config = JSON.parse(await f.read("workflow.config.json"));
  assert.equal(config.applicationMarker, "preserve-application-setting");
  assert.equal(config.controllerRepository, "acme/service");
  assert.deepEqual(config.humanOperators, ["operator"]);
});

test("bootstrap records the new Project identity before later configuration can fail", async (t) => {
  const f = await fixture(t, { failProjectDetails: true });
  const result = await f.run("bootstrap.mjs", bootstrapArguments);
  assert.notEqual(result.status, 0, "The injected Project-details outage must fail setup");
  const state = await f.state();
  assert.equal(state.createdProjects, 1);
  const variables = new Map(state.variables.map(({ name, value }) => [name, value]));
  assert.equal(
    variables.get("PROJECT_ID"),
    "project-node",
    "Persist the created Project ID before configuring it",
  );
  assert.equal(variables.get("PROJECT_NUMBER"), "12", "Persist its number for resumption");
  assert.equal(variables.get("PROJECT_OWNER"), "acme", "Persist its owner for resumption");
  assert.equal(variables.get("AUTOMATION_ENABLED"), "false");
});

test("bootstrap reuses the recorded bound Project without creating paid-automation infrastructure", async (t) => {
  const f = await fixture(t, {
    variables: [
      { name: "AUTOMATION_ENABLED", value: "false" },
      { name: "PROJECT_ID", value: "project-node" },
      { name: "PROJECT_NUMBER", value: "12" },
      { name: "PROJECT_OWNER", value: "acme" },
    ],
  });
  const result = await f.run("bootstrap.mjs", bootstrapArguments);
  assert.equal(result.status, 0, "Resuming the recorded installation must succeed");
  const state = await f.state();
  assert.equal(state.createdProjects, 0, "Resuming setup must not create a second Project");
  assert.ok(
    !state.calls.some(
      ({ path, method }) => /\/issues(?:\/900\/comments)?$/.test(path) && method !== "GET",
    ),
  );
  const variables = new Map(state.variables.map(({ name, value }) => [name, value]));
  assert.equal(variables.has("AUTOMATION_BUDGET_ISSUE"), false);
  assert.equal(variables.has("AUTOMATION_BUDGET_LOGIN"), false);
  assert.equal(variables.get("AUTOMATION_ENABLED"), "false");
});
