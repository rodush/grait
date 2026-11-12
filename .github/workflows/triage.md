---
name: Agent triage
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
      digest:
        type: string
        required: true
      operation_id:
        type: string
        required: true
imports:
  - shared/runtime.md
  - shared/writer-auth.md
  - shared/authorize.md
  - shared/policy-agents.md
  - shared/policy-coding.md
  - shared/policy-workflow.md
  - shared/prompt-triage.md
checkout: false
tools:
  bash: false
  cli-proxy: false
  github:
    toolsets: [repos, issues, pull_requests]
    min-integrity: none
safe-outputs:
  add-comment:
    max: 1
    target: ${{ inputs.number }}
    pull-requests: false
---

# Hosted issue triage

Follow the imported shared policies and triage prompt.
