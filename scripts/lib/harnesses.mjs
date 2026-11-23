import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { stringify as stringifyToml } from "smol-toml";
import { validateConfig } from "./policy.mjs";
import { nativeRoleFields, resolveRoleProfile, workflowRoles } from "./role-profiles.mjs";
const skillRoots = [".agents/skills", ".claude/skills", ".github/skills"];

export function validateAgentDefinitions(definitions) {
  if (!Array.isArray(definitions) || definitions.length !== workflowRoles.length)
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
    if (!workflowRoles.includes(agent.role) || foundRoles.has(agent.role))
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

export function renderCodexConfig(template, config) {
  const setting = /^max_concurrent_threads_per_session = \d+$/m;
  if (!setting.test(template)) throw new Error("Codex template must define its worker limit");
  let rendered = template.replace(
    setting,
    `max_concurrent_threads_per_session = ${config.maxConcurrentWorkers}`,
  );
  if (config.engine === "codex") {
    const profile = config.roleProfiles?.codex?.orchestrator ?? {};
    for (const [key, value] of Object.entries(nativeRoleFields("codex", profile))) {
      const keySetting = new RegExp(`^([ \t]*${key}[ \t]*=[ \t]*).*$`, "m");
      if (!keySetting.test(rendered)) throw new Error(`Codex template must define ${key}`);
      rendered = rendered.replace(keySetting, (_line, prefix) => prefix + JSON.stringify(value));
    }
  }
  return rendered;
}

export async function generateHarnessFiles(root) {
  const definitions = validateAgentDefinitions(
    JSON.parse(await readFile(join(root, "automation/agents.json"), "utf8")),
  );
  const config = validateConfig(
    JSON.parse(await readFile(join(root, "workflow.config.json"), "utf8")),
  );
  const files = new Map();
  files.set(
    ".codex/config.toml",
    renderCodexConfig(await readFile(join(root, "config/codex.toml"), "utf8"), config),
  );
  files.set(
    ".github/copilot-instructions.md",
    "# Shared repository instructions\n\nRead `AGENTS.md`, `docs/coding-guidelines.md`, and `docs/workflow.md` before working. The shared skill and role catalog is in `docs/agents.md`; native adapters are generated from `automation/skills/` and `automation/agents.json`. All agents run in this user-owned harness.\n\nFor PR review, also read `docs/review-guidelines.md`. Evaluate the exact PR head locally without executing untrusted code in the credentialed session; publish findings and formal decisions through the separate GitHub reviewer identity. Humans merge and release.\n",
  );
  for (const agent of definitions) {
    const source = `automation/skills/${agent.skill}/SKILL.md`;
    const text = await readFile(join(root, source), "utf8");
    readSkill(text, agent.skill);
    for (const directory of skillRoots) files.set(`${directory}/${agent.skill}/SKILL.md`, text);
    const roleFields = (engine) =>
      nativeRoleFields(engine, resolveRoleProfile(config, engine, agent.role));
    const instructions = `Read AGENTS.md and apply the ${agent.skill} skill at ${source}. All AI roles run in this user-owned harness, using its native login and subscription. Follow docs/worktrees.md: separate unrelated tasks from the orchestrator; the tester and implementer for one issue take sequential exclusive ownership of the SAME branch and worktree at the committed handoff SHA. Never start their stages concurrently or silently branch a handoff from the default branch. Inherit harness permissions; a role grants no additional authority. Use npm run orchestrator for queue policy and npm run github for GitHub publishing.\n`;
    files.set(
      `.codex/agents/${agent.name}.toml`,
      `# Generated from automation/agents.json; run npm run harness:generate.\n${stringifyToml({ name: agent.name, description: agent.description, developer_instructions: instructions, ...roleFields("codex") })}`,
    );
    const body = `<!-- Generated from automation/agents.json; run npm run harness:generate. -->\n\n${instructions}`;
    files.set(
      `.claude/agents/${agent.name}.md`,
      `---\n${stringify({ name: agent.name, description: agent.description, ...(["triage", "review"].includes(agent.role) ? { isolation: "worktree" } : {}), ...roleFields("claude") })}---\n\n${body}`,
    );
    files.set(
      `.github/agents/${agent.name}.agent.md`,
      `---\n${stringify({ name: agent.name, description: agent.description, "include-custom-instructions": true, ...roleFields("copilot") })}---\n\n${body}`,
    );
  }
  return files;
}
