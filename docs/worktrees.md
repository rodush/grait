# Coordinator and sub-agent worktrees

## Isolation and the TDD pair exception

The coordinator uses its own worktree. Every delegated issue has a worktree separate from the coordinator and unrelated sub-agents. **The tester and implementer assigned to the same issue share that issue worktree and branch**, taking exclusive ownership in sequence. They never write concurrently. Other sub-agents receive separate worktrees. Delegated work inherits its parent issue’s controller claim and does not consume another story slot.

Before delegation, inspect `git status --short` and `git worktree list`. Assign each agent an explicit path, role, base SHA, writable paths, and expected handoff. Reuse the issue worktree when transferring ownership between tester and implementer; do not create a second checkout of their branch. Preserve operator changes and never reset or clean someone else’s checkout.

## Shared issue branch and sequential handoff

Create the issue branch once in the shared pair worktree, normally `agent/issue-N`. The coordinator works from its own checkout and schedules one role at a time.

```sh
git worktree add -b agent/issue-123 ../issue-123 BASE_SHA
```

The tester starts from the accepted base and changes only configured test paths. After committing tests and recording runner-verified Red evidence, the tester relinquishes ownership. The implementer verifies the handoff SHA and clean status in that same worktree, then changes only implementation paths. If tests need revision, the implementer commits its allowed changes and returns ownership to the tester with a concrete reason. Do not copy dirty files between checkouts or let an inactive role edit the shared worktree.

Each handoff records issue, role, shared worktree path, branch, base SHA, resulting commit SHA, changed files, acceptance-criteria digest, validation evidence, and next owner. The coordinator checks scope, ancestry, evidence, and that the branch still matches the recorded head before authorizing the next role. If it advanced unexpectedly, stop and reconcile rather than force-pushing. Neither role may bypass its file boundary to complete the other’s work.

## Hosted execution

GitHub Actions runners are ephemeral. Hosted roles therefore use separate job checkouts of the same issue branch at the controller-authorized handoff SHA. Committed changes and evidence transfer between jobs; a physical checkout cannot persist across independent runners. Each role publishes through its scoped safe outputs. API-only triage and review retain their no-checkout policy; these instructions do not authorize executing PR code in review jobs.

## Cleanup after merge

The coordinator owns cleanup. Keep the shared tester/implementer worktree until the issue PR is merged and both roles have released it. After human merge, verify the PR’s merged state and accepted head, confirm the worktree is clean, and remove task-owned worktrees and obsolete local branches. Squash merges require checking the PR merge result, since Git ancestry alone may not contain the original commits. Never force removal of a dirty worktree; preserve it and report its path for reconciliation.

```sh
git worktree remove ../issue-123
git worktree prune
```
