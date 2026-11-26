import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { repositoryDevelopmentConfig } from "../scripts/lib/development-scope.mjs";
import { validateConfig } from "../scripts/lib/policy.mjs";
import { assertRoleChanges } from "../scripts/lib/tdd.mjs";

const checkoutConfig = validateConfig(
  JSON.parse(readFileSync(new URL("../workflow.config.json", import.meta.url))),
);
const { developmentWriteScope: committedScope, ...baseConfig } = checkoutConfig;
const policyEndpoint = `repos/rodush/grait/contents/workflow.config.json`;
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
const developmentWriteScope = {
  allowedWritePaths: ["scripts/**", "tests/**"],
  protectedPaths: [],
};

function repositoryFile(data) {
  return {
    type: "file",
    encoding: "base64",
    content: Buffer.from(typeof data === "string" ? data : JSON.stringify(data)).toString("base64"),
  };
}

test("canonical GRAIT resolves development scope from its default branch", async () => {
  const resolved = await repositoryDevelopmentConfig(baseConfig, {
    request(path) {
      assert.equal(path, policyEndpoint);
      return repositoryFile(checkoutConfig);
    },
  });

  assert.equal(resolved.development, true);
  assert.ok(committedScope);
  assert.doesNotThrow(() => assertRoleChanges(sourceFiles, "implementer", resolved.config));
  assert.doesNotThrow(() => assertRoleChanges(testChanges, "tester", resolved.config));
  assert.throws(() => assertRoleChanges(testChanges, "implementer", resolved.config));
  assert.throws(() => assertRoleChanges(sourceFiles, "tester", resolved.config));
});

test("canonical development uses default branch control settings from the same policy read", async () => {
  const trusted = {
    ...baseConfig,
    developmentWriteScope,
    labels: { ...baseConfig.labels, paused: "upstream:pause" },
    humanOperators: ["trusted-operator"],
    statuses: { ...baseConfig.statuses, review: "Upstream Review" },
    tdd: {
      ...baseConfig.tdd,
      runner: { command: ["upstream-test-runner"] },
      testPatterns: ["tests/**"],
    },
  };
  const local = {
    ...baseConfig,
    labels: { ...baseConfig.labels, paused: "local:pause" },
    humanOperators: ["local-operator"],
    statuses: { ...baseConfig.statuses, review: "Local Review" },
    tdd: {
      ...baseConfig.tdd,
      runner: { command: ["local-test-runner"] },
      testPatterns: ["tests/**", "**/*.mjs"],
    },
  };
  const resolved = await repositoryDevelopmentConfig(local, {
    request(path) {
      assert.equal(path, policyEndpoint);
      return repositoryFile(trusted);
    },
  });

  assert.equal(resolved.development, true);
  assert.deepEqual(resolved.config.labels, trusted.labels);
  assert.deepEqual(resolved.config.humanOperators, trusted.humanOperators);
  assert.deepEqual(resolved.config.statuses, trusted.statuses);
  assert.deepEqual(resolved.config.tdd.runner, trusted.tdd.runner);
  assert.deepEqual(resolved.config.tdd.testPatterns, trusted.tdd.testPatterns);
  assert.doesNotThrow(() =>
    assertRoleChanges(
      [{ filename: "scripts/publish-package.mjs" }],
      "implementer",
      resolved.config,
    ),
  );
});

test("an adopting repository keeps its own write scope even with a copied development marker", async () => {
  const adopter = { ...baseConfig, controllerRepository: "example/project", developmentWriteScope };
  const resolved = await repositoryDevelopmentConfig(adopter, {
    request() {
      assert.fail("adopting repositories do not load GRAIT's source development policy");
    },
  });

  assert.equal(resolved.development, false);
  assert.deepEqual(resolved.config, adopter);
  for (const filename of [".github/workflows/ci.yml", "package.json", "package-lock.json"])
    assert.throws(() => assertRoleChanges([{ filename }], "implementer", resolved.config));
  assert.doesNotThrow(() =>
    assertRoleChanges([{ filename: "docs/workflow.md" }], "implementer", resolved.config),
  );
});

test("a missing canonical default branch configuration stops policy resolution", async () => {
  await assert.rejects(
    repositoryDevelopmentConfig(baseConfig, {
      request() {
        throw Object.assign(new Error("File not found"), { status: 404 });
      },
    }),
  );
});

test("canonical controls still come from the default branch without a development marker", async () => {
  const local = validateConfig({
    ...baseConfig,
    developmentWriteScope,
    labels: { ...baseConfig.labels, paused: "local:pause" },
    allowedWritePaths: [...baseConfig.allowedWritePaths, "package.json"],
    protectedPaths: baseConfig.protectedPaths.filter((path) => path !== "package.json"),
    tdd: {
      ...baseConfig.tdd,
      implementationPaths: [...baseConfig.tdd.implementationPaths, "package.json"],
      runner: { command: ["local-test-runner"] },
    },
  });
  const resolved = await repositoryDevelopmentConfig(local, {
    request(path) {
      assert.equal(path, policyEndpoint);
      return repositoryFile(baseConfig);
    },
  });

  assert.equal(resolved.development, false);
  assert.deepEqual(resolved.config, baseConfig);
  assert.throws(() =>
    assertRoleChanges([{ filename: "package.json" }], "implementer", resolved.config),
  );
});

test("source development policy loading reports unexpected GitHub failures", async () => {
  const unavailable = Object.assign(new Error("GitHub unavailable"), { status: 503 });
  await assert.rejects(
    repositoryDevelopmentConfig(baseConfig, {
      request() {
        throw unavailable;
      },
    }),
    (error) => error === unavailable,
  );
});

test("invalid source development policies do not grant write scope", async () => {
  const invalidConfig = {
    ...baseConfig,
    developmentWriteScope: { allowedWritePaths: ["**"], protectedPaths: [] },
  };
  for (const response of [
    { type: "dir", encoding: "base64", content: "e30=" },
    repositoryFile("{"),
    repositoryFile(invalidConfig),
    repositoryFile({ ...baseConfig, schemaVersion: 1 }),
  ])
    await assert.rejects(repositoryDevelopmentConfig(baseConfig, { request: () => response }), {
      name: /Error$/,
    });
});
