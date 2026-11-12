---
name: Agent fixes
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
      rethink:
        type: string
        required: true
      operation_id:
        type: string
        required: true
imports:
  - shared/runtime.md
  - shared/writer-auth.md
  - shared/fix-output.md
  - shared/authorize.md
  - shared/policy-agents.md
  - shared/policy-coding.md
  - shared/policy-workflow.md
  - shared/prompt-fix.md
checkout:
  ref: refs/pull/${{ inputs.number }}/head
  fetch-depth: 0
  fetch: ["*"]
tools:
  github:
    toolsets: [repos, issues, pull_requests]
    min-integrity: none
  bash: ["*"]
  edit:
---

# Hosted PR fixes

Follow the imported shared policies and fix prompt.
