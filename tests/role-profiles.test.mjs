import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { generateHarnessFiles } from "../scripts/lib/harnesses.mjs";
import { validateConfig } from "../scripts/lib/policy.mjs";
import { generateProjectArtifacts } from "../src/project-policy.mjs";

const root = new URL("../", import.meta.url);
const base = JSON.parse(await readFile(new URL("workflow.config.json", root), "utf8"));
const roles = ["orchestrator", "triage", "test", "implement", "review", "fix"];
const nativeFields = {
  codex: { effort: "model_reasoning_effort", extended: "xhigh" },
  claude: { effort: "effort", extended: "max" },
  copilot: { effort: "reasoningEffort", extended: "xhigh" },
};
const engines = Object.keys(nativeFields);

function artifactPath(engine, role) {
  return {
    codex: `.codex/agents/grait-${role}.toml`,
    claude: `.claude/agents/grait-${role}.md`,
    copilot: `.github/agents/grait-${role}.agent.md`,
  }[engine];
}

function nativeAgent(engine, text) {
  if (engine === "codex") return parseToml(text);
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(frontmatter, "The agent must begin with native frontmatter");
  return parseYaml(frontmatter[1]);
}

function checkProfile(engine, role, text, expected = {}) {
  assert.equal(typeof text, "string", `${engine} ${role} artifact`);
  const agent = nativeAgent(engine, text);
  assert.equal(agent.model, expected.model, `${engine} ${role} model`);
  for (const [provider, { effort }] of Object.entries(nativeFields)) {
    assert.equal(
      agent[effort],
      engine === provider ? expected.reasoning : undefined,
      `${engine} ${role} ${effort}`,
    );
  }
}

function profilesFor(engine) {
  return Object.fromEntries(
    roles.map((role, index) => [
      role,
      {
        model: `${engine}-${role}-model`,
        reasoning: index % 2 === 0 ? "low" : nativeFields[engine].extended,
      },
    ]),
  );
}

const roleProfiles = Object.fromEntries(engines.map((engine) => [engine, profilesFor(engine)]));

async function templateFixture(t) {
  const path = await mkdtemp(join(tmpdir(), "grait-role-profiles-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  await Promise.all(
    ["automation", "config"].map((directory) =>
      cp(new URL(directory, root), join(path, directory), { recursive: true }),
    ),
  );
  return async (config) => {
    await writeFile(join(path, "workflow.config.json"), JSON.stringify(config));
    return generateHarnessFiles(path);
  };
}

for (const engine of engines) {
  test(`template applies independent ${engine} role profiles only to the selected harness`, async (t) => {
    const generate = await templateFixture(t);
    const defaultFiles = await generate({ ...base, engine });
    const configuredFiles = await generate({ ...base, engine, roleProfiles });
    for (const role of roles) {
      const path = artifactPath(engine, role);
      checkProfile(engine, role, configuredFiles.get(path), roleProfiles[engine][role]);
      for (const other of engines.filter((name) => name !== engine)) {
        const inactivePath = artifactPath(other, role);
        assert.equal(configuredFiles.get(inactivePath), defaultFiles.get(inactivePath));
      }
    }
  });

  test(`packaged ${engine} policy without configuration leaves native settings to the harness`, async () => {
    const files = await generateProjectArtifacts({ harness: engine, version: "0.1.0" });
    for (const role of roles) checkProfile(engine, role, files[artifactPath(engine, role)]);
  });

  test(`packaged policy writes ${engine} role profiles in the selected native agent format`, async () => {
    const files = await generateProjectArtifacts({
      harness: engine,
      version: "0.1.0",
      config: { ...base, engine, roleProfiles },
    });
    for (const role of roles) {
      const path = artifactPath(engine, role);
      checkProfile(engine, role, files[path], roleProfiles[engine][role]);
      for (const other of engines.filter((name) => name !== engine))
        assert.equal(files[artifactPath(other, role)], undefined);
    }
  });
}

test("missing role fields inherit legacy settings and documented defaults independently", async (t) => {
  const generate = await templateFixture(t);
  const config = structuredClone(base);
  config.engine = "codex";
  config.orchestrator.reasoning = "low";
  config.tdd.profiles.tester = { model: "legacy-tester-model", reasoning: "high" };
  config.tdd.profiles.implementer = { model: "legacy-implementer-model", reasoning: "medium" };
  config.roleProfiles = {
    codex: {
      orchestrator: { reasoning: "medium" },
      test: { model: null, reasoning: null },
      implement: { model: "configured-implementer-model" },
      review: { model: "configured-reviewer-model" },
      fix: { reasoning: "xhigh" },
    },
  };
  const files = await generate(config);
  for (const [role, expected] of Object.entries({
    orchestrator: { reasoning: "medium" },
    triage: {},
    test: { model: "legacy-tester-model", reasoning: "high" },
    implement: { model: "configured-implementer-model", reasoning: "medium" },
    review: { model: "configured-reviewer-model", reasoning: "high" },
    fix: { model: "legacy-implementer-model", reasoning: "xhigh" },
  })) {
    checkProfile("codex", role, files.get(artifactPath("codex", role)), expected);
  }
});

test("configured packaged policy inherits missing role fields without changing user-owned role settings", async () => {
  const config = structuredClone(base);
  config.engine = "codex";
  config.tdd.profiles.implementer = { model: "legacy-implementer-model", reasoning: "medium" };
  config.roleProfiles = {
    codex: {
      implement: { reasoning: "xhigh" },
      review: { model: "configured-reviewer-model" },
      triage: { model: "configured-triage-model", reasoning: "low" },
    },
  };
  const path = artifactPath("codex", "triage");
  const userRole =
    'name = "grait-triage"\nmodel = "local-triage-model"\nmodel_reasoning_effort = "high"\n';
  const files = await generateProjectArtifacts({
    harness: "codex",
    version: "0.1.0",
    config,
    existing: { [path]: userRole },
  });
  assert.ok(files[path].startsWith(userRole));
  checkProfile("codex", "triage", files[path], { model: "local-triage-model", reasoning: "high" });
  checkProfile("codex", "implement", files[artifactPath("codex", "implement")], {
    model: "legacy-implementer-model",
    reasoning: "xhigh",
  });
  checkProfile("codex", "review", files[artifactPath("codex", "review")], {
    model: "configured-reviewer-model",
    reasoning: "high",
  });
});

test("workflow validation rejects invalid role-profile entries even for inactive harnesses", () => {
  for (const invalid of [
    [],
    { unknown: { test: { model: "test-model" } } },
    { codex: { tester: { reasoning: "high" } } },
    { codex: { review: { permission: "write" } } },
    { codex: { review: { model: " " } } },
    { codex: { review: { model: 42 } } },
    { claude: { review: { reasoning: "ultra" } } },
    { copilot: { review: { reasoning: "minimal" } } },
    { copilot: { review: { model: "provider/private-model" } } },
  ]) {
    assert.throws(
      () => validateConfig({ ...base, engine: "codex", roleProfiles: invalid }),
      undefined,
      JSON.stringify(invalid),
    );
  }
  assert.doesNotThrow(() => validateConfig({ ...base, roleProfiles }));
});
