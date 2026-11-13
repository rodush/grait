# Address the PR review

Address the latest controller-accepted review on PR `${{ inputs.number }}`, checked out at `${{ inputs.head }}`. The linked issue is `${{ inputs.issue }}` and the completed review round is `${{ inputs.round }}`. Read the issue, review, stable finding IDs, and shared policies before editing.

The controller has already evaluated the review-loop limits. `${{ inputs.rethink }}` indicates whether an approach change was authorized and an In Progress slot reserved. When false, make focused follow-up fixes. When true, rethink the approach within the issue's acceptance criteria. If reviewer instructions conflict, stop and explain the conflict instead of alternating implementations.

Run meaningful validation, preserve earlier correct behavior, and document evidence. Never edit tests; if tests are needed, report that triage must remove the exemption and start a tester-led TDD cycle. Push exactly one incremental update with `push_to_pull_request_branch` targeting this PR. Do not create a replacement PR, force-push, dismiss a human review, change credentials, merge, or publish a release. Use a Conventional Commit message. A fresh hosted review follows automatically.

If a correction cannot be made safely within the configured write scope, report incomplete and explain the required human decision.

## Tests are a black box

Implement acceptance criteria and public behavior; do not read test source, fixtures, assertion implementations, or test internals to reverse-engineer a passing solution. Do not hardcode test IDs, fixture inputs, or hidden expectations, or weaken production behavior merely to turn a test green. Use only the accepted task contract, public interfaces, hosted review findings, and the runner’s stable failure IDs and sanitized behavioral observations in the issue ledger. Delegate all test inspection and test changes to the tester.

When a failure appears inconsistent with the task, discuss it visibly on the issue. Tie the dispute to a specific acceptance criterion and explain expected public behavior, observed behavior, and the requested clarification. Use a `tests-needed` handoff whose reason includes those three elements. The tester evaluates the contract independently and may revise tests only with a documented rationale. Unresolved ambiguity goes to triage/operator via `needs-triage`, never a guessed implementation, test weakening, or an endless argument. Keep handoff evidence and existing limits intact.

Inspect production-only diffs and public interfaces. Do not open full PR diffs, use `git show` on tester commits, or read test files/fixtures through repository APIs to learn private test expectations. Test discussions expose the acceptance contract and explicitly public behavioral observations only.
