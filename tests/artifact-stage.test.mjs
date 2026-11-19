import test from "node:test";
import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const moduleUrl = new URL("../src/artifact-stage.mjs", import.meta.url);

async function api() {
  assert.equal(
    await access(moduleUrl).then(
      () => true,
      () => false,
    ),
    true,
    "The public staged-artifact API must exist",
  );
  return import(moduleUrl.href);
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), "grait-artifact-acceptance-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  const stateDirectory = join(directory, "private");
  await mkdir(root);
  return { root, stateDirectory, directory };
}

async function contents(root, path) {
  return readFile(join(root, path), "utf8").catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

test("artifact staging previews additions changes and deletions without touching the project", async (t) => {
  const { stageArtifacts } = await api();
  const { root, stateDirectory } = await workspace(t);
  await writeFile(join(root, "policy.md"), "user policy\n");
  await writeFile(join(root, "obsolete.md"), "old\n");
  const artifacts = { "policy.md": "new policy\n", "new.md": "new\n", "obsolete.md": null };
  const plan = await stageArtifacts({ root, stateDirectory, artifacts });
  assert.equal(typeof plan.id, "string");
  assert.ok(plan.id.length > 0);
  assert.deepEqual(
    plan.changes
      .map(({ path, before, after }) => ({ path, before, after }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: "new.md", before: null, after: "new\n" },
      { path: "obsolete.md", before: "old\n", after: null },
      { path: "policy.md", before: "user policy\n", after: "new policy\n" },
    ],
  );
  assert.deepEqual((await readdir(root)).sort(), ["obsolete.md", "policy.md"]);
  assert.equal(await contents(root, "policy.md"), "user policy\n");
  assert.equal(await contents(root, "obsolete.md"), "old\n");
});

test("artifact application applies the reviewed result and repeats without changes", async (t) => {
  const { stageArtifacts, applyArtifacts } = await api();
  const { root, stateDirectory } = await workspace(t);
  await writeFile(join(root, "old.md"), "old\n");
  await writeFile(join(root, "app.txt"), "application\n");
  const artifacts = { "nested/policy.md": "policy\n", "old.md": null };
  const plan = await stageArtifacts({ root, stateDirectory, artifacts });
  await applyArtifacts({ root, stateDirectory, id: plan.id });
  assert.equal(await contents(root, "nested/policy.md"), "policy\n");
  assert.equal(await contents(root, "old.md"), null);
  assert.equal(await contents(root, "app.txt"), "application\n");
  const repeat = await stageArtifacts({ root, stateDirectory, artifacts });
  assert.deepEqual(repeat.changes, []);
  await applyArtifacts({ root, stateDirectory, id: repeat.id });
  assert.equal(await contents(root, "app.txt"), "application\n");
});

test("artifact application rejects intervening target edits before writing any artifact", async (t) => {
  const { stageArtifacts, applyArtifacts } = await api();
  const { root, stateDirectory } = await workspace(t);
  await writeFile(join(root, "first.md"), "before first\n");
  await writeFile(join(root, "second.md"), "before second\n");
  const plan = await stageArtifacts({
    root,
    stateDirectory,
    artifacts: { "first.md": "after first\n", "second.md": "after second\n" },
  });
  await writeFile(join(root, "second.md"), "user intervened\n");
  await assert.rejects(applyArtifacts({ root, stateDirectory, id: plan.id }));
  assert.equal(await contents(root, "first.md"), "before first\n");
  assert.equal(await contents(root, "second.md"), "user intervened\n");
});

test("artifact application restores earlier writes after an injected write failure", async (t) => {
  const { stageArtifacts, applyArtifacts, recoverArtifacts } = await api();
  const { root, stateDirectory } = await workspace(t);
  await writeFile(join(root, "first.md"), "before first\n");
  await writeFile(join(root, "second.md"), "before second\n");
  const plan = await stageArtifacts({
    root,
    stateDirectory,
    artifacts: { "first.md": "after first\n", "second.md": "after second\n" },
  });
  let writes = 0;
  await assert.rejects(
    applyArtifacts({
      root,
      stateDirectory,
      id: plan.id,
      writeFile: async (path, content) => {
        if (++writes === 2) throw new Error("Injected application write failure");
        await writeFile(path, content);
      },
    }),
  );
  await recoverArtifacts({ root, stateDirectory, id: plan.id });
  assert.equal(await contents(root, "first.md"), "before first\n");
  assert.equal(await contents(root, "second.md"), "before second\n");
});

test("artifact recovery rolls back an application interrupted by process exit", async (t) => {
  const { stageArtifacts, recoverArtifacts } = await api();
  const { root, stateDirectory } = await workspace(t);
  await writeFile(join(root, "first.md"), "before first\n");
  await writeFile(join(root, "second.md"), "before second\n");
  const plan = await stageArtifacts({
    root,
    stateDirectory,
    artifacts: { "first.md": "after first\n", "second.md": "after second\n" },
  });
  const script = `import {applyArtifacts} from ${JSON.stringify(moduleUrl.href)};
import {writeFile} from 'node:fs/promises';
await applyArtifacts({...JSON.parse(process.argv[1]), writeFile:async(path,content)=>{await writeFile(path,content);process.exit(71)}});`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, JSON.stringify({ root, stateDirectory, id: plan.id })],
    { encoding: "utf8", timeout: 10000, env: { PATH: process.env.PATH } },
  );
  assert.equal(child.status, 71, "application must reach the injected process interruption");
  await recoverArtifacts({ root, stateDirectory, id: plan.id });
  assert.equal(await contents(root, "first.md"), "before first\n");
  assert.equal(await contents(root, "second.md"), "before second\n");
  await recoverArtifacts({ root, stateDirectory, id: plan.id });
  assert.equal(await contents(root, "first.md"), "before first\n");
});

test("artifact staging rejects private storage inside the project and unsafe artifact paths", async (t) => {
  const { stageArtifacts } = await api();
  const { root, stateDirectory, directory } = await workspace(t);
  await assert.rejects(
    stageArtifacts({
      root,
      stateDirectory: join(root, ".staging"),
      artifacts: { "policy.md": "policy\n" },
    }),
  );
  for (const path of ["../escaped.md", join(directory, "absolute.md"), ".git/config"]) {
    await assert.rejects(
      stageArtifacts({ root, stateDirectory, artifacts: { [path]: "unsafe\n" } }),
    );
  }
  assert.deepEqual(await readdir(root), []);
  assert.equal(await contents(directory, "escaped.md"), null);
});

test("artifact staging and application refuse symlink targets", async (t) => {
  const { stageArtifacts, applyArtifacts } = await api();
  const { root, stateDirectory, directory } = await workspace(t);
  const outside = join(directory, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "policy.md"), "outside\n");
  await symlink(outside, join(root, "linked"), "dir");
  await assert.rejects(
    stageArtifacts({ root, stateDirectory, artifacts: { "linked/policy.md": "unsafe\n" } }),
  );
  const plan = await stageArtifacts({
    root,
    stateDirectory,
    artifacts: { "new/policy.md": "policy\n" },
  });
  await symlink(outside, join(root, "new"), "dir");
  await assert.rejects(applyArtifacts({ root, stateDirectory, id: plan.id }));
  assert.equal(await readFile(join(outside, "policy.md"), "utf8"), "outside\n");
});
