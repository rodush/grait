import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adoptionArguments,
  adoptionGuide,
  applicationFiles,
  applicationStacks,
  assertAdoptionExamples,
  assertApplicationWorks,
  gitPinnedDistribution,
} from "./helpers/cli-adoption-fixture.mjs";
import { setupFixture } from "./helpers/setup-fixture.mjs";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const revision = "a1".repeat(20);
const otherRevision = "b2".repeat(20);
const unknownRevision = "c3".repeat(20);
const target = "acme/service";
const sourceRepository = "rodush/grait";
const recordPath = ".grait/installation.json";
const initAt = (pin) => [
  "init",
  "--repo",
  target,
  "--revision",
  pin,
  "--harness",
  "codex",
  "--maintainers",
  "operator",
  "--no-browser",
];
const init = initAt(revision);
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
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const stateFile = process.env.GRAIT_SETUP_FIXTURE_STATE;
const stateAtStart = JSON.parse(readFileSync(stateFile, "utf8"));
if (stateAtStart.interruptAtRecord) {
  const originalRename = fs.rename;
  fs.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (destination === join(stateAtStart.targetRoot, ".grait/installation.json"))
      process.kill(process.pid, "SIGKILL");
  };
  syncBuiltinESMExports();
}
if (process.env.GRAIT_FIXTURE_TERMINAL === "1") {
  process.stdin.isTTY = true;
  process.stdout.isTTY = true;
}
const request = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  const path = parsed.pathname.slice(1);
  const prefix = "repos/acme/service/";
  const artifactPrefix = "repos/rodush/grait/";
  const method = options.method || "GET";
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  const raw = parsed.hostname === "raw.githubusercontent.com" && path.startsWith("rodush/grait/");
  if (raw || (parsed.hostname === "api.github.com" && path.startsWith(artifactPrefix))) {
    const endpoint = path.slice(raw ? "rodush/grait/".length : artifactPrefix.length);
    const commitRef = endpoint.startsWith("commits/") ? endpoint.slice("commits/".length) : null;
    const isContents = endpoint === "contents/dist/cli.mjs";
    const rawRef = raw && endpoint.endsWith("/dist/cli.mjs") ? endpoint.split("/")[0] : null;
    const ref = commitRef ?? (isContents ? parsed.searchParams.get("ref") : rawRef);
    const sha = ref && state.sourceCommits.find((candidate) => candidate.startsWith(ref));
    state.calls.push({ path, method, query: parsed.search });
    writeFileSync(stateFile, JSON.stringify(state));
    if (method !== "GET" || !sha) return Response.json({ message: "Not Found" }, { status: 404 });
    if (commitRef) return Response.json({ sha });
    let executable = readFileSync(state.runningCLI);
    if (sha !== state.installedRevision)
      executable = Buffer.concat([executable, Buffer.from("\\n// Bundle at the other commit\\n")]);
    if (raw || options.headers?.Accept?.includes("raw"))
      return new Response(executable);
    return Response.json({ encoding: "base64", content: executable.toString("base64") });
  }
  if (parsed.hostname === "api.github.com" && path === "graphql" && method === "POST") {
    const { query, variables } = JSON.parse(options.body);
    if (query.includes("pullRequest(")) {
      const { configurationPR: pull } = state;
      const found =
        variables.owner === "acme" && variables.name === "service" &&
        variables.number === pull?.number;
      return Response.json({
        data: {
          repository: {
            pullRequest: found ? {
              merged: pull.merged,
              mergeCommit: { oid: pull.merge_commit_sha },
              mergedBy: { __typename: pull.merged_by.type },
              baseRefName: pull.base.ref,
              baseRepository: { nameWithOwner: pull.base.repo.full_name },
            } : null,
          },
        },
      });
    }
  }
  if (parsed.hostname !== "api.github.com" || !path.startsWith(prefix))
    return request(url, options);
  const endpoint = path.slice(prefix.length);
  if (method === "PATCH" && endpoint === "actions/variables/AUTOMATION_ENABLED" &&
      state.interruptAtEnablement && JSON.parse(options.body).value === "true") {
    await request(url, options);
    process.kill(process.pid, "SIGKILL");
  }
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
  } else if (method === "GET" && endpoint === "commits") {
    const ref = parsed.searchParams.get("sha");
    const name = parsed.searchParams.get("path");
    const sha = ref === state.defaultHead && name === ".grait/installation.json"
      ? state.installationCommit
      : null;
    value = sha ? [{ sha }] : [];
  } else if (method === "GET" && /^commits\\/[^/]+\\/pulls$/.test(endpoint)) {
    const sha = endpoint.split("/")[1];
    value = state.configurationPR && (state.associatedCommit ?? state.configurationPR.merge_commit_sha) === sha
      ? [state.configurationPR] : [];
    if (state.omitRestMergeCommit) value = value.map(({ number }) => ({ number }));
  } else if (method === "GET" && endpoint === "pulls") {
    value = state.configurationPR ? [state.configurationPR] : [];
    value = value.filter((pull) => !parsed.searchParams.get("state") ||
      parsed.searchParams.get("state") === "all" || parsed.searchParams.get("state") === pull.state);
  } else if (method === "GET" && endpoint === "pulls/99" && state.configurationPR) {
    value = { ...state.configurationPR };
    if (state.omitRestMergeCommit) delete value.merge_commit_sha;
  } else if (method === "GET" && endpoint === "pulls/99/files" && state.configurationPR) {
    value = state.configurationFiles;
  } else if (method === "GET" && endpoint === "commits/main") {
    value = { sha: state.defaultHead, parents: [{ sha: state.previousDefaultHead }] };
  } else if (method === "GET" && /^actions\\/workflows\\/[^/]+\\/runs$/.test(endpoint)) {
    value = { workflow_runs: [{ head_sha: state.defaultHead, conclusion: state.ciConclusion }] };
  } else if (method === "GET" && endpoint.startsWith("contents/")) {
    const name = decodeURIComponent(endpoint.slice("contents/".length));
    const ref = parsed.searchParams.get("ref") || "main";
    const sha = ref === "main" ? state.defaultHead : ref;
    const content = state.committedFiles[sha]?.[name];
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

async function copyInstallerDistribution(t) {
  const packageDirectory = await mkdtemp(join(tmpdir(), "grait-installer-package-"));
  t.after(() => rm(packageDirectory, { recursive: true, force: true }));
  const installedPackage = join(packageDirectory, "node_modules", "grait");
  await mkdir(join(installedPackage, "dist"), { recursive: true });
  const cli = join(installedPackage, "dist", "cli.mjs");
  await copyFile(join(sourceRoot, "dist/cli.mjs"), cli);
  await copyFile(join(sourceRoot, "package.json"), join(installedPackage, "package.json"));
  const manifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8"));
  const resolved = "git+https://github.com/" + sourceRepository + ".git#" + revision;
  const packages = {
    "node_modules/grait": { version: manifest.version, resolved, bin: manifest.bin },
  };
  await writeFile(
    join(packageDirectory, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages: { "": {}, ...packages } }),
  );
  await writeFile(
    join(packageDirectory, "node_modules", ".package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );

  return cli;
}

async function installerFixture(t, overrides = {}, distribution) {
  const {
    initial: installedPin = revision,
    next: nextPin = otherRevision,
    stack,
  } = distribution ?? {};
  const cli = distribution
    ? await distribution.install(installedPin)
    : await copyInstallerDistribution(t);
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
    "src",
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
  const projectFiles = stack ? { ...application, ...applicationFiles(stack) } : application;
  for (const [path, content] of Object.entries(projectFiles))
    await writeFile(join(f.directory, path), content);
  f.git(["add", "--all"]);
  f.git(["commit", "--quiet", "-m", "test: retain only adopting application artifacts"]);
  f.git(["remote", "add", "origin", "https://github.com/acme/service.git"]);
  f.git(["switch", "-c", "configuration"]);
  const initialHead = f.git(["rev-parse", "HEAD"]);
  const remoteFixture = join(f.directory, ".git/installer-remote.mjs");
  await writeFile(remoteFixture, remoteService);
  const cliEnv = {
    NODE_OPTIONS: `--import=${join(f.directory, "preload.mjs")} --import=${remoteFixture}`,
  };
  const entry = (executable) => relative(join(f.directory, "scripts"), executable);
  const cliArgs = (args) => ["--cwd", join(f.directory, "app"), ...args];
  const run = (args, executable = cli, env) =>
    f.run(entry(executable), cliArgs(args), { env: { ...cliEnv, ...env } });
  const spawnInstalled = (args, env) => f.spawn(entry(cli), cliArgs(args), { ...cliEnv, ...env });
  const syncDefault = async (ciConclusion) => {
    const defaultHead = f.git(["rev-parse", "HEAD"]);
    const paths = f.git(["ls-tree", "-r", "--name-only", defaultHead]).split("\n");
    const files = Object.fromEntries(
      paths.map((file) => [
        file,
        execFileSync("git", ["show", defaultHead + ":" + file], {
          cwd: f.directory,
          encoding: "utf8",
        }),
      ]),
    );
    const installationCommit = f.git(["log", "-1", "--format=%H", defaultHead, "--", recordPath]);
    const { committedFiles } = await f.state();
    await f.update({
      defaultHead,
      committedFiles: { ...committedFiles, [defaultHead]: files },
      installationCommit,
      ciConclusion,
    });
  };
  await f.update({
    runningCLI: cli,
    sourceCommits: [installedPin, nextPin],
    installedRevision: installedPin,
    targetRoot: f.directory,
    previousDefaultHead: initialHead,
  });
  await syncDefault("success");
  const commitConfiguration = async (mode) => {
    if (mode === "direct") f.git(["switch", "main"]);
    f.git(mode === "record-only" ? ["add", "--", recordPath] : ["add", "--all"]);
    f.git(["commit", "--quiet", "-m", "test: configuration"]);
    if (mode !== "direct") {
      const proposal = f.git(["rev-parse", "HEAD"]);
      f.git(["switch", "main"]);
      f.git(["merge", "--squash", "configuration"]);
      f.git(["commit", "--quiet", "-m", "test: operator merges GRAIT configuration (#99)"]);
      const mergeCommit = f.git(["rev-parse", "HEAD"]);
      const actor = { login: "operator", id: 42, type: "User" };
      const configurationFiles = f
        .git(["diff", "--name-status", initialHead, mergeCommit])
        .split("\n")
        .map((line) => {
          const [type, filename] = line.split("\t");
          return { filename, status: type === "A" ? "added" : "modified" };
        });
      await f.update({
        configurationPR: {
          number: 99,
          state: "closed",
          merged: true,
          merged_at: "2026-11-20T10:00:00Z",
          merged_by: actor,
          user: actor,
          body: "Install GRAIT for this repository.",
          merge_commit_sha: mergeCommit,
          base: { ref: "main", sha: initialHead, repo: { full_name: target } },
          head: { ref: "configuration", sha: proposal, repo: { full_name: target } },
        },
        configurationFiles,
      });
    }
    await syncDefault(mode === "direct" ? "success" : "failure");
  };
  const commitFollowup = async (message) => {
    f.git(["add", "--all"]);
    f.git(["commit", "--quiet", "-m", message]);
    await syncDefault("success");
  };
  return {
    ...f,
    run,
    cli,
    spawnInstalled,
    initialHead,
    mergeConfiguration: () => commitConfiguration("merged"),
    mergeRecordOnly: () => commitConfiguration("record-only"),
    commitDirectly: () => commitConfiguration("direct"),
    commitFollowup,
  };
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
  assert.ok(
    (await f.state()).calls.every(
      ({ path, method }) =>
        method === "GET" &&
        (path.startsWith("repos/rodush/grait/") || path.startsWith("rodush/grait/")),
    ),
  );
});

test("installed init leaves the application test layout and runner unconfigured", async (t) => {
  const f = await installerFixture(t);
  const result = await f.run([...init, "--yes"]);
  assert.equal(result.status, 0, "An application can install before choosing its test layout");
  const configuration = JSON.parse(await f.read("workflow.config.json"));
  assert.deepEqual(
    configuration.tdd?.testPatterns ?? configuration.tdd?.testPaths ?? [],
    [],
    "Do not adopt an application test path or filename convention by default",
  );
  assert.ok(!configuration.allowedWritePaths?.includes("tests/**"));
  assert.ok(!configuration.tdd?.implementationPaths?.includes("src/**"));
  assert.ok(!configuration.tdd?.runner?.command?.length);
  assert.ok(!configuration.tdd?.runner?.install?.length);
  assert.ok(configuration.protectedPaths.includes("workflow.config.json"));
});

test("installed init preserves separate and colocated application test configurations", async (t) => {
  const layouts = [
    {
      allowedWritePaths: ["services/**", "quality/specifications/**"],
      implementationPaths: ["services/**"],
      testPaths: ["quality/specifications/**"],
      command: ["make", "verification-report"],
    },
    {
      allowedWritePaths: ["services/**"],
      implementationPaths: ["services/**"],
      testPatterns: ["services/**/specification/*.check"],
      command: ["sh", "services/tooling/report.sh", "--local"],
    },
  ];
  for (const { allowedWritePaths, command, ...layout } of layouts) {
    const f = await installerFixture(t);
    const tdd = {
      ...layout,
      profiles: { tester: { model: null }, implementer: { model: null } },
      runner: { install: [], command },
    };
    await writeFile(
      join(f.directory, "workflow.config.json"),
      JSON.stringify({ allowedWritePaths, tdd }),
    );

    const result = await f.run([...init, "--yes"]);

    assert.equal(result.status, 0, "Install with the application owner's explicit configuration");
    const applied = JSON.parse(await f.read("workflow.config.json"));
    assert.deepEqual(applied.allowedWritePaths, allowedWritePaths);
    assert.deepEqual(applied.tdd, tdd);
    assert.ok(applied.protectedPaths.includes("workflow.config.json"));
  }
});

test("installed init requires explicit confirmation before provisioning in a noninteractive session", async (t) => {
  const f = await installerFixture(t, { localApps: undefined });
  const result = await f.run(init);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /confirm|--yes|authoriz/i);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal(existsSync(join(f.directory, ".git/grait-setup")), false);
  assert.ok(
    (await f.state()).calls.every(
      ({ path, method }) =>
        method === "GET" &&
        (path.startsWith("repos/rodush/grait/") || path.startsWith("rodush/grait/")),
    ),
  );
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

  await writeFile(join(f.directory, "app", "notes.md"), "Unrelated application change.\n");
  await f.commitFollowup("test: unrelated application change");
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

test("installed init recovers a process interruption after publishing the installation record", async (t) => {
  const f = await installerFixture(t, { interruptAtRecord: true });
  const interrupted = await f.run([...init, "--yes"]);
  assert.notEqual(interrupted.status, 0, "The interrupted process must exit unsuccessfully");
  const partialRecord = await f.read(recordPath);
  assert.equal(JSON.parse(partialRecord).revision, revision);
  assert.equal(await f.read("AGENTS.md"), application["AGENTS.md"]);
  assert.equal(existsSync(join(f.directory, "workflow.config.json")), false);
  assert.equal((await f.state()).createdProjects, 1);

  // Simulate the documented operator cleanup after confirming the process exited.
  await rm(join(f.directory, ".git", "grait-setup", "lock"), { force: true });
  await f.update({ interruptAtRecord: false });
  const beforePreview = f.git(["status", "--porcelain"]);
  const privateState = await f.localState();
  await f.run([...init, "--plan"]);
  assert.deepEqual(await f.localState(), privateState);
  assert.equal(
    await f.read(recordPath),
    partialRecord,
    "Preview must leave recovery to confirmed init",
  );
  assert.equal(f.git(["status", "--porcelain"]), beforePreview);
  assert.equal(existsSync(join(f.directory, "workflow.config.json")), false);

  const resumed = await f.run([...init, "--yes"]);
  assert.equal(
    resumed.status,
    0,
    "Confirmed init recovers before reading incomplete installed artifacts",
  );
  assert.match(await f.read("AGENTS.md"), /grait:policy:start/);
  assert.equal((await f.run(["validate"])).status, 0);
  assert.equal((await f.state()).createdProjects, 1);
  await assertInactive(f);
});

test("installed activation rejects a direct default-branch commit despite matching artifacts and green CI", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  await f.commitDirectly();
  const activation = await f.run(["activate"]);
  assert.notEqual(activation.status, 0, "Require a merged configuration PR before enabling");
  assert.match(activation.output, /merge|pull request/i);
  await assertInactive(f);
});

test("installed activation accepts an exact human merge when REST omits the merge commit", async (t) => {
  const f = await installerFixture(t, { omitRestMergeCommit: true });
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  await f.mergeConfiguration();
  await f.update({ ciConclusion: "success" });

  const activation = await f.run(["activate"]);
  assert.equal(
    activation.status,
    0,
    "An exact human merge permits activation without the REST field",
  );
  assert.equal((await f.localState()).enabled, true);
  assert.equal(
    (await f.state()).variables.find(({ name }) => name === "AUTOMATION_ENABLED").value,
    "true",
  );
});

test("installed activation rejects an associated PR merged at a different commit", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  await f.mergeConfiguration();
  const { configurationPR, installationCommit } = await f.state();
  await f.update({
    ciConclusion: "success",
    associatedCommit: installationCommit,
    configurationPR: { ...configurationPR, merge_commit_sha: f.initialHead },
  });

  const activation = await f.run(["activate"]);
  assert.notEqual(
    activation.status,
    0,
    "PR association cannot replace an exact merge commit match",
  );
  assert.match(activation.output, /merge|pull request/i);
  await assertInactive(f);
});

test("installed activation rejects a configuration PR merged by a bot", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  await f.mergeConfiguration();
  const { configurationPR } = await f.state();
  await f.update({
    ciConclusion: "success",
    configurationPR: {
      ...configurationPR,
      merged_by: { login: "grait-writer[bot]", id: 101, type: "Bot" },
    },
  });
  const activation = await f.run(["activate"]);
  assert.notEqual(activation.status, 0, "A bot merge cannot establish human authorization");
  await assertInactive(f);
});

test("installed init rejects an unavailable Git pin before provisioning or changing application files", async (t) => {
  const f = await installerFixture(t);
  const rejected = await f.run([...initAt(unknownRevision), "--yes"]);
  assert.notEqual(rejected.status, 0, "The requested commit is unavailable for verification");
  assert.match(rejected.output, /revision|commit|pin/i);
  assert.equal((await f.state()).createdProjects, 0);
  assert.equal(f.git(["status", "--porcelain"]), "");
  await assertInactive(f);
});

test("installed init accepts a twelve-character revision and persists the full verified Git pin", async (t) => {
  const f = await installerFixture(t);
  const installed = await f.run([...initAt(revision.slice(0, 12)), "--yes"]);
  assert.equal(installed.status, 0, "Accept an unambiguous twelve-character commit prefix");
  const record = JSON.parse(await f.read(recordPath));
  assert.equal(record.revision, revision);
  const workflows = await readdir(join(f.directory, ".github", "workflows"));
  const contents = await Promise.all(
    workflows.map((path) => f.read(join(".github/workflows", path))),
  );
  assert.ok(contents.some((text) => text.includes(".git#" + revision)));
});

test("installed activation rejects a record-only merge followed by direct configuration commits", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  await f.mergeRecordOnly();
  assert.throws(() => f.git(["cat-file", "-e", "HEAD:workflow.config.json"]));
  await f.commitFollowup("test: commit the remaining configuration directly");
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal((await f.run(["validate"])).status, 0);

  const activation = await f.run(["activate"]);
  assert.notEqual(activation.status, 0, "The merged PR must establish the installed configuration");
  assert.match(activation.output, /merge|pull request/i);
  await assertInactive(f);
});

test("operators can follow the tested Git-pinned CLI adoption examples", async () => {
  assertAdoptionExamples(await adoptionGuide());
});

for (const [stackName, stack] of Object.entries(applicationStacks)) {
  test(`Git-pinned CLI installs, operates, and upgrades the ${stackName}`, async (t) => {
    const distribution = await gitPinnedDistribution(t);
    const f = await installerFixture(t, {}, { ...distribution, stack });
    const guide = await adoptionGuide();
    const values = {
      "OWNER/REPOSITORY": target,
      MAINTAINER: "operator",
      GIT_PIN: distribution.initial,
      UPGRADE_PIN: distribution.next,
    };
    const run = (operation, executable) =>
      f.run(adoptionArguments(guide, operation, values), executable);
    const assertSuccess = (result) => assert.equal(result.status, 0, result.output);
    await assertApplicationWorks(f.directory, stack, distribution.env);

    assertSuccess(await run("init preview"));
    assert.equal(f.git(["status", "--porcelain"]), "");
    assert.equal(existsSync(join(f.directory, recordPath)), false);
    assertSuccess(await run("init apply"));
    assert.equal(JSON.parse(await f.read(recordPath)).revision, distribution.initial);
    await f.mergeConfiguration();
    await f.update({
      ciConclusion: "success",
      projectItems: [
        {
          id: "adoption-issue",
          isArchived: false,
          fieldValueByName: { name: "Ready" },
          content: {
            __typename: "Issue",
            number: 24,
            title: "Try the adopted workflow",
            repository: { nameWithOwner: target },
          },
        },
      ],
    });
    assertSuccess(await run("activate"));
    const status = await run("status");
    assertSuccess(status);
    assert.equal(JSON.parse(status.output.trim())[0].status, "Ready");

    const nextExecutable = await distribution.install(distribution.next);
    assertSuccess(await run("upgrade preview", nextExecutable));
    assert.equal(f.git(["status", "--porcelain"]), "");
    assertSuccess(await run("upgrade apply", nextExecutable));
    assert.equal(JSON.parse(await f.read(recordPath)).revision, distribution.next);
    assertSuccess(await f.run(["validate"], nextExecutable));
    assert.match(await f.read(".github/workflows/grait.yml"), new RegExp(distribution.next));

    await assertApplicationWorks(f.directory, stack, distribution.env);
    for (const path of ["scripts", "automation", "config", "node_modules", ".npmrc"])
      assert.equal(existsSync(join(f.directory, path)), false, path);
    if (!stack.files["package.json"])
      for (const path of ["package.json", "package-lock.json"])
        assert.equal(existsSync(join(f.directory, path)), false, path);
  });
}

const lockPath = ".git/grait-setup/lock";

test("installed init infers the target and verifies the npm-pinned revision without flags", async (t) => {
  const f = await installerFixture(t);
  const preview = await f.run(["init", "--plan"]);
  assert.equal(preview.status, 0, "Use the only GitHub remote and the verified installed revision");
  assert.match(preview.output, /acme\/service/i);
  assert.match(preview.output, /codex/i);
  assert.ok(preview.output.includes(revision));
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal((await f.state()).createdProjects, 0);

  const applied = await f.run(["init", "--yes", "--no-browser"]);
  assert.equal(
    applied.status,
    0,
    "The inferred setup can be applied without revision or repo flags",
  );
  const record = JSON.parse(await f.read(recordPath));
  assert.equal(record.repository, target);
  assert.equal(record.revision, revision);
  assert.match(await f.read(".github/workflows/grait.yml"), new RegExp(revision));
  const nextSteps = applied.output
    .split("\n")
    .filter((line) => !line.startsWith("+"))
    .join("\n");
  assert.match(nextSteps, /commit[\s\S]*push/i);
  assert.match(
    nextSteps,
    /(?:pull request|configuration PR|gh pr create)[\s\S]*human[\s\S]*merge/i,
  );
  assert.match(nextSteps, /validation[\s\S]*grait activate/i);
});

test("installed init accepts an exact version tag and persists its immutable commit", async (t) => {
  const distribution = await gitPinnedDistribution(t);
  distribution.tag("v1.2.3", distribution.next);
  const f = await installerFixture(t, {}, distribution);
  const hostCommand = (name) =>
    process.env.PATH.split(delimiter)
      .map((dir) => join(dir, name))
      .find(existsSync);
  await rm(join(f.directory, "bin/npm"));
  await symlink(hostCommand("npm"), join(f.directory, "bin/npm"));
  const child = f.spawnInstalled([...initAt("v1.2.3"), "--yes"], {
    ...distribution.npmEnvironment,
    PATH: join(f.directory, "bin") + delimiter + process.env.PATH,
    npm_config_git: hostCommand("git"),
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => (output += chunk));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 45_000);
  t.after(() => clearTimeout(timer));
  const [status] = await once(child, "close");
  clearTimeout(timer);
  assert.equal(
    status,
    0,
    "The selected version tag resolves and applies even from another pinned CLI",
  );
  assert.ok(output.includes(distribution.next));
  assert.equal(JSON.parse(await f.read(recordPath)).revision, distribution.next);
  assert.ok((await f.read(".github/workflows/grait.yml")).includes(distribution.next));

  distribution.tag("v1.2.3", distribution.initial);
  const exactPackage = await distribution.install(distribution.next);
  const plan = await f.run(["init", "--plan"], exactPackage);
  assert.equal(plan.status, 0, "A moved tag does not reinterpret the existing installation");
  assert.equal(JSON.parse(await f.read(recordPath)).revision, distribution.next);
});

test("installed init offers a recovery command before showing a plan with missing provenance", async (t) => {
  const f = await installerFixture(t);
  const modules = dirname(dirname(dirname(f.cli)));
  await rm(join(modules, ".package-lock.json"));
  await rm(join(dirname(modules), "package-lock.json"));
  await f.update({ sourceCommits: [] });
  const result = await f.run(init, undefined, { NO_COLOR: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /(?:^|\n)ERROR\b/);
  assert.match(result.output, /provenance|cannot verify|revision.+unavailable/i);
  assert.match(result.output, /(?:npm (?:exec|install)|npx)\s+[^\n]+/i);
  assert.doesNotMatch(result.output, /Apply this plan|^\+\+\+/m);
  assert.doesNotMatch(result.output, /\u001b\[/);
  assert.equal((await f.state()).createdProjects, 0);
});

test("installed init reports ambiguous remotes and accepts an explicit target override", async (t) => {
  const f = await installerFixture(t, { localApps: undefined });
  f.git(["remote", "set-url", "origin", "git@github.com:operator/service.git"]);
  f.git(["remote", "add", "upstream", "https://github.com/acme/service.git"]);
  const result = await f.run(["init", "--plan", "--revision", revision]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /operator\/service/i);
  assert.match(result.output, /acme\/service/i);
  assert.match(result.output, /--repo/);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal((await f.run([...init, "--plan"])).status, 0, "Respect an unambiguous override");
});

test("installed init blocks default-branch apply before plan confirmation", async (t) => {
  const f = await installerFixture(t);
  f.git(["switch", "main"]);
  const result = await f.run(init, undefined, { GRAIT_FIXTURE_TERMINAL: "1", NO_COLOR: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /(?:^|\n)ERROR\b/);
  assert.match(result.output, /default branch.*main|main.*default branch/i);
  assert.match(result.output, /git (?:switch -c|checkout -b)/);
  assert.doesNotMatch(result.output, /Apply this plan|use --yes to authorize/i);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal((await f.state()).createdProjects, 0);
});

test("installed init resumes interrupted setup with its saved harness and verified bindings", async (t) => {
  const f = await installerFixture(t, { failProjectDetails: true });
  const attempt = [
    ...init.map((argument) => (argument === "codex" ? "claude" : argument)),
    "--yes",
  ];
  const interrupted = await f.run(attempt);
  assert.notEqual(interrupted.status, 0);
  assert.equal((await f.state()).createdProjects, 1);
  await f.update({ failProjectDetails: false });
  const retry = await f.run(["init", "--yes", "--no-browser"]);
  assert.equal(retry.status, 0, "Retry uses the already supplied setup inputs");
  assert.equal(JSON.parse(await f.read(recordPath)).harness, "claude");
  assert.equal((await f.state()).createdProjects, 1);
  assert.equal((await f.localState()).apps.writer.id, localApps.writer.id);
});

test("installed init describes partial publishing bindings before any confirmation", async (t) => {
  const f = await installerFixture(t, { localApps: undefined });
  await f.update({
    variables: [
      { name: "AUTOMATION_ENABLED", value: "false" },
      { name: "AUTOMATION_APP_ID", value: "123" },
    ],
  });
  const result = await f.run(init, undefined, { GRAIT_FIXTURE_TERMINAL: "1", NO_COLOR: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /(?:^|\n)ERROR\b/);
  assert.match(result.output, /acme\/service/);
  assert.match(result.output, /AUTOMATION_APP_ID/);
  assert.match(result.output, /REVIEW_APP_ID/);
  assert.match(result.output, /reconcile|verify|existing|stale/i);
  assert.doesNotMatch(
    result.output,
    /Apply this plan|Confirm the proposed|PRIVATE KEY|synthetic-setup-token/i,
  );
  assert.equal((await f.state()).createdProjects, 0);
});

for (const [role, otherRole] of [
  ["writer", "reviewer"],
  ["reviewer", "writer"],
]) {
  test(`installed init requires the bound ${role} App key before confirmation`, async (t) => {
    const { pem, ...app } = localApps[role];
    const f = await installerFixture(t, {
      localApps: {
        [otherRole]: { ...localApps[otherRole], botUserId: otherRole === "writer" ? 10001 : 20001 },
        ...(role === "reviewer" ? { reviewer: { ...app, botUserId: 20001 } } : {}),
      },
      variables: [
        { name: "AUTOMATION_ENABLED", value: "false" },
        { name: "AUTOMATION_APP_ID", value: "100" },
        { name: "AUTOMATION_BOT_USER_ID", value: "10001" },
        { name: "REVIEW_APP_ID", value: "200" },
        { name: "REVIEW_BOT_USER_ID", value: "20001" },
      ],
    });
    const terminal = { GRAIT_FIXTURE_TERMINAL: "1", NO_COLOR: "1" };
    const before = await f.localState();
    const blocked = await f.run(init, undefined, terminal);
    assert.notEqual(blocked.status, 0);
    assert.equal(/Apply this plan|Confirm the proposed/i.test(blocked.output), false);
    assert.match(blocked.output, new RegExp(`--${role}-key\\b`));
    assert.doesNotMatch(blocked.output, /PRIVATE KEY|synthetic-setup-token/i);

    const keyPath = join(f.directory, ".git", `${role}.pem`);
    await writeFile(keyPath, pem, { mode: 0o600 });
    const retry = await f.run([...init, `--${role}-key`, keyPath], undefined, terminal);
    assert.match(retry.output, /Apply this plan/i);
    assert.equal(f.git(["status", "--porcelain"]), "");
    assert.ok((await f.state()).calls.every(({ method }) => method === "GET"));
    assert.deepEqual(await f.localState(), before);
  });
}

test("installed init renders a plain warning for recoverable ruleset setup", async (t) => {
  const f = await installerFixture(t, { rulesUnavailable: true });
  const result = await f.run([...init, "--yes"], undefined, { NO_COLOR: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.output, /(?:^|\n)WARNING\b/);
  assert.match(result.output, /https:\/\/github\.com\/acme\/service\/settings\/rules/);
  assert.doesNotMatch(result.output, /\u001b\[/);
  await assertInactive(f);
});

async function interruptRulesetPrompt(t, f) {
  const child = f.spawnInstalled(["activate"], {
    GRAIT_FIXTURE_TERMINAL: "1",
    NO_COLOR: "1",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  t.after(() => clearTimeout(timer));
  let output = "";
  let interrupted = false;
  child.stderr.on("data", (chunk) => (output += chunk));
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!interrupted && /type ['’]?completed|choose.+['’]completed/i.test(output)) {
      interrupted = true;
      child.kill("SIGINT");
    }
  });
  const [status, signal] = await once(child, "close");
  clearTimeout(timer);
  assert.ok(interrupted, "Reach the ruleset decision before interrupting activation");
  return { output, status, signal };
}

test("installed activation reports Ctrl+C at the ruleset prompt and releases its own lock", async (t) => {
  const f = await installerFixture(t, { rulesUnavailable: true });
  assert.equal((await f.run([...init, "--yes", "--acknowledge-unenforced-rules"])).status, 0);
  await f.mergeConfiguration();
  await f.update({ ciConclusion: "success" });
  const interrupted = await interruptRulesetPrompt(t, f);
  assert.notEqual(interrupted.status, 0);
  assert.match(interrupted.output, /'completed'[\s\S]*'continue'[\s\S]*'pause'/i);
  assert.match(interrupted.output, /interrupt[^\n]*ruleset|ruleset[^\n]*interrupt/i);
  assert.match(interrupted.output, /grait activate/i);
  assert.equal(existsSync(join(f.directory, lockPath)), false);
  await assertInactive(f);
  const resumed = await f.run(["activate", "--acknowledge-unenforced-rules"]);
  assert.equal(resumed.status, 0);
  assert.equal((await f.state()).createdProjects, 1);
});

test("installed activation recovers a stale lock and a remote enablement interrupted before local persistence", async (t) => {
  const f = await installerFixture(t, { rulesUnavailable: true });
  assert.equal((await f.run([...init, "--yes", "--acknowledge-unenforced-rules"])).status, 0);
  await f.mergeConfiguration();
  await f.update({ ciConclusion: "success", interruptAtEnablement: true });
  const interrupted = await f.run(["activate", "--acknowledge-unenforced-rules"]);
  assert.notEqual(interrupted.status, 0);
  assert.equal((await f.localState()).enabled, false);
  assert.equal(
    (await f.state()).variables.find(({ name }) => name === "AUTOMATION_ENABLED").value,
    "true",
  );

  await f.update({ interruptAtEnablement: false });
  const retry = await f.run(["activate"]);
  assert.equal(
    retry.status,
    0,
    "Reconcile an already recorded remote decision without asking again",
  );
  assert.equal((await f.localState()).enabled, true);
  assert.equal(existsSync(join(f.directory, lockPath)), false);
  assert.equal((await f.state()).createdProjects, 1);
});

test("installed activation preserves a live setup lock", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  await f.mergeConfiguration();
  await f.update({ ciConclusion: "success" });
  const owner = String(process.pid);
  await writeFile(join(f.directory, lockPath), owner, { mode: 0o600 });
  const result = await f.run(["activate"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /lock/i);
  assert.equal(await f.read(lockPath), owner);
  await assertInactive(f);
});

test("installed activation identifies a direct push even when a later PR lists the record", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  await f.commitDirectly();
  const directCommit = (await f.state()).installationCommit;
  await writeFile(join(f.directory, "app/notes.md"), "A later PR did not change the record.\n");
  await f.commitFollowup("test: unrelated merge into the default branch");
  const mergeCommit = f.git(["rev-parse", "HEAD"]);
  await f.update({
    associatedCommit: directCommit,
    configurationPR: {
      number: 99,
      state: "closed",
      merged: true,
      merge_commit_sha: mergeCommit,
      merged_by: { login: "operator", id: 42, type: "User" },
      base: { ref: "main", repo: { full_name: target } },
    },
    configurationFiles: [{ filename: recordPath, status: "added" }],
  });
  const result = await f.run(["activate"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /direct (?:push|commit)|committed directly/i);
  assert.ok(result.output.includes(recordPath));
  assert.ok(result.output.includes(directCommit.slice(0, 12)));
  assert.match(result.output, /revert/i);
  assert.match(result.output, /re-?appl(?:y|ication)/i);
  await assertInactive(f);

  // Review and merge the revert first, then generate the reapplication PR from that default head.
  f.git(["switch", "-c", "revert-configuration"]);
  f.git(["revert", "--no-edit", directCommit]);
  f.git(["switch", "main"]);
  f.git(["merge", "--squash", "revert-configuration"]);
  f.git(["commit", "--quiet", "-m", "test: human merges the reviewed revert"]);
  f.git(["branch", "-f", "configuration", "main"]);
  f.git(["switch", "configuration"]);
  f.git(["cherry-pick", "--no-commit", directCommit]);
  await f.mergeConfiguration();
  await f.update({ ciConclusion: "success", associatedCommit: undefined });
  const recovered = await f.run(["activate"]);
  assert.equal(recovered.status, 0, "The reapplication PR establishes the unchanged artifacts");
  assert.equal((await f.localState()).enabled, true);
  assert.equal((await f.state()).createdProjects, 1);
});

test("interactive init separates the plan from a quoted confirmation of proposed maintainer access", async (t) => {
  const f = await installerFixture(t);
  const args = init.map((argument) =>
    argument === "operator" ? "operator,additional-maintainer" : argument,
  );
  const child = f.spawnInstalled(args, { GRAIT_FIXTURE_TERMINAL: "1", NO_COLOR: "1" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  t.after(() => clearTimeout(timer));
  let output = "";
  let answered = false;
  child.stderr.on("data", (chunk) => (output += chunk));
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (!answered && /(?:\[y\/n\]|'(?:y|yes)'[^\r\n]*'(?:n|no)')/i.test(output)) {
      answered = true;
      child.stdin.end("n\n");
    }
  });
  const [status] = await once(child, "close");
  clearTimeout(timer);
  assert.notEqual(status, 0);
  assert.match(output, /@additional-maintainer/i);
  assert.match(output, /\r?\n[\t ]*\r?\n[^\r\n]*(?:apply|confirm|proceed)/i);
  assert.match(output, /'(?:y|yes)'[^\r\n]*'(?:n|no)'/i);
  assert.equal((await f.state()).createdProjects, 0);
  assert.equal(f.git(["status", "--porcelain"]), "");
});

test("installed activation reports a pending configuration PR separately from a direct push", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  f.git(["add", "--all"]);
  f.git(["commit", "--quiet", "-m", "test: propose configuration"]);
  await f.update({
    configurationPR: {
      number: 99,
      html_url: "https://github.com/acme/service/pull/99",
      state: "open",
      merged: false,
      base: { ref: "main", repo: { full_name: target } },
      head: {
        ref: "configuration",
        sha: f.git(["rev-parse", "HEAD"]),
        repo: { full_name: target },
      },
    },
    configurationFiles: [{ filename: recordPath, status: "added" }],
  });
  const result = await f.run(["activate"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /#99|\/pull\/99/);
  assert.match(result.output, /human[^\n]*merg|merg[^\n]*human/i);
  assert.doesNotMatch(result.output, /direct (?:push|commit)|committed directly/i);
  await assertInactive(f);
});

test("installed activation rechecks missing delivery rulesets before reconciling a completed checkpoint", async (t) => {
  const f = await installerFixture(t);
  assert.equal((await f.run([...init, "--yes"])).status, 0);
  await f.mergeConfiguration();
  await f.update({ ciConclusion: "success" });
  assert.equal((await f.run(["activate"])).status, 0);
  const { rules, variables } = await f.state();
  const required = rules.find(
    ({ target, enforcement }) => target === "branch" && enforcement === "active",
  );
  assert.ok(required, "Establish an active delivery branch ruleset before simulating removal");
  assert.equal(variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "true");
  assert.equal(variables.find(({ name }) => name === "RULESET_ENFORCEMENT").value, "active");
  await f.update({ rules: rules.filter(({ id }) => id !== required.id) });

  const retry = await f.run(["activate"]);
  const restored = (await f.state()).rules.some(
    ({ name, enforcement }) => name === required.name && enforcement === "active",
  );
  assert.ok(
    retry.status !== 0 || restored,
    "Never report successful reconciliation with a missing required ruleset",
  );
  if (!restored) {
    assert.match(retry.output, /ruleset/i);
    assert.match(retry.output, /retry|resume|verify|configure/i);
    assert.doesNotMatch(retry.output, /Delivery rules are active/i);
  }
});

test("installed activation pauses automation on ruleset drift under another administrator", async (t) => {
  const operator = { login: "operator", id: 42, type: "User", node_id: "human-node" };
  const secondOperator = { login: "second-operator", id: 43, type: "User", node_id: "second-node" };
  const f = await installerFixture(t, {
    users: { [operator.login]: operator, [secondOperator.login]: secondOperator },
  });
  const args = init.map((argument) =>
    argument === operator.login ? `${operator.login},${secondOperator.login}` : argument,
  );
  assert.equal((await f.run([...args, "--yes"])).status, 0);
  await f.mergeConfiguration();
  await f.update({ ciConclusion: "success" });
  assert.equal((await f.run(["activate"])).status, 0);
  await f.update({ actor: secondOperator });
  assert.equal(
    (await f.run(["activate"])).status,
    0,
    "Both configured administrators can activate",
  );
  assert.equal((await f.localState()).enabled, true);
  const { rules, variables } = await f.state();
  assert.equal(variables.find(({ name }) => name === "AUTOMATION_ENABLED").value, "true");
  assert.equal(variables.find(({ name }) => name === "RULESET_ENFORCEMENT").value, "active");
  const deliveryRule = rules.find(({ target }) => target === "branch");
  assert.equal(deliveryRule?.enforcement, "active");
  await f.update({
    actor: operator,
    rules: rules.filter(({ id }) => id !== deliveryRule.id),
  });

  const retry = await f.run(["activate"]);
  assert.notEqual(retry.status, 0);
  assert.match(retry.output, /ruleset/i);
  await assertInactive(f);
});
