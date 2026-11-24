import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setupFixture } from "./helpers/setup-fixture.mjs";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const revision = "a1".repeat(20);
const otherRevision = "b2".repeat(20);
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
  if (parsed.hostname !== "api.github.com" || !path.startsWith(prefix))
    return request(url, options);
  const endpoint = path.slice(prefix.length);
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
    value = state.configurationPR?.merge_commit_sha === sha ? [state.configurationPR] : [];
  } else if (method === "GET" && endpoint === "pulls" && parsed.searchParams.get("state") === "closed") {
    value = state.configurationPR ? [state.configurationPR] : [];
  } else if (method === "GET" && endpoint === "pulls/99" && state.configurationPR) {
    value = state.configurationPR;
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

async function installerFixture(t, overrides = {}) {
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
    sourceCommits: [revision, otherRevision],
    installedRevision: revision,
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

test("installed init rejects a different Git pin before provisioning or changing application files", async (t) => {
  const f = await installerFixture(t);
  const rejected = await f.run([...initAt(otherRevision), "--yes"]);
  assert.notEqual(
    rejected.status,
    0,
    "The requested commit contains a different installed executable",
  );
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
