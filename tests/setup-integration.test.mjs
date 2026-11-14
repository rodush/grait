import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { issueDigest } from "../scripts/lib/policy.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupFixture } from "./helpers/setup-fixture.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const installedApps = Object.fromEntries(
  ["writer", "reviewer"].map((role) => [
    role,
    {
      name: `grait-${role}`,
      slug: `grait-${role}`,
      id: role === "writer" ? 100 : 200,
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
];
const rules = [
  "Required delivery gates",
  "Human merge authority",
  "Release tag creation",
  "Immutable release tags",
].map((name, index) => ({
  id: index + 1,
  name,
  source: "acme/service",
  enforcement: name.includes("release") ? "active" : "disabled",
}));

async function fixture(t, overrides = {}) {
  const f = await setupFixture({
    configured: true,
    localApps: installedApps,
    variables,
    rules,
    ...overrides,
  });
  t.after(() => f.close());
  return f;
}

function noCloudProvisioning(state) {
  assert.equal(state.createdProjects, 0);
  assert.ok(
    !state.calls.some(
      ({ path, method }) =>
        path.includes("app-manifests") ||
        path.includes("/actions/secrets") ||
        path.includes("/environments/") ||
        (/\/issues$/.test(path) && method === "POST"),
    ),
  );
  assert.ok(
    !state.commands.some(({ args }) => ["browse", "secret", "aw", "extension"].includes(args[0])),
  );
}

test("setup reuses local Apps and Project then publishes a validated writer-authored configuration PR", async (t) => {
  const f = await fixture(t);
  const result = await f.run("setup.mjs", ["--repo", "acme/service", "--yes", "--no-browser"], {
    env: { OPENAI_API_KEY: "synthetic-unwanted-api-key" },
  });
  assert.equal(result.status, 0, "The fake local setup happy path must finish");
  assert.match(result.output, /https:\/\/github.com\/acme\/service\/pull\/99/);
  assert.doesNotMatch(result.output, /synthetic-unwanted-api-key|BEGIN PRIVATE KEY/);
  const state = await f.state();
  noCloudProvisioning(state);
  const pr = state.pullRequests[0];
  assert.equal(pr.user.login, "grait-writer[bot]");
  assert.equal(pr.base, "main");
  assert.notEqual(pr.head, "main");
  const commands = state.commands;
  const validation = commands.findIndex(
    ({ command, args }) => command === "npm" && args.join(" ") === "run lint:md",
  );
  const committed = commands.findIndex(
    ({ command, args }) => command === "git" && args[0] === "commit",
  );
  const pushed = commands.findIndex(
    ({ command, args }) => command === "git" && args.includes("push"),
  );
  assert.ok(validation >= 0 && validation < committed && committed < pushed);
  assert.equal(commands[pushed].identity, "writer");
  assert.ok(commands[pushed].args.includes("credential.helper="));
  assert.ok(
    commands
      .filter(({ command }) => command === "codex")
      .every(({ credentialNames }) => credentialNames.length === 0),
  );
  const local = await f.localState();
  assert.equal(local.enabled, false);
  assert.equal(local.configuration.pr, 99);
  assert.equal(local.configuration.branch, pr.head);
  assert.equal(local.apps.writer.id, installedApps.writer.id);
  assert.equal(local.apps.reviewer.id, installedApps.reviewer.id);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.ok(
    f
      .git(["show", "--format=", "--name-only", "HEAD"])
      .split("\n")
      .every(
        (path) =>
          ["workflow.config.json", ".github/CODEOWNERS"].includes(path) ||
          /^(?:\.agents\/skills|\.claude\/(?:agents|skills)|\.codex\/(?:agents|config.toml))/.test(
            path,
          ),
      ),
  );
});

test("a failed configuration push retries only the saved exact branch without reprovisioning", async (t) => {
  const f = await fixture(t, { failPush: true });
  const first = await f.run("setup.mjs", ["--repo", "acme/service", "--yes", "--no-browser"]);
  assert.notEqual(first.status, 0);
  assert.match(first.output, /--publish/);
  const saved = await f.localState();
  assert.ok(saved.configuration.head);
  assert.equal(saved.configuration.pr, undefined);
  await f.update({ failPush: false, calls: [], commands: [] });
  const retry = await f.run("setup.mjs", ["--repo", "acme/service", "--publish"]);
  assert.equal(retry.status, 0, "Publication retry must reuse the completed local configuration");
  const state = await f.state();
  noCloudProvisioning(state);
  assert.ok(!state.commands.some(({ command }) => ["npm", "codex", "claude"].includes(command)));
  assert.equal(state.pullRequests.length, 1);
  assert.equal((await f.localState()).configuration.head, saved.configuration.head);
  await f.update({ calls: [], commands: [] });
  const repeated = await f.run("setup.mjs", ["--repo", "acme/service", "--publish"]);
  assert.equal(repeated.status, 0);
  assert.equal((await f.state()).pullRequests.length, 1);
});

test("configuration publication refuses a dirty or changed saved branch", async (t) => {
  const f = await fixture(t, { failPush: true });
  await f.run("setup.mjs", ["--repo", "acme/service", "--yes", "--no-browser"]);
  await writeFile(join(f.directory, "unrelated-application.txt"), "Unrelated user work");
  await f.update({ failPush: false, calls: [], commands: [] });
  const result = await f.run("setup.mjs", ["--repo", "acme/service", "--publish"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /clean|exact|branch|head/i);
  const state = await f.state();
  assert.ok(
    !state.commands.some(({ command, args }) => command === "git" && args.includes("push")),
  );
  assert.equal(state.pullRequests?.length || 0, 0);
});

test("activation validates committed config, current CI, humans and installed Apps without provider prerequisites", async (t) => {
  const f = await fixture(t, { remoteOwners: "* @operator\n" });
  const result = await f.run("activate.mjs");
  assert.equal(result.status, 0, "The fake local activation happy path must finish");
  const state = await f.state();
  assert.equal(state.variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "true");
  assert.equal((await f.localState()).enabled, true);
  assert.ok(state.calls.some(({ path }) => path.includes("/actions/workflows/ci.yml/runs")));
  assert.ok(state.calls.some(({ path }) => path.endsWith("/contents/workflow.config.json")));
  assert.equal(state.calls.filter(({ path }) => path.endsWith("/installation")).length, 2);
  assert.ok(
    !state.calls.some(({ path }) => /\/actions\/secrets|\/environments\/|\/issues$/.test(path)),
  );
  assert.ok(!state.commands.some(({ args }) => args[0] === "secret"));
});

test("activation cannot enable automation on failed CI, stale config or an unauthorized human", async (t) => {
  for (const change of [
    { ciRuns: [{ head_sha: "a".repeat(40), conclusion: "failure" }] },
    { remoteConfiguration: "{}" },
    { actor: { login: "outsider", id: 99, type: "User" } },
  ]) {
    const f = await fixture(t, { remoteOwners: "* @operator\n", ...change });
    const result = await f.run("activate.mjs");
    assert.notEqual(result.status, 0);
    const state = await f.state();
    assert.equal(state.variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "false");
    assert.ok(
      !state.calls.some(({ path, method }) => path.includes("/rulesets/") && method === "PUT"),
    );
    assert.equal((await f.localState()).enabled, false);
  }
});

test("native subscription preflight rechecks login and rejects API billing without exposing status details", async (t) => {
  for (const scenario of [
    { harness: "codex", nativeStatus: "Logged in using ChatGPT", accepted: true },
    {
      harness: "claude",
      nativeStatus: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiKeySource: null }),
      accepted: true,
    },
    {
      harness: "codex",
      nativeStatus: "Logged in using an API key: synthetic-sensitive-status",
      accepted: false,
    },
    {
      harness: "claude",
      nativeStatus: JSON.stringify({
        loggedIn: true,
        authMethod: "api_key",
        apiKeySource: "synthetic-sensitive-status",
      }),
      accepted: false,
    },
    {
      harness: "codex",
      nativeStatusCode: 1,
      afterLoginStatus: "Logged in using ChatGPT",
      accepted: true,
      login: true,
    },
  ]) {
    const f = await fixture(t, scenario);
    await writeFile(
      join(f.directory, ".git/subscription-check.mjs"),
      `import {requireSubscription} from '../scripts/lib/setup-process.mjs';\ntry { await requireSubscription(${JSON.stringify(scenario.harness)}, { login: ${Boolean(scenario.login)} }); console.log('subscription verified'); } catch(error) { console.error(error.message); process.exitCode=1; }`,
    );
    const result = await f.run("../.git/subscription-check.mjs");
    assert.equal(result.status === 0, scenario.accepted);
    assert.doesNotMatch(result.output, /synthetic-sensitive-status/);
    if (scenario.login) {
      const state = await f.state();
      assert.equal(state.nativeLoginCount, 1);
      assert.equal(
        state.commands.filter(
          ({ command, args }) => command === "codex" && args.join(" ") === "login status",
        ).length,
        2,
      );
    }
  }
});

test("staged setup review permits only an explicit configured-human reviewer context without activation", async (t) => {
  for (const scenario of [
    { options: { reviewer: true }, accepted: false },
    { options: { setupReview: true, reviewer: false }, accepted: false },
    {
      options: { setupReview: true, reviewer: true },
      accepted: false,
      actor: { login: "outsider", id: 99, type: "User" },
    },
    { options: { setupReview: true, reviewer: true }, accepted: true },
  ]) {
    const f = await fixture(t, scenario.actor ? { actor: scenario.actor } : {});
    await writeFile(
      join(f.directory, ".git/context-check.mjs"),
      `import {localContext} from '../scripts/lib/local-context.mjs';\nlet context; try { context=await localContext(${JSON.stringify(scenario.options)}); console.log('review context verified'); } catch(error) { console.error(error.message); process.exitCode=1; } finally { await context?.store.release(); }`,
    );
    const result = await f.run("../.git/context-check.mjs");
    assert.equal(
      result.status === 0,
      scenario.accepted,
      "Only explicit staged review by a configured human may acquire the reviewer context",
    );
    const state = await f.state();
    assert.equal(state.variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "false");
    assert.equal((await f.localState()).enabled, false);
    assert.ok(
      !state.calls.some(
        ({ path, method }) =>
          method !== "GET" && /\/actions\/variables|\/rulesets|\/issues|\/pulls/.test(path),
      ),
    );
  }
});

test("staged review and activation refuse host credentials that differ from recorded repository identities", async (t) => {
  const changedApps = {
    ...installedApps,
    writer: { ...installedApps.writer, name: "different-writer", slug: "different-writer" },
  };
  for (const operation of ["context", "activate"]) {
    const f = await fixture(t, { localApps: changedApps, remoteOwners: "* @operator\n" });
    if (operation === "context")
      await writeFile(
        join(f.directory, ".git/context-check.mjs"),
        `import {localContext} from '../scripts/lib/local-context.mjs';\nlet context; try { context=await localContext({setupReview:true,reviewer:true}); } catch(error) { console.error(error.message); process.exitCode=1; } finally { await context?.store.release(); }`,
      );
    const result = await f.run(
      operation === "context" ? "../.git/context-check.mjs" : "activate.mjs",
    );
    assert.notEqual(
      result.status,
      0,
      "Recorded publishing identities must match this host before staged review or activation",
    );
    assert.match(result.output, /identit|differ|match|App/i);
    const state = await f.state();
    assert.equal(state.variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "false");
    assert.equal((await f.localState()).enabled, false);
    assert.ok(
      !state.calls.some(({ path, method }) => path.includes("/rulesets/") && method === "PUT"),
    );
  }
});

test("existing integration publishes its original head as human before the App configuration push", async (t) => {
  const f = await fixture(t);
  const branch = "chore/adopt-local-grait";
  f.git(["switch", "-c", branch]);
  await mkdir(join(f.directory, ".github/workflows"), { recursive: true });
  await writeFile(
    join(f.directory, ".github/workflows/imported.yml"),
    "name: Existing application CI\non: workflow_dispatch\njobs: {}\n",
  );
  f.git(["add", ".github/workflows/imported.yml"]);
  f.git(["commit", "-m", "chore: import repository automation"]);
  const initialHead = f.git(["rev-parse", "HEAD"]);
  const result = await f.run("setup.mjs", ["--repo", "acme/service", "--yes", "--no-browser"]);
  assert.equal(
    result.status,
    0,
    "An existing integration branch must complete the split human/App publication",
  );
  const state = await f.state();
  noCloudProvisioning(state);
  const pushes = state.commands.filter(
    ({ command, args }) => command === "git" && args.includes("push"),
  );
  assert.equal(pushes.length, 2);
  assert.equal(pushes[0].identity, "human");
  assert.ok(pushes[0].args.includes(`${initialHead}:refs/heads/${branch}`));
  assert.equal(pushes[1].identity, "writer");
  const validation = state.commands.findIndex(
    ({ command, args }) => command === "npm" && args.join(" ") === "run lint:md",
  );
  const humanPush = state.commands.indexOf(pushes[0]);
  const configurationCommit = state.commands.findIndex(
    ({ command, args }) => command === "git" && args[0] === "commit",
  );
  const appPush = state.commands.indexOf(pushes[1]);
  assert.ok(
    validation >= 0 &&
      validation < humanPush &&
      humanPush < configurationCommit &&
      configurationCommit < appPush,
  );
  assert.equal(state.pullRequests.length, 1);
  assert.equal(state.pullRequests[0].user.login, "grait-writer[bot]");
  assert.equal(state.pullRequests[0].head, branch);
  const saved = await f.localState();
  assert.notEqual(saved.configuration.head, initialHead);
  assert.equal(f.git(["rev-parse", "HEAD^"]), initialHead);
  assert.ok(
    !f
      .git(["show", "--format=", "--name-only", "HEAD"])
      .split("\n")
      .includes(".github/workflows/imported.yml"),
  );
  assert.equal(f.git(["status", "--porcelain"]), "");
});

test("Copilot native preflight uses installation version and optional OAuth login without fake auth status", async (t) => {
  for (const login of [false, true]) {
    const f = await fixture(t);
    await writeFile(
      join(f.directory, ".git/copilot-preflight.mjs"),
      `import {requireSubscription} from '../scripts/lib/setup-process.mjs';\ntry { await requireSubscription('copilot', {login:${login}}); console.log('native preflight complete'); } catch(error) { console.error(error.message); process.exitCode=1; }`,
    );
    const result = await f.run("../.git/copilot-preflight.mjs", [], {
      env: {
        COPILOT_GITHUB_TOKEN: "synthetic-publishing-token",
        COPILOT_PROVIDER_API_KEY: "synthetic-provider-key",
        COPILOT_PROVIDERS_CONFIG: "synthetic-provider-config",
        COPILOT_MODEL: "synthetic-inherited-model",
        COPILOT_OFFLINE: "1",
      },
    });
    assert.equal(result.status, 0);
    const state = await f.state();
    const native = state.commands.filter(({ command }) => command === "copilot");
    assert.deepEqual(
      native.map(({ args }) => args),
      login ? [["--version"], ["login"]] : [["--version"]],
    );
    assert.ok(native.every(({ credentialNames }) => credentialNames.length === 0));
    assert.equal(state.nativeLoginCount || 0, login ? 1 : 0);
    assert.deepEqual(state.calls, []);
    assert.doesNotMatch(result.output, /synthetic-publishing-token|synthetic-provider-key/);
  }
});

test("Copilot setup uses its native login and preserves local publishing identity separation", async (t) => {
  const f = await fixture(t);
  const result = await f.run("setup.mjs", [
    "--repo",
    "acme/service",
    "--harness",
    "copilot",
    "--yes",
    "--no-browser",
  ]);
  assert.equal(result.status, 0);
  const state = await f.state();
  noCloudProvisioning(state);
  assert.equal(state.pullRequests[0].user.login, "grait-writer[bot]");
  const native = state.commands.filter(({ command }) => command === "copilot");
  assert.deepEqual(
    native.map(({ args }) => args),
    [["--version"], ["login"]],
  );
  assert.ok(native.every(({ credentialNames }) => credentialNames.length === 0));
  const configured = JSON.parse(await f.read("workflow.config.json"));
  assert.equal(configured.engine, "copilot");
  assert.deepEqual(configured.supportedEngines, ["codex", "claude", "copilot"]);
});

async function selectCopilot(f, { implementationProfile = false } = {}) {
  const configured = structuredClone(f.config);
  configured.engine = "copilot";
  configured.supportedEngines = ["codex", "claude", "copilot"];
  if (implementationProfile)
    configured.tdd.profiles.implementer = { model: "gpt-5", reasoning: "high" };
  await writeFile(join(f.directory, "workflow.config.json"), JSON.stringify(configured));
  f.git(["add", "workflow.config.json"]);
  f.git(["commit", "-m", "test: select native Copilot harness"]);
}

const nativeValue = (args, flag) => args[args.indexOf(flag) + 1];

test("the orchestrator starts a scrubbed local Copilot session with the orchestrator role", async (t) => {
  const f = await fixture(t, {
    localEnabled: true,
    variables: variables.map((entry) =>
      entry.name === "AUTOMATION_ENABLED" ? { ...entry, value: "true" } : entry,
    ),
  });
  await selectCopilot(f);
  const result = await f.run("orchestrator.mjs", ["start"], {
    env: {
      COPILOT_PROVIDER_API_KEY: "synthetic-provider-key",
      COPILOT_MODEL: "synthetic-inherited-model",
    },
  });
  assert.equal(result.status, 0);
  const state = await f.state();
  const native = state.commands.filter(({ command }) => command === "copilot");
  assert.deepEqual(native[0].args, ["--version"]);
  const launch = native.find(({ args }) => args.includes("--interactive"));
  assert.ok(launch);
  assert.equal(nativeValue(launch.args, "--agent"), "grait-orchestrator");
  assert.equal(nativeValue(launch.args, "--model"), "auto");
  assert.equal(nativeValue(launch.args, "--effort"), "medium");
  assert.match(nativeValue(launch.args, "--interactive"), /grait-orchestrator/);
  assert.equal(launch.cwd, f.directory);
  assert.ok(native.every(({ credentialNames }) => credentialNames.length === 0));
  assert.ok(!state.calls.some(({ path }) => /app-manifests|dispatches/.test(path)));
});

test("Copilot implementation launches in the accepted shared issue worktree with its selected profile", async (t) => {
  const f = await fixture(t, {
    localEnabled: true,
    variables: variables.map((entry) =>
      entry.name === "AUTOMATION_ENABLED" ? { ...entry, value: "true" } : entry,
    ),
  });
  await selectCopilot(f, { implementationProfile: true });
  const acceptedHead = f.git(["rev-parse", "HEAD"]);
  const worktree = join(f.directory, ".git/accepted-issue-worktree");
  f.git(["worktree", "add", "-b", "agent/issue-1", worktree, acceptedHead]);
  const issue = {
    number: 1,
    node_id: "issue-1",
    title: "Implement the accepted local outcome",
    body: "Accepted public behavior",
    state: "open",
    user: { login: "operator" },
    labels: [],
  };
  const digest = issueDigest(issue);
  const recorded = {
    version: 1,
    number: 1,
    triagedDigest: digest,
    triage: { ready: true, blockers: [] },
    claim: { issue: 1, branch: "agent/issue-1", digest },
    tdd: {
      version: 1,
      issue: 1,
      branch: "agent/issue-1",
      head: acceptedHead,
      baseline: acceptedHead,
      acceptanceDigest: digest,
      owner: "implementer",
      phase: "implementation",
      evidence: ["accepted-red"],
    },
  };
  await f.update({
    issue,
    issueComments: [
      {
        id: 701,
        user: { login: "grait-writer[bot]" },
        body: "<!-- workflow-state:v1 -->\n\n```json\n" + JSON.stringify(recorded) + "\n```",
      },
    ],
    projectItems: [
      {
        id: "project-issue-1",
        isArchived: false,
        fieldValueByName: { name: "In Progress" },
        content: { __typename: "Issue", number: 1, repository: { nameWithOwner: "acme/service" } },
      },
    ],
  });
  const result = await f.run("orchestrator.mjs", ["worker", "--issue", "1", "--role", "implement"]);
  assert.equal(result.status, 0);
  const state = await f.state();
  const launch = state.commands.find(
    ({ command, args }) => command === "copilot" && args.includes("--interactive"),
  );
  assert.ok(launch);
  assert.equal(launch.cwd, worktree);
  assert.equal(nativeValue(launch.args, "--agent"), "grait-implement");
  assert.equal(nativeValue(launch.args, "--model"), "gpt-5");
  assert.equal(nativeValue(launch.args, "--effort"), "high");
  assert.match(nativeValue(launch.args, "--interactive"), /claimed issue #1/);
  assert.equal(launch.credentialNames.length, 0);
  assert.ok(
    !state.commands.some(({ command, args }) => command === "git" && args.includes("fetch")),
  );
});
