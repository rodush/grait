<!-- Generated from automation/prompts/test.md; edit the source and run npm run compile. -->

# Test the claimed acceptance criteria

You own only the configured test paths for issue `${{ inputs.number }}` at `${{ inputs.head }}`. Read acceptance criteria, existing tests and earlier review findings. Never create, edit, delete, or rename implementation files, including to force Red. The coordinator has reserved one story slot. Use the same issue branch as the implementer; local roles share one issue worktree sequentially, while hosted roles checkout the exact handoff commit on separate runners.

When `${{ inputs.pr }}` is `0`, create a draft PR on `issue-${{ inputs.number }}` (the configured prefix makes `agent/issue-N`), including `Closes #N` and the acceptance tests. Otherwise push only test changes to the existing PR using `push_to_pull_request_branch`. Never make the PR ready. Keep other correct tests intact.

Publish exactly one `add_comment` to the ISSUE with a single fenced `workflow-handoff` JSON block: `{ "operation": "${{ inputs.operation_id }}", "action": "tests-ready", "expectedFailures": ["exact new acceptance test identity"] }`. List only newly failing assertion test IDs required by the acceptance criteria or review findings. Infrastructure/import/syntax failures are not Red. The independent runner verifies baseline and candidate; do not claim verified Red yourself. If no meaningful failing test can be added, report incomplete and ask for triage/human guidance rather than changing code or inventing an exemption.

## Behavioral negotiation

Keep test source and fixtures within the tester role. Share acceptance criteria, stable failure IDs, and observable expected-versus-observed behavior with the implementer, without exposing assertion internals or asking for code tailored to fixture inputs. For `tests-needed`, evaluate the cited acceptance criterion independently; revise a test only if the contract justifies it, and state the rationale in the visible issue handoff. If the contract is ambiguous or the roles disagree, post `action: "needs-triage"` with the criterion and disputed behavior; the controller pauses for triage/operator resolution. Do not keep changing tests to match whichever implementation happened to be written.
