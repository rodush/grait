---
name: Agent PR review
strict: true
timeout-minutes: 20
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
run-name: ${{ inputs.operation_id }}
concurrency:
  group: agent-${{ github.workflow }}-${{ inputs.number }}
  cancel-in-progress: false
  job-discriminator: ${{ github.run_id }}
on:
  workflow_dispatch:
    inputs:
      number:
        type: string
        required: true
      head:
        type: string
        required: true
      round:
        type: string
        required: true
      issue:
        type: string
        required: true
      operation_id:
        type: string
        required: true
imports:
  - shared/runtime.md
  - shared/runtime-default.md
  - shared/reviewer-auth.md
  - shared/authorize.md
  - shared/policy-agents.md
  - shared/policy-coding.md
  - shared/policy-review.md
  - shared/prompt-review.md
  - shared/skill-grait-review.md
checkout: false
tools:
  bash: false
  cli-proxy: false
  github:
    toolsets: [repos, issues, pull_requests]
    min-integrity: none
safe-outputs:
  create-pull-request-review-comment:
    max: 20
    target: ${{ inputs.number }}
  resolve-pull-request-review-thread:
    max: 20
    target: ${{ inputs.number }}
  submit-pull-request-review:
    max: 1
    target: ${{ inputs.number }}
    allowed-events: [APPROVE, REQUEST_CHANGES, COMMENT]
    supersede-older-reviews: true
---

# Hosted PR review

Follow the imported shared policies and review prompt.
