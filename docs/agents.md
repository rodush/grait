# Skills and agent roles

The canonical catalog is `automation/agents.json`; role instructions live under `automation/skills/`. All roles execute in the user's Codex or Claude Code harness using its native login.

| Role                 | Responsibility                                                                       |
| -------------------- | ------------------------------------------------------------------------------------ |
| `grait-orchestrator` | Parent session: manage the queue, claims, worker capacity, handoffs, and PR delivery |
| `grait-triage`       | Clarify scope, acceptance, validation, and native blockers                           |
| `grait-test`         | Write acceptance tests and hand independent Red evidence to the implementer          |
| `grait-implement`    | Implement accepted work without reading or changing tests                            |
| `grait-review`       | Evaluate the exact PR head and return inline findings/formal review data             |
| `grait-fix`          | Correct published findings within the existing claim and loop bounds                 |

## Generated adapters

`npm run harness:generate` installs skills under `.agents/skills/` for Codex and `.claude/skills/` for Claude Code, plus native role definitions under `.codex/agents/` and `.claude/agents/`. It also installs canonical `config/codex.toml` as `.codex/config.toml`. Edit sources, regenerate, and commit the resulting adapters. `npm run check` verifies drift.

Start the main orchestrator with `npm run orchestrator -- start`. Within an existing native session, ask it to apply the `grait-orchestrator` skill. It delegates the other roles using supported native tools, or starts a role session in an assigned issue worktree with `npm run orchestrator -- worker --issue N --role test|implement|fix`. A role definition does not authorize unclaimed work, extra permissions, or another story slot.

Tester and implementer use the same issue branch/worktree sequentially at exact committed handoffs. Claude's automatic worktree isolation is limited to independent triage/review roles to avoid accidentally branching an implementation handoff from the default branch. See [worktrees](worktrees.md) and [TDD](tdd.md).

## Review and models

Review evaluation happens locally in a separate session. The parent publishes the result using the reviewer App through `orchestrator review`; it never routes evaluation to Actions. Writer and reviewer are two GitHub publishing identities shared by the relevant roles, not two provider accounts. Human approval remains required.

The orchestrator defaults to medium reasoning; reviewer to high. Tester/implementer overrides use `workflow.config.json` and otherwise inherit native defaults. Native sub-agents share the user's subscription allowance; stop at saved handoffs rather than switching silently to API billing. See the [configuration reference](setup.md).

Native formats follow [Codex sub-agents](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents).
