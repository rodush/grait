---
safe-outputs:
  create-pull-request:
    max: 1
    draft: true
    branch-prefix: agent/
    preserve-branch-name: true
    labels:
      - agent:managed
    allowed-files:
      - src/**/test_*.py
      - src/**/*.spec.py
      - src/**/*.test.*
      - tests/**
      - tests/**/test_*.py
      - tests/**/*.spec.py
      - tests/**/*.test.*
      - assets/**/test_*.py
      - assets/**/*.spec.py
      - assets/**/*.test.*
      - docs/project/**/test_*.py
      - docs/project/**/*.spec.py
      - docs/project/**/*.test.*
    excluded-files:
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
    fallback-as-issue: false
    auto-merge: false
    github-token-for-extra-empty-commit: app
  push-to-pull-request-branch:
    max: 1
    target: ${{ inputs.pr }}
    required-labels:
      - agent:managed
    allowed-files:
      - src/**/test_*.py
      - src/**/*.spec.py
      - src/**/*.test.*
      - tests/**
      - tests/**/test_*.py
      - tests/**/*.spec.py
      - tests/**/*.test.*
      - assets/**/test_*.py
      - assets/**/*.spec.py
      - assets/**/*.test.*
      - docs/project/**/test_*.py
      - docs/project/**/*.spec.py
      - docs/project/**/*.test.*
    excluded-files:
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
