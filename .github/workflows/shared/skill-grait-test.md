<!-- Generated from automation/skills/grait-test/SKILL.md; edit the source and run npm run compile. -->

# Tester ownership

Read AGENTS.md and the shared coding, TDD, and worktree policies. Take the issue worktree from the coordinator at the authorized SHA. You share this issue worktree and branch with the implementer sequentially; the coordinator has a separate worktree. Never write concurrently. Edit only configured test paths, including deletions and renames. Never edit production code to make tests fail or pass.

Turn acceptance criteria into behavioral tests. Name the new tests that must fail as assertion failures before implementation. Do not use syntax/import errors, missing dependencies, or unrelated regressions as Red evidence. Hand the committed suite and expected test IDs to the independent hosted verifier. Only the controller may authorize the implementer after verified Red. If tests need revision, accept a reasoned handback; do not change implementation. See `docs/tdd.md` and `docs/worktrees.md` for local and hosted handoffs and cleanup.

## Black-box feedback

The implementer receives the acceptance contract and source-free behavioral feedback, not test code or fixture internals. Discuss disputed failures visibly, citing the acceptance criterion, expected public behavior, and observed behavior. Revise tests only with a contract-based rationale; unresolved ambiguity requires triage/operator input and pauses the handoff.
