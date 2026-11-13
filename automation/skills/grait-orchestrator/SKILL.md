---
name: grait-orchestrator
description: Manage the local Project queue and delegate tester, implementer, reviewer, triage, and fix sub-agents in a subscription-backed harness. Use to coordinate issue delivery.
---

# Orchestrate local delivery

Read AGENTS.md, docs/workflow.md, docs/operations.md, and docs/worktrees.md. You are the parent session in the user's Codex or Claude Code harness. All specialists and commands run on this host; use the harness's existing login. Never dispatch an AI workflow to GitHub or request a provider API key.

1. Inspect `npm run orchestrator -- status` and current issue/PR discussions. Delegate scope clarification to grait-triage. Accept its current assessment with `ready --issue N --file PATH`; native GitHub blockers must already match.
2. Reserve work with `claim --issue N`. Never start an unclaimed story. Respect the configured worker limit (two by default) independently of the five-story Project cap.
3. Prepare `worktree --issue N`. Assign its absolute path, branch, acceptance digest, base SHA, writable paths, and next owner. The tester and implementer share this SAME worktree sequentially. Start native sub-agents with that explicit assignment, or use `worker --issue N --role test|implement|fix` to launch a native session there. Do not use a fresh default-branch worktree for an implementation handoff.
4. For testable work, delegate the tester first. Independently run and record Red, then transfer exclusive ownership to the implementer. Independently run full-suite Green before review. Use the handoff and verification commands in docs/tdd.md. The implementer receives only stable failure IDs and explicitly public sanitized observations; never send test source or fixture internals.
5. Publish committed work using `npm run github -- push --issue N`, then `pr --issue N --title 'feat: ...' --body-file PATH`. PRs start as drafts. After Green and readiness, mark the PR ready and run `sync --pr N`.
6. Delegate grait-review in a separate worktree at the exact PR head, using trusted default-branch policy. Publish its JSON through `review --pr N --file PATH`. Follow the returned decision. Incremental fixes stay Review; a rethink must reacquire In Progress capacity first. Humans merge and release. After human merge, run `sync --pr N` and clean up only task-owned clean worktrees.

Before every stage, recheck repository enablement, issue/PR pause labels, current head, and ownership. Stop on conflicting instructions, an uncertain external write, repeated blockers, oscillation, exhausted review rounds, or unavailable evidence. Save committed handoff/checkpoint evidence on GitHub before ending a subscription-limited session. Do not busy-loop model calls while waiting for humans, CI, or allowance resets. Only one host may coordinate a Project; locks serialize local commands, not independent hosts.
