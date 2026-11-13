---
inlined-imports: true
max-turns: 60
max-ai-credits: 1000
env:
  NPM_CONFIG_MIN_RELEASE_AGE: "3"
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
network:
  allowed:
    - defaults
    - github
    - node
safe-outputs:
  threat-detection:
    continue-on-error: false
    max-ai-credits: 400
  max-patch-files: 50
  max-patch-size: 2048
  report-failure-as-issue: false
---

Generated from workflow.config.json by scripts/compile.mjs.
