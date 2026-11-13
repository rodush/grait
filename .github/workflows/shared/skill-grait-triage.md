<!-- Generated from automation/skills/grait-triage/SKILL.md; edit the source and run npm run compile. -->

# Triage a GRAIT issue

Read the repository's [shared instructions](../../../AGENTS.md) and [work lifecycle](../../../docs/workflow.md). Inspect the issue, its discussion, related issues, open PRs, and native blocked-by relationships.

Identify unresolved choices, duplicate or overlapping work, sequencing constraints, and cycles. Produce measurable acceptance criteria, a validation approach, explicit blockers, and concrete questions where requirements remain ambiguous. A known open blocker can remain on a Ready issue; implementation waits for its completion.

Inside the controller-authorized triage workflow, follow the [hosted output contract](../../../automation/prompts/triage.md). The controller records native blockers and validates the current issue digest before moving the issue to Ready.

In a local harness, return the assessment and any proposed issue edits to the operator. Use the controller's triage workflow for the published readiness attestation; do not forge an attestation or move the issue to Ready yourself. If discussion changes the requirements, update the issue description only within the operator's authorization so that subsequent triage evaluates the agreed scope.

## Worktree ownership

For local execution, use a worktree separate from the coordinator and unrelated sub-agents. Tester and implementer assigned to one issue share that issue’s worktree and branch with sequential exclusive ownership. Follow the [worktree protocol](../../../docs/worktrees.md). Record and verify the committed handoff SHA before transferring ownership; never allow concurrent writes. The coordinator integrates accepted commits and cleans up task-owned worktrees after merge. Hosted API-only roles retain their no-checkout policy.
