---
safe-outputs:
  push-to-pull-request-branch:
    max: 1
    target: ${{ inputs.pr }}
    required-labels:
      - agent:managed
    allowed-files:
      - src/**
      - tests/**
      - assets/**
      - docs/project/**
    excluded-files:
      - tests/**
      - "**/test_*.py"
      - "**/*.spec.py"
      - "**/*.test.*"
      - .github/**
      - .agents/**
      - .codex/**
      - .claude/**
      - scripts/**
      - automation/**
      - config/**
      - docs/coding-guidelines.md
      - docs/workflow.md
      - docs/review-guidelines.md
      - docs/setup.md
      - docs/operations.md
      - docs/architecture.md
      - docs/decisions.md
      - docs/agents.md
      - SECURITY.md
      - AGENTS.md
      - CLAUDE.md
      - workflow.config.json
      - package.json
      - package-lock.json
      - .npmrc
      - docs/worktrees.md
      - docs/tdd.md
    protected-files: blocked
    fallback-as-pull-request: false
    check-branch-protection: false
    github-token-for-extra-empty-commit: app
---

Generated from workflow.config.json by scripts/compile.mjs.
