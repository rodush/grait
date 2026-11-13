---
name: grait-implement
description: Implement an orchestrator-claimed GitHub issue in its assigned local worktree and prepare an issue-linked PR after tester handoff.
---

# Implement a claimed issue

Read AGENTS.md, docs/coding-guidelines.md, docs/workflow.md, and docs/tdd.md. Verify the orchestrator's accepted claim, exact committed handoff SHA, and exclusive ownership of the assigned issue worktree. A delegated subtask inherits its parent claim; it never acquires another story slot. Do not move Project Status manually.

Implement the acceptance criteria within allowed production paths. Tester and implementer share the SAME issue worktree and branch sequentially; never branch from default during handoff or write concurrently. Return committed changes, changed paths, and actual validation evidence. Publish only through the configured writer identity. Humans merge and release.

## TDD boundary

Never create, edit, delete, or rename test files. Never read test source, fixtures, assertion implementations, or test internals to reverse-engineer a passing solution. Do not hardcode test identities or fixture inputs. Work from the acceptance contract, public interfaces, stable failing test IDs, and sanitized public observations. Inspect production-only diffs rather than full tester commits or full PR diffs containing tests.

Start testable implementation only after independently verified Red. Independent full-suite Green is required before review. If tests need revision, commit your production changes and return ownership to the tester with the acceptance criterion, expected behavior, observed behavior, and requested correction. Do not repair tests yourself. Unresolved disagreement returns to triage or a human; never weaken checks to proceed.
