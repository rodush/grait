<!-- Generated from automation/skills/grait-implement/SKILL.md; edit the source and run npm run compile. -->

# Implement a claimed GRAIT issue

Read the repository's [shared instructions](../../../AGENTS.md), [coding guidelines](../../../docs/coding-guidelines.md), and [work lifecycle](../../../docs/workflow.md). Confirm the issue's accepted outcome and a controller-confirmed In Progress claim. A delegated subtask shares its parent issue's claim; do not acquire an additional story slot for it.

If no claim exists, have an authorized operator request `claim-local` and wait for the controller's claim comment before starting. Never move Project Status directly to bypass dependency or capacity checks. Clarify choices that would change the implementation instead of choosing a stack or product behavior without authorization.

Implement within the accepted scope and permitted paths. Run meaningful behavioral checks, preserve their evidence, and open an issue-linked PR using Conventional Commits. Report missing validation honestly. Humans retain merge and release authority.

Inside the hosted implementation workflow, follow the [safe-output contract](../../../automation/prompts/implement.md). In a local harness, use the claimed issue's isolated branch and the operator-authorized GitHub identity. Protected policy or automation changes require human handling.

## Worktree ownership

For local execution, use a worktree separate from the coordinator and unrelated sub-agents. Tester and implementer assigned to one issue share that issue’s worktree and branch with sequential exclusive ownership. Follow the [worktree protocol](../../../docs/worktrees.md). Record and verify the committed handoff SHA before transferring ownership; never allow concurrent writes. The coordinator integrates accepted commits and cleans up task-owned worktrees after merge. Hosted API-only roles retain their no-checkout policy.
