<!-- Generated from automation/skills/grait-fix/SKILL.md; edit the source and run npm run compile. -->

# Address hosted GRAIT findings

Read the current PR head, its hosted review, the linked issue, and the controller ledger. Apply the [work lifecycle](../../../docs/workflow.md) and [coding guidelines](../../../docs/coding-guidelines.md). Verify that automation is not paused and that the ten-round lifetime review budget has not been exhausted.

Make focused corrections while the issue stays in Review. If the reviewer requires rethinking the approach, wait until the controller reserves an In Progress slot and records that transition before reimplementing. Stop for conflicting instructions, recurring code reversals, or a blocker that survives two completed fix attempts.

Validate the corrected behavior and preserve evidence. Never dismiss a human objection, reset the ledger, force-push, merge, or publish a release to complete the loop. A new head receives another hosted review; do not review it locally.

Inside the hosted fix workflow, follow the [incremental safe-output contract](../../../automation/prompts/fix.md). Local authors may update their own branch within the operator's authorization after checking the same stop conditions. Fork branches remain the contributor's responsibility.

## Worktree ownership

For local execution, use a worktree separate from the coordinator and unrelated sub-agents. Tester and implementer assigned to one issue share that issue’s worktree and branch with sequential exclusive ownership. Follow the [worktree protocol](../../../docs/worktrees.md). Record and verify the committed handoff SHA before transferring ownership; never allow concurrent writes. The coordinator integrates accepted commits and cleans up task-owned worktrees after merge. Hosted API-only roles retain their no-checkout policy.

## TDD boundary

Never create, edit, delete, or rename test files. The tester owns all configured test paths. Start only at the controller-accepted Red SHA; change production paths only. If tests are incorrect or incomplete, hand back to the tester with a reason. The independent runner must verify full-suite Green before review. Use `docs/tdd.md` for the handoff contract.

## Tests are a black box

Implement acceptance criteria and public behavior; do not read test source, fixtures, assertion implementations, or test internals to reverse-engineer a passing solution. Do not hardcode test IDs, fixture inputs, or hidden expectations, or weaken production behavior merely to turn a test green. Use only the accepted task contract, public interfaces, hosted review findings, and the runner’s stable failure IDs and sanitized behavioral observations in the issue ledger. Delegate all test inspection and test changes to the tester.

When a failure appears inconsistent with the task, discuss it visibly on the issue. Tie the dispute to a specific acceptance criterion and explain expected public behavior, observed behavior, and the requested clarification. Use a `tests-needed` handoff whose reason includes those three elements. The tester evaluates the contract independently and may revise tests only with a documented rationale. Unresolved ambiguity goes to triage/operator via `needs-triage`, never a guessed implementation, test weakening, or an endless argument. Keep handoff evidence and existing limits intact.

Inspect production-only diffs and public interfaces. Do not open full PR diffs, use `git show` on tester commits, or read test files/fixtures through repository APIs to learn private test expectations. Test discussions expose the acceptance contract and explicitly public behavioral observations only.
