# Shared skills and agent definitions

The canonical skills live in `automation/skills/`; `automation/agents.json` defines the corresponding roles. These are repository-scoped workflow skills, intended to travel with GRAIT's policies and controller.

| Role              | Skill                                                           | Responsibility                                                    |
| ----------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| `grait-triage`    | [Triage](../automation/skills/grait-triage/SKILL.md)            | Clarify scope, acceptance, validation, and blocking relationships |
| `grait-implement` | [Implementation](../automation/skills/grait-implement/SKILL.md) | Implement an already claimed issue and prepare its PR             |
| `grait-review`    | [Hosted review](../automation/skills/grait-review/SKILL.md)     | Review in Actions; locally, request or inspect that hosted review |
| `grait-fix`       | [Follow-up fixes](../automation/skills/grait-fix/SKILL.md)      | Address hosted findings within the existing claim and loop budget |

## Harness adapters

`npm run harness:generate` produces skills in `.agents/skills/` for Codex, `.claude/skills/` for Claude Code, and `.github/skills/` for Copilot. It also produces native agent definitions in `.codex/agents/*.toml`, `.claude/agents/*.md`, and `.github/agents/*.agent.md`. The adapters refer to the same canonical skills and inherit their harness's model and permissions.

Use the named role or skill through the harness's supported invocation mechanism. For example, invoke `$grait-implement` in Codex for an already claimed issue, or ask the harness to assign that issue to `grait-implement`. Defining roles does not authorize extra work, external writes, parallel story claims, or permission changes.

For PR review, a local invocation dispatches or observes the controller's hosted workflow. It never performs local code review. The review workflow imports the same skill, enforces controller authorization, and publishes findings in GitHub. Local triage similarly prepares an assessment; the hosted workflow supplies the published readiness attestation.

## Maintain the shared definitions

Edit canonical skills or role metadata, then run:

```sh
npm run format
npm run harness:generate
npm run compile
npm run check
```

Generated files are committed and checked for drift. The gh-aw compiler embeds the skill bodies in shared workflow fragments, so hosted jobs do not depend on local harness discovery. Keep controller inputs and output schemas in `automation/prompts/`; portable skills explain the task and execution boundaries.

Native formats follow the [Codex agent reference](https://learn.chatgpt.com/docs/agent-configuration/subagents), [Claude Code agent reference](https://code.claude.com/docs/en/sub-agents), and [Copilot agent reference](https://docs.github.com/en/copilot/reference/custom-agents-configuration). Skills use the shared `SKILL.md` format with each harness's discovery location.

## Coordinator responsibilities

The coordinator keeps its checkout isolated and assigns separate worktrees to unrelated sub-agents. The tester and implementer for the same issue share one worktree and branch, handing over exclusive ownership sequentially. It records the role, scope, base SHA, and handoff evidence, serializes tester/implementer ownership of the shared issue branch, and verifies commits before integration. See [the worktree protocol](worktrees.md), including cleanup after human merge.
