<!-- Generated from automation/prompts/fix.md; edit the source and run npm run compile. -->

# Address the PR review

Address the latest controller-accepted review on PR `${{ inputs.number }}`, checked out at `${{ inputs.head }}`. The linked issue is `${{ inputs.issue }}` and the completed review round is `${{ inputs.round }}`. Read the issue, review, stable finding IDs, and shared policies before editing.

The controller has already evaluated the review-loop limits. `${{ inputs.rethink }}` indicates whether an approach change was authorized and an In Progress slot reserved. When false, make focused follow-up fixes. When true, rethink the approach within the issue's acceptance criteria. If reviewer instructions conflict, stop and explain the conflict instead of alternating implementations.

Run meaningful validation, preserve earlier correct behavior, and document evidence. Push exactly one incremental update with `push_to_pull_request_branch` targeting this PR. Do not create a replacement PR, force-push, dismiss a human review, change credentials, merge, or publish a release. Use a Conventional Commit message. A fresh hosted review follows automatically.

If a correction cannot be made safely within the configured write scope, report incomplete and explain the required human decision.
