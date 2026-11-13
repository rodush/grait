import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("agent definitions cannot add model or permission overrides", () => {
  for (const key of ["model", "sandbox_mode", "approval_policy", "tools"]) {
    const changed = structuredClone(definitions);
    changed[0][key] = "override";
    assert.throws(() => validateAgentDefinitions(changed), /cannot override/);
  }
});

test("the review role cannot be reclassified for local evaluation", () => {
  const changed = structuredClone(definitions);
  changed.find((agent) => agent.role === "review").execution = "local-and-hosted";
  assert.throws(() => validateAgentDefinitions(changed), /remain hosted/);
});

test("role metadata rejects duplicate identities and paths outside the skill catalog", () => {
  const duplicate = structuredClone(definitions);
  duplicate[1].name = duplicate[0].name;
  assert.throws(() => validateAgentDefinitions(duplicate), /duplicate/);
  const escaped = structuredClone(definitions);
  escaped[0].skill = "../../outside";
  assert.throws(() => validateAgentDefinitions(escaped), /matching skill/);
});

test("skill frontmatter must identify the expected skill", () => {
  assert.throws(() => readSkill("# No metadata", "grait-triage"), /frontmatter/);
  assert.throws(
    () => readSkill("---\nname: another\ndescription: Triage\n---\nBody", "grait-triage"),
    /metadata/,
  );
});

test("native definitions preserve parent configuration across all three schemas", async () => {
  const files = await generateHarnessFiles(root);
  for (const agent of definitions) {
    const codex = parseToml(files.get(`.codex/agents/${agent.name}.toml`));
    assert.deepEqual(Object.keys(codex).sort(), ["description", "developer_instructions", "name"]);
    assert.equal(codex.name, agent.name);
    assert.ok(codex.developer_instructions.includes(`automation/skills/${agent.skill}/SKILL.md`));
    for (const [directory, suffix] of [
      [".claude/agents", ".md"],
      [".github/agents", ".agent.md"],
    ]) {
      const text = files.get(`${directory}/${agent.name}${suffix}`);
      const frontmatter = parse(text.split("\n---")[0].slice(4));
      assert.deepEqual(Object.keys(frontmatter).sort(), ["description", "name"]);
      assert.equal(frontmatter.name, codex.name);
    }
  }
});

test("portable skills contain no unresolved hosted input expressions", async () => {
  const files = await generateHarnessFiles(root);
  for (const agent of definitions) {
    for (const directory of [".agents/skills", ".claude/skills", ".github/skills"]) {
      const text = files.get(`${directory}/${agent.skill}/SKILL.md`);
      assert.equal(readSkill(text, agent.skill).metadata.name, agent.skill);
      assert.ok(!text.includes("${{ inputs."));
    }
  }
});
