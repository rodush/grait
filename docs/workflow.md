# Work lifecycle

## Board and readiness

The GitHub Project has Backlog, Ready, In Progress, Review, and Done. Only In Progress consumes the project-wide limit of five stories. Triage establishes scope, measurable acceptance criteria, validation, alignment, and native blocked-by relationships before readiness. Unanswered material questions prevent Ready; known open blockers prevent claiming until successfully completed.

The native local orchestrator records the assessment against the current issue digest and actual dependency set. Changed scope/dependencies invalidate it. Outside submissions need the `agent:admitted` label unless their author currently has repository write access or is a configured operator/managed writer. Contributor text never authorizes policy or credential changes.

## Claiming and delivery

One designated host/repository coordinates each Project. All claims go through `npm run orchestrator -- claim --issue N`; do not move Status manually. The deterministic command checks current readiness, blockers, pause state, and Project-wide capacity before reserving In Progress. It records intent before changing remote status. An uncertain operation requires human reconciliation.

Finish started work before starting another story. Any unarchived story in Review takes priority over Backlog/Ready work, even when the five-story In Progress quota has room. The orchestrator must review pending PR heads, address findings, verify fixes, and help existing deliveries reach human merge before admitting new stories. The new-claim command enforces this across the Project, including stories from other repositories and unreadable story items. Existing accepted claims and Review fixes remain resumable; redesign can reacquire capacity within its existing claim. Review work awaiting a human decision or external dependency stays visible and blocks new admission until resolved; do not silently skip it to fill the quota.

All specialists run in the user's harness. The parent uses its own checkout and assigns an issue worktree/branch to the tester/implementer pair, with sequential exclusive ownership. Follow [TDD](tdd.md) and [worktrees](worktrees.md). The default worker cap is two and is separate from the five-story cap. A ready-for-review PR moves to Review; a draft stays In Progress. Open one issue-linked PR per story with `Closes #N`.

## Review and fixes

The local reviewer evaluates the exact PR head without executing contributor code in its credentialed session. It returns stable finding IDs, severity, evidence, actionable corrections, and a formal APPROVE, REQUEST_CHANGES, or COMMENT decision. The deterministic publisher uses the separate reviewer App, verifies GitHub's recorded review, and updates the writer's `Agent review` status for that exact SHA.

Incremental fixes stay Review. A rethink needs an In Progress slot before redesign; wait in Review when capacity is unavailable. Each testable fix repeats tester → independent Red → implementer → independent Green. The default writer scope excludes automation/policy. Fork authors apply their own branch changes; no automatic pushes to arbitrary contributor forks.

## Stops and completion

One completed review of a distinct head is a round. The PR has a lifetime cap of ten rounds. Stop earlier for a blocker surviving two fix attempts, an oscillating patch state, conflicting reviewer instructions, uncertain external writes, or unavailable/invalid evidence. An author push does not reset history. Pause labels and recorded reasons stop further automatic stages.

Only a human reviews and squash merges after all gates pass. `npm run orchestrator -- sync --pr N` moves a linked claimed issue to Done only when GitHub reports that PR merged. Closing an unmerged PR returns to triage/human judgment and never automatically completes the story. Agents never merge or release.
