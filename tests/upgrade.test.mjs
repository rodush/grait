import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planInstallation } from "../src/installer.mjs";

const oldRevision = "a1".repeat(20);
const newRevision = "b2".repeat(20);
const oldVersion = "0.0.1";
const recordPath = ".grait/installation.json";
const workflowPath = ".github/workflows/grait.yml";
const applicationPath = "app/main.py";
const agentInstructions = "# Application instructions\n\nRun the local Python tests.\n";
const cliSource = fileURLToPath(new URL("../dist/cli.mjs", import.meta.url));
const fetchedCliOutput = "Running the fetched GRAIT fixture";

async function installedFixture(t, { runtimeRevision = newRevision, fetchedRevision } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "grait-upgrade-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, "project");
  const installation = join(temporary, "runtime/node_modules/grait/dist/cli.mjs");
  const checkout = join(temporary, "checkout/dist/cli.mjs");
  const lockfile = join(temporary, "runtime/package-lock.json");
  const commands = join(temporary, "commands");
  const fetchLog = join(temporary, "fetch.log");
  const env = {
    PATH: commands + delimiter + process.env.PATH,
    HOME: temporary,
    TMPDIR: temporary,
  };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const run = (...args) => {
    const result = spawnSync(
      process.execPath,
      [runtimeRevision ? installation : checkout, "--cwd", join(root, "app"), ...args],
      {
        cwd: temporary,
        env,
        encoding: "utf8",
      },
    );
    if (result.error) throw result.error;
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const write = async (path, content) => {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  const read = (path) => readFile(join(root, path), "utf8");

  const packageLock = (revision) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/grait": {
          resolved: "git+https://github.com/rodush/grait.git#" + revision,
        },
      },
    });
  if (runtimeRevision) {
    await mkdir(dirname(installation), { recursive: true });
    await copyFile(cliSource, installation);
    await writeFile(lockfile, packageLock(runtimeRevision));
  } else {
    await mkdir(dirname(checkout), { recursive: true });
    await copyFile(cliSource, checkout);
  }
  await mkdir(commands);
  await writeFile(
    join(commands, "npm"),
    `#!/usr/bin/env node
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, relative } = require("node:path");
const args = process.argv.slice(2);
const gitPackage = args.find((arg) => arg.startsWith("git+https://github.com/rodush/grait.git#"));
const prefix = args.find((arg) => arg.startsWith("--prefix="))?.slice("--prefix=".length)
  ?? (args.includes("--prefix") ? args[args.indexOf("--prefix") + 1] : process.cwd());
const requestLog = ${JSON.stringify(fetchLog)};
writeFileSync(requestLog, gitPackage ?? "");
if (!gitPackage || !args.includes("--ignore-scripts") || !relative(${JSON.stringify(root)}, prefix).startsWith("..")) {
  console.error("Fixture requires a canonical Git install with scripts disabled outside the target");
  process.exit(1);
}
if (!${Boolean(fetchedRevision)}) {
  console.error("Fixture Git revision is unavailable");
  process.exit(1);
}
const executable = join(prefix, "node_modules", "grait", "dist", "cli.mjs");
mkdirSync(dirname(executable), { recursive: true });
const cli = readFileSync(${JSON.stringify(cliSource)}, "utf8");
const marker = ${JSON.stringify(`console.log(${JSON.stringify(fetchedCliOutput)});\n`)};
writeFileSync(executable, cli.replace(/^(#![^\\n]*\\n)/, "$1" + marker), { mode: 0o755 });
writeFileSync(join(dirname(executable), "..", "package.json"), JSON.stringify({
  name: "grait",
  version: "0.1.0",
  bin: { grait: "dist/cli.mjs" },
}));
writeFileSync(join(prefix, "package-lock.json"), ${JSON.stringify(packageLock(fetchedRevision))});
`,
    { mode: 0o755 },
  );
  await write("AGENTS.md", agentInstructions);
  await write(applicationPath, "print('project owned')\n");
  git("init", "--quiet", "--initial-branch=main");
  const { artifacts } = await planInstallation({
    root,
    repo: "acme/service",
    verifiedRevision: oldRevision,
    version: oldVersion,
    harness: "codex",
    maintainers: ["operator"],
    project: { name: "Service", context: "Workflow policy for Service." },
  });
  for (const [path, content] of Object.entries(artifacts)) await write(path, content);
  git("add", "--all");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "Installed GRAIT",
  );
  const paths = [...Object.keys(artifacts), applicationPath];
  const snapshot = async () => Promise.all(paths.map(read));
  return {
    git,
    run,
    read,
    write,
    snapshot,
    npmRequest: () =>
      readFile(fetchLog, "utf8").catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      }),
    upgrade: (...args) => run("upgrade", "--revision", newRevision, ...args),
  };
}

test("a pinned upgrade previews and applies new managed artifacts and ownership, then repeats unchanged", async (t) => {
  const f = await installedFixture(t);
  const before = await f.snapshot();
  const head = f.git("rev-parse", "HEAD");

  const preview = f.upgrade("--plan");
  assert.equal(preview.status, 0, "An installed CLI can preview a pinned upgrade");
  assert.ok(preview.output.includes(newRevision), "Show the new pin before writing");
  assert.match(preview.output, /grait\.yml/);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.git("status", "--porcelain"), "");

  const applied = f.upgrade("--yes");
  assert.equal(applied.status, 0, "A confirmed CLI invocation applies the pinned upgrade");
  assert.equal(f.git("rev-parse", "HEAD"), head);
  const record = JSON.parse(await f.read(recordPath));
  const version = f.run("--version").output.trim();
  assert.notEqual(record.version, oldVersion);
  assert.equal(record.version, version);
  assert.equal(record.revision, newRevision);
  assert.deepEqual(record.project, {
    name: "Service",
    context: "Workflow policy for Service.",
  });
  assert.ok((await f.read(workflowPath)).includes(newRevision));
  assert.ok(!(await f.read(workflowPath)).includes(oldRevision));
  assert.ok((await f.read("AGENTS.md")).includes("grait:policy:start version=" + version));
  for (const path of ["AGENTS.md", workflowPath]) {
    assert.equal(
      record.artifacts[path].hash,
      createHash("sha256")
        .update(await f.read(path))
        .digest("hex"),
    );
  }
  assert.equal(f.run("validate").status, 0, "The new metadata validates against the new artifacts");

  const after = await f.snapshot();
  const status = f.git("status", "--porcelain");
  assert.equal(f.upgrade("--yes").status, 0);
  assert.deepEqual(await f.snapshot(), after);
  assert.equal(f.git("status", "--porcelain"), status);
});

test("a pinned upgrade preserves local text outside managed blocks and project-owned files", async (t) => {
  const f = await installedFixture(t);
  const projectInstructions = "# Revised application instructions\n\nRun the project CI checks.\n";
  const additionalInstructions = "\n## Project note\n\nRetain the local deployment procedure.\n";
  const codexModel = 'model = "project-model"\n\n';
  const agents = (await f.read("AGENTS.md")).replace(agentInstructions, projectInstructions);
  const codex = codexModel + (await f.read(".codex/config.toml"));
  const customFiles = {
    "workflow.config.json": (await f.read("workflow.config.json")).replace(
      '"maxConcurrentWorkers": 5',
      '"maxConcurrentWorkers": 2',
    ),
    ".github/CODEOWNERS": "/app/ @application-owner\n" + (await f.read(".github/CODEOWNERS")),
    [applicationPath]: "print('custom application')\n",
  };
  for (const [path, content] of Object.entries({
    ...customFiles,
    "AGENTS.md": agents + additionalInstructions,
    ".codex/config.toml": codex,
  }))
    await f.write(path, content);

  assert.equal(f.upgrade("--yes").status, 0, "Local edits outside managed content permit upgrade");
  const version = f.run("--version").output.trim();
  const upgradedAgents = await f.read("AGENTS.md");
  const upgradedCodex = await f.read(".codex/config.toml");
  assert.ok(upgradedAgents.startsWith(projectInstructions));
  assert.ok(upgradedAgents.endsWith(additionalInstructions));
  assert.ok(upgradedCodex.startsWith(codexModel));
  for (const content of [upgradedAgents, upgradedCodex])
    assert.ok(content.includes("grait:policy:start version=" + version));
  for (const [path, content] of Object.entries(customFiles))
    assert.equal(await f.read(path), content);
  assert.equal(f.run("validate").status, 0);
});

test("a pinned upgrade reports drift inside a managed block before writing", async (t) => {
  const f = await installedFixture(t);
  const changed = (await f.read("AGENTS.md")).replace(
    "Workflow policy for Service.",
    "Locally changed managed text.",
  );
  await f.write("AGENTS.md", changed);
  const before = await f.snapshot();

  const preview = f.upgrade("--plan");
  assert.match(preview.output, /drift|conflict|modified/i);
  assert.match(preview.output, /AGENTS\.md/);
  assert.deepEqual(await f.snapshot(), before);

  const apply = f.upgrade("--yes");
  assert.notEqual(apply.status, 0, "A confirmed upgrade cannot overwrite a managed conflict");
  assert.match(apply.output, /AGENTS\.md/);
  assert.deepEqual(await f.snapshot(), before);
});

test("an upgrade can preview a requested Git revision from a checkout", async (t) => {
  const f = await installedFixture(t, {
    runtimeRevision: null,
    fetchedRevision: newRevision,
  });
  const before = await f.snapshot();

  const preview = f.upgrade("--plan");
  assert.equal(preview.status, 0, "A checkout can preview an upgrade at the requested pin");
  assert.ok(preview.output.includes(fetchedCliOutput));
  assert.ok(preview.output.includes(newRevision));
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("an older GRAIT package delegates an upgrade pinned to a Git prefix", async (t) => {
  const f = await installedFixture(t, {
    runtimeRevision: oldRevision,
    fetchedRevision: newRevision,
  });
  const prefix = newRevision.slice(0, 12);

  const applied = f.run("upgrade", "--revision", prefix, "--yes");
  assert.equal(applied.status, 0, "An older package can apply the selected upgrade");
  assert.ok(applied.output.includes(fetchedCliOutput));
  assert.equal(JSON.parse(await f.read(recordPath)).revision, newRevision);
  assert.ok((await f.read(workflowPath)).includes(newRevision));
  assert.equal(
    f.git(
      "status",
      "--porcelain",
      "--ignored",
      "package.json",
      "package-lock.json",
      "node_modules",
    ),
    "",
  );
});

test("an unavailable upgrade revision fails without writing the project", async (t) => {
  const f = await installedFixture(t);
  const before = await f.snapshot();
  const result = f.run("upgrade", "--revision", oldRevision, "--yes");
  assert.notEqual(result.status, 0);
  assert.ok(
    (await f.npmRequest())?.endsWith("#" + oldRevision),
    "Try to fetch the selected revision",
  );
  assert.match(result.output, /fetch|install|download/i);
  assert.ok(result.output.includes(oldRevision));
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("an upgrade refuses to run a fetched package with a mismatched Git revision", async (t) => {
  const f = await installedFixture(t, {
    runtimeRevision: null,
    fetchedRevision: oldRevision,
  });
  const before = await f.snapshot();

  const applied = f.upgrade("--yes");
  assert.notEqual(applied.status, 0);
  assert.ok(
    (await f.npmRequest())?.endsWith("#" + newRevision),
    "Try to fetch the selected revision",
  );
  assert.match(applied.output, /verif|mismatch|different|does not match/i);
  assert.ok(!applied.output.includes(fetchedCliOutput), "Do not invoke an unverifiable package");
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(f.git("status", "--porcelain"), "");
});
