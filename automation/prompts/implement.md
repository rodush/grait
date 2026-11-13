# Implement the claimed issue

Implement issue `${{ inputs.number }}`. The controller has reserved its In Progress slot. Read the issue, triage discussion, native dependencies, and relevant project code. Follow AGENTS.md and its linked policies. If requirements remain ambiguous or the issue has changed, report incomplete and explain the decision needed in an issue comment.

Work only on the issue's accepted outcome and within the configured safe-output write paths. Use the existing stack and its commands. Run meaningful checks and update relevant documentation. Never edit tests; the tester owns them. For a project without an application stack, ask for a stack choice rather than choosing a framework.

Create one ready PR through `create_pull_request` on branch `issue-${{ inputs.number }}`; the configured prefix produces `agent/issue-${{ inputs.number }}`. Use a Conventional Commit title. Include `Closes #${{ inputs.number }}`, outcome, validation evidence, and relevant risks. Set the PR ready only after the work is ready for review. Never merge or publish a release. Use safe outputs for writes; do not push directly or change authentication.

If the task requires protected automation, instruction, or configuration files outside your write scope, report the limitation and ask for human handling. Do not work around the policy or weaken checks.

## Tests are a black box

Implement acceptance criteria and public behavior; do not read test source, fixtures, assertion implementations, or test internals to reverse-engineer a passing solution. Do not hardcode test IDs, fixture inputs, or hidden expectations, or weaken production behavior merely to turn a test green. Use only the accepted task contract, public interfaces, hosted review findings, and the runner’s stable failure IDs and sanitized behavioral observations in the issue ledger. Delegate all test inspection and test changes to the tester.

When a failure appears inconsistent with the task, discuss it visibly on the issue. Tie the dispute to a specific acceptance criterion and explain expected public behavior, observed behavior, and the requested clarification. Use a `tests-needed` handoff whose reason includes those three elements. The tester evaluates the contract independently and may revise tests only with a documented rationale. Unresolved ambiguity goes to triage/operator via `needs-triage`, never a guessed implementation, test weakening, or an endless argument. Keep handoff evidence and existing limits intact.

Inspect production-only diffs and public interfaces. Do not open full PR diffs, use `git show` on tester commits, or read test files/fixtures through repository APIs to learn private test expectations. Test discussions expose the acceptance contract and explicitly public behavioral observations only.
