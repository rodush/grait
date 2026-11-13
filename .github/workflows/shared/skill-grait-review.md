<!-- Generated from automation/skills/grait-review/SKILL.md; edit the source and run npm run compile. -->

# Route GRAIT PR review

Review evaluation runs only in the controller-authorized GitHub Actions review workflow. Findings and formal decisions belong in the PR UI.

## Local harness

Identify the PR and its current head. Inspect the controller ledger, hosted run status, and already-published findings. If a current review is missing and the operator authorized a review, request controller reconciliation once:

```sh
gh workflow run controller.yml -f task=reconcile
```

Wait for or report the hosted run's state. Do not analyze the diff locally, produce local code-review findings, submit a local approval, or dispatch `review.lock.yml` directly. A paused or exhausted loop needs the operator's decision; repeated dispatches cannot reset it.

## Authorized hosted workflow

Apply the [review policy](../../../docs/review-guidelines.md) and [hosted review contract](../../../automation/prompts/review.md) to the exact requested head. Read contributor code through GitHub APIs without executing it. Publish actionable inline findings and one formal review with stable finding IDs and matching controller metadata. A stale head, missing evidence, or conflicting instructions cannot authorize a merge.

## Worktree ownership

For local execution, use a worktree separate from the coordinator and unrelated sub-agents. Tester and implementer assigned to one issue share that issue’s worktree and branch with sequential exclusive ownership. Follow the [worktree protocol](../../../docs/worktrees.md). Record and verify the committed handoff SHA before transferring ownership; never allow concurrent writes. The coordinator integrates accepted commits and cleans up task-owned worktrees after merge. Hosted API-only roles retain their no-checkout policy.
