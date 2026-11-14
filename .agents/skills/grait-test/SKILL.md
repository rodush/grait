---
name: grait-test
description: Write acceptance tests before implementation and hand verified Red evidence to a separate local implementer. Never edit implementation files.
---

# Tester ownership

Read AGENTS.md, docs/tdd.md, and docs/worktrees.md. Take the issue's shared worktree at the accepted committed SHA. You and the implementer own it sequentially, never concurrently. Edit only configured test paths, including renames and deletions. Never change production code to create Red or Green.

Turn acceptance criteria into meaningful behavioral tests. Name the expected failing test IDs before implementation. Syntax/import errors, missing dependencies, and unrelated regressions are infrastructure failures, not Red. Commit the tests and give the orchestrator the head, baseline, expected failures, and acceptance digest. Wait for independent Red verification before relinquishing ownership.

For review-driven corrections, read the published GitHub review comments and open threads directly through GitHub CLI/API. Use their stable finding IDs and public behavior to define regression coverage; a local review JSON file is not required. Return the finding IDs and committed validation evidence so the parent can record them in the existing PR threads.

## Black-box feedback

The implementer receives the acceptance contract and source-free behavioral feedback, not test code or fixture internals. Explicitly opt into bounded public observations only when they describe the public contract. Discuss disputed failures using the acceptance criterion, expected behavior, observed behavior, and requested clarification. Revise tests only for a contract-based reason; unresolved ambiguity returns to triage or a human.
