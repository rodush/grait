<!-- Generated from docs/workflow.md; edit the source and run npm run compile. -->

# Work lifecycle

## Board and readiness

The default project has five Status values: **Backlog**, **Ready**, **In Progress**, **Review**, and **Done**. Only In Progress counts against the project-wide limit of five stories. All work, including work by local agents, must use this queue and its controller.

Triage must establish:

1. A clear problem, scope, and measurable acceptance criteria.
2. A validation approach and any relevant constraints.
3. Related and duplicate issues, parent/sub-issues where useful, and native GitHub blocked-by relationships.
4. Whether proposed changes overlap with another story and need sequencing.
5. No unanswered question that would change the implementation approach.

Triage agents may authorize Ready. The controller verifies the triage attestation against the current issue body and the current dependency set. It claims only issues whose blockers completed successfully. A closed, rejected dependency does not count as implemented. Missing or inaccessible dependency information prevents claiming.

## Claiming and delivery

One designated controller repository schedules each project. Its serialized controller reserves a slot by moving the issue to In Progress before dispatching implementation. It counts all project stories, including stories from other repositories; it picks work only for its own repository. To automate several repositories in one project, extend the single controller rather than enabling competing schedulers.

Hosted agents open a PR linked to the issue. Local agents request `claim-local` and wait for the claim comment. Both implement the same acceptance criteria. A PR that is ready for review moves the issue to Review. Draft PRs stay In Progress.

## Review and fixes

Reviews run in GitHub Actions. Findings have a stable ID, severity, evidence, and an actionable correction. The reviewer uses APPROVE, REQUEST_CHANGES, or COMMENT and publishes inline comments when a valid diff location exists.

The default automated writer edits only the paths in `allowedWritePaths`. Changes to workflow policy, credentials, or automation require human handling. Fork PRs receive the same hosted review; automatic pushes to arbitrary contributor forks are not enabled. Fork authors apply fixes, and subsequent pushes receive another review.

Follow-up fixes stay in Review. A reviewer marks an approach change explicitly; the controller returns the issue to In Progress before allowing a redesign. The five-story cap still applies. A redesign waits for capacity rather than exceeding the cap.

## Stopping and completion

A round is one completed agent review of a distinct PR head. At most ten rounds are allowed per PR, including the initial review. A normal author push does not reset the counter. Stop earlier when the same blocking finding survives two fix attempts, a previous patch state recurs, reviewer instructions conflict, or required data is invalid or unavailable.

The controller posts the reason in the PR and adds `agent:needs-human`. `agent:paused` stops automated work. A human may resume after resolving the problem; the ten-round lifetime cap remains.

A human reviews and squash merges. Only a merged linked PR completes the issue and moves it to Done. Closing an unmerged PR requires triage or a human decision, and never marks the story completed automatically.

## Admission before automation

Maintainers apply `agent:admitted` to outside submissions before paid triage/review. Repository writers, configured operators, and the managed writer are trusted automatically. The triage agent may still authorize Ready once the checklist and dependencies pass. All hosted dispatches share the concurrency and rolling-credit reservations described in `docs/operations.md`; exhausted budgets defer work without consuming new implementation slots.

## Coordinator and delegated work

The coordinator has a separate worktree from delegated work. Tester and implementer for the same issue share one worktree and branch, handing over exclusive write ownership sequentially. Unrelated sub-agents use separate worktrees. Follow `docs/worktrees.md` for isolation, ownership, integration, and cleanup after merge. Hosted jobs have separate ephemeral checkouts; API-only review does not check out PR code.
