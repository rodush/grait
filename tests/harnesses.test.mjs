import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse } from "yaml";
import {
  generateHarnessFiles,
  readSkill,
  validateAgentDefinitions,
} from "../scripts/lib/harnesses.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const definitions = JSON.parse(
  await readFile(new URL("../automation/agents.json", import.meta.url), "utf8"),
);
const roles = ["orchestrator", "triage", "test", "implement", "review", "fix"];

test("the native catalog exposes six subscription-backed local roles including orchestrator", () => {
  assert.deepEqual(definitions.map(({ role }) => role).sort(), roles.toSorted());
  assert.ok(definitions.every(({ execution }) => execution === "local"));
  assert.doesNotThrow(() => validateAgentDefinitions(definitions));
});

test("agent definitions cannot grant model permissions or re-enable hosted execution", () => {
  for (const key of ["model", "sandbox_mode", "approval_policy", "tools"]) {
    const changed = structuredClone(definitions);
    changed[0][key] = "override";
    assert.throws(() => validateAgentDefinitions(changed));
  }
  const changed = structuredClone(definitions);
  changed.find(({ role }) => role === "review").execution = "hosted-review";
  assert.throws(() => validateAgentDefinitions(changed));
});

test("role metadata rejects duplicate identities and paths outside the skill catalog", () => {
  const duplicate = structuredClone(definitions);
  duplicate[1].name = duplicate[0].name;
  assert.throws(() => validateAgentDefinitions(duplicate));
  const escaped = structuredClone(definitions);
  escaped[0].skill = "../../outside";
  assert.throws(() => validateAgentDefinitions(escaped));
});

test("skill frontmatter identifies the expected portable skill", () => {
  assert.throws(() => readSkill("# No metadata", "grait-triage"), /frontmatter/);
  assert.throws(
    () => readSkill("---\nname: another\ndescription: Triage\n---\nBody", "grait-triage"),
    /metadata/,
  );
});

test("native agents support all three subscription harnesses without hosted adapters", async () => {
  const files = await generateHarnessFiles(root);
  assert.ok(files.has(".github/agents/grait-orchestrator.agent.md"));
  const instructions = files.get(".github/copilot-instructions.md");
  assert.equal(typeof instructions, "string");
  assert.match(instructions, /AGENTS\.md/);
  assert.match(instructions, /local|native|user.*harness/i);
  assert.doesNotMatch(instructions, /gh-aw compile|workflow_dispatch/);
  assert.ok(files.has(".codex/agents/grait-orchestrator.toml"));
  assert.ok(files.has(".claude/agents/grait-orchestrator.md"));
  for (const agent of definitions) {
    const codexSource = files.get(`.codex/agents/${agent.name}.toml`);
    assert.equal(typeof codexSource, "string");
    const codex = parseToml(codexSource);
    assert.equal(codex.name, agent.name);
    assert.ok(codex.developer_instructions.includes(`automation/skills/${agent.skill}/SKILL.md`));
    for (const key of ["api_key", "base_url", "model_provider", "approval_policy", "sandbox_mode"])
      assert.equal(Object.hasOwn(codex, key), false);
    const text = files.get(`.claude/agents/${agent.name}.md`);
    assert.equal(typeof text, "string");
    const frontmatter = parse(text.split("\n---")[0].slice(4));
    assert.equal(frontmatter.name, agent.name);
    const copilotText = files.get(`.github/agents/${agent.name}.agent.md`);
    assert.equal(typeof copilotText, "string");
    const copilot = parse(copilotText.split("\n---")[0].slice(4));
    assert.equal(copilot.name, agent.name);
    assert.equal(copilot["include-custom-instructions"], true);
    assert.equal(copilot.model, undefined);
    for (const key of [
      "isolation",
      "effort",
      "model_reasoning_effort",
      "model_provider",
      "api_key",
    ])
      assert.equal(copilot[key], undefined);
    if (["triage", "review"].includes(agent.role)) assert.equal(frontmatter.isolation, "worktree");
    else assert.notEqual(frontmatter.isolation, "worktree");
    if (agent.role === "orchestrator") {
      assert.equal(codex.model_reasoning_effort, "medium");
      assert.equal(frontmatter.effort, "medium");
      assert.equal(copilot.reasoningEffort, "medium");
    }
    if (agent.role === "review") {
      assert.equal(codex.model_reasoning_effort, "high");
      assert.equal(frontmatter.effort, "high");
      assert.equal(copilot.reasoningEffort, "high");
    }
  }
});

test("portable local skills have no hosted inputs or BYOK requirement", async () => {
  const files = await generateHarnessFiles(root);
  for (const agent of definitions) {
    for (const directory of [".agents/skills", ".claude/skills", ".github/skills"]) {
      const text = files.get(`${directory}/${agent.skill}/SKILL.md`);
      assert.equal(typeof text, "string");
      assert.equal(readSkill(text, agent.skill).metadata.name, agent.skill);
      assert.ok(!text.includes("${{ inputs."));
      assert.doesNotMatch(text, /(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_API_KEY)/);
    }
  }
});

test("role model profiles apply only to the selected native harness", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "grait-harness-profile-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await cp(join(root, "automation"), join(temporary, "automation"), { recursive: true });
  await cp(join(root, "config"), join(temporary, "config"), { recursive: true });
  const original = JSON.parse(await readFile(join(root, "workflow.config.json"), "utf8"));
  for (const engine of ["codex", "claude", "copilot"]) {
    const selected = structuredClone(original);
    selected.engine = engine;
    selected.supportedEngines = ["codex", "claude", "copilot"];
    selected.tdd.profiles.tester = { model: `${engine}-test-model`, reasoning: "high" };
    selected.tdd.profiles.implementer = {
      model: `${engine}-implementation-model`,
      reasoning: "medium",
    };
    await writeFile(join(temporary, "workflow.config.json"), JSON.stringify(selected));
    const files = await generateHarnessFiles(temporary);
    for (const role of ["test", "implement", "fix"]) {
      const expected =
        role === "test" ? selected.tdd.profiles.tester : selected.tdd.profiles.implementer;
      const codex = parseToml(files.get(`.codex/agents/grait-${role}.toml`));
      const claudeText = files.get(`.claude/agents/grait-${role}.md`);
      const claude = parse(claudeText.split("\n---")[0].slice(4));
      const copilotText = files.get(`.github/agents/grait-${role}.agent.md`);
      assert.equal(typeof copilotText, "string");
      const copilot = parse(copilotText.split("\n---")[0].slice(4));
      assert.equal(codex.model, engine === "codex" ? expected.model : undefined);
      assert.equal(claude.model, engine === "claude" ? expected.model : undefined);
      assert.equal(copilot.model, engine === "copilot" ? expected.model : undefined);
      assert.equal(copilot.model_reasoning_effort, undefined);
      assert.equal(copilot.effort, undefined);
      assert.equal(copilot.isolation, undefined);
    }
  }
});
