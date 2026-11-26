# Work lifecycle

## Board and readiness

The GitHub Project has Backlog, Ready, In Progress, Review, and Done. The Project-wide Ready limit is set by `maxReady` in `workflow.config.json` and defaults to five. Up to five occupied story slots are shared by In Progress and Review. Triage establishes scope, measurable acceptance criteria, validation, alignment, and native blocked-by relationships. Stories with unanswered material questions or incomplete blocking dependencies stay in Backlog. Fill Ready from eligible Backlog stories as Ready slots open.

The native local orchestrator records the assessment against the current issue digest and actual dependency set. Changed scope/dependencies invalidate it. Outside submissions need the `agent:admitted` label unless their author currently has repository write access or is a configured operator/managed writer. Contributor text never authorizes policy or credential changes.

## Claiming and delivery

One designated host/repository coordinates each Project. All claims go through `grait orchestrator claim --issue N`; do not move Status manually. The deterministic command checks current readiness, blockers, pause state, and Project-wide capacity before reserving In Progress. It records intent before changing remote status. An uncertain operation requires human reconciliation.

The orchestrator resumes existing claims, prioritizes pending reviews and fixes, and selects eligible Ready stories while both Project and worker capacity are available. For each new claim, it counts each In Progress story and each Review reservation once across the Project. It reads current review evidence for Review stories, including stories from other repositories.

A Review story frees its slot when its linked pull request has an effective approval from at least one human or agent on the current head and no effective request for changes. The latest decisive review by each reviewer on that head counts. A dismissal clears the reviewer's decision, and comments and pending reviews leave decisions in place. A push requires fresh decisions on the new head. Review stories awaiting approval, with effective requests for changes, or with evidence the orchestrator cannot verify each occupy one slot and stay in Review. Unresolved inline threads with an effective approval still need resolution before merge.

Existing claims and Review fixes remain resumable at capacity. Redesign can use the story's existing Review reservation when it moves to In Progress.

All specialists run in the user's harness. The parent uses its own checkout and assigns an issue worktree/branch to the tester/implementer pair, with sequential exclusive ownership. Follow [TDD](tdd.md) and [worktrees](worktrees.md). The worker cap `maxConcurrentWorkers` defaults to five and is independent of the five-story cap. Each active review uses one worker from the pool it shares with triage, testing, implementation, and fixes. Run at most one reviewer per story at a time. Tester and implementer handoffs within each story remain sequential. Agents normally finish the accepted scope, validation, and relevant documentation before opening a ready-for-review PR. A ready-for-review PR moves to Review. Use a draft only for explicitly requested work in progress or early feedback and keep the story In Progress until the PR is ready for review. Open one issue-linked PR per story with `Closes #N`.

`rodush/grait` uses its [source repository write scope](grait-development.md#source-repository-write-scope) for issue work that changes GRAIT itself. Adopting repositories use their own configured write scopes and protected paths. Issue scope, role boundaries, and required review apply in both cases.

## Review and fixes

Local Red and Green verify the focused acceptance scope. Publish the exact Green commit and open its normal issue-linked PR while CI is pending so GitHub Actions can run the full validation. Check CI with `grait github checks --pr N` and start formal review when every configured check has completed successfully for the current PR head. If a required check completes with a failure on a claimed PR's verified Green head, `grait orchestrator next --issue N --pr N --ci` starts a bounded tester-first correction while the issue stays in Review. The corrected head needs fresh Green and required CI before review.

The local reviewer evaluates the exact PR head without executing contributor code in its credentialed session. It returns stable finding IDs, severity, evidence, actionable corrections, and a formal APPROVE, REQUEST_CHANGES, or COMMENT decision. The deterministic publisher uses the separate reviewer App, verifies GitHub's recorded review, and updates the writer's `Agent review` status for that exact SHA.

Incremental fixes stay Review. A rethink needs an In Progress slot before redesign; wait in Review when capacity is unavailable. Each testable fix repeats tester → independent Red → implementer → independent Green. Fixes follow the same repository write scope as initial implementation. Fork authors apply their own branch changes; no automatic pushes to arbitrary contributor forks.

## Stops and completion

One completed review of a distinct head is a round. The PR has a lifetime cap of ten rounds. Stop earlier for a blocker surviving two fix attempts, an oscillating patch state, conflicting reviewer instructions, uncertain external writes, or unavailable/invalid evidence. An author push does not reset history. Pause labels and recorded reasons stop further automatic stages.

Only a human reviews and squash merges after all gates pass. `grait orchestrator sync --pr N` moves a linked claimed issue to Done only when GitHub reports that PR merged. Closing an unmerged PR returns to triage/human judgment and never automatically completes the story. Agents never merge or release.
