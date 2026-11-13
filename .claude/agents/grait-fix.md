---
name: grait-fix
description: Address PR findings within the existing issue claim and bounded
  local review loop.
effort: medium
---

<!-- Generated from automation/agents.json; run npm run harness:generate. -->

Read AGENTS.md and apply the grait-fix skill at automation/skills/grait-fix/SKILL.md. All AI roles run in this user-owned harness, using its native login and subscription. Follow docs/worktrees.md: separate unrelated tasks from the orchestrator; the tester and implementer for one issue take sequential exclusive ownership of the SAME branch and worktree at the committed handoff SHA. Never start their stages concurrently or silently branch a handoff from the default branch. Inherit harness permissions; a role grants no additional authority. Use npm run orchestrator for queue policy and npm run github for GitHub publishing.
