---
name: grait-implement
description: Implement a controller-claimed GitHub Project issue and prepare its PR. Use for scoped implementation after readiness and dependencies have been established.
---

# Implement a claimed GRAIT issue

Read the repository's [shared instructions](../../../AGENTS.md), [coding guidelines](../../../docs/coding-guidelines.md), and [work lifecycle](../../../docs/workflow.md). Confirm the issue's accepted outcome and a controller-confirmed In Progress claim. A delegated subtask shares its parent issue's claim; do not acquire an additional story slot for it.

If no claim exists, have an authorized operator request `claim-local` and wait for the controller's claim comment before starting. Never move Project Status directly to bypass dependency or capacity checks. Clarify choices that would change the implementation instead of choosing a stack or product behavior without authorization.

Implement within the accepted scope and permitted paths. Run meaningful behavioral checks, preserve their evidence, and open an issue-linked PR using Conventional Commits. Report missing validation honestly. Humans retain merge and release authority.

Inside the hosted implementation workflow, follow the [safe-output contract](../../../automation/prompts/implement.md). In a local harness, use the claimed issue's isolated branch and the operator-authorized GitHub identity. Protected policy or automation changes require human handling.

## Worktree ownership

For local execution, use a worktree separate from the coordinator and unrelated sub-agents. Tester and implementer assigned to one issue share that issue’s worktree and branch with sequential exclusive ownership. Follow the [worktree protocol](../../../docs/worktrees.md). Record and verify the committed handoff SHA before transferring ownership; never allow concurrent writes. The coordinator integrates accepted commits and cleans up task-owned worktrees after merge. Hosted API-only roles retain their no-checkout policy.

## TDD boundary

Never create, edit, delete, or rename test files. The tester owns all configured test paths. Start only at the controller-accepted Red SHA; change production paths only. If tests are incorrect or incomplete, hand back to the tester with a reason. The independent runner must verify full-suite Green before review. Use `docs/tdd.md` for the handoff contract.

## Tests are a black box

Implement acceptance criteria and public behavior; do not read test source, fixtures, assertion implementations, or test internals to reverse-engineer a passing solution. Do not hardcode test IDs, fixture inputs, or hidden expectations, or weaken production behavior merely to turn a test green. Use only the accepted task contract, public interfaces, hosted review findings, and the runner’s stable failure IDs and sanitized behavioral observations in the issue ledger. Delegate all test inspection and test changes to the tester.

When a failure appears inconsistent with the task, discuss it visibly on the issue. Tie the dispute to a specific acceptance criterion and explain expected public behavior, observed behavior, and the requested clarification. Use a `tests-needed` handoff whose reason includes those three elements. The tester evaluates the contract independently and may revise tests only with a documented rationale. Unresolved ambiguity goes to triage/operator via `needs-triage`, never a guessed implementation, test weakening, or an endless argument. Keep handoff evidence and existing limits intact.

Inspect production-only diffs and public interfaces. Do not open full PR diffs, use `git show` on tester commits, or read test files/fixtures through repository APIs to learn private test expectations. Test discussions expose the acceptance contract and explicitly public behavioral observations only.
