---
safe-outputs:
  push-to-pull-request-branch:
    max: 1
    target: ${{ inputs.number }}
    required-labels:
      - agent:managed
    allowed-files:
      - src/**
      - tests/**
      - assets/**
      - docs/project/**
    protected-files: blocked
    fallback-as-pull-request: false
    check-branch-protection: false
    github-token-for-extra-empty-commit: app
---

Generated from workflow.config.json by scripts/compile.mjs.
