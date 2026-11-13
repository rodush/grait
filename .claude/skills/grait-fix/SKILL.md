---
name: grait-fix
description: Address published PR findings within the existing issue claim and bounded local review loop. Use for incremental fixes or orchestrator-authorized redesign.
---

# Address PR findings

Read the exact PR head, its published review, linked issue, and orchestrator ledger. Follow docs/workflow.md and docs/tdd.md. Verify exclusive worktree ownership and that the loop is enabled, unpaused, and within its lifetime review limit.

Apply focused production corrections while the issue stays Review. A rethink requires the orchestrator to reacquire an In Progress slot before redesign. Follow the same tester → independent Red → implementer → independent Green sequence for testable corrections. Never create, edit, delete, or rename test files. Never read test source, fixtures, or assertion internals; use the public acceptance contract, stable failure IDs, and sanitized public observations. If tests need revision, hand ownership back to the tester with a contract-based reason.

Preserve stable finding IDs and committed validation evidence. Stop on conflicting instructions, recurring code states, or a blocker surviving two fix attempts. Never reset history, dismiss a human objection, force-push, merge, or release. The separate local reviewer evaluates the next exact head and publishes through its own GitHub identity. Fork branches remain the contributor's responsibility.
