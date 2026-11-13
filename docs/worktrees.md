# Coordinator and sub-agent worktrees

## Isolation and the TDD pair exception

The coordinator uses its own worktree. Every delegated issue has a worktree separate from the coordinator and unrelated sub-agents. **The tester and implementer assigned to the same issue share that issue worktree and branch**, taking exclusive ownership in sequence. They never write concurrently. Other sub-agents receive separate worktrees. Delegated work inherits its parent issue’s orchestrator claim and does not consume another story slot.

Before delegation, inspect `git status --short` and `git worktree list`. Assign each agent an explicit path, role, base SHA, writable paths, and expected handoff. Reuse the issue worktree when transferring ownership between tester and implementer; do not create a second checkout of their branch. Preserve operator changes and never reset or clean someone else’s checkout.

## Shared issue branch and sequential handoff

Create the issue branch once in the shared pair worktree, normally `agent/issue-N`. The coordinator works from its own checkout and schedules one role at a time.

```sh
git worktree add -b agent/issue-123 ../issue-123 BASE_SHA
```

The tester starts from the accepted base and changes only configured test paths. After committing tests and recording runner-verified Red evidence, the tester relinquishes ownership. The implementer verifies the handoff SHA and clean status in that same worktree, then changes only implementation paths. If tests need revision, the implementer commits its allowed changes and returns ownership to the tester with a concrete reason. Do not copy dirty files between checkouts or let an inactive role edit the shared worktree.

Each handoff records issue, role, shared worktree path, branch, base SHA, resulting commit SHA, changed files, acceptance-criteria digest, validation evidence, and next owner. The coordinator checks scope, ancestry, evidence, and that the branch still matches the recorded head before authorizing the next role. If it advanced unexpectedly, stop and reconcile rather than force-pushing. Neither role may bypass its file boundary to complete the other’s work.

## Native harness execution

All roles run on the user host. Native triage/review may use temporary independent worktrees. Tester and implementer instead use the existing shared issue worktree at its recorded head; a fresh default-branch worktree is not an implementation handoff. `npm run orchestrator -- worktree --issue N` prepares/reuses the branch; `worker --issue N --role test|implement|fix` launches an official native session there. The orchestrator may delegate natively with the same explicit absolute path and ownership contract.

The worker command refuses a dirty handoff but cannot identify every independently started process editing the same files. The orchestrator must wait for the old role to release ownership before starting the next. Worktrees and prompts are not OS security boundaries. Keep one coordinating host per Project; separate hosts have independent locks.

## Cleanup after merge

The coordinator owns cleanup. Keep the shared tester/implementer worktree until the issue PR is merged and both roles have released it. After human merge, verify the PR’s merged state and accepted head, confirm the worktree is clean, and remove task-owned worktrees and obsolete local branches. Squash merges require checking the PR merge result, since Git ancestry alone may not contain the original commits. Never force removal of a dirty worktree; preserve it and report its path for reconciliation.

```sh
git worktree remove ../issue-123
git worktree prune
```
