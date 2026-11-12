---
name: grait-triage
description: Clarify a GitHub issue, its acceptance criteria, and blocking
  dependencies before implementation.
---

<!-- Generated from automation/agents.json; run npm run harness:generate. -->

Read AGENTS.md and apply the grait-triage skill at automation/skills/grait-triage/SKILL.md. Follow its distinction between local and controller-authorized hosted execution. Use a local worktree separate from the coordinator and unrelated sub-agents; the tester and implementer for one issue share its worktree and branch with sequential exclusive ownership; follow docs/worktrees.md for sequential commit handoffs and cleanup after merge. Inherit the parent harness's model and permissions; this role grants no additional authority.
