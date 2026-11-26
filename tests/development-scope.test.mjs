import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { validateConfig } from "../scripts/lib/policy.mjs";
import { assertRoleChanges } from "../scripts/lib/tdd.mjs";

const resolverUrl = new URL("../scripts/lib/development-scope.mjs", import.meta.url);
const policyUrl = new URL("../config/grait-development.json", import.meta.url);
const config = validateConfig(
  JSON.parse(readFileSync(new URL("../workflow.config.json", import.meta.url))),
);
const repository = "rodush/grait";
const policyEndpoint = `repos/${repository}/contents/config/grait-development.json`;
const sourceFiles = [
  ".github/workflows/ci.yml",
  "AGENTS.md",
  "docs/grait-development.md",
  "docs/workflow.md",
  "package.json",
  "package-lock.json",
  "scripts/publish-package.mjs",
].map((filename) => ({ filename }));
const testChanges = [{ filename: "tests/development-scope.test.mjs" }];

async function developmentResolver() {
  assert.ok(existsSync(resolverUrl), "the source development policy resolver is available");
  const { repositoryDevelopmentConfig } = await import(resolverUrl);
  return repositoryDevelopmentConfig;
}

async function resolvePolicy(base, request) {
  return (await developmentResolver())(base, { request });
}

function repositoryFile(data) {
  return { type: "file", encoding: "base64", content: Buffer.from(data).toString("base64") };
}

test("canonical GRAIT resolves development scope from its default branch", async () => {
  const resolved = await resolvePolicy({ ...config, controllerRepository: repository }, (path) => {
    assert.equal(path, policyEndpoint);
    assert.ok(existsSync(policyUrl), "the source repository defines a development policy");
    return repositoryFile(readFileSync(policyUrl));
  });

  assert.equal(resolved.development, true);
  assert.doesNotThrow(() => assertRoleChanges(sourceFiles, "implementer", resolved.config));
  assert.doesNotThrow(() => assertRoleChanges(testChanges, "tester", resolved.config));
  assert.throws(() => assertRoleChanges(testChanges, "implementer", resolved.config));
  assert.throws(() => assertRoleChanges(sourceFiles, "tester", resolved.config));
  assert.deepEqual(resolved.config.tdd.runner, config.tdd.runner);
});

test("an adopting repository keeps its own write scope", async () => {
  const adopter = { ...config, controllerRepository: "example/project" };
  const resolved = await resolvePolicy(adopter, () =>
    assert.fail("adopting repositories do not load GRAIT's source development policy"),
  );

  assert.equal(resolved.development, false);
  assert.deepEqual(resolved.config, adopter);
  for (const file of sourceFiles)
    assert.throws(() => assertRoleChanges([file], "implementer", resolved.config));
});

test("a missing source development policy uses the baseline scope", async () => {
  const baseline = { ...config, controllerRepository: repository };
  const resolved = await resolvePolicy(baseline, (path) => {
    assert.equal(path, policyEndpoint);
    throw Object.assign(new Error("File not found"), { status: 404 });
  });

  assert.equal(resolved.development, false);
  assert.deepEqual(resolved.config, baseline);
});

test("source development policy loading reports unexpected GitHub failures", async () => {
  const unavailable = Object.assign(new Error("GitHub unavailable"), { status: 503 });
  await assert.rejects(
    resolvePolicy({ ...config, controllerRepository: repository }, () => {
      throw unavailable;
    }),
    (error) => error === unavailable,
  );
});

test("invalid source development policies do not grant write scope", async () => {
  const resolve = await developmentResolver();
  const baseline = { ...config, controllerRepository: repository };
  for (const response of [
    { type: "dir", encoding: "base64", content: "e30=" },
    repositoryFile("{"),
    repositoryFile(JSON.stringify({ allowedWritePaths: ["**"], protectedPaths: [] })),
  ])
    await assert.rejects(
      resolvePolicy(baseline, () => response),
      {
        name: /Error$/,
      },
    );
});
