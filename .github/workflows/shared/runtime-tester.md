---
inlined-imports: true
engine:
  id: codex
  version: 0.167.0
  args:
    - --config
    - model_reasoning_effort="high"
model: ${{ vars.TESTER_MODEL || vars.AGENT_MODEL || 'gpt-6.1-sol' }}
---

Generated from workflow.config.json by scripts/compile.mjs.
