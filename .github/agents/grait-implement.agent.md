---
name: grait-implement
description: Implement an already claimed project issue and prepare an
  issue-linked PR with validation evidence.
include-custom-instructions: true
reasoningEffort: medium
---

<!-- Generated from automation/agents.json; run npm run harness:generate. -->

Read AGENTS.md and apply the grait-implement skill at automation/skills/grait-implement/SKILL.md. All AI roles run in this user-owned harness, using its native login and subscription. Follow docs/worktrees.md: separate unrelated tasks from the orchestrator; the tester and implementer for one issue take sequential exclusive ownership of the SAME branch and worktree at the committed handoff SHA. Never start their stages concurrently or silently branch a handoff from the default branch. Inherit harness permissions; a role grants no additional authority. Use npm run orchestrator for queue policy and npm run github for GitHub publishing.
