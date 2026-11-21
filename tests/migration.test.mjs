import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("..", import.meta.url));
const canonical = "https://github.com/rodush/grait.git";
const repository = "acme/service";
const origin = `https://github.com/${repository}.git`;
const revision = "a1".repeat(20);
const installation = ".grait/installation.json";
const session = ".git/grait-setup/session.json";
const legacyRunner = "scripts/setup.mjs";
const legacyWorkflow = ".github/workflows/ci.yml";
const legacyDependency = "scripts/lib/entrypoint.mjs";
const codexSettings = ".codex/config.toml";
const application = {
  "app/main.py": "print('app')\n",
  "package.json": '{"name":"app","scripts":{"test":"python -m unittest"}}\n',
  "package-lock.json": '{"name":"app","lockfileVersion":3,"packages":{}}\n',
  ".github/workflows/application.yml": "name: Application\non: [push]\njobs: {}\n",
  ".github/CODEOWNERS": "* @operator\n/app/ @team-owner\n",
};

async function put(root, path, content, options) {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, options);
}

async function fixture(t, { customized = {}, verifiedPackage = true, stockWorkflow = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "grait-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home");
  const baseline = join(directory, "template");
  const target = join(directory, "target");
  const installed = join(directory, "package", "node_modules");
  const entry = join(installed, "grait/dist/cli.mjs");
  const version = JSON.parse(await readFile(join(source, "package.json"), "utf8")).version;
  for (const path of [home, baseline, dirname(entry)]) await mkdir(path, { recursive: true });
  await copyFile(join(source, "dist/cli.mjs"), entry);
  if (verifiedPackage)
    await put(
      installed,
      ".package-lock.json",
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/grait": {
            version,
            resolved: `git+${canonical}#${revision}`,
          },
        },
      }),
    );

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
  };
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  const commit = (cwd) => {
    git(cwd, "add", "--all");
    git(
      cwd,
      "-c",
      "user.name=GRAIT Tests",
      "-c",
      "user.email=tests@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    return git(cwd, "rev-parse", "HEAD");
  };
  git(baseline, "init", "-q", "--initial-branch=main");
  for (const path of [
    legacyRunner,
    legacyDependency,
    codexSettings,
    "scripts/bootstrap.mjs",
    "scripts/check.mjs",
    "automation/agents.json",
    "AGENTS.md",
    "workflow.config.json",
    "package.json",
  ]) {
    await put(baseline, path, await readFile(join(source, path)));
  }
  const toolingOnlyWorkflow = `name: Template CI
on: [push, pull_request]
jobs:
  validate:
    name: Template validation
    runs-on: ubuntu-latest
    steps:
      - run: node ${legacyDependency}
`;
  await put(
    baseline,
    legacyWorkflow,
    stockWorkflow ? await readFile(join(source, legacyWorkflow), "utf8") : toolingOnlyWorkflow,
  );
  const legacyRevision = commit(baseline);
  for (const url of [
    canonical,
    "https://github.com/rodush/grait",
    "git@github.com:rodush/grait.git",
    "ssh://git@github.com/rodush/grait.git",
  ]) {
    git(baseline, "config", "--global", "--add", `url.${baseline}.insteadOf`, url);
  }
  git(directory, "clone", "-q", "--no-hardlinks", baseline, target);
  git(target, "remote", "set-url", "origin", origin);

  const config = {
    ...JSON.parse(await readFile(join(source, "workflow.config.json"), "utf8")),
    controllerRepository: repository,
    humanOperators: ["operator"],
    applicationMarker: "keep project configuration",
  };
  const projectFiles = { ...application, ...customized };
  for (const [path, content] of Object.entries(projectFiles)) await put(target, path, content);
  await put(target, "workflow.config.json", JSON.stringify(config, null, 2) + "\n");
  const head = commit(target);

  const app = (role, id) => ({
    id,
    name: `existing-${role}`,
    slug: `existing-${role}`,
    clientId: `client-${role}`,
    botUserId: id + 1000,
    pem: "-----BEGIN TEST FIXTURE-----\nfixture-credential\n-----END TEST FIXTURE-----\n",
  });
  const checkpoint = {
    version: 1,
    repo: repository,
    enabled: true,
    project: { id: "existing-project", owner: "acme", number: 9 },
    apps: { writer: app("writer", 100), reviewer: app("reviewer", 200) },
  };
  await mkdir(join(target, dirname(session)), { mode: 0o700 });
  await put(target, session, JSON.stringify(checkpoint, null, 2) + "\n", {
    mode: 0o600,
  });

  // Only Git's rewritten template transport is available. Repository and Project
  // provisioning would call a real service, so fail and record those attempts.
  const accessLog = join(directory, "remote-access");
  await put(directory, "bin/gh", `#!/bin/sh\necho gh >> "${accessLog}"\nexit 1\n`, { mode: 0o700 });
  const preload = join(directory, "deny-live-api.mjs");
  await put(
    directory,
    "deny-live-api.mjs",
    `import { appendFileSync } from "node:fs";
globalThis.fetch = () => {
  appendFileSync(${JSON.stringify(accessLog)}, "fetch\\n");
  throw new Error("Live API disabled in migration fixture");
};\n`,
  );
  const run = (program, args, cwd = target, environment = env) => {
    const result = spawnSync(program, args, { cwd, env: environment, encoding: "utf8" });
    if (result.error || result.signal)
      throw result.error || new Error("Fixture command interrupted");
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const cli = (...args) =>
    run(
      process.execPath,
      ["--import", preload, entry, "--cwd", join(target, "app"), ...args],
      directory,
      { ...env, PATH: join(directory, "bin") + ":" + env.PATH },
    );
  return {
    exists: (path) => existsSync(join(target, path)),
    read: (path) => readFile(join(target, path), "utf8"),
    status: () => git(target, "status", "--porcelain", "--untracked-files=all"),
    migrate: (mode) =>
      cli("migrate", "--revision", revision, "--legacy-revision", legacyRevision, mode),
    validate: () => cli("validate"),
    checkApplication: () => run("npm", ["run", "--silent", "check"]),
    testApplication: () => run("npm", ["test", "--silent"]),
    runFromScriptsDirectory: () =>
      run(process.execPath, [basename(legacyDependency)], join(target, dirname(legacyDependency))),
    async workflows() {
      const directory = join(target, ".github/workflows");
      const files = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name));
      return Promise.all(files.map((file) => readFile(join(directory, file), "utf8")));
    },
    async assertPreserved() {
      assert.equal(git(target, "rev-parse", "HEAD"), head, "Migration preserves Git history");
      assert.equal(
        git(target, "diff", "--cached", "--name-only"),
        "",
        "Migration leaves the Git index to the operator",
      );
      assert.equal(git(target, "remote", "get-url", "origin"), origin);
      for (const [path, content] of Object.entries(projectFiles)) {
        if (path !== "AGENTS.md" && path !== codexSettings)
          assert.equal(await readFile(join(target, path), "utf8"), content, path);
      }
      assert.deepEqual(
        JSON.parse(await readFile(join(target, "workflow.config.json"), "utf8")),
        config,
      );
      assert.deepEqual(JSON.parse(await readFile(join(target, session), "utf8")), checkpoint);
      assert.equal((await lstat(join(target, session))).mode & 0o777, 0o600);
      assert.equal(
        existsSync(accessLog),
        false,
        "Migration leaves Project and publishing services alone",
      );
    },
  };
}

function assertSuccess(result) {
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /fixture-credential/);
}

test("migration previews and applies verified template removals and a pinned installation", async (t) => {
  const f = await fixture(t);
  const preview = f.migrate("--plan");
  assertSuccess(preview);
  assert.match(preview.output, /scripts\/setup\.mjs/);
  assert.match(preview.output, /\.github\/workflows\/ci\.yml/);
  assert.match(preview.output, /\.grait\/installation\.json/);
  assert.equal(f.status(), "");
  assert.equal(f.exists(installation), false);
  await f.assertPreserved();

  assertSuccess(f.migrate("--yes"));
  assert.equal(f.exists(legacyRunner), false);
  assert.equal(f.exists(legacyWorkflow), false);
  assert.match(await f.read("AGENTS.md"), /grait:policy:start/);
  assert.match(await f.read(".github/workflows/grait.yml"), new RegExp(revision));
  const record = JSON.parse(await f.read(installation));
  assert.equal(record.revision, revision);
  assert.equal(record.repository, repository);
  assert.equal(record.harness, "codex");
  assertSuccess(f.validate());
  await f.assertPreserved();
});

test("migration retains customized legacy files and files absent from the template pin", async (t) => {
  const customSettings = 'approval_policy = "never"\nsandbox_mode = "workspace-write"\n';
  const f = await fixture(t, {
    customized: {
      "AGENTS.md": "# Application instructions\n\nRun python -m unittest.\n",
      "scripts/bootstrap.mjs": "export const projectBootstrap = true;\n",
      "scripts/project-helper.mjs": "export const projectHelper = true;\n",
      [legacyWorkflow]: "name: Customized application pipeline\non: [push]\njobs: {}\n",
      [codexSettings]: customSettings,
    },
  });
  const preview = f.migrate("--plan");
  assertSuccess(preview);
  assert.equal(f.status(), "");
  assert.equal(f.exists(legacyRunner), true);
  assert.equal(f.exists(installation), false);

  assertSuccess(f.migrate("--yes"));
  assert.equal(f.exists(legacyRunner), false);
  assert.match(
    await f.read("AGENTS.md"),
    /^# Application instructions\n\nRun python -m unittest\.\n/,
  );
  assert.match(await f.read("AGENTS.md"), /grait:policy:start/);
  assert.ok((await f.read(codexSettings)).includes(customSettings));
  assertSuccess(f.validate());
  await f.assertPreserved();
});

test("migration preserves a retained CI command or rejects the migration before changing artifacts", async (t) => {
  const f = await fixture(t, {
    customized: {
      "package.json":
        JSON.stringify({
          name: "app",
          scripts: { check: `node ${legacyDependency}` },
        }) + "\n",
      ".github/workflows/application.yml":
        "name: Application\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run check\n",
    },
  });
  assertSuccess(f.checkApplication());

  const result = f.migrate("--yes");
  if (result.status === 0) {
    assertSuccess(f.checkApplication());
    assertSuccess(f.validate());
  } else {
    assert.match(result.output, /scripts\/lib\/entrypoint\.mjs|npm run check/i);
    assert.equal(f.status(), "");
    assert.equal(f.exists(installation), false);
    assertSuccess(f.checkApplication());
  }
  await f.assertPreserved();
});

test("migration preserves existing Codex settings that match the template", async (t) => {
  const f = await fixture(t);
  const before = await f.read(codexSettings);

  assertSuccess(f.migrate("--yes"));
  const after = await f.read(codexSettings);
  assert.ok(after.includes(before), "The migrated config retains the existing Codex settings");
  assert.match(after, /grait:policy:start/);
  assertSuccess(f.validate());
});

test("migration refuses to preview a full target SHA without verified package pin metadata", async (t) => {
  const f = await fixture(t, { verifiedPackage: false });
  const preview = f.migrate("--plan");

  assert.notEqual(
    preview.status,
    0,
    "A supplied full SHA cannot establish the running package pin",
  );
  assert.match(preview.output, /could not|cannot|unable|missing/i);
  assert.match(preview.output, /revision|package.*pin|lockfile/i);
  assert.equal(f.status(), "");
  assert.equal(f.exists(installation), false);
  await f.assertPreserved();
});

test("migration keeps the script used relative to a retained CI working directory", async (t) => {
  const f = await fixture(t, {
    customized: {
      ".github/workflows/application.yml": `name: Application CI
on: [push]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - working-directory: ${dirname(legacyDependency)}
        run: node ${basename(legacyDependency)}
`,
    },
  });
  assertSuccess(f.runFromScriptsDirectory());

  const result = f.migrate("--yes");
  if (result.status === 0) {
    assert.equal(f.exists(legacyDependency), true, "The retained workflow still has its script");
    assertSuccess(f.validate());
  } else {
    assert.match(result.output, /application\.yml|entrypoint\.mjs/i);
    assert.equal(f.status(), "");
    assert.equal(f.exists(installation), false);
  }
  assertSuccess(f.runFromScriptsDirectory());
  await f.assertPreserved();
});

test("migration keeps application tests invoked by stock CI or stops before changing artifacts", async (t) => {
  const f = await fixture(t, {
    stockWorkflow: true,
    customized: {
      "package.json":
        JSON.stringify({
          name: "app",
          scripts: { test: "node --test app/application.test.mjs" },
        }) + "\n",
      "app/application.test.mjs": `import test from "node:test";
import assert from "node:assert/strict";

test("application check", () => assert.equal(process.version.startsWith("v"), true));
`,
    },
  });
  const invokesNpmTest = (workflow) => /^\s*-\s*run:\s*npm\s+(?:run\s+)?test\b/m.test(workflow);
  assert.ok(invokesNpmTest(await f.read(legacyWorkflow)));
  assertSuccess(f.testApplication());

  const result = f.migrate("--yes");
  if (result.status === 0) {
    assert.ok((await f.workflows()).some(invokesNpmTest), "Application tests still run in CI");
    assertSuccess(f.validate());
  } else {
    assert.match(result.output, /ci\.yml|application\s+(?:ci|workflow)/i);
    assert.match(result.output, /npm\s+(?:run\s+)?test|test\s+script|application\s+tests?/i);
    assert.equal(f.status(), "");
    assert.equal(f.exists(installation), false);
  }
  assertSuccess(f.testApplication());
  await f.assertPreserved();
});

test("migration protects application tests selected by the unmodified template test command", async (t) => {
  const applicationTest = "tests/project-behavior.test.mjs";
  const f = await fixture(t, {
    stockWorkflow: true,
    customized: {
      "package.json": await readFile(join(source, "package.json"), "utf8"),
      [applicationTest]: `import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("runs project behavior from the inherited test glob", async () => {
  const program = await readFile(new URL("../app/main.py", import.meta.url), "utf8");
  assert.equal(program.trim(), "print('app')");
});
`,
    },
  });
  const invokesNpmTest = (workflow) => /^\s*-\s*run:\s*npm\s+(?:run\s+)?test\b/m.test(workflow);
  assert.ok(invokesNpmTest(await f.read(legacyWorkflow)));
  const before = f.testApplication();
  assertSuccess(before);
  assert.match(before.output, /runs project behavior from the inherited test glob/);

  const result = f.migrate("--yes");
  if (result.status === 0) {
    const invokesApplicationTest = (workflow) =>
      invokesNpmTest(workflow) ||
      /^\s*-\s*run:\s*node\s+--test\b[^\r\n]*tests\/(?:project-behavior|\*)\.test\.mjs\b/m.test(
        workflow,
      );
    assert.ok(
      (await f.workflows()).some(invokesApplicationTest),
      "Application tests reached by the inherited command still run in CI",
    );
    assertSuccess(f.validate());
  } else {
    assert.match(result.output, /ci\.yml|application\s+(?:ci|workflow)/i);
    assert.match(result.output, /npm\s+(?:run\s+)?test|tests\/project-behavior\.test\.mjs/i);
    assert.equal(f.status(), "");
    assert.equal(f.exists(installation), false);
  }
  const after = f.testApplication();
  assertSuccess(after);
  assert.match(after.output, /runs project behavior from the inherited test glob/);
  await f.assertPreserved();
});
