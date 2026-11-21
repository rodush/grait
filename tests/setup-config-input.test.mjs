import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupFixture } from "./helpers/setup-fixture.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const apps = Object.fromEntries(
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
const args = ["--repo", "acme/service", "--yes", "--no-browser"];

async function fixture(t, changes = {}) {
  const f = await setupFixture({ configured: true, localApps: apps, variables, rules, ...changes });
  t.after(() => f.close());
  return f;
}

async function editConfig(f, staging = "unstaged") {
  const config = JSON.parse(await f.read("workflow.config.json"));
  config.maxConcurrentWorkers = 1;
  config.applicationMarker = "user-entered-input";
  config.projectSpecific = { preserve: ["custom", "configuration"] };
  await writeFile(join(f.directory, "workflow.config.json"), JSON.stringify(config));
  if (staging !== "unstaged") f.git(["add", "workflow.config.json"]);
  if (staging === "mixed") {
    config.projectSpecific.pendingEdit = "latest unstaged value";
    await writeFile(join(f.directory, "workflow.config.json"), JSON.stringify(config));
  }
  return config;
}

function assertNoSetupMutation(state) {
  assert.ok(
    !state.calls.some(({ path, method, body }) =>
      path === "graphql" ? /^\s*mutation\b/.test(body.query) : method !== "GET",
    ),
  );
  assert.equal(state.createdProjects, 0);
  assert.ok(
    !state.commands.some(
      ({ command, args }) =>
        command === "npm" ||
        ["codex", "claude", "copilot"].includes(command) ||
        (command === "git" &&
          args.some((arg) => ["commit", "push", "add", "switch"].includes(arg))),
    ),
  );
}

for (const staging of ["unstaged", "staged", "mixed"]) {
  test(`setup includes ${staging} tracked config input in its configuration PR without an intermediate user commit`, async (t) => {
    const f = await fixture(t);
    const before = f.git(["rev-parse", "HEAD"]);
    const intended = await editConfig(f, staging);
    const result = await f.run("setup.mjs", args);
    assert.equal(result.status, 0, "Tracked workflow configuration edits are intended setup input");
    const committed = JSON.parse(f.git(["show", "HEAD:workflow.config.json"]));
    assert.equal(committed.maxConcurrentWorkers, intended.maxConcurrentWorkers);
    assert.equal(committed.applicationMarker, intended.applicationMarker);
    assert.deepEqual(committed.projectSpecific, intended.projectSpecific);
    assert.equal(f.git(["rev-list", "--count", `${before}..HEAD`]), "1");
    assert.equal(f.git(["status", "--porcelain"]), "");
    const state = await f.state();
    assert.equal(state.pullRequests.length, 1);
    assert.equal(state.pullRequests[0].user.login, "grait-writer[bot]");
    assert.equal(state.createdProjects, 0);
    assert.ok(!state.calls.some(({ path }) => path.includes("app-manifests")));
  });
}

test("config input still requires the overall setup confirmation before provisioning", async (t) => {
  const f = await fixture(t);
  await editConfig(f);
  const original = await f.read("workflow.config.json");
  const result = await f.run("setup.mjs", ["--repo", "acme/service", "--no-browser"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Interactive confirmation is required/);
  assert.equal(await f.read("workflow.config.json"), original);
  assertNoSetupMutation(await f.state());
});

test("config input and its staged snapshot remain intact on ordinary setup failure", async (t) => {
  const f = await fixture(t, { nativeStatusCode: 1 });
  await editConfig(f, "mixed");
  const original = await f.read("workflow.config.json");
  const indexed = f.git(["show", ":workflow.config.json"]);
  const result = await f.run("setup.mjs", args);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /native subscription login is required/i);
  assert.equal(await f.read("workflow.config.json"), original);
  assert.equal(f.git(["show", ":workflow.config.json"]), indexed);
  assert.equal((await f.state()).pullRequests?.length || 0, 0);
});

test("config input survives a deliberate ruleset pause and resumes without a halfway commit", async (t) => {
  const f = await fixture(t);
  await editConfig(f, "mixed");
  const original = await f.read("workflow.config.json");
  const indexed = f.git(["show", ":workflow.config.json"]);
  const injection = join(f.directory, ".git/deny-rulesets.mjs");
  await writeFile(
    injection,
    `
const fetch = globalThis.fetch;
globalThis.fetch = (url, options) => new URL(url).pathname === '/repos/acme/service/rulesets'
  ? Promise.resolve(Response.json({message: 'Rulesets unavailable'}, {status: 403}))
  : fetch(url, options);
`,
  );
  const env = {
    NODE_OPTIONS: `--import=${join(f.directory, "preload.mjs")} --import=${injection}`,
  };
  const paused = await f.run("setup.mjs", args, { env });
  assert.notEqual(paused.status, 0);
  assert.match(paused.output, /Ruleset configuration is pending/);
  assert.equal(await f.read("workflow.config.json"), original);
  assert.equal(f.git(["show", ":workflow.config.json"]), indexed);
  assert.equal((await f.state()).pullRequests?.length || 0, 0);
  const resumed = await f.run("setup.mjs", [...args, "--acknowledge-unenforced-rules"], { env });
  assert.equal(resumed.status, 0);
  const committed = JSON.parse(f.git(["show", "HEAD:workflow.config.json"]));
  assert.deepEqual(committed.projectSpecific, JSON.parse(original).projectSpecific);
  assert.equal((await f.state()).createdProjects, 0);
});

test("setup rejects unrelated staged unstaged and untracked paths before provisioning", async (t) => {
  for (const kind of ["staged", "unstaged", "untracked"]) {
    const f = await fixture(t);
    await editConfig(f);
    const path = kind === "untracked" ? "unrelated notes\nwith newline.txt" : "preload.mjs";
    await writeFile(join(f.directory, path), "Unrelated user work\n");
    if (kind === "staged") f.git(["add", path]);
    const before = f.git(["status", "--porcelain"]);
    const original = await f.read("workflow.config.json");
    const result = await f.run("setup.mjs", args);
    assert.notEqual(result.status, 0);
    assert.equal(f.git(["status", "--porcelain"]), before);
    assert.equal(await f.read("workflow.config.json"), original);
    assertNoSetupMutation(await f.state());
  }
});

test("setup rejects deleted renamed symlinked or untracked config before provisioning", async (t) => {
  for (const kind of ["deleted", "renamed", "symlinked", "staged-symlink", "untracked"]) {
    const f = await fixture(t);
    const path = join(f.directory, "workflow.config.json");
    if (kind === "deleted") await rm(path);
    if (kind === "renamed") await rename(path, join(f.directory, "renamed-config.json"));
    if (kind === "symlinked" || kind === "staged-symlink") {
      const target = join(f.directory, ".git/external-config.json");
      await writeFile(target, await f.read("workflow.config.json"));
      await rm(path);
      await symlink(target, path);
      if (kind === "staged-symlink") f.git(["add", "workflow.config.json"]);
    }
    if (kind === "untracked") f.git(["rm", "--cached", "workflow.config.json"]);
    const before = f.git(["status", "--porcelain"]);
    const result = await f.run("setup.mjs", args);
    assert.notEqual(result.status, 0);
    assert.equal(f.git(["status", "--porcelain"]), before);
    assertNoSetupMutation(await f.state());
  }
});
