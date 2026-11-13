import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { stringify as stringifyToml } from "smol-toml";

const roles = ["triage", "test", "implement", "review", "fix"];
const skillRoots = [".agents/skills", ".claude/skills", ".github/skills"];

export function validateAgentDefinitions(definitions) {
  if (!Array.isArray(definitions) || definitions.length !== roles.length)
    throw new Error("Define exactly one agent for each workflow role");
  const names = new Set();
  const foundRoles = new Set();
  for (const agent of definitions) {
    if (
      Object.keys(agent).some(
        (key) => !["role", "name", "description", "skill", "execution"].includes(key),
      )
    )
      throw new Error("Agent definitions cannot override model, permissions, or harness settings");
    if (!roles.includes(agent.role) || foundRoles.has(agent.role))
      throw new Error("Unknown or duplicate agent role");
    if (!/^grait-[a-z0-9-]+$/.test(agent.name) || agent.name.length >= 64 || names.has(agent.name))
      throw new Error("Invalid or duplicate agent name");
    if (
      agent.skill !== agent.name ||
      typeof agent.description !== "string" ||
      !agent.description.trim()
    )
      throw new Error("Each agent needs a matching skill and description");
    if (agent.execution !== (agent.role === "review" ? "hosted-review" : "local-and-hosted"))
      throw new Error("Review evaluation must remain hosted");
    names.add(agent.name);
    foundRoles.add(agent.role);
  }
  return definitions;
}

export function readSkill(text, expectedName) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error(`Missing skill frontmatter for ${expectedName}`);
  const metadata = parse(match[1]);
  if (
    metadata.name !== expectedName ||
    typeof metadata.description !== "string" ||
    !metadata.description.trim()
  )
    throw new Error(`Invalid skill metadata for ${expectedName}`);
  return { metadata, body: match[2].trimStart() };
}

export async function generateHarnessFiles(root) {
  const definitions = validateAgentDefinitions(
    JSON.parse(await readFile(join(root, "automation/agents.json"), "utf8")),
  );
  const config = JSON.parse(await readFile(join(root, "workflow.config.json"), "utf8"));
  const files = new Map();
  for (const agent of definitions) {
    const source = `automation/skills/${agent.skill}/SKILL.md`;
    const text = await readFile(join(root, source), "utf8");
    readSkill(text, agent.skill);
    for (const directory of skillRoots) files.set(`${directory}/${agent.skill}/SKILL.md`, text);
    const profile =
      config.tdd?.profiles?.[
        agent.role === "test"
          ? "tester"
          : ["implement", "fix"].includes(agent.role)
            ? "implementer"
            : ""
      ] || {};
    const instructions = `Read AGENTS.md and apply the ${agent.skill} skill at ${source}. Follow its distinction between local and controller-authorized hosted execution. Use a local worktree separate from the coordinator and unrelated sub-agents; the tester and implementer for one issue share its worktree and branch with sequential exclusive ownership; follow docs/worktrees.md for sequential commit handoffs and cleanup after merge. Apply configured role model/reasoning only when this harness matches workflow.config.json engine; other harnesses inherit the parent model/reasoning; inherit permissions; this role grants no additional authority.\n`;
    files.set(
      `.codex/agents/${agent.name}.toml`,
      `# Generated from automation/agents.json; run npm run harness:generate.\n${stringifyToml({ name: agent.name, description: agent.description, developer_instructions: instructions, ...(config.engine === "codex" && profile.model ? { model: profile.model } : {}), ...(config.engine === "codex" && profile.reasoning ? { model_reasoning_effort: profile.reasoning } : {}) })}`,
    );
    const body = `<!-- Generated from automation/agents.json; run npm run harness:generate. -->\n\n${instructions}`;
    files.set(
      `.claude/agents/${agent.name}.md`,
      `---\n${stringify({ name: agent.name, description: agent.description, ...(config.engine === "claude" && profile.model ? { model: profile.model } : {}) })}---\n\n${body}`,
    );
    files.set(
      `.github/agents/${agent.name}.agent.md`,
      `---\n${stringify({ name: agent.name, description: agent.description, ...(config.engine === "copilot" && profile.model ? { model: profile.model } : {}) })}---\n\n${body}`,
    );
  }
  return files;
}
