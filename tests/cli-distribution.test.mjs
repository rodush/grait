import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const env = { ...process.env, NPM_CONFIG_IGNORE_SCRIPTS: "true" };
for (const key of Object.keys(env))
  if (/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY/i.test(key)) delete env[key];

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60000 });
  assert.ifError(result.error);
  return result;
}

async function temporary(fn) {
  const directory = await mkdtemp(join(tmpdir(), "grait-distribution-test-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("distribution declares a prebuilt executable without Git preparation hooks", async () => {
  assert.equal(manifest.bin?.grait, "dist/cli.mjs");
  assert.ok(Array.isArray(manifest.files), "An explicit npm package allowlist is required");
  assert.ok(manifest.files.includes("dist") || manifest.files.includes("dist/"));
  for (const key of ["build", "prepare", "prepack", "preinstall", "install", "postinstall"])
    assert.equal(manifest.scripts?.[key], undefined, `${key} triggers Git package preparation`);
  assert.equal(manifest.workspaces, undefined);
  const cli = await readFile(join(root, manifest.bin.grait), "utf8");
  assert.match(cli, /^#!\/usr\/bin\/env node\r?\n/);
});

test("allowlisted distribution runs outside the checkout without development dependencies", async () => {
  assert.equal(manifest.bin?.grait, "dist/cli.mjs");
  const listing = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], root);
  assert.equal(listing.status, 0);
  const packages = JSON.parse(listing.stdout);
  const packed = Array.isArray(packages) ? packages[0] : packages[manifest.name];
  assert.ok(Array.isArray(packed?.files), "npm must report the package file listing");
  const files = packed.files.map((file) => file.path);
  assert.ok(files.includes("dist/cli.mjs"));
  assert.ok(files.includes("LICENSE"));
  for (const path of files)
    assert.ok(
      path.startsWith("dist/") || ["package.json", "LICENSE", "README.md"].includes(path),
      `Development or host-state file leaked into package: ${path}`,
    );
  for (const path of files)
    assert.ok(
      !/(?:^|\/)(?:tests|fixtures|node_modules)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]s$/.test(path),
      `Development tests or dependencies leaked into package: ${path}`,
    );
  await temporary(async (directory) => {
    const packageDirectory = join(directory, "package");
    const application = join(directory, "application");
    await mkdir(application);
    for (const path of files) {
      await mkdir(dirname(join(packageDirectory, path)), { recursive: true });
      await cp(join(root, path), join(packageDirectory, path));
    }
    for (const argument of ["--help", "--version"]) {
      const result = run(
        process.execPath,
        [join(packageDirectory, "dist/cli.mjs"), argument],
        application,
      );
      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      if (argument === "--help") assert.match(result.stdout, /grait/i);
      else assert.equal(result.stdout.trim(), manifest.version);
    }
  });
});

test("bundle compiles imported modules instead of mirroring the source tree", async () => {
  await temporary(async (directory) => {
    await cp(root, directory, {
      recursive: true,
      filter: (path) => ![join(root, ".git"), join(root, "node_modules")].includes(path),
    });
    await cp(join(root, "node_modules"), join(directory, "node_modules"), { recursive: true });
    const cliPath = join(directory, "src/cli.mjs");
    await writeFile(
      cliPath,
      `${await readFile(cliPath, "utf8")}\nimport { compiledProbe } from "./bundle-probe.mjs";\nconsole.log(compiledProbe);\n`,
    );
    await writeFile(
      join(directory, "src/bundle-probe.mjs"),
      'export { compiledProbe } from "./bundle-probe-value.mjs";\n',
    );
    await writeFile(
      join(directory, "src/bundle-probe-value.mjs"),
      'export const compiledProbe = "compiled-dependency-graph";\n',
    );
    const build = run("npm", ["run", "bundle"], directory);
    assert.equal(build.status, 0);
    await rm(join(directory, "src"), { recursive: true });
    await rm(join(directory, "scripts"), { recursive: true });
    await rm(join(directory, "node_modules"), { recursive: true });
    // Imported implementation belongs in compiled entrypoints/chunks, not a
    // byte-for-byte mirror that makes source files runtime dependencies.
    await rm(join(directory, "dist/bundle-probe.mjs"), { force: true });
    await rm(join(directory, "dist/bundle-probe-value.mjs"), { force: true });
    const result = run(process.execPath, [join(directory, "dist/cli.mjs"), "--version"], directory);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), `${manifest.version}\ncompiled-dependency-graph`);
  });
});

test("bundle freshness detects changed and missing committed output", async () => {
  assert.equal(typeof manifest.scripts?.bundle, "string");
  assert.equal(typeof manifest.scripts?.["bundle:check"], "string");
  await temporary(async (directory) => {
    await cp(root, directory, {
      recursive: true,
      filter: (path) => ![join(root, ".git"), join(root, "node_modules")].includes(path),
    });
    // Build tools belong to the developer checkout, never to the installed package.
    try {
      await cp(join(root, "node_modules"), join(directory, "node_modules"), { recursive: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    assert.equal(run("npm", ["run", "bundle:check"], directory).status, 0);
    const cliPath = join(directory, "dist/cli.mjs");
    const original = await readFile(cliPath, "utf8");
    await writeFile(cliPath, `${original}\n// stale generated output\n`);
    assert.notEqual(run("npm", ["run", "bundle:check"], directory).status, 0);
    assert.equal(await readFile(cliPath, "utf8"), `${original}\n// stale generated output\n`);
    assert.equal(run("npm", ["run", "bundle"], directory).status, 0);
    assert.equal(await readFile(cliPath, "utf8"), original);
    await rm(cliPath);
    assert.notEqual(run("npm", ["run", "bundle:check"], directory).status, 0);
    assert.equal(run("npm", ["run", "bundle"], directory).status, 0);
    assert.equal(run("npm", ["run", "bundle:check"], directory).status, 0);
    assert.equal(await readFile(cliPath, "utf8"), original);
    await writeFile(join(directory, "dist/unexpected-generated-file"), "unexpected\n");
    assert.notEqual(run("npm", ["run", "bundle:check"], directory).status, 0);
  });
});
