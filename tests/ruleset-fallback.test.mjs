import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupFixture, bootstrapArguments } from "./helpers/setup-fixture.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const installedApps = Object.fromEntries(
  ["writer", "reviewer"].map((role) => [
    role,
    {
      name: `grait-${role}`,
      slug: `grait-${role}`,
      id: role === "writer" ? 100 : 200,
      botUserId: role === "writer" ? 10001 : 20001,
      clientId: `Iv1.${role}`,
      pem,
      phase: "installed",
      installed: true,
    },
  ]),
);
const variables = [
  { name: "AUTOMATION_ENABLED", value: "false" },
  { name: "PROJECT_ID", value: "project-node" },
  { name: "PROJECT_NUMBER", value: "12" },
  { name: "PROJECT_OWNER", value: "acme" },
  { name: "AUTOMATION_LOGIN", value: "grait-writer[bot]" },
  { name: "REVIEW_LOGIN", value: "grait-reviewer[bot]" },
  { name: "AUTOMATION_APP_ID", value: "100" },
  { name: "AUTOMATION_BOT_USER_ID", value: "10001" },
  { name: "REVIEW_APP_ID", value: "200" },
  { name: "REVIEW_BOT_USER_ID", value: "20001" },
];
const rules = [
  "Required delivery gates",
  "Human merge authority",
  "Release tag creation",
  "Immutable release tags",
].map((name, index) => ({ id: index + 1, name, source: "acme/service", enforcement: "disabled" }));

async function fixture(t, overrides = {}) {
  const f = await setupFixture({
    configured: true,
    localApps: installedApps,
    variables,
    rules,
    remoteOwners: "* @operator\n",
    failurePath: "repos/acme/service/rulesets",
    failureStatus: 403,
    ...overrides,
  });
  t.after(() => f.close());
  const injection = join(f.directory, ".git/ruleset-failure.mjs");
  await writeFile(
    injection,
    `import { readFileSync, writeFileSync } from 'node:fs';
const request = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const state = JSON.parse(readFileSync(process.env.GRAIT_SETUP_FIXTURE_STATE, 'utf8'));
  const path = new URL(url).pathname.slice(1);
  const method = options.method || 'GET';
  if (state.failureStatus && path === state.failurePath && (!state.failureMethod || method === state.failureMethod)) {
    state.calls.push({ path, method, body: options.body ? JSON.parse(options.body) : undefined, identity: 'human' });
    writeFileSync(process.env.GRAIT_SETUP_FIXTURE_STATE, JSON.stringify(state));
    return Response.json({ message: 'synthetic-sensitive-error-details' }, { status: state.failureStatus });
  }
  return request(url, options);
};`,
  );
  return {
    ...f,
    run: (entry, args = []) =>
      f.run(entry, args, {
        env: {
          NODE_OPTIONS: `--import=${join(f.directory, "preload.mjs")} --import=${injection}`,
        },
      }),
  };
}

function assertGuidance(output) {
  assert.match(output, /https:\/\/github.com\/acme\/service\/settings\/rules/);
  assert.match(output, /private/i);
  assert.match(output, /GitHub Free|free plan/i);
  assert.match(output, /--acknowledge-unenforced-rules/);
  assert.match(output, /human/i);
  assert.match(output, /approv|merge/i);
  for (const { name } of rules) assert.ok(output.includes(`"name": "${name}"`));
  for (const expected of [
    '"required_approving_review_count": 1',
    '"require_code_owner_review": true',
    '"require_last_push_approval": true',
    '"required_review_thread_resolution": true',
    '"strict_required_status_checks_policy": true',
    '"context": "Template validation"',
    '"context": "Agent review"',
    '"integration_id": 7',
    '"integration_id": 100',
    '"~DEFAULT_BRANCH"',
    '"refs/tags/v*"',
  ])
    assert.ok(output.includes(expected), `Show the canonical configuration setting ${expected}`);
  assert.doesNotMatch(
    output,
    /synthetic-sensitive-error-details|synthetic-setup-token|BEGIN PRIVATE KEY/,
  );
}

function assertNoProvisioningDuplicates(state) {
  assert.equal(state.createdProjects, 0);
  assert.ok(!state.calls.some(({ path }) => path.includes("app-manifests")));
}

test("bootstrap ruleset errors display canonical manual configuration and require explicit acknowledgement", async (t) => {
  for (const failureStatus of [403, 422, 503]) {
    const f = await fixture(t, { failureStatus });
    const result = await f.run("bootstrap.mjs", bootstrapArguments);
    assert.notEqual(result.status, 0);
    assertGuidance(result.output);
    const state = await f.state();
    assert.equal(state.variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "false");
    assert.equal(
      state.variables.find(({ name }) => name === "RULESET_ENFORCEMENT").value,
      "pending",
    );
    assertNoProvisioningDuplicates(state);
  }
});

test("bootstrap can continue explicitly without rulesets after a failed list or partial write", async (t) => {
  for (const failure of [
    {},
    { failurePath: "repos/acme/service/rulesets/2", failureMethod: "PUT", failureStatus: 422 },
  ]) {
    const f = await fixture(t, failure);
    const result = await f.run("bootstrap.mjs", [
      ...bootstrapArguments,
      "--acknowledge-unenforced-rules",
    ]);
    assert.equal(result.status, 0, "Explicit acknowledgement permits automation configuration");
    assertGuidance(result.output);
    const state = await f.state();
    assert.equal(state.variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "false");
    assert.equal(
      JSON.parse(await f.read("workflow.config.json")).controllerRepository,
      "acme/service",
    );
    assert.equal(
      state.variables.find(({ name }) => name === "RULESET_ENFORCEMENT").value,
      "unenforced",
    );
    assertNoProvisioningDuplicates(state);
  }
});

test("setup --yes does not silently acknowledge unavailable rulesets and can resume the pending setup", async (t) => {
  const f = await fixture(t);
  const args = ["--repo", "acme/service", "--yes", "--no-browser"];
  const pending = await f.run("setup.mjs", args);
  assert.notEqual(pending.status, 0);
  assertGuidance(pending.output);
  assert.equal((await f.state()).pullRequests?.length || 0, 0);
  const resumed = await f.run("setup.mjs", [...args, "--acknowledge-unenforced-rules"]);
  assert.equal(
    resumed.status,
    0,
    "Acknowledged setup resumes without manual cleanup or duplicate provisioning",
  );
  const state = await f.state();
  assert.equal(state.pullRequests.length, 1);
  assertNoProvisioningDuplicates(state);
  assert.equal((await f.localState()).enabled, false);
});

test("activation ruleset failure leaves automation disabled until acknowledged", async (t) => {
  const f = await fixture(t);
  const pending = await f.run("activate.mjs");
  assert.notEqual(pending.status, 0);
  assertGuidance(pending.output);
  assert.equal((await f.localState()).enabled, false);
  assert.equal((await f.localState()).rulesetEnforcement, "pending");
  assert.equal(
    (await f.state()).variables.find(({ name }) => name === "AUTOMATION_ENABLED").value,
    "false",
  );
  const resumed = await f.run("activate.mjs", ["--acknowledge-unenforced-rules"]);
  assert.equal(resumed.status, 0, "Acknowledged unenforced operation must permit activation");
  assert.equal((await f.localState()).enabled, true);
  assert.equal((await f.localState()).rulesetEnforcement, "unenforced");
  assert.equal(
    (await f.state()).variables.find(({ name }) => name === "RULESET_ENFORCEMENT").value,
    "unenforced",
  );
  assert.equal(
    (await f.state()).variables.find(({ name }) => name === "AUTOMATION_ENABLED").value,
    "true",
  );
});

test("setup --activate forwards explicit unenforced acknowledgement to activation", async (t) => {
  const f = await fixture(t, { failureStatus: 503 });
  const result = await f.run("setup.mjs", ["--activate", "--acknowledge-unenforced-rules"]);
  assert.equal(result.status, 0);
  assert.equal((await f.localState()).enabled, true);
});

test("activation can acknowledge missing staged rulesets or a partial activation write", async (t) => {
  for (const failure of [
    { failureStatus: 0, rules: [] },
    { failurePath: "repos/acme/service/rulesets/2", failureMethod: "PUT", failureStatus: 422 },
  ]) {
    const f = await fixture(t, failure);
    const result = await f.run("activate.mjs", ["--acknowledge-unenforced-rules"]);
    assert.equal(result.status, 0);
    assertGuidance(result.output);
    assert.equal((await f.localState()).enabled, true);
  }
});

test("unenforced acknowledgement never suppresses unrelated provisioning or activation errors", async (t) => {
  for (const scenario of [
    {
      entry: "bootstrap.mjs",
      args: bootstrapArguments,
      failurePath: "repos/acme/service",
      failureMethod: "PATCH",
      failureStatus: 422,
    },
    {
      entry: "activate.mjs",
      args: [],
      ciRuns: [{ head_sha: "a".repeat(40), conclusion: "failure" }],
      failureStatus: 0,
    },
  ]) {
    const f = await fixture(t, scenario);
    const result = await f.run(scenario.entry, [
      ...scenario.args,
      "--acknowledge-unenforced-rules",
    ]);
    assert.notEqual(result.status, 0);
    assert.equal((await f.localState()).enabled, false);
    assert.equal(
      (await f.state()).variables.find(({ name }) => name === "AUTOMATION_ENABLED").value,
      "false",
    );
  }
});
