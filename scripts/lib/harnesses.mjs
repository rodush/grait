import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { stringify as stringifyToml } from "smol-toml";

const roles = ["orchestrator", "triage", "test", "implement", "review", "fix"];
const skillRoots = [".agents/skills", ".claude/skills"];

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
    if (agent.execution !== "local")
      throw new Error("Every role must run in the user's local harness");
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
  files.set(".codex/config.toml", await readFile(join(root, "config/codex.toml"), "utf8"));
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
    const instructions = `Read AGENTS.md and apply the ${agent.skill} skill at ${source}. All AI roles run in this user-owned harness, using its native login and subscription. Follow docs/worktrees.md: separate unrelated tasks from the orchestrator; the tester and implementer for one issue take sequential exclusive ownership of the SAME branch and worktree at the committed handoff SHA. Never start their stages concurrently or silently branch a handoff from the default branch. Inherit harness permissions; a role grants no additional authority. Use npm run orchestrator for queue policy and npm run github for GitHub publishing.\n`;
    files.set(
      `.codex/agents/${agent.name}.toml`,
      `# Generated from automation/agents.json; run npm run harness:generate.\n${stringifyToml({ name: agent.name, description: agent.description, developer_instructions: instructions, ...(config.engine === "codex" && profile.model ? { model: profile.model } : {}), ...(config.engine === "codex" && profile.reasoning ? { model_reasoning_effort: profile.reasoning } : agent.role === "orchestrator" ? { model_reasoning_effort: config.orchestrator.reasoning } : agent.role === "review" ? { model_reasoning_effort: "high" } : {}) })}`,
    );
    const body = `<!-- Generated from automation/agents.json; run npm run harness:generate. -->\n\n${instructions}`;
    files.set(
      `.claude/agents/${agent.name}.md`,
      `---\n${stringify({ name: agent.name, description: agent.description, ...(["triage", "review"].includes(agent.role) ? { isolation: "worktree" } : {}), ...(config.engine === "claude" && profile.model ? { model: profile.model } : {}), effort: config.engine === "claude" && profile.reasoning ? profile.reasoning : agent.role === "review" ? "high" : config.orchestrator.reasoning })}---\n\n${body}`,
    );
  }
  return files;
}
