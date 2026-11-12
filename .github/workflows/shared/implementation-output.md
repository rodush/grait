---
safe-outputs:
  create-pull-request:
    max: 1
    draft: false
    branch-prefix: agent/
    preserve-branch-name: true
    labels:
      - agent:managed
    allowed-files:
      - src/**
      - tests/**
      - assets/**
      - docs/project/**
    protected-files: blocked
    fallback-as-issue: false
    auto-merge: false
    github-token-for-extra-empty-commit: app
---

Generated from workflow.config.json by scripts/compile.mjs.
