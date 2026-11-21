import { readFile } from "node:fs/promises";

import { packageResource } from "./resources.mjs";

const policyUrl = packageResource("automation/policy/shared.md");
const roles = {
  orchestrator: {
    description: "Coordinate the Project queue and local specialist handoffs.",
    instructions:
      "Inspect `grait orchestrator status`, resume existing claims, and prioritize Review. Select eligible Ready stories without waiting for the operator to name them. Use Project priorities, dependency order, then queue order. Honor the admission checks and claim independent stories while Project and worker slots are available, even when other claims are active. Replenish Ready from Backlog as slots open, up to five stories, without delaying eligible Ready claims. Keep blocked stories in Backlog until their dependencies complete. Report paused candidates and consider the next eligible story. Refresh the queue as capacity or eligibility changes. Delegate triage, testing, implementation, review, and fixes to local specialists in explicitly assigned worktrees. Accept current readiness with `grait orchestrator ready --issue N --file PATH`, claim with `grait orchestrator claim --issue N`, and prepare its worktree with `grait orchestrator worktree --issue N`. Recheck pause state, exact head, ownership, and capacity before every stage. Independently verify Red and Green with `grait orchestrator verify`. Publish finished changes with `grait github`. Submit independent reviews for the current PR head through `grait orchestrator review` using the separate reviewer identity. Synchronize confirmed merge state with `grait orchestrator sync`. Humans merge and release.",
  },
  triage: {
    description: "Assess issue scope, acceptance, validation, and native blockers.",
    instructions:
      "Inspect the current issue, discussion, related work, and native blocked-by relationships. Return readiness bound to the exact current issue title/body digest and actual blockers, with explicit scope, acceptance, validation, dependencies, and alignment checks. Return `ready: false` while any blocker remains incomplete or a material question remains unanswered. The orchestrator accepts the assessment using `grait orchestrator ready` and manages Project status.",
  },
  test: {
    description: "Write acceptance tests before implementation and hand off verified Red.",
    instructions:
      "Own only configured test paths in the assigned shared issue worktree. Write meaningful behavioral tests and commit them. Return exact baseline and test SHAs, acceptance digest, and expected stable failure IDs for independent Red verification. Never edit production. Relinquish ownership before the implementer starts. Give only the acceptance contract and explicitly public sanitized observations to implementation; keep test source and fixture internals private.",
  },
  implement: {
    description: "Implement accepted behavior after independent Red verification.",
    instructions:
      "Verify the accepted issue claim, assigned worktree, exact committed handoff, and exclusive ownership. Start only after independently verified Red. Own production paths only; never read, edit, delete, or rename tests or fixtures. Work from the acceptance contract and sanitized behavioral feedback. Complete scope and documentation, commit changes, then return exact SHA and validation for independent full-suite Green. If the test contract needs correction, commit allowed changes and return ownership to the tester with a concrete reason. Publish finished changes through `grait github` after Green.",
  },
  review: {
    description: "Independently review the exact pull request head.",
    instructions:
      "Read trusted project policy and current GitHub reviews and threads. Inspect the exact requested head in a separate review worktree. Never execute contributor code in a credentialed session. Return stable finding IDs, severity, evidence, actionable corrections, and an APPROVE, REQUEST_CHANGES, or COMMENT decision. Have the orchestrator publish the structured review through `grait orchestrator review` using the separate reviewer identity, then verify the remote result. Verify fixes against the current head and retain original threads. Human approval, merge, and release remain human-only.",
  },
  fix: {
    description: "Address published findings within the existing issue and review loop.",
    instructions:
      "Read published findings and original review threads directly from GitHub. Stay within the existing issue claim and accepted fix scope. Use `grait orchestrator next` for the accepted cycle; incremental fixes stay Review and redesign reacquires capacity. Repeat tester-first ownership, independent Red, implementation, and independent Green. Own production only during implementation; never inspect test internals. Return finding IDs, exact committed head, and verification evidence for the original review threads. Stop at bounded-loop limits and leave human objections for humans.",
  },
};

function validateVersion(version) {
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  )
    throw new Error("Provide a safe semantic policy version");
}

function updateManaged(original, body, version, { comment = false } = {}) {
  const start = comment ? "# grait:policy:start version=" : "<!-- grait:policy:start version=";
  const end = comment ? "# grait:policy:end" : "<!-- grait:policy:end -->";
  const opening = comment ? `${start}${version}` : `${start}${version} -->`;
  const managed = `${opening}\n${body.trim()}\n${end}`;
  // Every recognized marker must belong to exactly one complete, ordered section.
  const markerCount = (original.match(/grait:policy:(?:start|end)/g) || []).length;
  if (!markerCount)
    return `${original}${original && !original.endsWith("\n") ? "\n" : ""}${original ? "\n" : ""}${managed}\n`;
  const pattern = comment
    ? /^# grait:policy:start version=[^\r\n]+\r?\n[\s\S]*?^# grait:policy:end$/m
    : /<!-- grait:policy:start version=[^\r\n<>]+ -->\r?\n[\s\S]*?<!-- grait:policy:end -->/;
  const match = original.match(pattern);
  if (markerCount !== 2 || !match)
    throw new Error("Malformed or duplicate GRAIT managed policy boundaries");
  return original.slice(0, match.index) + managed + original.slice(match.index + match[0].length);
}

function roleBody(role, instructions) {
  return (
    "# GRAIT " +
    role +
    "\n\nRead `AGENTS.md` and the project's own stack and command reference. " +
    instructions +
    "\n\nUse the packaged `grait orchestrator` and `grait github` commands from the target repository. This role grants no additional permissions."
  );
}

function frontmatter(name, description) {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n`;
}

/** Return durable project artifacts without reading or writing the target repository. */
export async function generateProjectArtifacts({ harness, version, project = {}, existing = {} }) {
  if (!["codex", "claude", "copilot"].includes(harness))
    throw new Error("Choose a supported harness: codex, claude, or copilot");
  validateVersion(version);
  if (!project || typeof project !== "object" || Array.isArray(project))
    throw new Error("Project context must be an object");
  if (!existing || typeof existing !== "object" || Array.isArray(existing))
    throw new Error("Existing artifacts must be a path-to-text object");
  for (const value of Object.values(existing))
    if (typeof value !== "string") throw new Error("Existing artifact content must be text");
  for (const key of ["name", "context"])
    if (project[key] !== undefined && typeof project[key] !== "string")
      throw new Error("Project name and context must be text");
  if ([project.name, project.context].some((text) => text?.includes("grait:policy:")))
    throw new Error("Project context cannot contain managed policy boundaries");
  const policy = (
    typeof GRAIT_SHARED_POLICY === "string"
      ? GRAIT_SHARED_POLICY
      : await readFile(policyUrl, "utf8")
  ).trim();
  const artifacts = {};
  const emit = (path, body, options = {}) => {
    const original = existing[path] ?? options.initial ?? "";
    artifacts[path] = updateManaged(original, body, version, options);
  };
  const context = [project.name ? `# ${project.name}` : "# Project instructions", project.context]
    .filter(Boolean)
    .join("\n\n");
  emit("AGENTS.md", `${context}\n\n${policy}`);
  const harnessInstructions =
    "Read `AGENTS.md` for shared engineering policy and the project's stack and exact commands. Use `grait orchestrator` for local queue coordination and `grait github` for scoped publishing. Apply the selected GRAIT role instructions. Humans approve, merge, and release.";
  if (harness === "codex") {
    emit(
      ".codex/config.toml",
      "# GRAIT role instructions are installed in .codex/agents and .agents/skills.\n# Read AGENTS.md; run grait orchestrator and grait github from this repository.\n# Existing model, permissions, and other user settings remain authoritative.",
      { comment: true },
    );
  } else {
    emit(
      harness === "claude" ? "CLAUDE.md" : ".github/copilot-instructions.md",
      harnessInstructions,
    );
  }
  for (const [role, definition] of Object.entries(roles)) {
    const name = `grait-${role}`;
    const body = roleBody(role, definition.instructions);
    const skillRoot =
      harness === "codex"
        ? ".agents/skills"
        : harness === "claude"
          ? ".claude/skills"
          : ".github/skills";
    emit(`${skillRoot}/${name}/SKILL.md`, body, {
      initial: frontmatter(name, definition.description),
    });
    if (harness === "codex") {
      // Standalone role files keep project-level model and permission settings intact.
      const instructions = `${body}\n\n${harnessInstructions}`;
      const rolePath = `.codex/agents/${name}.toml`;
      const original = existing[rolePath] || "";
      const unmanaged = original.replace(
        /^# grait:policy:start version=[^\r\n]+\r?\n[\s\S]*?^# grait:policy:end$/m,
        "",
      );
      // A pre-existing named role can contain arbitrary valid TOML strings and
      // settings. Preserve it verbatim; its companion skill supplies the managed
      // instructions without appending duplicate TOML keys or table definitions.
      const userRole = /^\s*(?:name|description|developer_instructions)\s*=/m.test(unmanaged);
      const roleConfig = userRole
        ? instructions
            .split("\n")
            .map((line) => `# ${line}`)
            .join("\n")
        : `name = ${JSON.stringify(name)}\ndescription = ${JSON.stringify(definition.description)}\ndeveloper_instructions = ${JSON.stringify(instructions)}`;
      emit(rolePath, roleConfig, { comment: true });
    } else {
      const path =
        harness === "claude" ? `.claude/agents/${name}.md` : `.github/agents/${name}.agent.md`;
      emit(path, body, { initial: frontmatter(name, definition.description) });
    }
  }
  return artifacts;
}
