import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setupFixture } from "./helpers/setup-fixture.mjs";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const revision = "a1".repeat(20);
const target = "acme/service";
const recordPath = ".grait/installation.json";
const init = [
  "init",
  "--repo",
  target,
  "--revision",
  revision,
  "--harness",
  "codex",
  "--maintainers",
  "operator",
  "--no-browser",
];
const application = {
  "AGENTS.md": "# Application conventions\n\nRun the documented application tests.\n",
  "app/build.gradle.kts": "// Existing Kotlin application\n",
  ".github/workflows/app.yml": "name: Application\non: [push]\njobs: {}\n",
};
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const localApps = Object.fromEntries(
  ["writer", "reviewer"].map((role, index) => [
    role,
    {
      name: `grait-${role}`,
      slug: `grait-${role}`,
      id: (index + 1) * 100,
      clientId: `Iv1.${role}`,
      pem: privateKey.export({ type: "pkcs8", format: "pem" }),
      phase: "installed",
      installed: true,
    },
  ]),
);

// The API fixture models a remote default-branch snapshot independently from
// changes in the applying checkout, including GitHub's workflow run response.
const remoteService = `
import { readFileSync, writeFileSync } from "node:fs";
const request = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const path = parsed.pathname.slice(1);
  const prefix = "repos/acme/service/";
  if (parsed.hostname !== "api.github.com" || !path.startsWith(prefix))
    return request(url, options);
  const endpoint = path.slice(prefix.length);
  const method = options.method || "GET";
  const stateFile = process.env.GRAIT_SETUP_FIXTURE_STATE;
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  let value;
  let status = 200;
  if (state.rulesUnavailable && /^rulesets(?:\\/|$)/.test(endpoint)) {
    status = 403;
    value = { message: "Upgrade your GitHub plan to use rulesets on this private repository" };
  } else if (method === "POST" && endpoint === "rulesets") {
    state.rules ||= [];
    value = { ...JSON.parse(options.body), id: state.rules.length + 1, source: "acme/service" };
    state.rules.push(value);
  } else if (method === "PUT" && /^rulesets\\/\\d+$/.test(endpoint)) {
    const id = Number(endpoint.split("/").at(-1));
    value = state.rules?.find((rule) => rule.id === id);
    if (value) Object.assign(value, JSON.parse(options.body));
    else {
      status = 404;
      value = { message: "Not Found" };
    }
  } else if (method === "GET" && endpoint === "commits/main") {
    value = { sha: state.defaultHead };
  } else if (method === "GET" && /^actions\\/workflows\\/[^/]+\\/runs$/.test(endpoint)) {
    value = { workflow_runs: [{ head_sha: state.defaultHead, conclusion: state.ciConclusion }] };
  } else if (method === "GET" && endpoint.startsWith("contents/")) {
    const name = decodeURIComponent(endpoint.slice("contents/".length));
    const content = state.defaultFiles[name];
    if (typeof content === "string") {
      value = { content: Buffer.from(content).toString("base64") };
    } else {
      status = 404;
      value = { message: "Not Found" };
    }
  } else return request(url, options);
  state.calls.push({ path, method, query: parsed.search });
  writeFileSync(stateFile, JSON.stringify(state));
  return Response.json(value, { status });
};
`;

async function installerFixture(t, overrides = {}) {
  const packageDirectory = await mkdtemp(join(tmpdir(), "grait-installer-package-"));
  t.after(() => rm(packageDirectory, { recursive: true, force: true }));
  const cli = join(packageDirectory, "cli.mjs");
  await copyFile(join(sourceRoot, "dist/cli.mjs"), cli);

  const f = await setupFixture({
    localApps,
    hidePublishingApps: true,
    projectStatuses: { review: "Review" },
    ...overrides,
  });
  t.after(() => f.close());
  for (const path of [
    "workflow.config.json",
    "scripts",
    "automation",
    "config",
    "node_modules",
    "package.json",
    "package-lock.json",
    ".npmrc",
    ".agents",
    ".claude",
    ".codex",
    ".github/agents",
    ".github/skills",
    ".github/copilot-instructions.md",
  ]) {
    await rm(join(f.directory, path), { recursive: true, force: true });
  }
  await mkdir(join(f.directory, "app"));
  await mkdir(join(f.directory, ".github/workflows"));
  for (const [path, content] of Object.entries(application))
    await writeFile(join(f.directory, path), content);
  f.git(["add", "--all"]);
  f.git(["commit", "--quiet", "-m", "test: retain only adopting application artifacts"]);
  f.git(["remote", "add", "origin", "https://github.com/acme/service.git"]);
  f.git(["switch", "-c", "configuration"]);
  const initialHead = f.git(["rev-parse", "HEAD"]);
  const remoteFixture = join(f.directory, ".git/installer-remote.mjs");
  await writeFile(remoteFixture, remoteService);
  const run = (args) =>
    f.run(
      relative(join(f.directory, "scripts"), cli),
      ["--cwd", join(f.directory, "app"), ...args],
      {
        env: {
          NODE_OPTIONS: `--import=${join(f.directory, "preload.mjs")} --import=${remoteFixture}`,
        },
      },
    );
  const syncDefault = async (ciConclusion) => {
    const defaultHead = f.git(["rev-parse", "HEAD"]);
    const paths = f.git(["ls-tree", "-r", "--name-only", defaultHead]).split("\n");
    const defaultFiles = Object.fromEntries(
      await Promise.all(paths.map(async (path) => [path, await f.read(path)])),
    );
    await f.update({ defaultHead, defaultFiles, ciConclusion });
  };
  await syncDefault("success");
  const mergeConfiguration = async () => {
    f.git(["add", "--all"]);
    f.git(["commit", "--quiet", "-m", "test: proposed GRAIT configuration"]);
    f.git(["switch", "main"]);
    f.git(["merge", "--squash", "configuration"]);
    f.git(["commit", "--quiet", "-m", "test: operator merges GRAIT configuration"]);
    await syncDefault("failure");
  };
  return { ...f, run, initialHead, mergeConfiguration };
}

async function assertInactive(f) {
  assert.equal((await f.localState()).enabled, false);
  assert.equal(
    (await f.state()).variables.find(({ name }) => name === "AUTOMATION_ENABLED")?.value,
    "false",
  );
}

test("installed init previews generated artifacts without changing the repository or provisioning", async (t) => {
  const f = await installerFixture(t, { localApps: undefined });
  const plan = await f.run([...init, "--plan"]);
  assert.equal(plan.status, 0, "The installed CLI must support read-only initialization");
  assert.match(plan.output, /AGENTS\.md/);
  assert.match(plan.output, /workflow\.config\.json/);
  assert.match(plan.output, /\.codex\//);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initialHead);
  assert.equal(existsSync(join(f.directory, ".git/grait-setup")), false);
  assert.equal((await f.state()).calls.length, 0);
});

test("installed init requires explicit confirmation before provisioning in a noninteractive session", async (t) => {
  const f = await installerFixture(t, { localApps: undefined });
  const result = await f.run(init);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /confirm|--yes|authoriz/i);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal(existsSync(join(f.directory, ".git/grait-setup")), false);
  assert.equal((await f.state()).calls.length, 0);
});

test("installed init resumes interrupted provisioning with the known Apps and Project and replays unchanged", async (t) => {
  const f = await installerFixture(t, { failProjectDetails: true });
  const interrupted = await f.run([...init, "--yes"]);
  assert.notEqual(interrupted.status, 0);
  const checkpoint = await f.state();
  assert.equal(checkpoint.createdProjects, 1, "Reach provisioning and record the new Project");
  assert.ok(checkpoint.variables.some(({ name, value }) => name === "PROJECT_ID" && value));
  assert.equal(f.git(["status", "--porcelain"]), "", "Keep target artifacts untouched on failure");
  await assertInactive(f);

  await f.update({ failProjectDetails: false });
  const installed = await f.run([...init, "--yes"]);
  assert.equal(installed.status, 0, "Retry must apply a complete installation");
  const local = await f.localState();
  for (const role of ["writer", "reviewer"]) assert.equal(local.apps[role].id, localApps[role].id);
  const state = await f.state();
  assert.equal(state.createdProjects, 1);
  assert.equal(
    state.calls.some(({ path }) => path.includes("app-manifests")),
    false,
  );
  assert.equal(f.git(["rev-parse", "HEAD"]), f.initialHead);
  for (const [path, contents] of Object.entries(application)) {
    if (path === "AGENTS.md") assert.ok((await f.read(path)).includes(contents.trim()));
    else assert.equal(await f.read(path), contents);
  }
  assert.match(await f.read(".github/CODEOWNERS"), /@application-owner/);
  assert.match(await f.read(".github/CODEOWNERS"), /@operator/);
  assert.ok(existsSync(join(f.directory, ".codex/config.toml")));
  for (const path of ["CLAUDE.md", "scripts", "package.json", "node_modules"])
    assert.equal(existsSync(join(f.directory, path)), false);

  const recordText = await f.read(recordPath);
  const record = JSON.parse(recordText);
  const version = await f.run(["--version"]);
  assert.equal(record.version, version.output.trim());
  assert.equal(record.revision, revision);
  for (const path of ["AGENTS.md", "workflow.config.json", ".codex/config.toml"]) {
    const entry = record.artifacts[path];
    assert.match(typeof entry === "string" ? entry : (entry?.hash ?? ""), /^[a-f0-9]{64}$/);
  }
  assert.doesNotMatch(recordText, /PRIVATE KEY|synthetic-setup-token/);
  const session = await lstat(join(f.directory, ".git/grait-setup/session.json"));
  assert.equal(session.mode & 0o077, 0);
  await assertInactive(f);

  const installedStatus = f.git(["status", "--porcelain"]);
  const repeated = await f.run([...init, "--yes"]);
  assert.equal(repeated.status, 0);
  assert.equal(await f.read(recordPath), recordText);
  assert.equal(f.git(["status", "--porcelain"]), installedStatus);
  assert.equal((await f.state()).createdProjects, 1);
  assert.equal((await f.state()).pullRequests?.length || 0, 0);
});

test("installed activation requires a human-merged configuration and successful current default CI", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0, "Stage the configuration for merge");

  const unmerged = await f.run(["activate"]);
  assert.notEqual(unmerged.status, 0);
  await assertInactive(f);

  await f.mergeConfiguration();
  const failingCI = await f.run(["activate"]);
  assert.notEqual(failingCI.status, 0);
  assert.match(failingCI.output, /\bCI\b|successful|check/i);
  await assertInactive(f);

  await f.update({ ciConclusion: "success" });
  const activated = await f.run(["activate"]);
  assert.equal(activated.status, 0, "Current successful CI permits human activation");
  assert.equal((await f.localState()).enabled, true);
  assert.equal(
    (await f.state()).variables.find(({ name }) => name === "AUTOMATION_ENABLED").value,
    "true",
  );
  assert.equal(f.git(["status", "--porcelain"]), "");
});

test("installed ruleset fallback stays pending on init --yes and requires explicit acknowledgement", async (t) => {
  const f = await installerFixture(t, { rulesUnavailable: true });
  const pending = await f.run([...init, "--yes"]);
  assert.notEqual(pending.status, 0);
  assert.match(pending.output, /https:\/\/github\.com\/acme\/service\/settings\/rules/);
  assert.match(pending.output, /--acknowledge-unenforced-rules/);
  assert.equal(f.git(["status", "--porcelain"]), "");
  await assertInactive(f);

  const acknowledged = await f.run([...init, "--yes", "--acknowledge-unenforced-rules"]);
  assert.equal(acknowledged.status, 0, "Explicit acknowledgement permits provisioning");
  assert.equal((await f.state()).createdProjects, 1);
  await assertInactive(f);
  await f.mergeConfiguration();
  await f.update({ ciConclusion: "success" });

  const waitingActivation = await f.run(["activate"]);
  assert.notEqual(waitingActivation.status, 0);
  assert.match(waitingActivation.output, /--acknowledge-unenforced-rules/);
  await assertInactive(f);
  const active = await f.run(["activate", "--acknowledge-unenforced-rules"]);
  assert.equal(active.status, 0);
  const state = await f.state();
  assert.equal(
    state.variables.find(({ name }) => name === "RULESET_ENFORCEMENT").value,
    "unenforced",
  );
  assert.equal(state.variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "true");
});
