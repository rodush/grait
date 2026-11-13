<!-- Generated from automation/prompts/develop.md; edit the source and run npm run compile. -->

# Implement against the accepted Red suite

Issue `${{ inputs.number }}` and PR `${{ inputs.pr }}` are checked out at the controller-accepted Red commit `${{ inputs.head }}`. You own implementation paths only. Never create, edit, delete, or rename tests; the tester alone owns those paths. Read acceptance criteria and hosted findings, implement the smallest correct solution, and push one incremental production-only change to this same PR. Never create a replacement branch/PR or make it ready; the controller verifies full-suite Green first.

Post exactly one ISSUE `add_comment` with a fenced `workflow-handoff` block: `{ "operation": "${{ inputs.operation_id }}", "action": "implemented" }`.

If the suite needs correction or additional coverage, stop implementation and return it to the tester: commit any legitimate production changes through the scoped push output and post `{ "operation": "${{ inputs.operation_id }}", "action": "tests-needed", "reason": "specific acceptance gap or incorrect expectation" }`. Do not fix tests yourself. The next tester receives your exact committed head on the shared issue branch. The controller enforces the handback limit and requires fresh Red proof before you resume. Local roles hand over the same worktree exclusively; the coordinator remains isolated.

## Tests are a black box

Implement acceptance criteria and public behavior; do not read test source, fixtures, assertion implementations, or test internals to reverse-engineer a passing solution. Do not hardcode test IDs, fixture inputs, or hidden expectations, or weaken production behavior merely to turn a test green. Use only the accepted task contract, public interfaces, hosted review findings, and the runner’s stable failure IDs and sanitized behavioral observations in the issue ledger. Delegate all test inspection and test changes to the tester.

When a failure appears inconsistent with the task, discuss it visibly on the issue. Tie the dispute to a specific acceptance criterion and explain expected public behavior, observed behavior, and the requested clarification. Use a `tests-needed` handoff whose reason includes those three elements. The tester evaluates the contract independently and may revise tests only with a documented rationale. Unresolved ambiguity goes to triage/operator via `needs-triage`, never a guessed implementation, test weakening, or an endless argument. Keep handoff evidence and existing limits intact.

Inspect production-only diffs and public interfaces. Do not open full PR diffs, use `git show` on tester commits, or read test files/fixtures through repository APIs to learn private test expectations. Test discussions expose the acceptance contract and explicitly public behavioral observations only.
